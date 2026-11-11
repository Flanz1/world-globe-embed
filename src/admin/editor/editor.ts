/**
 * The region editor: a flat equirectangular canvas for drawing and editing, with the real globe
 * (the preview page) beside it, updated live by postMessage.
 *
 * Coordinates are [lon, lat] in the map image's frame; see model.ts. Every edit goes through the
 * History command stack (undo/redo), and a drag is one step. Saving is one commit of
 * content/regions/<id>.json, refused if the file changed on GitHub since it was opened.
 */
import {
  MAX_VERTICES,
  areaPercent,
  checkGeometry,
  closeRing,
  douglasPeucker,
  geometryBounds,
  globeToImage,
  imageToGlobe,
  mapGeometry,
  polygonsOf,
  round,
  simplifyRing,
  type Position,
  type RegionGeometry,
  type Ring,
} from "../../shared/geo.ts";
import { findClashes, findClashesBetween, prepare, type Prepared } from "../../shared/clash.ts";
import { paintSpec, traceGeometry, traceRing } from "../../shared/raster.ts";
import { capClash, clashPolygon, paintSpecOf, partColours, type Clashes } from "../../shared/region-paint.ts";
import {
  DEFAULT_FILL_OPACITY,
  LEGEND_LABEL_MAX,
  LEGEND_MAX,
  LEGEND_TITLE_MAX,
  OWN_COLOUR,
  REGION_COLOR,
  REGION_ID,
  flatFit,
  flatMinK,
  checkParts,
  normalizePartContested,
  normalizePartLabels,
  normalizePartLegend,
  PART_LABEL_MAX,
  slugify,
  uniqueId,
  type RegionData,
  type RegionFeature,
} from "../../shared/region.ts";
import { clampPadding } from "../../shared/params.ts";
import { TEXTURE_WIDTHS, type MapMeta, type SlotsFile, type TextureWidth } from "../../shared/types.ts";
import { deviceLimit, nextTier } from "../../shared/tiers.ts";
import { h } from "../dom.ts";
import type { GitHub } from "../github.ts";
import { loadMapImage } from "../images.ts";
import { SITE } from "../dom.ts";
import { TILE_BUDGET, TILE_LEVELS, TileCache, levelFor, tileRect, tilesAt, tileUrl, type TileLevel } from "../../shared/tiles.ts";
import { alertBox, confirmBox, modal, openEmbedDialog, previewUrl, sendRegion } from "../region-dialogs.ts";
import { regionPath, serialize, stamp } from "../regions.ts";
import {
  History,
  addPart,
  cutParts,
  splitParts,
  countVertices,
  deleteVertices,
  insertVertex,
  moveLegendEntry,
  partAnchor,
  nextLegendColour,
  partAt,
  partsAt,
  partsFromGeometry,
  remapContested,
  removeLegendEntry,
  setContested,
  zonesOf,
  ringProblem,
  simplifyParts,
  smoothParts,
  toGeometry,
  toStyledGeometry,
  translate,
  vkey,
  type CutResult,
  type EditorState,
  type Parts,
  type RingProblem,
  type VRef,
} from "./model.ts";

export interface EditorOptions {
  gh: GitHub;
  maps: MapMeta[];
  slots: SlotsFile;
  /** Region to edit (or the copy to start from when duplicating). */
  feature?: RegionFeature;
  /** Slot for a new region. */
  slot?: string;
  /** Blob SHA of the file when it was opened; null for a new region. */
  sha: string | null;
  isNew: boolean;
  /** Other regions (the ones on the same slot are drawn as grey outlines and are snap targets). */
  neighbours: RegionFeature[];
  takenIds: Set<string>;
  afterCommit: (sha: string) => Promise<void>;
}

type Tool = "select" | "polygon" | "freehand";
/** What the polygon and freehand tools draw: a part, a shape to cut away, a split line or a contested zone. */
type DrawTarget = "part" | "cut" | "split" | "contested";

const HANDLE = 5;
const HIT = 8;
const SNAP_PX = 8;

/** Git's blob SHA-1 of a text file, to know the file's SHA after our own commit without asking GitHub. */
async function gitBlobSha(text: string): Promise<string> {
  const body = new TextEncoder().encode(text);
  const head = new TextEncoder().encode(`blob ${body.length}\0`);
  const all = new Uint8Array(head.length + body.length);
  all.set(head);
  all.set(body, head.length);
  const d = new Uint8Array(await crypto.subtle.digest("SHA-1", all));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const expandHex = (c: string) => (/^#[0-9a-f]{3}$/i.test(c) ? `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}` : c).toLowerCase();

class Conflict extends Error {}

/** Editor state for a saved region (or the empty state for a new one). */
function stateOf(f: RegionFeature | undefined, fallbackColour = "#c0392b"): EditorState {
  const fp = f?.properties;
  const legend = (fp?.legend ?? [])
    .slice(0, LEGEND_MAX)
    .map((e) => ({ label: String(e.label ?? "").slice(0, LEGEND_LABEL_MAX), color: REGION_COLOR.test(e.color) ? expandHex(e.color) : "#7f8c8d" }));
  const parts = f ? partsFromGeometry(f.geometry) : [];
  // Older regions have one name instead of part labels: it becomes the first part's label.
  const legacy = !fp?.partLabels && fp?.name && (fp.label ?? true) ? [fp.name] : undefined;
  return {
    parts,
    styles: normalizePartLegend(fp?.partLegend, parts.length, legend.length),
    labels: normalizePartLabels(fp?.partLabels ?? legacy, parts.length),
    contested: normalizePartContested(fp?.partContested, parts.length),
    props: {
      color: fp && REGION_COLOR.test(fp.color) ? expandHex(fp.color) : fallbackColour,
      fillOpacity: fp?.fillOpacity ?? DEFAULT_FILL_OPACITY,
      label: fp?.label ?? true,
      description: fp?.description ?? "",
      legendTitle: (fp?.legendTitle ?? "").slice(0, LEGEND_TITLE_MAX),
      legend,
    },
  };
}

export const SHORTCUTS: [string, string][] = [
  ["V / P / F", "Select, polygon and freehand tools"],
  ["Click (polygon)", "Add a point; double-click, Enter or click the first point to close (a split line: double-click or Enter)"],
  ["Backspace (drawing)", "Remove the last point"],
  ["Esc", "Cancel the outline being drawn, or clear the selection"],
  ["Drag a vertex", "Move it; hold Shift to snap to a neighbouring region's vertex"],
  ["Drag a midpoint", "Insert a vertex there"],
  ["Alt+click / right-click", "Delete a vertex"],
  ["Shift+click, box drag", "Select several vertices"],
  ["Delete / Backspace", "Delete the selected vertices"],
  ["Click inside a part", "Select that part (or click its badge or its row in the Parts list)"],
  ["Alt+click inside", "Select the next part under the pointer, where parts overlap"],
  ["Drag inside a part", "Move that part; Ctrl+drag (Cmd on macOS) moves the whole region"],
  ["Arrow keys", "Nudge the selected vertices, else the selected part, else the whole region, 1 px; Shift for 10 px"],
  ["Ctrl+Z", "Undo"],
  ["Ctrl+Shift+Z / Ctrl+Y", "Redo"],
  ["Wheel / pinch", "Zoom around the cursor"],
  ["Space+drag / middle drag", "Pan (the map wraps round)"],
  ["G", "Toggle the grid"],
  ["?", "This list"],
];

export function openEditor(o: EditorOptions): void {
  const slotName = o.feature?.properties.slot ?? o.slot!;
  const slot = o.slots.slots[slotName];
  if (!slot) return alertBox("Slot missing", `The slot "${slotName}" doesn't exist any more, so this region can't be edited.`);
  const map = o.maps.find((m) => m.id === slot.map);
  const aspect = map?.aspect ?? 2;
  const ky = 2 / aspect;
  const pad = clampPadding(slot.north ?? 0, slot.south ?? 0);
  const frame = { north: pad.north, south: pad.south, shift: slot.shift ?? 0 };
  const neighbours = o.neighbours.filter((n) => n.properties.slot === slotName);
  const snapPts: Position[] = [];
  for (const n of neighbours) for (const poly of polygonsOf(n.geometry)) for (const r of poly) for (const p of r) snapPts.push(p);

  const hist = new History(stateOf(o.feature));
  let id = o.feature?.id ?? uniqueId("region", o.takenIds);
  let sha = o.sha;
  let isNew = o.isNew;
  let saved = isNew ? "" : JSON.stringify(hist.state);
  const dirty = () => JSON.stringify(hist.state) !== saved;

  /* ── DOM ── */
  const canvas = h("canvas", { className: "ed-canvas", tabIndex: 0, ariaLabel: "Flat map: draw and edit the region here" });
  const g = canvas.getContext("2d")!;
  const status = h("div", { className: "ed-status", ariaLive: "off" });
  const msg = h("p", { className: "ed-msg", role: "status", ariaLive: "polite" });
  const frameEl = h("iframe", { className: "ed-globe", title: "Globe preview of the region" });
  const ctxMenu = h("div", { className: "ed-menu", hidden: true, role: "menu" });
  const tip = h("div", { className: "ed-tip", hidden: true });

  const toolBtn = (t: Tool, text: string, key: string, more = "") =>
    h("button", { type: "button", className: "ghost tool", textContent: text, title: `${text} (${key})${more}`, dataset: { tool: t }, onclick: () => setTool(t) });
  const btn = (text: string, title: string, onclick: () => void, data = "") =>
    h("button", { type: "button", className: "ghost", textContent: text, title, onclick, dataset: data ? { act: data } : {} });
  const undoBtn = btn("Undo", "Undo (Ctrl+Z)", () => undo(), "undo");
  const redoBtn = btn("Redo", "Redo (Ctrl+Shift+Z or Ctrl+Y)", () => redo(), "redo");
  const gridBtn = btn("Grid", "Show the globe's 15° grid (G)", () => toggleGrid(), "grid");
  const simplifyBtn = btn("Simplify…", "Fewer vertices, same shape", () => toggleSimplify(), "simplify");
  const smoothBtn = btn("Smooth", "Round the corners (one Chaikin pass; doubles the vertices)", () => smooth(), "smooth");

  const idIn = h("input", { type: "text", maxLength: 64, spellcheck: false, value: id, name: "id", pattern: "[a-z0-9][a-z0-9\\-]{0,63}" });
  const colorIn = h("input", { type: "color", value: hist.state.props.color, name: "color", ariaLabel: "Default colour" });
  const opacityIn = h("input", { type: "range", min: "0", max: "1", step: "0.05", value: String(hist.state.props.fillOpacity), name: "opacity" });
  const opacityOut = h("output", {});
  const labelIn = h("input", { type: "checkbox", checked: hist.state.props.label, name: "label" });
  const descIn = h("textarea", { maxLength: 500, rows: 3, value: hist.state.props.description, name: "description" });
  const stats = h("p", { className: "muted small ed-stats" });
  const keyTitleIn = h("input", { type: "text", maxLength: LEGEND_TITLE_MAX, placeholder: "Legend", value: hist.state.props.legendTitle, name: "legend-title" });
  const keyRows = h("div", { className: "ed-key" });
  const addKeyBtn = btn("Add colour", "Add a colour with a label to the legend", () => addLegendEntry(), "key-add");
  const partRows = h("div", { className: "ed-parts" });
  const zonesFollowIn = h("input", { type: "checkbox", checked: false, name: "zones-follow" });
  const clashList = h("ul", { className: "ed-clashes small", ariaLive: "polite" });
  const saveBtn = h("button", { type: "button", textContent: "Save", className: "ed-save" });
  const closeBtn = h("button", { type: "button", className: "ghost", textContent: "Close" });

  const simpRange = h("input", { type: "range", min: "0", max: "100", value: "30", ariaLabel: "Simplify tolerance" });
  const simpInfo = h("span", { className: "small" });
  const simpPanel = h(
    "div",
    { className: "ed-simplify", hidden: true },
    h("label", {}, "Tolerance", simpRange),
    simpInfo,
    h("div", { className: "row" }, btn("Apply", "Apply the simplification (one undo step)", () => applySimplify(), "simplify-apply"), btn("Cancel", "", () => toggleSimplify(false))),
  );

  const title = h("h2", {});
  const dlg = h(
    "dialog",
    { className: "editor", ariaLabel: "Region editor" },
    h("div", { className: "pv-head" }, title, h("div", { className: "row" }, saveBtn, closeBtn)),
    h(
      "div",
      { className: "ed-toolbar", role: "toolbar" },
      toolBtn("select", "Select", "V", ": click a part to select it, drag inside it to move it, Ctrl+drag to move the whole region, Alt+click for the next part where parts overlap"),
      toolBtn("polygon", "Polygon", "P"),
      toolBtn("freehand", "Freehand", "F"),
      h("span", { className: "sep" }),
      btn("Add part", "Draw another polygon (an island or exclave)", () => startDraw("part"), "add-part"),
      btn("Cut", "Draw a shape to cut away: inside a part it makes a hole, across a part's edge it bites it, right across it splits it into separate parts", () => startDraw("cut"), "cut-hole"),
      btn("Split", "Draw a line right across a part to split it into separate parts", () => startDraw("split"), "split"),
      btn("Add contested zone", "Draw land a part claims but doesn't firmly hold (dashed in the embed)", () => addContested(), "add-contested"),
      h("span", { className: "sep" }),
      undoBtn,
      redoBtn,
      h("span", { className: "sep" }),
      simplifyBtn,
      smoothBtn,
      h("span", { className: "sep" }),
      gridBtn,
      btn("?", "Keyboard shortcuts", () => showHelp(), "help"),
    ),
    h(
      "div",
      { className: "ed-body" },
      h("div", { className: "ed-canvas-wrap" }, canvas, ctxMenu, tip, simpPanel, status),
      h(
        "div",
        { className: "ed-side" },
        frameEl,
        h("div", { className: "row" }, btn("Centre on region", "Turn the globe preview to face the region", () => sendPreview(true), "centre"), btn("Embed code…", "Copy the iframe code for this region", () => embed(), "embed")),
        msg,
        h("label", {}, "Id (permanent; embeds use it)", idIn),
        h("p", { className: "muted small", textContent: `Slot: ${slotName} · map: ${slot.map}` }),
        h("label", { className: "inline grow ed-fill" }, "Fill", opacityIn, opacityOut),
        h("label", { className: "check" }, labelIn, "Show part labels in embed"),
        h("label", {}, "Description (plain text)", descIn),
        h(
          "fieldset",
          { className: "ed-colours" },
          h("legend", { textContent: "Colours and legend" }),
          h("p", { className: "muted small", textContent: "Add colours with a label, then pick a colour for each part below. The embed shows them as a legend." }),
          h("label", {}, "Legend title", keyTitleIn),
          h(
            "div",
            { className: "ed-key-row ed-key-default" },
            colorIn,
            h("span", { textContent: "Default colour", title: "Parts without a colour of their own use this one. It isn't listed in the legend." }),
          ),
          keyRows,
          addKeyBtn,
          h("p", { className: "muted small", textContent: "Parts: a label (shown on that part in the embed) and a colour for each. The numbers match the badges on the map." }),
          partRows,
          h("label", { className: "check", title: "Off: moving a part leaves its contested zones where they are" }, zonesFollowIn, "Move contested zones with their part"),
        ),
        h(
          "fieldset",
          { className: "ed-overlaps" },
          h("legend", { textContent: "Overlaps" }),
          h("p", { className: "muted small", textContent: "Where parts overlap each other or another region on this slot, the embed draws the border dashed." }),
          clashList,
        ),
        stats,
      ),
    ),
  );
  document.body.append(dlg);

  /* ── View ── */
  let view = { cx: 0, cy: 0, k: 1 };
  let touched = false;
  // The canvas's CSS size, cached: reading clientWidth in sx()/sy() forced a layout per vertex
  // (seconds per frame at 2,000 vertices). Refreshed by the ResizeObserver below and when opened.
  let cssSize = { w: 1, h: 1 };
  const measure = () => (cssSize = { w: Math.max(1, canvas.clientWidth), h: Math.max(1, canvas.clientHeight) });
  const size = () => cssSize;
  const sx = (lon: number) => (lon - view.cx) * view.k + size().w / 2;
  const sy = (lat: number) => (view.cy - lat) * view.k * ky + size().h / 2;
  const wx = (x: number) => view.cx + (x - size().w / 2) / view.k;
  const wy = (y: number) => view.cy - (y - size().h / 2) / (view.k * ky);
  const nearest = (lon: number, near: number) => lon + 360 * Math.round((near - lon) / 360);
  const kLimits = () => {
    const { w, h: hh } = size();
    return [flatMinK(aspect, w, hh) * 0.5, 400] as const;
  };
  function fitView(): void {
    const { w, h: hh } = size();
    const b: [number, number, number, number] = hist.state.parts.length ? geometryBounds(toGeometry(hist.state.parts)) : [-180, -90, 180, 90];
    const v = flatFit(b, aspect, w, hh);
    view = { cx: v.cx, cy: v.cy, k: v.k };
  }
  function zoomAt(f: number, x: number, y: number): void {
    const lon = wx(x);
    const lat = wy(y);
    const [lo, hi] = kLimits();
    view.k = Math.min(hi, Math.max(lo, view.k * f));
    view.cx = lon - (x - size().w / 2) / view.k;
    view.cy = lat + (y - size().h / 2) / (view.k * ky);
    view.cy = Math.max(-90, Math.min(90, view.cy));
    touched = true;
    maybeUpgrade();
    draw();
  }

  /* ── Map image: 2048, then 4096 when zoomed far in, then 8192 when zoomed in further (then tiles) ── */
  let img: HTMLImageElement | null = null;
  let imgW = 0;
  let upgrading = false;
  if (map) void loadMapImage(map, 2048).then((i) => ((img = i), (imgW = 2048), draw()), () => setMsg("The map image isn't deployed yet; you can still draw.", "error"));
  function maybeUpgrade(): void {
    if (!map || upgrading) return;
    const need = 360 * view.k * (window.devicePixelRatio || 1);
    const want = need >= 6000 ? 8192 : need >= 3000 ? 4096 : 2048;
    const pick = nextTier(TEXTURE_WIDTHS.filter((w) => map.sizes[`${w}`]).map((w) => ({ w, url: "" })), imgW, want, deviceLimit(false));
    if (!pick) return;
    const w = pick.w as TextureWidth;
    upgrading = true;
    void loadMapImage(map, w).then(
      (i) => {
        img = i;
        imgW = w;
        upgrading = false;
        draw();
        maybeUpgrade(); // 8192 after 4096, if still zoomed in that far
      },
      () => {}, // keep the current image and stop upgrading
    );
  }

  /* ── Close-up tiles past 8192 (16384, then 32768), only those under the view, as in the flat embed ── */
  const tileLevels: TileLevel[] = map
    ? TILE_LEVELS.flatMap((w) => {
        const l = map.tiles?.[`${w}`];
        return l ? [{ ...l, url: new URL(l.url, SITE).href }] : [];
      })
    : [];
  type EdTile = { img: HTMLImageElement; level: number; c: number; r: number };
  const tileCache = new TileCache<EdTile>(TILE_BUDGET, () => {});
  const tileKey = (l: number, c: number, r: number) => `${l}:${c}:${r}`;
  let tileBusy = false;
  let tilesOff = false;
  let tileTop = -1;
  function drawTiles(offs: number[]): void {
    if (tileTop < 0) return;
    const { w, h: hh } = size();
    const span = 360 * view.k;
    const height = 180 * view.k * ky;
    const top = sy(90);
    const shown = [...tileCache.entries()].map(([, t]) => t).filter((t) => t.level <= tileTop).sort((a, b) => a.level - b.level);
    for (const t of shown) {
      const [u0, v0, u1, v1] = tileRect(tileLevels[t.level], t.c, t.r);
      const y = top + v0 * height;
      const th = (v1 - v0) * height;
      if (y > hh || y + th < 0) continue;
      for (const off of offs) {
        const x = sx(-180 + off) + u0 * span;
        const tw = (u1 - u0) * span;
        if (x > w || x + tw < 0) continue;
        g.drawImage(t.img, x, y, tw, th);
      }
    }
  }
  function maybeTiles(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // Once any tile level is wanted, go all the way to the finest one (16384 shows while 32768 loads),
    // whatever the screen: tracing borders wants the sharpest map, not the one that just fills the pixels.
    const top = tileLevels.length && imgW >= 8192 && levelFor(tileLevels, 360 * view.k * dpr) ? tileLevels[tileLevels.length - 1] : undefined;
    tileTop = top ? tileLevels.indexOf(top) : -1;
    if (!top || tileBusy || tilesOff) return;
    const { w, h: hh } = size();
    const steps = [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6, 1];
    const pts: [number, number][] = [];
    for (const [fx, fy] of [[0.5, 0.5], ...steps.flatMap((a) => steps.map((b) => [a, b]))]) {
      const lat = wy(fy * hh);
      if (lat > 90 || lat < -90) continue;
      pts.push([(wx(fx * w) + 180) / 360, (90 - lat) / 180]);
    }
    // Lower levels first: the 16384 tiles show while the 32768 ones load.
    const need: [number, number, number][] = [];
    for (let li = 0; li <= tileTop; li++) for (const [c, r] of tilesAt(tileLevels[li], pts)) need.push([li, c, r]);
    const next = need.find(([l, c, r]) => !tileCache.has(tileKey(l, c, r)));
    if (!next) {
      dlg.dataset.tiles = String(top.w);
      return;
    }
    const keep = new Set(need.map(([l, c, r]) => tileKey(l, c, r)));
    const [l, c, r] = next;
    tileBusy = true;
    // Not through images.ts's cache, which keeps everything: only TILE_BUDGET tiles stay in memory.
    const im = new Image();
    im.src = tileUrl(tileLevels[l], c, r);
    void im.decode().then(
      () => {
        tileCache.set(tileKey(l, c, r), { img: im, level: l, c, r }, keep);
        tileBusy = false;
        draw(); // the render calls maybeTiles again for the next one
      },
      () => {
        tileBusy = false;
        tilesOff = true; // a broken tile: keep what's there, load no more
      },
    );
  }

  /* ── State ── */
  let tool: Tool = "select";
  let target: DrawTarget = "part";
  /** The part a contested zone being drawn will extend. */
  let zoneParent = -1;
  /** The selected part (-1 for none): click inside it, its badge or its row. Separate from the vertex selection. */
  let selPart = -1;
  /** Alt+click cycling through the parts under one spot. */
  let cycle: { x: number; y: number; list: number[]; i: number } | null = null;
  let pickHint = "";
  let drawing: Position[] | null = null;
  let cursor: Position | null = null;
  let selection = new Map<string, VRef>();
  let problem: RingProblem | null = null;
  let gridOn = false;
  let simplifyPreview: Parts | null = null;
  let spaceHeld = false;
  type Drag =
    | { kind: "vertex"; base: Parts; refs: VRef[]; grab: VRef; x0: number; y0: number; w0: Position; moved: boolean; label: string; toggle: boolean }
    | { kind: "shape"; base: Parts; part: number[] | null; w0: Position; moved: boolean }
    | { kind: "pan"; x0: number; y0: number; v0: typeof view }
    | { kind: "box"; x0: number; y0: number; x1: number; y1: number; add: boolean }
    | { kind: "free"; pts: Position[] }
    | null;
  let drag: Drag = null;
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch: { d: number; mx: number; my: number } | null = null;

  const parts = () => hist.state.parts;
  /** Geometry edits. `styles`, `labels` and `contested` must be given whenever parts are added or removed. */
  const setParts = (label: string, next: Parts, merge?: string, styles = hist.state.styles, labels = hist.state.labels, contested = hist.state.contested) =>
    hist.apply(
      label,
      {
        ...hist.state,
        parts: next,
        styles: normalizePartLegend(styles, next.length, hist.state.props.legend.length),
        labels: normalizePartLabels(labels, next.length),
        contested: normalizePartContested(contested, next.length),
      },
      merge,
    );
  /** Part under the pointer, on the map or in the side panel's Parts list, or -1. */
  let hoverPart = -1;
  function setHoverPart(p: number): void {
    if (p === hoverPart) return;
    hoverPart = p;
    partRows.querySelectorAll<HTMLElement>(".ed-part-row").forEach((row) => row.classList.toggle("hot", Number(row.dataset.row) === p));
    draw();
  }
  function selectPart(p: number, hint = ""): void {
    selPart = p >= 0 && p < parts().length ? p : -1;
    pickHint = selPart >= 0 ? hint : "";
    partRows.querySelectorAll<HTMLElement>(".ed-part-row").forEach((row) => {
      const on = Number(row.dataset.row) === selPart;
      row.classList.toggle("sel", on);
      row.querySelector<HTMLButtonElement>("button[data-act=part-select]")?.setAttribute("aria-pressed", String(on));
    });
    draw();
  }
  /** The parts a move of part p takes along: p, plus its contested zones when that's switched on. */
  const moveSet = (p: number): number[] => (zonesFollowIn.checked ? [p, ...zonesOf(hist.state.contested, p)] : [p]);

  function setMsg(text: string, kind: "muted" | "error" | "ok" = "muted"): void {
    msg.textContent = text;
    msg.className = `ed-msg ${kind}`;
  }

  /* ── Rendering ── */
  let raf = 0;
  function draw(): void {
    if (!raf) raf = requestAnimationFrame(render);
  }
  function offsets(): number[] {
    const { w } = size();
    const span = 360 * view.k;
    const first = Math.floor((0 - sx(-180)) / span) - 1;
    const last = Math.floor((w - sx(-180)) / span) + 1;
    const out: number[] = [];
    for (let n = first; n <= last; n++) out.push(n * 360);
    return out;
  }
  const asGeometry = (p: Parts): RegionGeometry => ({ type: "MultiPolygon", coordinates: p.map((rings) => rings.map(closeRing)) });

  /* ── Overlaps (clashes), with each other and with the neighbours ── */
  const nbPolys: Ring[][] = [];
  const nbOwner: { f: RegionFeature; p: number }[] = [];
  for (const n of neighbours) polygonsOf(n.geometry).forEach((poly, p) => (nbPolys.push(poly), nbOwner.push({ f: n, p })));
  let nbPreps: Prepared[] | null = null;
  const nbPrepared = () => (nbPreps ??= nbPolys.map((poly) => prepare(poly)));
  type ClashState = { version: number; preps: Prepared[]; clashes: Clashes; spec: ReturnType<typeof paintSpecOf> };
  let clashCache: ClashState | null = null;
  /** During a drag: the clashes where it began, and which parts the drag moves. */
  let dragBase: { cs: ClashState; moving: Set<number> } | null = null;
  /**
   * Clashes and the paint spec for the current parts, recomputed only when they change (not on pan or
   * zoom). While a drag moves some parts, only the pairs involving those parts are tested again.
   */
  function clashState(): ClashState {
    if (clashCache && clashCache.version === hist.version) return clashCache;
    const ps = parts();
    let preps: Prepared[];
    let clashes: Clashes;
    const base = dragBase && hist.dragging && dragBase.cs.preps.length === ps.length ? dragBase : null;
    if (base && base.moving.size < ps.length) {
      const mv = base.moving;
      preps = ps.map((r, i) => (mv.has(i) ? prepare(r) : base.cs.preps[i]));
      clashes = {
        internal: [...base.cs.clashes.internal.filter(([i, j]) => !mv.has(i) && !mv.has(j)), ...findClashes(preps, mv)],
        external: [...base.cs.clashes.external.filter(([i]) => !mv.has(i)), ...findClashesBetween(preps, nbPrepared(), mv)],
      };
    } else {
      preps = ps.map((r) => prepare(r));
      clashes = { internal: findClashes(preps), external: findClashesBetween(preps, nbPrepared()) };
    }
    const st = hist.state;
    const spec = paintSpecOf({ color: st.props.color, legend: st.props.legend, parts: st.styles, contested: st.contested, geometry: asGeometry(ps) }, clashes, nbPolys);
    clashCache = { version: hist.version, preps, clashes, spec };
    return clashCache;
  }
  /** Call when a drag starts: later clashState() calls only re-test the moving parts. */
  function beginClashDrag(moving: Iterable<number>): void {
    dragBase = { cs: clashState(), moving: new Set(moving) };
  }
  const neighbourName = (e: number): string => {
    const o = nbOwner[e];
    if (!o) return "another region";
    const pl = o.f.properties.partLabels?.[o.p];
    return (typeof pl === "string" && pl.trim()) || o.f.properties.name?.trim() || o.f.id;
  };
  const partName = (p: number): string => {
    const t = hist.state.labels[p]?.trim();
    return t ? `part ${p + 1} (${t})` : `part ${p + 1}`;
  };
  let clashListVersion = -1;
  /** The side panel's list of overlaps (plain text only: labels and names are untrusted). */
  function syncClashList(cs: ClashState): void {
    if (clashListVersion === cs.version) return;
    clashListVersion = cs.version;
    const c = hist.state.contested;
    const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
    const rows: HTMLElement[] = [];
    for (const [i, j] of cs.clashes.internal) {
      // A zone overlapping the part it extends is what zones are for; not worth listing.
      if (c[i] === j || c[j] === i) continue;
      rows.push(h("li", { dataset: { clash: `${i}:${j}` } }, `${cap(partName(i))} overlaps ${partName(j)}`));
    }
    for (const [i, e] of cs.clashes.external) rows.push(h("li", { dataset: { clash: `${i}:n${e}` } }, `${cap(partName(i))} overlaps `, h("em", { textContent: neighbourName(e) })));
    if (!rows.length) rows.push(h("li", { className: "muted", textContent: "No overlaps." }));
    clashList.replaceChildren(...rows);
  }

  function render(): void {
    raf = 0;
    const { w, h: hh } = size();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hh * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(hh * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = "#14120f";
    g.fillRect(0, 0, w, hh);
    const offs = offsets();
    if (img) {
      g.imageSmoothingQuality = "high";
      for (const off of offs) g.drawImage(img, sx(-180 + off), sy(90), 360 * view.k, 180 * view.k * ky);
      maybeTiles();
      drawTiles(offs);
    }
    if (gridOn) drawGrid(offs);
    // Neighbours on the same slot: thin grey outlines to trace against.
    if (neighbours.length) {
      g.save();
      g.lineWidth = 1;
      g.strokeStyle = "rgba(220,220,220,.75)";
      g.setLineDash([]);
      g.beginPath();
      for (const n of neighbours) traceGeometry(g, n.geometry, sx, sy, offs);
      g.stroke();
      g.restore();
    }
    const p = simplifyPreview ?? parts();
    const s = hist.state.props;
    const cs = clashState();
    syncClashList(cs);
    if (p.length) {
      paintSpec(g, cs.spec, sx, sy, offs, { fillOpacity: simplifyPreview ? s.fillOpacity * 0.4 : s.fillOpacity, lineWidth: 2 }, { w, h: hh });
      const sp = parts()[selPart];
      if (sp) {
        g.save();
        g.lineWidth = 3;
        g.lineJoin = "round";
        g.strokeStyle = "#ffd400";
        g.beginPath();
        for (const ring of sp) traceRing(g, ring, sx, sy, offs);
        g.stroke();
        g.restore();
      }
      const hp = parts()[hoverPart];
      if (hp) {
        g.save();
        g.setLineDash([6, 4]);
        g.lineWidth = 2.5;
        g.strokeStyle = "#ffffff";
        g.beginPath();
        for (const ring of hp) traceRing(g, ring, sx, sy, offs);
        g.stroke();
        g.restore();
      }
      if (simplifyPreview) {
        g.save();
        g.setLineDash([5, 4]);
        g.lineWidth = 1.5;
        g.strokeStyle = "#ffffff";
        g.beginPath();
        traceGeometry(g, asGeometry(simplifyPreview), sx, sy, offs);
        g.stroke();
        g.restore();
      }
    }
    if (problem) {
      const ring = parts()[problem.p]?.[problem.r];
      if (ring) {
        g.save();
        g.strokeStyle = "#ff2d2d";
        g.lineWidth = 3;
        g.beginPath();
        for (const e of problem.edges) {
          const a = ring[e];
          const b = ring[(e + 1) % ring.length];
          for (const off of offs) {
            g.moveTo(sx(a[0] + off), sy(a[1]));
            g.lineTo(sx(b[0] + off), sy(b[1]));
          }
        }
        if (!problem.edges.length) traceRing(g, ring, sx, sy, offs);
        g.stroke();
        g.restore();
      }
    }
    if (tool === "select" && !simplifyPreview) drawHandles(offs);
    if (parts().length > 1 && !simplifyPreview) drawBadges(offs);
    else badgeAt = [];
    if (drawing || drag?.kind === "free") {
      const pts = drawing ?? (drag as { pts: Position[] }).pts;
      g.save();
      g.strokeStyle = s.color;
      g.lineWidth = 2;
      g.beginPath();
      pts.forEach((pt, i) => (i ? g.lineTo(sx(pt[0]), sy(pt[1])) : g.moveTo(sx(pt[0]), sy(pt[1]))));
      if (drawing && cursor) g.lineTo(sx(cursor[0]), sy(cursor[1]));
      g.stroke();
      g.fillStyle = "#fff";
      for (const [i, pt] of pts.entries()) {
        g.beginPath();
        g.arc(sx(pt[0]), sy(pt[1]), i === 0 ? 6 : 3.5, 0, Math.PI * 2);
        g.fill();
      }
      g.restore();
    }
    if (drag?.kind === "box") {
      g.save();
      g.strokeStyle = "#fff";
      g.setLineDash([4, 3]);
      g.strokeRect(Math.min(drag.x0, drag.x1), Math.min(drag.y0, drag.y1), Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
      g.restore();
    }
    updateStatus();
  }

  /** The colour part p is drawn in (a contested zone takes its parent's unless it has its own). */
  const partColour = (p: number): string => {
    const st = hist.state;
    return partColours({ color: st.props.color, legend: st.props.legend, parts: st.styles, contested: st.contested }, st.parts.length)[p] ?? st.props.color;
  };
  // Badge positions, recomputed only when the parts change (not on every pan or hover).
  let anchors: { version: number; at: (Position | null)[] } = { version: -1, at: [] };
  /** Badge positions as last drawn (none when badges aren't shown), for clicking them. */
  let badgeAt: (Position | null)[] = [];
  function hitBadge(x: number, y: number): number {
    if (parts().length < 2 || simplifyPreview) return -1;
    const cl = wx(x);
    for (let p = badgeAt.length - 1; p >= 0; p--) {
      const a = badgeAt[p];
      if (a && Math.hypot(sx(nearest(a[0], cl)) - x, sy(a[1]) - y) <= 12) return p;
    }
    return -1;
  }
  /** Numbered badges ("1", "2", …) on each part, matching the Parts list in the side panel. */
  function drawBadges(offs: number[]): void {
    if (anchors.version !== hist.version) anchors = { version: hist.version, at: parts().map((rings) => partAnchor(rings)) };
    badgeAt = anchors.at;
    const { w, h: hh } = size();
    g.save();
    g.textAlign = "center";
    g.textBaseline = "middle";
    anchors.at.forEach((a, p) => {
      if (!a) return;
      const hot = p === hoverPart || p === selPart;
      const r = hot ? 14 : 11;
      const fill = partColour(p);
      const zone = (hist.state.contested[p] ?? -1) >= 0;
      g.font = `600 ${hot ? 13 : 11}px system-ui, sans-serif`;
      for (const off of offs) {
        const x = sx(a[0] + off);
        const y = sy(a[1]);
        if (x < -r || x > w + r || y < -r || y > hh + r) continue;
        // A dark chip with a ring in the part's colour reads on any fill and any map.
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        // The selected part's badge is filled with its colour.
        g.fillStyle = p === selPart ? fill : "rgba(20,18,14,.85)";
        g.fill();
        g.lineWidth = hot ? 3.5 : 2.5;
        g.strokeStyle = hot ? "#fff" : fill;
        // Contested zones: a dashed ring.
        g.setLineDash(zone ? [3, 2.5] : []);
        g.stroke();
        g.setLineDash([]);
        g.fillStyle = "#fff";
        if (p === selPart) {
          g.lineWidth = 3;
          g.strokeStyle = "rgba(0,0,0,.7)";
          g.strokeText(String(p + 1), x, y + 0.5);
        }
        g.fillText(String(p + 1), x, y + 0.5);
      }
    });
    g.restore();
  }

  function drawHandles(offs: number[]): void {
    const { w, h: hh } = size();
    const vis = (x: number, y: number) => x > -10 && x < w + 10 && y > -10 && y < hh + 10;
    g.save();
    parts().forEach((rings, p) =>
      rings.forEach((ring, r) => {
        const n = ring.length;
        // Midpoints first (under the vertices).
        g.fillStyle = "rgba(255,255,255,.55)";
        g.strokeStyle = "rgba(0,0,0,.6)";
        g.lineWidth = 1;
        for (let i = 0; i < n; i++) {
          const a = ring[i];
          const b = ring[(i + 1) % n];
          const mx = (a[0] + b[0]) / 2;
          const my = (a[1] + b[1]) / 2;
          for (const off of offs) {
            const x = sx(mx + off);
            const y = sy(my);
            if (!vis(x, y)) continue;
            g.beginPath();
            g.arc(x, y, 3, 0, Math.PI * 2);
            g.fill();
            g.stroke();
          }
        }
        for (let i = 0; i < n; i++) {
          const sel = selection.has(vkey({ p, r, i }));
          g.fillStyle = sel ? "#ffd400" : "#ffffff";
          g.strokeStyle = "#000";
          for (const off of offs) {
            const x = sx(ring[i][0] + off);
            const y = sy(ring[i][1]);
            if (!vis(x, y)) continue;
            g.fillRect(x - HANDLE / 2 - (sel ? 1 : 0), y - HANDLE / 2 - (sel ? 1 : 0), HANDLE + (sel ? 2 : 0), HANDLE + (sel ? 2 : 0));
            g.strokeRect(x - HANDLE / 2 - (sel ? 1 : 0), y - HANDLE / 2 - (sel ? 1 : 0), HANDLE + (sel ? 2 : 0), HANDLE + (sel ? 2 : 0));
          }
        }
      }),
    );
    g.restore();
  }

  function drawGrid(offs: number[]): void {
    const { w } = size();
    g.save();
    g.lineWidth = 1;
    for (let lat = -75; lat <= 75; lat += 15) {
      const il = globeToImage([0, lat], frame)[1];
      if (il < -90 || il > 90) continue;
      g.strokeStyle = lat === 0 ? "rgba(232,196,74,.7)" : "rgba(201,169,78,.3)";
      g.beginPath();
      g.moveTo(0, sy(il));
      g.lineTo(w, sy(il));
      g.stroke();
    }
    for (let lon = -180; lon < 180; lon += 15) {
      const x0 = globeToImage([lon, 0], frame)[0];
      g.strokeStyle = lon === 0 ? "rgba(232,80,80,.65)" : "rgba(201,169,78,.3)";
      for (const off of offs) {
        g.beginPath();
        g.moveTo(sx(x0 + off), sy(90));
        g.lineTo(sx(x0 + off), sy(-90));
        g.stroke();
      }
    }
    g.restore();
  }

  let lastArea = -1;
  function updateStatus(): void {
    const n = countVertices(parts());
    const parts_ = parts().length;
    const what = target === "cut" ? "Cut" : target === "split" ? "Split" : target === "contested" ? `Contested zone of part ${zoneParent + 1}` : "";
    let line = `${tool === "select" ? "Select" : `${tool === "polygon" ? "Polygon" : "Freehand"}${what ? ` (${what})` : ""}`} · ${n} vertices`;
    if (tool === "select" && selPart >= 0) line += ` · ${pickHint || `Part ${selPart + 1} selected`}`;
    if (cursor) {
      const lon = ((((cursor[0] + 180) % 360) + 360) % 360) - 180;
      const gl = imageToGlobe([lon, cursor[1]], frame);
      line += ` · map lon ${round(lon, 3)}, lat ${round(cursor[1], 3)} (stored) · globe lon ${round(gl[0], 2)}, lat ${round(gl[1], 2)}`;
    }
    status.textContent = line;
    undoBtn.disabled = !hist.canUndo;
    redoBtn.disabled = !hist.canRedo;
    for (const b of dlg.querySelectorAll<HTMLButtonElement>("button.tool")) b.setAttribute("aria-pressed", String(b.dataset.tool === tool));
    gridBtn.setAttribute("aria-pressed", String(gridOn));
    // The spherical area is skipped mid-drag (it costs a few ms at 2,000 vertices) and refreshed on release.
    if (!hist.dragging || lastArea < 0) lastArea = parts_ ? areaPercent(mapGeometry(toGeometry(parts()), (p) => imageToGlobe(p, frame))) : 0;
    const area = lastArea;
    stats.textContent = `${n.toLocaleString()} vertices in ${parts_} part${parts_ === 1 ? "" : "s"} · about ${area < 0.01 ? area.toFixed(4) : area.toFixed(2)}% of the globe's surface`;
    stats.classList.toggle("error", n >= 4000);
    if (n >= 4000) stats.textContent += ` · close to the ${MAX_VERTICES.toLocaleString()}-vertex limit`;
  }

  /* ── Live globe preview ── */
  const previewId = () => (REGION_ID.test(id) ? id : "new-region");
  const regionNow = (): RegionData => ({
    id: previewId(),
    slot: slotName,
    name: "",
    color: hist.state.props.color,
    fillOpacity: hist.state.props.fillOpacity,
    label: hist.state.props.label,
    legendTitle: hist.state.props.legendTitle.slice(0, LEGEND_TITLE_MAX),
    legend: hist.state.props.legend.map((e) => ({ label: e.label.slice(0, LEGEND_LABEL_MAX), color: e.color })),
    ...(({ geometry, partLegend, partLabels, partContested }) => ({ geometry, parts: partLegend, labels: partLabels.map((t) => t.slice(0, PART_LABEL_MAX)), contested: partContested }))(
      toStyledGeometry(parts(), hist.state.styles, hist.state.labels, hist.state.contested),
    ),
    // What the build will add: the neighbours' polygons this region overlaps.
    clash: capClash([...new Set(clashState().clashes.external.map(([, e]) => e))].sort((a, b) => a - b).map((e) => clashPolygon(nbPolys[e]))),
  });
  let previewRaf = 0;
  let lastSent = -1;
  function sendPreview(centre = false, focus?: number): void {
    if (centre) return sendRegion(frameEl, regionNow(), true, focus);
    // At most one update per animation frame, even while dragging.
    if (previewRaf || lastSent === hist.version) return;
    previewRaf = requestAnimationFrame(() => {
      previewRaf = 0;
      lastSent = hist.version;
      sendRegion(frameEl, regionNow());
    });
  }
  frameEl.addEventListener("load", () => {
    lastSent = -1;
    sendRegion(frameEl, regionNow(), true);
  });
  frameEl.src = previewUrl(slot, { region: previewId(), lock: "0" });

  /* ── Side panel ↔ state ── */
  function syncPanel(): void {
    const s = hist.state.props;
    colorIn.value = s.color;
    opacityIn.value = String(s.fillOpacity);
    opacityOut.value = `${Math.round(s.fillOpacity * 100)}%`;
    labelIn.checked = s.label;
    if (document.activeElement !== descIn) descIn.value = s.description;
    if (document.activeElement !== keyTitleIn) keyTitleIn.value = s.legendTitle;
    syncColours();
    idIn.disabled = !isNew;
    title.textContent = `${isNew ? "New region" : "Edit region"}: ${id || "(no id yet)"}`;
  }
  const setProp = <K extends keyof EditorState["props"]>(k: K, v: EditorState["props"][K], label: string) =>
    hist.apply(label, { ...hist.state, props: { ...hist.state.props, [k]: v } }, `prop:${k}`);
  idIn.addEventListener("input", () => {
    id = idIn.value.trim();
    title.textContent = `New region: ${id || "(no id yet)"}`;
  });
  idIn.addEventListener("change", () => {
    id = slugify(idIn.value) || id;
    idIn.value = id;
    changed();
  });
  colorIn.addEventListener("input", () => (setProp("color", colorIn.value.toLowerCase(), "Default colour"), changed()));
  opacityIn.addEventListener("input", () => (setProp("fillOpacity", Number(opacityIn.value), "Fill opacity"), changed()));
  labelIn.addEventListener("change", () => (setProp("label", labelIn.checked, "Label"), changed()));
  descIn.addEventListener("input", () => (setProp("description", descIn.value, "Description"), changed()));
  keyTitleIn.addEventListener("input", () => (setProp("legendTitle", keyTitleIn.value.slice(0, LEGEND_TITLE_MAX), "Legend title"), changed()));

  /* ── Colours and legend ── */
  const entryName = (k: number) => (k === OWN_COLOUR ? "Default colour" : hist.state.props.legend[k]?.label.trim() || `Colour ${k + 1}`);
  function setLegend(label: string, legend: EditorState["props"]["legend"], merge?: string): void {
    hist.apply(label, { ...hist.state, props: { ...hist.state.props, legend } }, merge);
    changed();
  }
  function addLegendEntry(): void {
    const l = hist.state.props.legend;
    if (l.length >= LEGEND_MAX) return setMsg(`A legend can have at most ${LEGEND_MAX} colours.`, "error");
    setLegend("Add legend colour", [...l.map((e) => ({ ...e })), { label: "", color: nextLegendColour([hist.state.props.color, ...l.map((e) => e.color)]) }]);
    (keyRows.querySelectorAll<HTMLInputElement>("input[type=text]")[l.length] ?? null)?.focus();
  }
  function setPartStyle(p: number, k: number): void {
    const styles = [...hist.state.styles];
    styles[p] = k;
    hist.apply("Part colour", { ...hist.state, styles });
    changed();
  }
  function setPartContested(p: number, k: number): void {
    const next = setContested(hist.state, p, k);
    if (typeof next === "string") {
      setMsg(next, "error");
      colourSig = "";
      return changed();
    }
    hist.apply(k < 0 ? "Make normal part" : "Make contested zone", next);
    setMsg(k < 0 ? `Part ${p + 1} is a normal part again.` : `Part ${p + 1} is now a contested zone of part ${k + 1}.`, "ok");
    changed();
  }
  /** Pans the flat map to part p and turns the globe preview to it. */
  function centrePart(p: number): void {
    const rings = parts()[p];
    if (!rings) return;
    const { w, h: hh } = size();
    const v = flatFit(geometryBounds(toGeometry([rings])), aspect, w, hh);
    view = { cx: v.cx, cy: v.cy, k: v.k };
    touched = true;
    setTool("select");
    selectPart(p);
    // The preview's part indices are after storing, which drops degenerate parts; they match here.
    sendPreview(true, p);
    draw();
  }
  /** Rebuilds the legend and part rows only when their structure changes, so typing keeps focus. */
  let colourSig = "";
  function syncColours(): void {
    const s = hist.state;
    const sig = JSON.stringify([s.props.legend.length, s.parts.length, s.parts.map((r) => [r[0]?.length ?? 0, r.length]), s.contested]);
    if (sig !== colourSig) {
      colourSig = sig;
      keyRows.replaceChildren(
        ...s.props.legend.map((e, k) => {
          const c = h("input", { type: "color", value: e.color, ariaLabel: `Colour ${k + 1}`, dataset: { key: String(k) } });
          const t = h("input", { type: "text", maxLength: LEGEND_LABEL_MAX, placeholder: `Colour ${k + 1}`, value: e.label, ariaLabel: `Label for colour ${k + 1}`, dataset: { key: String(k) } });
          c.addEventListener("input", () => {
            const legend = hist.state.props.legend.map((x) => ({ ...x }));
            legend[k].color = c.value.toLowerCase();
            setLegend("Legend colour", legend, `key-colour:${k}`);
          });
          t.addEventListener("input", () => {
            const legend = hist.state.props.legend.map((x) => ({ ...x }));
            legend[k].label = t.value.slice(0, LEGEND_LABEL_MAX);
            setLegend("Legend label", legend, `key-label:${k}`);
          });
          const used = hist.state.styles.filter((v) => v === k).length;
          return h(
            "div",
            { className: "ed-key-row" },
            c,
            t,
            h("span", { className: "muted small", textContent: `${used} part${used === 1 ? "" : "s"}`, title: "Parts drawn in this colour" }),
            btn("↑", "Move up", () => (hist.apply("Reorder legend", moveLegendEntry(hist.state, k, -1)), changed())),
            btn("↓", "Move down", () => (hist.apply("Reorder legend", moveLegendEntry(hist.state, k, 1)), changed())),
            btn("×", "Remove this colour (its parts go back to the default colour)", () => (hist.apply("Remove legend colour", removeLegendEntry(hist.state, k)), changed()), "key-remove"),
          );
        }),
      );
      // Normal parts in order, each followed by its contested zones (indented).
      const order: number[] = [];
      s.parts.forEach((_, p) => {
        if ((s.contested[p] ?? -1) >= 0 && s.contested[s.contested[p]] === -1) return;
        order.push(p, ...zonesOf(s.contested, p));
      });
      partRows.replaceChildren(
        ...order.map((p) => {
          const rings = s.parts[p];
          const zone = (s.contested[p] ?? -1) >= 0;
          const sel = h("select", { ariaLabel: `Colour of part ${p + 1}`, dataset: { part: String(p) } });
          for (const k of [OWN_COLOUR, ...s.props.legend.map((_, i) => i)]) sel.append(h("option", { value: String(k), textContent: entryName(k) }));
          sel.addEventListener("change", () => setPartStyle(p, Number(sel.value)));
          const of = h("select", { ariaLabel: `Part ${p + 1}: contested zone of`, title: "Contested of: make this part a contested zone of another part (dashed in the embed)", dataset: { contestedOf: String(p) } });
          of.append(h("option", { value: "-1", textContent: "— (normal part)" }));
          const hasZones = zonesOf(s.contested, p).length > 0;
          s.parts.forEach((_, k) => {
            if (k === p || (s.contested[k] ?? -1) >= 0) return;
            of.append(
              h("option", {
                value: String(k),
                textContent: `Part ${k + 1}${s.labels[k]?.trim() ? ` (${s.labels[k].trim()})` : ""}`,
                disabled: hasZones,
                title: hasZones ? `Part ${p + 1} has contested zones of its own, so it can't become one` : "",
              }),
            );
          });
          if (hasZones) of.title = `Part ${p + 1} has contested zones of its own, so it can't become one`;
          of.addEventListener("change", () => setPartContested(p, Number(of.value)));
          const sw = h("i", { className: `ed-swatch ed-badge${zone ? " zone" : ""}`, textContent: String(p + 1), ariaHidden: "true" });
          const lbl = h("input", {
            type: "text",
            maxLength: PART_LABEL_MAX,
            placeholder: `Part ${p + 1} label`,
            value: s.labels[p] ?? "",
            ariaLabel: `Label for part ${p + 1}`,
            title: `${rings[0]?.length ?? 0} vertices${rings.length > 1 ? `, ${rings.length - 1} hole(s)` : ""}`,
            dataset: { partLabel: String(p) },
          });
          lbl.addEventListener("input", () => {
            const labels = [...hist.state.labels];
            labels[p] = lbl.value.slice(0, PART_LABEL_MAX);
            hist.apply("Part label", { ...hist.state, labels }, `part-label:${p}`);
            changed();
          });
          const pick = h("button", { type: "button", className: "ghost tiny", textContent: "Select", title: `Select part ${p + 1}`, dataset: { act: "part-select" }, onclick: () => (setTool("select"), selectPart(p)) });
          const centre = h("button", { type: "button", className: "ghost tiny", textContent: "Centre", title: `Show part ${p + 1} on the map and the globe`, dataset: { act: "part-centre" }, onclick: () => centrePart(p) });
          const row = h(
            "div",
            { className: `ed-part-row${zone ? " zone" : ""}`, dataset: { row: String(p) } },
            sw,
            lbl,
            sel,
            h("label", { className: "ed-of" }, h("span", { className: "muted small", textContent: "Contested of" }), of),
            h("span", { className: "ed-part-acts" }, pick, centre),
          );
          row.addEventListener("pointerenter", () => setHoverPart(p));
          row.addEventListener("pointerleave", () => setHoverPart(-1));
          return row;
        }),
      );
      if (!s.parts.length) partRows.append(h("p", { className: "muted small", textContent: "No parts yet." }));
    }
    // Values that change without changing the structure.
    keyRows.querySelectorAll<HTMLInputElement>("input").forEach((el) => {
      const e = s.props.legend[Number(el.dataset.key)];
      if (!e || document.activeElement === el) return;
      if (el.type === "color") el.value = e.color;
      else el.value = e.label;
    });
    partRows.querySelectorAll<HTMLDivElement>(".ed-part-row").forEach((row) => {
      const p = Number(row.dataset.row);
      const k = s.styles[p] ?? OWN_COLOUR;
      const sel = row.querySelector<HTMLSelectElement>("select[data-part]")!;
      const of = row.querySelector<HTMLSelectElement>("select[data-contested-of]")!;
      if (document.activeElement !== of) of.value = String(s.contested[p] ?? -1);
      for (const opt of of.options) {
        const n = Number(opt.value);
        if (n < 0) continue;
        const t = `Part ${n + 1}${s.labels[n]?.trim() ? ` (${s.labels[n].trim()})` : ""}`;
        if (opt.textContent !== t) opt.textContent = t;
      }
      const lbl = row.querySelector<HTMLInputElement>("input[type=text]")!;
      if (document.activeElement !== lbl) lbl.value = s.labels[p] ?? "";
      // Option texts follow the legend labels as they're typed (rebuilding the rows would lose focus).
      for (const opt of sel.options) {
        const t = entryName(Number(opt.value));
        if (opt.textContent !== t) opt.textContent = t;
      }
      if (document.activeElement !== sel) sel.value = String(k);
      const badge = row.querySelector(".ed-swatch") as HTMLElement;
      badge.style.borderColor = partColour(p);
      row.classList.toggle("hot", p === hoverPart);
      row.classList.toggle("sel", p === selPart);
      row.querySelector("button[data-act=part-select]")?.setAttribute("aria-pressed", String(p === selPart));
    });
    keyRows.querySelectorAll<HTMLSpanElement>(".ed-key-row > span").forEach((el, k) => {
      const used = s.styles.filter((v) => v === k).length;
      el.textContent = `${used} part${used === 1 ? "" : "s"}`;
    });
    addKeyBtn.disabled = s.props.legend.length >= LEGEND_MAX;
  }

  /** After any state change: redraw, update the panel and the globe. */
  function changed(): void {
    // Drop selections that no longer exist.
    for (const [k, v] of selection) if (!parts()[v.p]?.[v.r]?.[v.i]) selection.delete(k);
    if (selPart >= parts().length) selPart = -1;
    syncPanel();
    undoBtn.disabled = !hist.canUndo;
    redoBtn.disabled = !hist.canRedo;
    draw();
    sendPreview();
  }

  /* ── Tools ── */
  /** The drawing tool Add part, Cut and Split use: freehand until the polygon tool is picked. */
  let drawTool: "polygon" | "freehand" = "freehand";
  function setTool(t: Tool): void {
    if (drawing && t !== "polygon") drawing = null;
    tool = t;
    if (t !== "select") drawTool = t;
    if (t !== "polygon" && t !== "freehand") target = "part";
    canvas.style.cursor = t === "select" ? "default" : "crosshair";
    toggleSimplify(false);
    changed();
  }
  function drawHint(t: DrawTarget): string {
    const zone = t === "contested" ? `Contested zone of part ${zoneParent + 1}: ` : "";
    if (t === "split")
      return drawTool === "freehand"
        ? "Drag a line right across a part, from outside it to outside it; let go to split it. Press P for the polygon tool."
        : "Click points along a line right across a part, starting and ending outside it. Double-click or Enter to split.";
    if (t === "cut")
      return drawTool === "freehand"
        ? "Drag around the area to cut away; let go to cut. Inside a part it makes a hole, right across a part it splits it."
        : "Click points around the area to cut away. Double-click, Enter or click the first point to cut.";
    if (drawTool === "freehand") return `${zone}Drag on the map to draw the outline; let go to close it. Press P for the polygon tool.`;
    return `${zone}Click to add points. Double-click, Enter or click the first point to close.`;
  }
  function startDraw(t: DrawTarget): void {
    if ((t === "cut" || t === "split") && !parts().length) return setMsg(`Draw a part first, then ${t} it.`, "error");
    target = t;
    drawing = null;
    tool = drawTool;
    canvas.style.cursor = "crosshair";
    setMsg(drawHint(t));
    changed();
  }

  /**
   * "Add contested zone": extends the selected part (or the part a selected zone extends); with nothing
   * selected, asks which part, unless there's only one normal part.
   */
  function addContested(): void {
    const st = hist.state;
    if (!st.parts.length) return setMsg("Draw a part first; a contested zone extends one of its parts.", "error");
    const normal = st.parts.flatMap((_, p) => ((st.contested[p] ?? -1) < 0 ? [p] : []));
    const fromSel = selPart >= 0 ? ((st.contested[selPart] ?? -1) >= 0 ? st.contested[selPart] : selPart) : -1;
    const go = (k: number) => {
      zoneParent = k;
      selectPart(k);
      startDraw("contested");
    };
    if (fromSel >= 0) return go(fromSel);
    if (normal.length === 1) return go(normal[0]);
    const m = modal("Extends which part?", "zone-pick");
    m.body.append(
      h("p", { className: "muted small", textContent: "The new contested zone extends one part: it's drawn in that part's colour, dashed." }),
      h(
        "div",
        { className: "zone-pick-list" },
        ...normal.map((k) =>
          h("button", {
            type: "button",
            className: "ghost",
            dataset: { pickPart: String(k) },
            textContent: `Part ${k + 1}${st.labels[k]?.trim() ? ` (${st.labels[k].trim()})` : ""}`,
            onclick: () => (m.close(), go(k)),
          }),
        ),
      ),
    );
  }

  /** Validates and adds a closed outline from the polygon or freehand tool. */
  function finishRing(ring: Position[]): boolean {
    if (ring.length < 3) {
      setMsg("An outline needs at least 3 points.", "error");
      return false;
    }
    const prob = ringProblem([[ring]]);
    if (prob) {
      setMsg(prob.message, "error");
      return false;
    }
    if (countVertices(parts()) + ring.length > MAX_VERTICES) {
      setMsg(`That would go over the ${MAX_VERTICES}-vertex limit.`, "error");
      return false;
    }
    if (target === "cut") return applyCut(cutParts(hist.state, [ring]), "Cut");
    if (target === "contested" && zoneParent >= 0 && zoneParent < parts().length) {
      setParts("Add contested zone", addPart(parts(), ring), undefined, [...hist.state.styles, OWN_COLOUR], [...hist.state.labels, ""], [...hist.state.contested, zoneParent]);
    } else setParts(parts().length ? "Add part" : "Draw outline", addPart(parts(), ring), undefined, [...hist.state.styles, OWN_COLOUR], [...hist.state.labels, ""], [...hist.state.contested, -1]);
    setMsg(
      target === "contested" ? `Contested zone of part ${zoneParent + 1} added (part ${parts().length}).` : "Outline added. Drag vertices to refine it.",
      "ok",
    );
    selPart = parts().length - 1;
    endDraw();
    return true;
  }
  function endDraw(): void {
    target = "part";
    zoneParent = -1;
    drawing = null;
    tool = "select";
    canvas.style.cursor = "default";
    changed();
  }

  /** Commits a cut or split (one undo step) and says what it did. False if it changed nothing. */
  function applyCut(res: CutResult, label: string): boolean {
    if (!res.cut.length) {
      setMsg(
        label === "Split" ? "The line has to go right across a part, from outside it to outside it." : "That doesn't overlap any part, so there's nothing to cut.",
        "error",
      );
      return false;
    }
    if (countVertices(res.state.parts) > MAX_VERTICES) {
      setMsg(`That would go over the ${MAX_VERTICES}-vertex limit.`, "error");
      return false;
    }
    const prob = res.problem ?? ringProblem(res.state.parts)?.message.toLowerCase();
    if (prob) {
      setMsg(`Can't ${label.toLowerCase()} there: ${prob}`, "error");
      return false;
    }
    hist.apply(label, res.state);
    selection.clear();
    if (selPart >= 0) selPart = res.index[selPart] ?? -1;
    const total = res.state.parts.length;
    const first = total - res.added + 1;
    const bits: string[] = [];
    if (res.added) bits.push(res.added === 1 ? `part ${first} is new` : `parts ${first}–${total} are new`);
    if (res.removed) bits.push(`${res.removed} cut away`);
    if (res.orphaned) bits.push(`${res.orphaned} zone${res.orphaned === 1 ? "" : "s"} now normal`);
    setMsg(bits.length ? `${label}: ${bits.join(", ")}.` : "Cut. Drag vertices to refine it.", "ok");
    endDraw();
    return true;
  }

  /** Finishes a split line from the polygon or freehand tool. */
  function finishLine(line: Position[]): boolean {
    if (line.length < 2) {
      setMsg("A split line needs at least 2 points.", "error");
      return false;
    }
    return applyCut(splitParts(hist.state, line, undefined, ky), "Split");
  }

  /* ── Hit testing (screen pixels, nearest copy of each point) ── */
  function hitVertex(x: number, y: number): VRef | null {
    const cl = wx(x);
    let best: VRef | null = null;
    let bestD = HIT;
    parts().forEach((rings, p) =>
      rings.forEach((ring, r) =>
        ring.forEach((pt, i) => {
          const d = Math.hypot(sx(nearest(pt[0], cl)) - x, sy(pt[1]) - y);
          if (d <= bestD) {
            bestD = d;
            best = { p, r, i };
          }
        }),
      ),
    );
    return best;
  }
  function hitMidpoint(x: number, y: number): { p: number; r: number; i: number; pos: Position } | null {
    const cl = wx(x);
    let best: { p: number; r: number; i: number; pos: Position } | null = null;
    let bestD = HIT - 1;
    parts().forEach((rings, p) =>
      rings.forEach((ring, r) => {
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i];
          const b = ring[(i + 1) % ring.length];
          const m: Position = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          const lon = nearest(m[0], cl);
          const d = Math.hypot(sx(lon) - x, sy(m[1]) - y);
          if (d <= bestD) {
            bestD = d;
            best = { p, r, i, pos: m };
          }
        }
      }),
    );
    return best;
  }
  /** Nearest neighbour-region vertex within SNAP_PX of a position (in the same copy), or null. */
  function snapTarget(pos: Position): Position | null {
    let best: Position | null = null;
    let bestD = SNAP_PX;
    for (const p of snapPts) {
      const lon = nearest(p[0], pos[0]);
      const d = Math.hypot((lon - pos[0]) * view.k, (p[1] - pos[1]) * view.k * ky);
      if (d <= bestD) {
        bestD = d;
        best = [lon, p[1]];
      }
    }
    return best;
  }

  /* ── Edits ── */
  function deleteRefs(refs: VRef[], label = refs.length > 1 ? `Delete ${refs.length} vertices` : "Delete vertex"): void {
    if (!refs.length) return;
    const res = deleteVertices(parts(), refs);
    const prob = ringProblem(res.parts);
    if (prob) return setMsg(`Can't delete that: ${prob.message.toLowerCase()}`, "error");
    const zones = remapContested(hist.state.contested, res.kept);
    setParts(
      label,
      res.parts,
      undefined,
      res.kept.map((p) => hist.state.styles[p] ?? OWN_COLOUR),
      res.kept.map((p) => hist.state.labels[p] ?? ""),
      zones.contested,
    );
    selection.clear();
    if (res.removedParts) selPart = selPart >= 0 ? res.kept.indexOf(selPart) : -1;
    const orphans = zones.orphaned ? ` ${zones.orphaned === 1 ? "Its contested zone is" : `Its ${zones.orphaned} contested zones are`} now normal part${zones.orphaned === 1 ? "" : "s"}.` : "";
    setMsg(
      res.removedParts
        ? `A ring needs at least 3 vertices, so the whole part was deleted (undo brings it back).${orphans}`
        : res.removedHoles
          ? "A hole needs at least 3 vertices, so the hole was deleted."
          : "",
      res.removedParts || res.removedHoles ? "error" : "muted",
    );
    changed();
  }
  function nudge(dxPx: number, dyPx: number): void {
    const dLon = dxPx / view.k;
    const dLat = -dyPx / (view.k * ky);
    if (selection.size) {
      const refs = [...selection.values()];
      const next = parts().map((rings, p) => rings.map((ring, r) => ring.map((pt, i) => (selection.has(vkey({ p, r, i })) ? ([pt[0] + dLon, Math.max(-90, Math.min(90, pt[1] + dLat))] as Position) : pt))));
      const prob = ringProblem(next, refs);
      if (prob) return setMsg(prob.message, "error");
      setParts("Nudge", next, "nudge");
    } else if (selPart >= 0 && parts()[selPart]) setParts("Nudge part", translate(parts(), moveSet(selPart), dLon, dLat), "nudge-part");
    else if (parts().length) setParts("Nudge shape", translate(parts(), null, dLon, dLat), "nudge");
    changed();
  }
  function undo(): void {
    if (drawing) {
      drawing = null;
      return changed();
    }
    if (hist.undo()) setMsg("Undone.");
    selection.clear();
    changed();
  }
  function redo(): void {
    if (hist.redo()) setMsg("Redone.");
    selection.clear();
    changed();
  }
  function toggleGrid(): void {
    gridOn = !gridOn;
    draw();
    updateStatus();
  }

  const simplifyTol = () => 0.001 * Math.pow(3000, Number(simpRange.value) / 100);
  function toggleSimplify(show = simpPanel.hidden): void {
    simpPanel.hidden = !show;
    simplifyBtn.setAttribute("aria-pressed", String(show));
    simplifyPreview = show ? simplifyParts(parts(), simplifyTol(), ky).parts : null;
    if (show) updateSimplify();
    draw();
  }
  function updateSimplify(): void {
    const res = simplifyParts(parts(), simplifyTol(), ky);
    simplifyPreview = res.parts;
    simpInfo.textContent = `${countVertices(parts()).toLocaleString()} → ${countVertices(res.parts).toLocaleString()} vertices (tolerance ≈ ${(simplifyTol() * view.k).toFixed(1)} px at this zoom)${res.kept ? ` · ${res.kept} ring(s) kept as they were, simplifying them would make them cross` : ""}`;
    draw();
  }
  simpRange.addEventListener("input", updateSimplify);
  function applySimplify(): void {
    const res = simplifyParts(parts(), simplifyTol(), ky);
    const before = countVertices(parts());
    setParts("Simplify", res.parts);
    toggleSimplify(false);
    setMsg(`Simplified: ${before} → ${countVertices(res.parts)} vertices.`, "ok");
    changed();
  }
  function smooth(): void {
    if (!parts().length) return;
    const next = smoothParts(parts());
    if (!next) return setMsg(`Smoothing would go over the ${MAX_VERTICES.toLocaleString()}-vertex limit. Simplify first.`, "error");
    const prob = ringProblem(next);
    if (prob) return setMsg(`Can't smooth: ${prob.message.toLowerCase()}`, "error");
    setParts("Smooth", next);
    const n = countVertices(next);
    setMsg(`Smoothed: ${n.toLocaleString()} vertices.${n >= 4000 ? ` Close to the ${MAX_VERTICES.toLocaleString()} limit.` : ""}`, n >= 4000 ? "error" : "ok");
    changed();
  }

  /* ── Pointer input ── */
  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  canvas.addEventListener("pointerdown", (e) => {
    canvas.focus();
    hideMenu();
    const { x, y } = local(e);
    pointers.set(e.pointerId, { x, y });
    canvas.setPointerCapture(e.pointerId);
    if (pointers.size === 2) {
      // Pinch: abandon whatever the first finger started.
      if (drag && drag.kind !== "pan" && hist.dragging) hist.cancel();
      drag = null;
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      return;
    }
    if (e.button === 2) return;
    if (e.button === 1 || spaceHeld) {
      e.preventDefault();
      drag = { kind: "pan", x0: x, y0: y, v0: { ...view } };
      canvas.style.cursor = "grabbing";
      return;
    }
    const w0: Position = [wx(x), wy(y)];
    if (simplifyPreview) return;
    if (tool === "polygon") {
      if (!drawing) drawing = [w0];
      else {
        const f = drawing[0];
        if (target !== "split" && drawing.length >= 3 && Math.hypot(sx(f[0]) - x, sy(f[1]) - y) <= HIT) return void finishRing(drawing);
        const last = drawing[drawing.length - 1];
        if (Math.hypot(sx(last[0]) - x, sy(last[1]) - y) > 2) drawing.push(w0);
      }
      return draw();
    }
    if (tool === "freehand") {
      drag = { kind: "free", pts: [w0] };
      return draw();
    }
    // Select tool.
    const v = hitVertex(x, y);
    if (v) {
      if (e.altKey) return deleteRefs([v]);
      const k = vkey(v);
      const was = selection.has(k);
      if (!was) {
        if (!e.shiftKey) selection.clear();
        selection.set(k, v);
      }
      const refs = [...selection.values()];
      const vp = parts()[v.p][v.r][v.i];
      beginClashDrag(refs.map((r) => r.p));
      hist.begin();
      drag = { kind: "vertex", base: parts(), refs, grab: v, x0: x, y0: y, w0: [nearest(vp[0], w0[0]), vp[1]], moved: false, label: refs.length > 1 ? `Move ${refs.length} vertices` : "Move vertex", toggle: was && e.shiftKey };
      return draw();
    }
    const m = hitMidpoint(x, y);
    if (m) {
      beginClashDrag([m.p]);
      hist.begin();
      const ins = insertVertex(parts(), m.p, m.r, m.i, m.pos);
      hist.preview({ ...hist.state, parts: ins.parts });
      selection = new Map([[vkey(ins.v), ins.v]]);
      drag = { kind: "vertex", base: ins.parts, refs: [ins.v], grab: ins.v, x0: x, y0: y, w0: [nearest(m.pos[0], w0[0]), m.pos[1]], moved: true, label: "Insert vertex", toggle: false };
      changed();
      return;
    }
    const here = partsAt(parts(), w0, hist.state.contested);
    const badge = hitBadge(x, y);
    if (e.altKey && here.length) {
      // Alt+click: the next part under the pointer (topmost first, wrapping round).
      const same = cycle && Math.hypot(cycle.x - x, cycle.y - y) < 4 && cycle.list.join() === here.join();
      const i = same ? (cycle!.i + 1) % here.length : (here.indexOf(selPart) + 1) % here.length;
      cycle = { x, y, list: here, i };
      selectPart(here[i], `Part ${here[i] + 1} (${i + 1} of ${here.length} here, Alt+click for the next)`);
      return;
    }
    // A click keeps the selected part when it's under the pointer (picked with Alt+click), else takes the topmost.
    const p = badge >= 0 ? badge : here.includes(selPart) ? selPart : (here[0] ?? -1);
    if (p >= 0) {
      cycle = null;
      const i = here.indexOf(p);
      selectPart(p, here.length > 1 && i >= 0 ? `Part ${p + 1} (${i + 1} of ${here.length} here, Alt+click for the next)` : "");
      const whole = e.ctrlKey || e.metaKey;
      const moving = whole ? null : moveSet(p);
      beginClashDrag(moving ?? parts().map((_, k) => k));
      hist.begin();
      drag = { kind: "shape", base: parts(), part: moving, w0, moved: false };
      canvas.style.cursor = "move";
      return;
    }
    drag = { kind: "box", x0: x, y0: y, x1: x, y1: y, add: e.shiftKey };
  });

  canvas.addEventListener("pointermove", (e) => {
    const { x, y } = local(e);
    cursor = [wx(x), wy(y)];
    const pt = pointers.get(e.pointerId);
    if (pt) {
      pt.x = x;
      pt.y = y;
    }
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      view.cx -= (mx - pinch.mx) / view.k;
      view.cy += (my - pinch.my) / (view.k * ky);
      if (pinch.d > 0 && d > 0) zoomAt(d / pinch.d, mx, my);
      pinch = { d, mx, my };
      return draw();
    }
    if (!drag) {
      if (tool === "select") {
        const over = hitVertex(x, y) || hitMidpoint(x, y);
        const under = cursor ? partAt(parts(), cursor, hist.state.contested) : -1;
        canvas.style.cursor = spaceHeld ? "grab" : over ? "pointer" : under >= 0 ? "move" : "default";
        setHoverPart(under);
      }
      return draw();
    }
    if (drag.kind === "pan") {
      view.cx = drag.v0.cx - (x - drag.x0) / view.k;
      view.cy = Math.max(-90, Math.min(90, drag.v0.cy + (y - drag.y0) / (view.k * ky)));
      touched = true;
      return draw();
    }
    if (drag.kind === "box") {
      drag.x1 = x;
      drag.y1 = y;
      return draw();
    }
    if (drag.kind === "free") {
      const last = drag.pts[drag.pts.length - 1];
      if (Math.hypot(sx(last[0]) - x, sy(last[1]) - y) >= 2) drag.pts.push([wx(x), wy(y)]);
      return draw();
    }
    if (drag.kind === "shape") {
      drag.moved = true;
      const next = translate(drag.base, drag.part, cursor[0] - drag.w0[0], cursor[1] - drag.w0[1]);
      hist.preview({ ...hist.state, parts: next });
      return changed();
    }
    // Vertex drag.
    if (!drag.moved && Math.hypot(x - drag.x0, y - drag.y0) < 3) return;
    drag.moved = true;
    let dLon = cursor[0] - drag.w0[0];
    let dLat = cursor[1] - drag.w0[1];
    if (e.shiftKey) {
      const g0 = drag.base[drag.grab.p][drag.grab.r][drag.grab.i];
      const want: Position = [g0[0] + dLon, g0[1] + dLat];
      const t = snapTarget(want);
      if (t) {
        dLon = t[0] - g0[0];
        dLat = t[1] - g0[1];
      }
    }
    const refs = drag.refs;
    const keys = new Set(refs.map(vkey));
    const next = drag.base.map((rings, p) =>
      rings.map((ring, r) => ring.map((q, i) => (keys.has(vkey({ p, r, i })) ? ([q[0] + dLon, Math.max(-90, Math.min(90, q[1] + dLat))] as Position) : q))),
    );
    problem = ringProblem(next, refs);
    hist.preview({ ...hist.state, parts: next });
    changed();
  });

  const endPointer = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pinch) {
      if (pointers.size < 2) pinch = null;
      return;
    }
    const d = drag;
    drag = null;
    if (!d) return;
    if (d.kind === "pan") canvas.style.cursor = spaceHeld ? "grab" : "default";
    if (d.kind === "box") {
      const [x0, x1] = [Math.min(d.x0, d.x1), Math.max(d.x0, d.x1)];
      const [y0, y1] = [Math.min(d.y0, d.y1), Math.max(d.y0, d.y1)];
      if (!d.add) selection.clear();
      // A plain click on empty map clears the selected part too.
      if (x1 - x0 <= 2 && y1 - y0 <= 2 && !d.add) selectPart(-1);
      if (x1 - x0 > 2 || y1 - y0 > 2) {
        const cl = wx((x0 + x1) / 2);
        parts().forEach((rings, p) =>
          rings.forEach((ring, r) =>
            ring.forEach((q, i) => {
              const X = sx(nearest(q[0], cl));
              const Y = sy(q[1]);
              if (X >= x0 && X <= x1 && Y >= y0 && Y <= y1) selection.set(vkey({ p, r, i }), { p, r, i });
            }),
          ),
        );
      }
      return changed();
    }
    if (d.kind === "free") {
      // Simplify the sketch: Douglas–Peucker at about 2 screen pixels.
      const tol = 2 / view.k;
      const simple = (pts: Position[]) => simplifyRing(pts.map(([px, py]) => [px, py * ky]), tol).map(([px, py]) => [px, py / ky] as Position);
      if (target === "split") {
        if (d.pts.length < 2) return draw();
        const line = douglasPeucker(d.pts.map(([px, py]) => [px, py * ky]), tol).map(([px, py]) => [px, py / ky] as Position);
        if (!finishLine(line)) draw();
        return;
      }
      if (d.pts.length < 3) return draw();
      if (!finishRing(simple(d.pts))) draw();
      return;
    }
    if (d.kind === "shape") {
      canvas.style.cursor = "default";
      if (d.moved) hist.commit(d.part === null ? "Move region" : d.part.length > 1 ? "Move part and its zones" : "Move part");
      else hist.cancel();
      dragBase = null;
      return changed();
    }
    if (d.kind === "vertex") {
      if (problem) {
        // Refuse the drop: snap back.
        hist.cancel();
        setMsg(problem.message + " The vertex went back.", "error");
        problem = null;
      } else if (d.moved) {
        hist.commit(d.label);
        setMsg("");
      } else {
        hist.cancel();
        if (d.toggle) selection.delete(vkey(d.grab));
      }
      dragBase = null;
      changed();
    }
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("pointerleave", () => {
    cursor = null;
    setHoverPart(-1);
    draw();
  });
  canvas.addEventListener("dblclick", (e) => {
    if (tool !== "polygon" || !drawing) return;
    e.preventDefault();
    // The double-click's second click added a point on top of the previous one; drop it.
    const pts = drawing.filter((p, i) => i === 0 || Math.hypot(sx(p[0]) - sx(drawing![i - 1][0]), sy(p[1]) - sy(drawing![i - 1][1])) > 3);
    if (target === "split") {
      if (pts.length >= 2) finishLine(pts);
    } else if (pts.length >= 3) finishRing(pts);
  });
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const { x, y } = local(e);
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(Math.exp(-dy * 0.002), x, y);
    },
    { passive: false },
  );

  /* ── Context menu: right-click → Delete ── */
  function hideMenu(): void {
    ctxMenu.hidden = true;
  }
  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (tool !== "select") return;
    const { x, y } = local(e);
    const v = hitVertex(x, y);
    if (!v) return hideMenu();
    const refs = selection.has(vkey(v)) && selection.size > 1 ? [...selection.values()] : [v];
    ctxMenu.replaceChildren(
      h("button", { type: "button", role: "menuitem", textContent: refs.length > 1 ? `Delete ${refs.length} vertices` : "Delete", onclick: () => (hideMenu(), deleteRefs(refs)) }),
    );
    ctxMenu.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    ctxMenu.hidden = false;
    (ctxMenu.firstElementChild as HTMLElement).focus();
  });

  /* ── Keyboard ── */
  dlg.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !(t instanceof HTMLInputElement && ["range", "checkbox", "color"].includes(t.type));
    const mod = e.ctrlKey || e.metaKey;
    if (typing) return; // native editing and undo inside text fields
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      return e.shiftKey ? redo() : undo();
    }
    if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      return redo();
    }
    if (e.key === " ") {
      if (t.tagName === "BUTTON") return;
      e.preventDefault();
      spaceHeld = true;
      canvas.style.cursor = "grab";
      return;
    }
    if (e.key === "Enter" && drawing) {
      e.preventDefault();
      return void (target === "split" ? finishLine(drawing) : finishRing(drawing));
    }
    if (e.key === "Backspace" && drawing) {
      e.preventDefault();
      drawing.pop();
      if (!drawing.length) drawing = null;
      return draw();
    }
    if ((e.key === "Delete" || e.key === "Backspace") && tool === "select" && selection.size) {
      e.preventDefault();
      return deleteRefs([...selection.values()]);
    }
    if (e.key.startsWith("Arrow") && tool === "select" && !mod) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      return nudge(e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0, e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0);
    }
    if (mod || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "v") setTool("select");
    else if (k === "p") setTool("polygon");
    else if (k === "f") setTool("freehand");
    else if (k === "g") toggleGrid();
    else if (e.key === "?") showHelp();
  });
  dlg.addEventListener("keyup", (e) => {
    if (e.key === " ") {
      spaceHeld = false;
      canvas.style.cursor = "default";
    }
  });
  // Esc: cancel the outline being drawn first; only then close (asking if there are unsaved changes).
  dlg.addEventListener("cancel", (e) => {
    e.preventDefault();
    if (!ctxMenu.hidden) return hideMenu();
    if (drawing || drag?.kind === "free") {
      drawing = null;
      drag = null;
      setMsg("Outline cancelled.");
      return draw();
    }
    if (selection.size) {
      selection.clear();
      return draw();
    }
    if (selPart >= 0) return selectPart(-1);
    if (target === "contested" && (tool === "polygon" || tool === "freehand")) {
      target = "part";
      zoneParent = -1;
      setMsg("Contested zone cancelled.");
      return setTool("select");
    }
    void tryClose();
  });

  function showHelp(): void {
    const m = modal("Keyboard shortcuts", "help-dlg");
    m.body.append(h("dl", { className: "shortcuts" }, ...SHORTCUTS.flatMap(([k, v]) => [h("dt", {}, h("kbd", { textContent: k })), h("dd", { textContent: v })])));
  }

  function embed(): void {
    if (isNew) return alertBox("Save first", "Save the region before copying its embed code: the embed loads the saved region by its id.");
    openEmbedDialog({ region: { id, name: id, label: hist.state.props.label, hasLegend: hist.state.props.legend.length > 0 }, slot: slotName, slotTitle: slot.title ?? map?.name ?? slotName });
  }

  /* ── Save ── */
  let saving = false;
  async function save(): Promise<void> {
    if (saving) return;
    const s = hist.state;
    if (isNew) {
      if (!REGION_ID.test(id)) return setMsg("The id must be lowercase letters, digits and dashes.", "error"), idIn.focus();
      if (o.takenIds.has(id)) return setMsg(`The id "${id}" is taken. Choose another one.`, "error"), idIn.focus();
    }
    if (!s.parts.length) return setMsg("Draw the region first.", "error");
    const { geometry, partLegend, partLabels, partContested } = toStyledGeometry(s.parts, s.styles, s.labels, s.contested);
    const hasZones = partContested.some((k) => k !== -1);
    const errs = [...checkGeometry(geometry), ...checkParts({ slot: slotName, map: slot.map, color: s.props.color, ...(hasZones ? { partContested } : {}) }, geometry, "Contested zones")];
    if (errs.length) return setMsg(errs[0], "error");
    const props = s.props;
    const feature: RegionFeature = {
      $schema: "../../schema/region.schema.json",
      type: "Feature",
      id,
      properties: {
        slot: slotName,
        map: slot.map,
        color: props.color,
        fillOpacity: Math.round(props.fillOpacity * 100) / 100,
        label: props.label,
        ...(props.description.trim() ? { description: props.description.trim().slice(0, 500) } : {}),
        ...(props.legend.length && props.legendTitle.trim() ? { legendTitle: props.legendTitle.trim().slice(0, LEGEND_TITLE_MAX) } : {}),
        ...(props.legend.length
          ? { legend: props.legend.map((e) => ({ label: e.label.trim().slice(0, LEGEND_LABEL_MAX), color: e.color })), partLegend }
          : {}),
        ...(partLabels.some((t) => t.trim()) ? { partLabels: partLabels.map((t) => t.trim().slice(0, PART_LABEL_MAX)) } : {}),
        ...(hasZones ? { partContested } : {}),
        updated: stamp(),
      },
      geometry,
    };
    const path = regionPath(id);
    const text = serialize(feature);
    saving = true;
    saveBtn.disabled = true;
    setMsg("Saving…");
    try {
      const commitSha = await o.gh.commit(`Save region ${id}`, async () => {
        const cur = await o.gh.fileSha(path);
        if (cur !== sha) throw new Conflict(cur ? "changed" : "gone");
        return [{ path, content: text }];
      });
      sha = await gitBlobSha(text);
      isNew = false;
      o.takenIds.add(id);
      saved = JSON.stringify(hist.state);
      setMsg(`Saved in commit ${commitSha.slice(0, 7)} to ${o.gh.branch}.`, "ok");
      syncPanel();
      void o.afterCommit(commitSha);
    } catch (e) {
      if (e instanceof Conflict) void conflict(e.message === "gone");
      else setMsg((e as Error).message, "error");
    } finally {
      saving = false;
      saveBtn.disabled = false;
    }
  }

  async function conflict(gone: boolean): Promise<void> {
    if (isNew) {
      setMsg(`A region with the id "${id}" already exists on ${o.gh.branch}. Choose another id.`, "error");
      return idIn.focus();
    }
    const reload = await confirmBox(
      "Changed on GitHub",
      gone
        ? "This region was deleted on GitHub since you opened it. Close the editor, or keep editing and save it under a new id from a duplicate."
        : "Someone changed this region on GitHub since you opened it. Reload it (your unsaved changes here are lost), or keep editing without saving over their change.",
      gone ? "Close editor" : "Reload from GitHub",
      "Keep editing",
    );
    if (!reload) return setMsg("Not saved. The version on GitHub is newer.", "error");
    if (gone) return close();
    try {
      const f = await o.gh.readFile(regionPath(id));
      const fresh = JSON.parse(f.text) as RegionFeature;
      sha = f.sha;
      hist.apply("Reload from GitHub", stateOf(fresh, hist.state.props.color));
      saved = JSON.stringify(hist.state);
      setMsg("Reloaded the latest version from GitHub.", "ok");
      changed();
    } catch (e) {
      setMsg((e as Error).message, "error");
    }
  }

  /* ── Close ── */
  const beforeUnload = (e: BeforeUnloadEvent) => {
    if (dirty()) e.preventDefault();
  };
  window.addEventListener("beforeunload", beforeUnload);
  async function tryClose(): Promise<void> {
    if (dirty() && !(await confirmBox("Unsaved changes", "Close the editor and lose the changes you haven't saved?", "Discard changes", "Keep editing"))) return;
    close();
  }
  function close(): void {
    window.removeEventListener("beforeunload", beforeUnload);
    ro.disconnect();
    frameEl.src = "about:blank";
    dlg.close();
    dlg.remove();
  }
  saveBtn.addEventListener("click", () => void save());
  closeBtn.addEventListener("click", () => void tryClose());

  const ro = new ResizeObserver(() => {
    measure();
    if (!touched) fitView();
    draw();
  });
  ro.observe(canvas);

  dlg.showModal();
  measure();
  fitView();
  setTool(parts().length ? "select" : "freehand");
  if (!parts().length) setMsg(drawHint("part"));
  syncPanel();
  canvas.focus();
  // Test hook: lets the browser tests read the editor's state; exposes nothing the page doesn't already have.
  (dlg as HTMLDialogElement & { wgeEditor?: unknown }).wgeEditor = {
    state: () => hist.state,
    view: () => ({ ...view }),
    setView: (cx: number, cy: number, k: number) => {
      view = { cx, cy, k };
      touched = true;
      draw();
    },
    toScreen: (lon: number, lat: number) => [sx(lon), sy(lat)],
    id: () => id,
    selectedPart: () => selPart,
    clashes: () => clashState().clashes,
  };
}
