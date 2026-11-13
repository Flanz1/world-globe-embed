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
  WARN_VERTICES,
  areaPercent,
  checkGeometry,
  closeRing,
  douglasPeucker,
  geometryBounds,
  globeToImage,
  imageToGlobe,
  mapGeometry,
  openRing,
  polygonsOf,
  round,
  wrapLon,
  simplifyRing,
  unwrapRing,
  type Position,
  type RegionGeometry,
} from "../../shared/geo.ts";
import { findClashes, prepare, type Prepared } from "../../shared/clash.ts";
import { paintSpec, traceGeometry, traceRing } from "../../shared/raster.ts";
import { paintSpecOf, partColours, type Clashes } from "../../shared/region-paint.ts";
import {
  LEGEND_LABEL_MAX,
  LEGEND_MAX,
  LEGEND_TITLE_MAX,
  OWN_COLOUR,
  REGION_ID,
  flatFit,
  flatMinK,
  checkParts,
  DEFAULT_COLOUR_NAME,
  normalizePartContested,
  normalizePartLabels,
  normalizePartLegend,
  normalizePartLabelHidden,
  normalizePartLocked,
  PART_LABEL_MAX,
  PROVINCE_BORDER_MAX,
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
import { createOverlayFilter, type OverlayCategory, type OverlayMeta } from "./overlay-filter.ts";
import { TILE_BUDGET, TILE_LEVELS, TileCache, levelFor, tileRect, tilesAt, tileUrl, type TileLevel } from "../../shared/tiles.ts";
import { alertBox, confirmBox, modal, openEmbedDialog, previewUrl, sendRegion } from "../region-dialogs.ts";
import { regionPath, serialize, stamp } from "../regions.ts";
import { account } from "../session.ts";
import { combineKind, combineParts, extendPart, type MergeResult } from "./merge.ts";
import { MAX_LIVE, liveState, ownEntry, previewLegend, removeLiveEntry, splitLive, type LiveSource } from "./live.ts";
import {
  History,
  addPart,
  cutParts,
  splitParts,
  stateOf,
  countVertices,
  deleteParts,
  deleteVertices,
  fullyChosenRings,
  insertVertex,
  moveLegendEntry,
  partAnchor,
  nextLegendColour,
  partAt,
  partsAt,
  planMove,
  pointSegmentDistance,
  remapContested,
  removeLegendEntry,
  reorderPart,
  layerTarget,
  ringRefs,
  setLabelHidden,
  setLabelsHidden,
  setLocked,
  ringProblem,
  trimStrokeOvershoot,
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
import { Coast, loadCoast, thinTrace } from "./coast.ts";
import { carryLines, posKey, findSnap, followBorders, lineCarry, type LineCarry, insertOnEdges, partRings, sharedEdges, snapRing, traceBetween, vertexIndex, withGlued, type Snap, type SnapRing } from "./snap.ts";

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
  /** For the "Other regions" panel: creator, category and dates of the regions in `neighbours`. Without it the panel just lists ids. */
  neighbourMeta?: { meta: Map<string, OverlayMeta>; categories: OverlayCategory[]; meId: number | undefined };
  takenIds: Set<string>;
  afterCommit: (sha: string) => Promise<void>;
  /**
   * Edit several saved regions together (live.ts): every region's parts load into this editor, and
   * saving writes each changed region back to its own file, in one commit. `feature` is the first one.
   */
  live?: {
    /** The regions in the view, first one first; `current` = unsaved changes to start from (else as saved). */
    sources: { id: string; feature: RegionFeature; sha: string; current?: EditorState }[];
    /** Regions that may be added to the view: on this slot and editable by the user (the ones in the view too). */
    pool: () => { id: string; feature: RegionFeature; sha: string }[];
    /** The other regions (outlines and snap targets) when `ids` are the ones being edited. */
    neighboursFor: (ids: Set<string>) => RegionFeature[];
    /** Where the map was looking (kept when regions are added or taken out). */
    view?: { cx: number; cy: number; k: number };
  };
}

type Tool = "select" | "polygon" | "freehand";
/** What the polygon and freehand tools draw: a part, a shape to cut away, a split line, land to add to a part or a province border. */
type DrawTarget = "part" | "cut" | "split" | "extend" | "border";

const HANDLE = 5;
const HIT = 8;
/** Screen-pixel radius around a polygon's first point inside which a click closes the outline (the point lights up). */
const CLOSE_R = 14;
/** A freehand stroke smaller than this on screen (px) is a slip, not an outline. */
const MIN_STROKE = 12;
const EDGE_HIT = 6;
const SNAP_PX = 10;
const SNAP_COLOUR = "#4dd0e1";
const SNAP_PREF = "wge.editor.snap";
/** Gaps up to this many screen pixels between an Extend shape and its part are filled. */
const EXTEND_GAP_PX = 12;
const COAST_PREF = "wge.editor.coast";
/** The map's coastline, drawn while coast snapping is on. */
const COAST_COLOUR = "rgba(255,196,64,.8)";

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

class Conflict extends Error {}

export const SHORTCUTS: [string, string][] = [
  ["V / P / F", "Select, polygon and freehand tools"],
  ["Click (polygon)", "Add a point; double-click, Enter or click the first point to close (a split line: double-click or Enter)"],
  ["Backspace or right-click (drawing)", "Remove the last point (repeat to go back to the start)"],
  ["Esc", "Cancel the outline being drawn, or clear the selection"],
  ["Drag a vertex", "Move it, with any vertices attached to it (other parts' vertices on the same spot); it snaps to vertices and lines of other parts and regions"],
  ["Ctrl+drag a vertex", "Move just that vertex, without snapping (pulls it off a shared border)"],
  ["Drag a midpoint", "Insert a vertex there (on a shared border, on both sides)"],
  ["S", "Snapping on or off; hold Ctrl to place one point freely"],
  ["O", "Coast snapping on or off: points also snap to the map's coastline (when no part or region is in reach); click two points on the coast to follow it"],
  ["Click two points on one border (polygon)", "Fills in that border's vertices in between; Tab takes the other way round. Clicking the first point to close follows the border too"],
  ["Freehand along a border", "The stroke follows that border's vertices exactly"],
  ["Click a line", "Select every vertex of that outline or hole (Shift adds); Delete then removes it"],
  ["Alt+click / right-click", "Delete a vertex"],
  ["Shift+click, box drag", "Select several vertices"],
  ["Delete / Backspace", "Delete the selected vertices, else the selected part (asks first)"],
  ["Right-click inside a part", "Delete that whole part (asks first)"],
  ["Click inside a part", "Select that part (or click its badge or its row in the Parts list)"],
  ["Alt+click inside", "Select the next part under the pointer, where parts overlap"],
  ["Drag inside a part", "Move that part; Ctrl+drag (Cmd on macOS) moves the whole region"],
  ["Shift+click a part", "Pick several parts (also Shift+click Select in the Parts list); Esc clears the picks"],
  ["C", "Combine the picked parts into one, filling small gaps (with one part selected: it and the parts touching it; click parts to add or remove them, Enter to apply)"],
  ["E", "Extend the selected part: draw a shape that touches it and it's added to the part"],
  ["] / [", "Bring the selected part forward / send it backward: past the next part it overlaps (it's drawn on top of the parts below it)"],
  ["L", "Lock or unlock the selected part (a locked part can't be moved; its vertices and midpoints still edit)"],
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
  // Other regions are hidden until switched on in the "Other regions" panel (top right of the map).
  /** The part the map selection is on: the selected part, else the one part the selected vertices belong to. */
  function layerBarPart(): number {
    if (selPart >= 0 && selPart < parts().length) return selPart;
    const ps = new Set([...selection.values()].map((v) => v.p));
    return ps.size === 1 ? [...ps][0] : -1;
  }
  function layerBarMove(dir: 1 | -1): void {
    const p = layerBarPart();
    if (p >= 0) moveLayer(p, dir);
  }
  function syncLayerBar(): void {
    const p = layerBarPart();
    const show = p >= 0 && overlays.panel.hidden;
    layerBar.el.hidden = !show;
    if (!show) return;
    const n = parts().length;
    layerBar.label.textContent = `Part ${p + 1} of ${n}`;
    layerBar.fwd.disabled = p >= n - 1;
    layerBar.back.disabled = p <= 0;
  }
  const overlays = createOverlayFilter({
    items: neighbours.map((n, index) => ({
      categoryId: null,
      id: n.id as string,
      labels: n.properties.name ?? "",
      creator: n.properties.createdBy?.login ?? "the owner",
      creatorId: n.properties.createdBy?.id ?? 0,
      updated: n.properties.updated ?? "",
      created: n.properties.created ?? "",
      ...o.neighbourMeta?.meta.get(n.id as string),
      index,
    })),
    categories: o.neighbourMeta?.categories ?? [],
    meId: o.neighbourMeta?.meId,
    onChange: () => {
      ringCache.version = -1;
      draw();
    },
  });

  /** Editing several regions together: each one as saved, and its file's blob SHA (to notice changes on GitHub). */
  const live = o.live?.sources.length ? o.live.sources.map((x) => ({ id: x.id, sha: x.sha, feature: x.feature })) : null;
  const liveSources: LiveSource[] = live ? live.map((x) => ({ id: x.id, state: stateOf(x.feature) })) : [];
  const legendCap = live ? 1000 : LEGEND_MAX;
  /** Vertex limit for the editor's parts: per region, so editing together the save checks each region instead. */
  const vertexCap = live ? MAX_VERTICES * live.length : MAX_VERTICES;
  /** Live: the region new parts go to (the "New parts go to" menu); a colour folder's + Part uses the folder's region. */
  let newOwner = live ? live[0].id : "";
  let newPartOwner: string | null = null;
  const hist = new History(live ? liveState(o.live!.sources.map((x, i) => (x.current ? { id: x.id, state: x.current } : liveSources[i]))) : stateOf(o.feature));
  let id = o.feature?.id ?? uniqueId("region", o.takenIds);
  let sha = o.sha;
  let isNew = o.isNew;
  let saved = isNew ? "" : JSON.stringify(live ? liveState(liveSources) : hist.state);
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
  /** Top right of the map while a part is selected (or its vertices): send it forward or backward. */
  const layerBar = (() => {
    const label = h("span", { className: "ed-layer-name" });
    const fwd = btn("Forward", "Bring the selected part forward: on top of the next part it overlaps (])", () => layerBarMove(1), "layer-forward");
    const back = btn("Back", "Send the selected part backward: under the next part it overlaps ([)", () => layerBarMove(-1), "layer-backward");
    const el = h("div", { className: "ed-layer-bar", hidden: true, role: "toolbar", ariaLabel: "Layer order" }, label, back, fwd);
    for (const t of ["pointerdown", "mousedown", "wheel"] as const) el.addEventListener(t, (e) => e.stopPropagation());
    return { el, label, fwd, back };
  })();
  const undoBtn = btn("Undo", "Undo (Ctrl+Z)", () => undo(), "undo");
  const redoBtn = btn("Redo", "Redo (Ctrl+Shift+Z or Ctrl+Y)", () => redo(), "redo");
  const gridBtn = btn("Grid", "Show the globe's 15° grid (G)", () => toggleGrid(), "grid");
  const snapBtn = btn(
    "Snap",
    "Snap to the vertices and lines of other parts and regions while drawing and dragging, so borders are shared exactly (S). Hold Ctrl to place a point freely.",
    () => toggleSnap(),
    "snap",
  );
  const coastBtn = btn(
    "Coast",
    "Also snap to the map's coastline (shown in amber) where no part or region is in reach, and follow it between two clicks (O). Rivers, lakes and marshes count as land.",
    () => toggleCoast(),
    "coast",
  );
  coastBtn.hidden = true;
  const simplifyBtn = btn("Simplify…", "Fewer vertices, same shape", () => toggleSimplify(), "simplify");
  const smoothBtn = btn("Smooth", "Round the corners (one Chaikin pass; doubles the vertices)", () => smooth(), "smooth");

  const idIn = h("input", { type: "text", maxLength: 64, spellcheck: false, value: id, name: "id", pattern: "[a-z0-9][a-z0-9\\-]{0,63}" });
  const colorIn = h("input", { type: "color", value: hist.state.props.color, name: "color", ariaLabel: "Colour of the Default colour folder" });
  const colorLabelIn = h("input", {
    type: "text",
    maxLength: LEGEND_LABEL_MAX,
    placeholder: DEFAULT_COLOUR_NAME,
    value: hist.state.props.colorLabel,
    name: "color-label",
    ariaLabel: "Label for the default colour",
    title: "Rename this colour; once it has a label the embed's legend lists it",
  });
  const opacityIn = h("input", { type: "range", min: "0", max: "1", step: "0.05", value: String(hist.state.props.fillOpacity), name: "opacity" });
  const opacityOut = h("output", {});
  const labelIn = h("input", { type: "checkbox", checked: hist.state.props.label, name: "label" });
  const borderIn = h("input", { type: "checkbox", checked: hist.state.props.nationalBorders === true, name: "national-borders" });
  const descIn = h("textarea", { maxLength: 500, rows: 3, value: hist.state.props.description, name: "description" });
  const stats = h("p", { className: "muted small ed-stats" });
  const keyTitleIn = h("input", { type: "text", maxLength: LEGEND_TITLE_MAX, placeholder: "Legend", value: hist.state.props.legendTitle, name: "legend-title" });
  /** One collapsible folder per colour (the region's own colour first), each holding its parts' rows. */
  const folders = h("div", { className: "ed-folders" });
  const addKeyBtn = btn("Add colour", "Add a colour (a new folder) for parts", () => addLegendEntry(), "key-add");
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

  const combRange = h("input", { type: "range", min: "0", max: "40", value: "10", ariaLabel: "Fill gaps up to (pixels)", name: "combine-gap" });
  const combGapOut = h("output", {});
  const combInfo = h("p", { className: "small ed-comb-info", ariaLive: "polite" });
  const combApply = btn("Combine", "Combine the picked parts into one (one undo step; Enter)", () => applyCombine(), "combine-apply");
  const combPanel = h(
    "div",
    { className: "ed-combine", hidden: true },
    h("strong", { textContent: "Combine parts" }),
    h("p", { className: "muted small", textContent: "Click parts on the map to add or remove them. Small gaps between them are filled." }),
    h("label", {}, "Fill gaps up to", combRange, combGapOut),
    combInfo,
    h("div", { className: "row" }, combApply, btn("Cancel", "", () => closeCombine())),
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
      btn("Add part", "Draw another polygon (an island or exclave), in the default colour; a colour's + Part draws one in that colour", () => ((newPartStyle = OWN_COLOUR), startDraw("part")), "add-part"),
      btn("Cut", "Draw a shape to cut away: inside a part it makes a hole, across a part's edge it bites it, right across it splits it into separate parts", () => startDraw("cut"), "cut-hole"),
      btn("Split", "Draw a line right across a part to split it into separate parts", () => startDraw("split"), "split"),
      btn("Combine…", "Combine the parts you picked (click one, Shift+click the others) into one part, filling small gaps (C)", () => openCombine(), "combine"),
      btn("Extend", "Draw a shape that touches the selected part to add it to that part (E)", () => startExtend(), "extend"),
      btn(
        "Province border",
        "Draw a province border inside the region: a dashed line in the embed, shown only inside the parts. It doesn't change the parts. Click a border to select it; Delete removes it.",
        () => startDraw("border"),
        "province-border",
      ),
      h("span", { className: "sep" }),
      undoBtn,
      redoBtn,
      h("span", { className: "sep" }),
      simplifyBtn,
      smoothBtn,
      h("span", { className: "sep" }),
      snapBtn,
      coastBtn,
      gridBtn,
      btn("?", "Keyboard shortcuts", () => showHelp(), "help"),
      h("span", { className: "ed-toolbar-end" }, overlays.button),
    ),
    h(
      "div",
      { className: "ed-body" },
      h("div", { className: "ed-canvas-wrap" }, canvas, overlays.panel, layerBar.el, ctxMenu, tip, simpPanel, combPanel, status),
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
        h("label", { className: "check", title: "Draw a dark border where parts of different colours share a line (parts of one colour read as one). Off: parts that touch just touch." }, borderIn, "Draw national borders"),
        h("label", {}, "Description (plain text)", descIn),
        h(
          "fieldset",
          { className: "ed-colours" },
          h("legend", { textContent: "Colours and parts" }),
          h("p", {
            className: "muted small",
            textContent:
              "Each colour is a folder of parts. Give a colour a label and the embed lists it in the legend. Move a part to another colour with its colour menu. Where parts overlap, the higher-numbered part is drawn on top: use Forward and Back to change that.",
          }),
          h("label", {}, "Legend title", keyTitleIn),
          folders,
          addKeyBtn,
        ),
        h(
          "fieldset",
          { className: "ed-overlaps" },
          h("legend", { textContent: "Overlaps" }),
          h("p", { className: "muted small", textContent: "Where parts of different colours overlap, the overlap is contested: the upper layer's colour is the main one and the lower one's is hatched over it, in the embed too. Forward / Back decide which is on top." }),
          clashList,
        ),
        stats,
      ),
    ),
  );
  document.body.append(dlg);
  if (live) {
    // Editing together: settings that belong to one region stay as each region has them, so they're not shown.
    for (const el of [idIn, opacityIn, labelIn, borderIn, descIn, keyTitleIn]) (el.closest("label") as HTMLElement).hidden = true;
    for (const act of ["province-border", "embed"]) (dlg.querySelector(`button[data-act="${act}"]`) as HTMLElement).hidden = true;
    const ownerIn = h(
      "select",
      { name: "new-owner", ariaLabel: "Region new parts go to" },
      ...live.map((x) => h("option", { value: x.id, textContent: x.id })),
    );
    ownerIn.addEventListener("change", () => (newOwner = ownerIn.value));
    idIn.closest("label")!.after(
      h(
        "p",
        { className: "muted small ed-live-note" },
        `Editing ${live.length} regions together: ${live.map((x) => x.id).join(", ")}. Each part belongs to one of them (its Region menu in the Parts list), and Save writes every region that changed, in one commit. Each region keeps its own fill, description, legend title and province borders.`,
      ),
      h("label", {}, "New parts go to", ownerIn),
      h("div", { className: "row" }, btn("Regions…", "Add regions to this view or take them out", () => openLiveRegions(), "live-regions")),
    );
  }

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
  // The coastline, for coast snapping (the Coast button shows once it's here).
  void loadCoast(map?.coast ? new URL(map.coast, SITE).href : null).then((data) => {
    if (!data || !dlg.isConnected) return;
    coast = new Coast(data, ky);
    coastBtn.hidden = false;
    ringCache.version = -1;
    draw();
  });
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
  /** The colour (legend index, or OWN_COLOUR) a part drawn with Add part goes into: set by a folder's "+ Part". */
  let newPartStyle = OWN_COLOUR;
  /** The selected part (-1 for none): click inside it, its badge or its row. Separate from the vertex selection. */
  let selPart = -1;
  /** Parts picked together with Shift+click (in the order picked; the first keeps its place when combined), and the history version they were picked at. */
  let picked: number[] = [];
  let pickedVersion = -1;
  /** The selected province border (-1 for none): click its line. */
  let selLine = -1;
  /** Alt+click cycling through the parts under one spot. */
  let cycle: { x: number; y: number; list: number[]; i: number } | null = null;
  let pickHint = "";
  let drawing: Position[] | null = null;
  let cursor: Position | null = null;
  let selection = new Map<string, VRef>();
  let problem: RingProblem | null = null;
  let gridOn = false;
  let simplifyPreview: Parts | null = null;
  /** The Combine panel: the parts picked (the first keeps its place) and the result or why not. */
  let combine: { set: number[]; res: MergeResult | string; version: number } | null = null;
  /** The part an Extend shape is added to (-1: the part the shape starts in). */
  let extendTarget = -1;
  let spaceHeld = false;
  /** Snapping to other parts' and regions' vertices and lines (S, or the Snap button); remembered per browser. */
  let snapOn = true;
  try {
    snapOn = localStorage.getItem(SNAP_PREF) !== "off";
  } catch {
    /* storage blocked: default on */
  }
  /** The map's coastline (loaded after the editor opens; null when the map has none). */
  let coast: Coast | null = null;
  /** Snapping to the coastline too (O, or the Coast button); remembered per browser. Only with snapping on. */
  let coastOn = true;
  try {
    coastOn = localStorage.getItem(COAST_PREF) !== "off";
  } catch {
    /* storage blocked: default on */
  }
  /** Where the pointer would snap right now (drawn as a ring), with the rings it refers to. */
  let snapHint: { snap: Snap; rings: readonly SnapRing[] } | null = null;
  /** Per point of `drawing`: where it snapped (null for a free point), for tracing along a border. */
  let drawSnaps: (Snap | null)[] = [];
  /** Tab while drawing: trace the other way round the border. */
  let traceFlip = false;
  type Drag =
    | {
        kind: "vertex";
        base: Parts;
        refs: VRef[];
        grab: VRef;
        x0: number;
        y0: number;
        w0: Position;
        moved: boolean;
        label: string;
        toggle: boolean;
        /** Snap targets for this drag, leaving out the rings being reshaped. */
        rings: SnapRing[];
        skip: (ring: number) => boolean;
        /** Province borders as they were, and which points sit on outlines (they follow the vertices). */
        baseLines: Position[][];
        carry: LineCarry;
      }
    | { kind: "lvertex"; l: number; k: number; base: Position[][]; x0: number; y0: number; moved: boolean; rings: SnapRing[]; skip: (ring: number) => boolean }
    | { kind: "shape"; base: Parts; part: number[] | null; w0: Position; moved: boolean; baseLines: Position[][]; carry: LineCarry }
    | { kind: "pan"; x0: number; y0: number; v0: typeof view }
    | { kind: "box"; x0: number; y0: number; x1: number; y1: number; add: boolean; refused?: string }
    | { kind: "free"; pts: Position[] }
    | null;
  let drag: Drag = null;
  /** The ring whose line is under a press; a click (no drag) on it selects all that ring's vertices. */
  let edgePick: { p: number; r: number } | null = null;
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch: { d: number; mx: number; my: number } | null = null;

  const parts = () => hist.state.parts;
  /** Geometry edits. `styles`, `labels`, `contested` and `locked` must be given whenever parts are removed (added parts start locked). */
  const setParts = (
    label: string,
    next: Parts,
    merge?: string,
    styles = hist.state.styles,
    labels = hist.state.labels,
    contested = hist.state.contested,
    locked = hist.state.locked,
    labelHidden = hist.state.labelHidden,
    owners = hist.state.owners,
  ) =>
    hist.apply(
      label,
      {
        ...hist.state,
        ...(owners ? { owners: Array.from({ length: next.length }, (_, p) => owners[p] || newOwner) } : {}),
        parts: next,
        styles: normalizePartLegend(styles, next.length, hist.state.props.legend.length),
        labels: normalizePartLabels(labels, next.length),
        contested: normalizePartContested(contested, next.length),
        locked: normalizePartLocked(locked, next.length),
        labelHidden: normalizePartLabelHidden(labelHidden, next.length),
      },
      merge,
    );
  /** Part under the pointer, on the map or in the side panel's Parts list, or -1. */
  let hoverPart = -1;
  function setHoverPart(p: number): void {
    if (p === hoverPart) return;
    hoverPart = p;
    folders.querySelectorAll<HTMLElement>(".ed-part-row").forEach((row) => row.classList.toggle("hot", Number(row.dataset.row) === p));
    draw();
  }
  function selectPart(p: number, hint = ""): void {
    selPart = p >= 0 && p < parts().length ? p : -1;
    pickHint = selPart >= 0 ? hint : "";
    folders.querySelectorAll<HTMLElement>(".ed-part-row").forEach((row) => {
      const on = Number(row.dataset.row) === selPart;
      row.classList.toggle("sel", on);
      row.classList.toggle("pick", picked.includes(Number(row.dataset.row)));
      row.querySelector<HTMLButtonElement>("button[data-act=part-select]")?.setAttribute("aria-pressed", String(on));
    });
    draw();
  }
  /** Shift+click: adds part p to the picked parts, or takes it out. The selected part counts as picked from the first Shift+click. */
  function togglePick(p: number): void {
    if (pickedVersion !== hist.version) picked = [];
    pickedVersion = hist.version;
    if (!picked.length && selPart >= 0 && selPart !== p) picked = [selPart];
    picked = picked.includes(p) ? picked.filter((q) => q !== p) : [...picked, p];
    selectPart(p, picked.length > 1 ? `${picked.length} parts picked: press C to combine them, Esc to clear` : "");
    if (picked.length > 1) setMsg(`${picked.length} parts picked (Shift+click adds or removes). Press C or Combine to merge them.`);
  }
  /** The picked parts, or none if an edit made the picks stale. */
  const pickedNow = (): number[] => (pickedVersion === hist.version ? picked.filter((q) => q < parts().length) : []);
  function clearPicks(): void {
    if (!picked.length) return;
    picked = [];
    selectPart(selPart);
  }
  /**
   * The parts a move of part p (or the whole region, null) takes along, or why a lock refuses the move.
   */
  const moveSet = (p: number | null) => {
    const s = hist.state;
    return planMove(s.locked, s.labels, s.parts.length, p, p === null ? [] : [p]);
  };

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

  /*
   * ── Overlaps (clashes) between this region's own parts ──
   * Neighbours (other regions on the slot) are separate maps: they're drawn as outlines to trace against
   * and snap to, but never compared with this region, so they never cover or mark its parts.
   */
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
    if (ps.length < 2) {
      // One part can't overlap anything: nothing to prepare (a big ring would cost milliseconds per drag move).
      preps = [];
      clashes = { internal: [] };
    } else if (base && base.moving.size < ps.length) {
      const mv = base.moving;
      preps = ps.map((r, i) => (mv.has(i) ? prepare(r) : base.cs.preps[i]));
      clashes = {
        internal: [...base.cs.clashes.internal.filter(([i, j]) => !mv.has(i) && !mv.has(j)), ...findClashes(preps, mv)],
      };
    } else {
      preps = ps.map((r) => prepare(r));
      clashes = { internal: findClashes(preps) };
    }
    const st = hist.state;
    // Editing several regions together: each region is its own map, so only its own parts overlap (as in the embed).
    const own = st.owners;
    if (own) clashes = { internal: clashes.internal.filter(([i, j]) => own[i] === own[j]) };
    const spec = paintSpecOf({ color: st.props.color, legend: st.props.legend, parts: st.styles, geometry: asGeometry(ps), ...(st.lines?.length ? { provinceBorders: st.lines } : {}), ...(st.props.nationalBorders ? { nationalBorders: true } : {}) }, clashes);
    clashCache = { version: hist.version, preps, clashes, spec };
    return clashCache;
  }
  /** Call when a drag starts: later clashState() calls only re-test the moving parts. */
  function beginClashDrag(moving: Iterable<number>): void {
    dragBase = { cs: clashState(), moving: new Set(moving) };
  }
  const partName = (p: number): string => {
    const t = hist.state.labels[p]?.trim();
    return t ? `part ${p + 1} (${t})` : `part ${p + 1}`;
  };
  let clashListVersion = -1;
  /** The side panel's list of overlaps (plain text only: labels and names are untrusted). */
  function syncClashList(cs: ClashState): void {
    if (clashListVersion === cs.version) return;
    clashListVersion = cs.version;
    const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
    const rows: HTMLElement[] = [];
    for (const [i, j] of cs.clashes.internal) {
      const [lo, hi] = i < j ? [i, j] : [j, i];
      // The upper layer's colour is the main one in the overlap, the lower one's is hatched over it.
      const contested = partColour(hi) !== partColour(lo);
      rows.push(h("li", { dataset: { clash: `${i}:${j}` } }, contested ? `${cap(partName(hi))} over ${partName(lo)}: contested, ${partName(hi)}'s colour is the main one` : `${cap(partName(hi))} covers ${partName(lo)} (same colour)`));
    }
    if (!rows.length) rows.push(h("li", { className: "muted", textContent: "No overlaps." }));
    clashList.replaceChildren(...rows);
  }

  function render(): void {
    raf = 0;
    syncLayerBar();
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
    if (coastActive()) drawCoast(offs);
    // Neighbours on the same slot: thin grey outlines to trace against.
    const shownNb = neighbours.filter((_, i) => overlays.visible(i));
    if (shownNb.length) {
      g.save();
      g.lineWidth = 1;
      g.strokeStyle = "rgba(220,220,220,.75)";
      g.setLineDash([]);
      g.beginPath();
      for (const n of shownNb) traceGeometry(g, n.geometry, sx, sy, offs);
      g.stroke();
      g.restore();
    }
    const p = simplifyPreview ?? parts();
    const s = hist.state.props;
    const cs = clashState();
    syncClashList(cs);
    if (p.length) {
      paintSpec(g, cs.spec, sx, sy, offs, { fillOpacity: simplifyPreview ? s.fillOpacity * 0.4 : s.fillOpacity, lineWidth: 2 }, { w, h: hh });
      const sl = (hist.state.lines ?? [])[selLine];
      if (sl) {
        g.save();
        g.lineWidth = 4;
        g.lineJoin = "round";
        g.strokeStyle = "#ffd400";
        g.globalAlpha = 0.7;
        g.beginPath();
        for (const off of offs) sl.forEach((pt, i) => (i ? g.lineTo(sx(pt[0] + off), sy(pt[1])) : g.moveTo(sx(pt[0] + off), sy(pt[1]))));
        g.stroke();
        g.restore();
      }
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
      const pk = pickedNow();
      if (pk.length) {
        g.save();
        g.lineWidth = 3;
        g.lineJoin = "round";
        g.setLineDash([8, 4]);
        g.strokeStyle = "#ffd400";
        g.beginPath();
        for (const q of pk) for (const ring of parts()[q] ?? []) traceRing(g, ring, sx, sy, offs);
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
    if (combine) drawCombine(offs);
    if (tool === "select" && !simplifyPreview && !combine) {
      drawHandles(offs);
      drawLineHandles(offs);
    }
    if ((parts().length > 1 || hist.state.locked.some((l) => l !== false)) && !simplifyPreview) drawBadges(offs);
    else badgeAt = [];
    if (drawing || drag?.kind === "free") {
      const pts = drawing ?? (drag as { pts: Position[] }).pts;
      g.save();
      g.strokeStyle = s.color;
      g.lineWidth = 2;
      g.beginPath();
      pts.forEach((pt, i) => (i ? g.lineTo(sx(pt[0]), sy(pt[1])) : g.moveTo(sx(pt[0]), sy(pt[1]))));
      g.stroke();
      // From the last point to the pointer, along a border where the next click would trace one.
      const tail = drawing ? pendingTail() : null;
      if (tail && drawing) {
        const last = drawing[drawing.length - 1];
        g.beginPath();
        g.moveTo(sx(last[0]), sy(last[1]));
        for (const q of tail.pts) g.lineTo(sx(q[0]), sy(q[1]));
        if (tail.traced) {
          g.strokeStyle = SNAP_COLOUR;
          g.lineWidth = 3;
        }
        g.stroke();
        g.fillStyle = SNAP_COLOUR;
        for (const q of tail.pts.slice(0, -1)) {
          g.beginPath();
          g.arc(sx(q[0]), sy(q[1]), 2.5, 0, Math.PI * 2);
          g.fill();
        }
      }
      g.fillStyle = "#fff";
      if (drawing && cursor && tool === "polygon" && closesAt(sx(cursor[0]), sy(cursor[1]))) {
        // The next click closes the outline: light the first point up.
        g.save();
        g.strokeStyle = SNAP_COLOUR;
        g.fillStyle = SNAP_COLOUR;
        g.lineWidth = 3;
        g.beginPath();
        g.arc(sx(pts[0][0]), sy(pts[0][1]), CLOSE_R, 0, Math.PI * 2);
        g.globalAlpha = 0.25;
        g.fill();
        g.globalAlpha = 1;
        g.stroke();
        g.restore();
      }
      for (const [i, pt] of pts.entries()) {
        g.beginPath();
        g.arc(sx(pt[0]), sy(pt[1]), i === 0 ? 6 : 3.5, 0, Math.PI * 2);
        g.fill();
      }
      g.restore();
    }
    if (snapHint && snapOn && !simplifyPreview) {
      const q = snapHint.snap.pos;
      g.save();
      g.strokeStyle = SNAP_COLOUR;
      g.lineWidth = 2;
      for (const off of offs) {
        const x = sx(q[0] + off);
        const y = sy(q[1]);
        if (x < -20 || x > w + 20) continue;
        g.beginPath();
        if (snapHint.snap.kind === "vertex") g.arc(x, y, 7, 0, Math.PI * 2);
        else {
          g.moveTo(x - 6, y);
          g.lineTo(x, y - 6);
          g.lineTo(x + 6, y);
          g.lineTo(x, y + 6);
          g.closePath();
        }
        g.stroke();
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

  /** The colour part p is drawn in. */
  const partColour = (p: number): string => {
    const st = hist.state;
    return partColours({ color: st.props.color, legend: st.props.legend, parts: st.styles }, st.parts.length)[p] ?? st.props.color;
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
  /** A small padlock (locked part) centred at x, y, on the badge's top-right. */
  function drawLock(x: number, y: number): void {
    g.save();
    g.beginPath();
    g.arc(x, y, 7.5, 0, Math.PI * 2);
    g.fillStyle = "#ffd400";
    g.fill();
    g.strokeStyle = "rgba(20,18,14,.9)";
    g.lineWidth = 1.5;
    g.stroke();
    // Shackle and body.
    g.beginPath();
    g.arc(x, y - 1.5, 2.3, Math.PI, 0);
    g.stroke();
    g.fillStyle = "rgba(20,18,14,.9)";
    g.fillRect(x - 3.5, y - 1.5, 7, 5);
    g.restore();
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
        g.stroke();
        g.fillStyle = "#fff";
        if (p === selPart) {
          g.lineWidth = 3;
          g.strokeStyle = "rgba(0,0,0,.7)";
          g.strokeText(String(p + 1), x, y + 0.5);
        }
        g.fillText(String(p + 1), x, y + 0.5);
        if (hist.state.locked[p] !== false) drawLock(x + r * 0.8, y - r * 0.8);
      }
    });
    g.restore();
  }

  function drawLineHandles(offs: number[]): void {
    g.save();
    g.fillStyle = "#fff";
    g.strokeStyle = "#000";
    (hist.state.lines ?? []).forEach((line, l) => {
      if (l !== selLine) return;
      for (let k = 0; k + 1 < line.length; k++) {
        g.save();
        g.fillStyle = "rgba(255,255,255,.55)";
        for (const off of offs) {
          g.beginPath();
          g.arc(sx((line[k][0] + line[k + 1][0]) / 2 + off), sy((line[k][1] + line[k + 1][1]) / 2), 3, 0, Math.PI * 2);
          g.fill();
          g.stroke();
        }
        g.restore();
      }
      for (const pt of line)
        for (const off of offs) {
          g.fillRect(sx(pt[0] + off) - HANDLE / 2, sy(pt[1]) - HANDLE / 2, HANDLE, HANDLE);
          g.strokeRect(sx(pt[0] + off) - HANDLE / 2, sy(pt[1]) - HANDLE / 2, HANDLE, HANDLE);
        }
    });
    g.restore();
  }
  /** Rings with more vertices than this get thinned handles (see drawHandles). */
  const DENSE_RING = 1500;
  const MIN_HANDLE_GAP = 5;
  const MIN_MIDPOINT_EDGE = 14;
  function drawHandles(offs: number[]): void {
    const { w, h: hh } = size();
    const glued = glue().glued;
    const vis = (x: number, y: number) => x > -10 && x < w + 10 && y > -10 && y < hh + 10;
    g.save();
    parts().forEach((rings, p) =>
      rings.forEach((ring, r) => {
        const n = ring.length;
        // Midpoints first (under the vertices).
        g.fillStyle = "rgba(255,255,255,.55)";
        g.strokeStyle = "rgba(0,0,0,.6)";
        g.lineWidth = 1;
        // A big ring (a combined map's coastline) has more handles than pixels when zoomed out: draw
        // one every few pixels, and no midpoints on edges too short to grab. Every vertex is still hit-testable.
        const dense = n > DENSE_RING;
        for (let i = 0; i < n; i++) {
          const a = ring[i];
          const b = ring[(i + 1) % n];
          if (dense && Math.hypot(sx(b[0]) - sx(a[0]), sy(b[1]) - sy(a[1])) < MIN_MIDPOINT_EDGE) continue;
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
        let lastX = -Infinity;
        let lastY = -Infinity;
        for (let i = 0; i < n; i++) {
          const key = selection.size > 0 || glued.size > 0 ? vkey({ p, r, i }) : "";
          const sel = selection.size > 0 && selection.has(key);
          if (dense && !sel && !(glued.size > 0 && glued.has(key))) {
            const x0 = sx(ring[i][0]);
            const y0 = sy(ring[i][1]);
            if (Math.abs(x0 - lastX) < MIN_HANDLE_GAP && Math.abs(y0 - lastY) < MIN_HANDLE_GAP) continue;
            lastX = x0;
            lastY = y0;
          }
          g.fillStyle = sel ? "#ffd400" : "#ffffff";
          g.strokeStyle = "#000";
          const stuck = glued.size > 0 && glued.has(key);
          for (const off of offs) {
            const x = sx(ring[i][0] + off);
            const y = sy(ring[i][1]);
            if (!vis(x, y)) continue;
            if (stuck) {
              // Attached to another part's vertex: a diamond in the snap colour (moves with it).
              const d = HANDLE / 2 + 1.5 + (sel ? 1 : 0);
              g.save();
              g.fillStyle = sel ? "#ffd400" : SNAP_COLOUR;
              g.beginPath();
              g.moveTo(x, y - d);
              g.lineTo(x + d, y);
              g.lineTo(x, y + d);
              g.lineTo(x - d, y);
              g.closePath();
              g.fill();
              g.stroke();
              g.restore();
              continue;
            }
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
  // Drawing tips (the long how-to line above the map) are off by default; the "?" dialog turns them on.
  let tipsOn = ((): boolean => {
    try {
      return localStorage.getItem("ed-tips") === "on";
    } catch {
      return false;
    }
  })();
  function updateStatus(): void {
    const n = countVertices(parts());
    const parts_ = parts().length;
    const what = target === "cut" ? "Cut" : target === "split" ? "Split" : target === "border" ? "Province border" : target === "extend" ? (extendTarget >= 0 ? `Extend part ${extendTarget + 1}` : "Extend") : "";
    let line = `${tool === "select" ? "Select" : `${tool === "polygon" ? "Polygon" : "Freehand"}${what ? ` (${what})` : ""}`} · ${n} vertices`;
    if (tool === "select" && selPart >= 0) line += ` · ${pickHint || `Part ${selPart + 1} selected`}`;
    if (snapHint && snapOn) line += ` · snaps to ${snapName(snapHint.snap, snapHint.rings)}`;
    if (tool === "polygon" && drawing && pendingTail()?.traced) line += ` · follows the border${traceFlip ? " the other way" : ""} (Tab: ${traceFlip ? "back" : "other way"})`;
    if (cursor) {
      const lon = ((((cursor[0] + 180) % 360) + 360) % 360) - 180;
      const gl = imageToGlobe([lon, cursor[1]], frame);
      line += ` · lon ${round(lon, 3)}, lat ${round(cursor[1], 3)}`;
      if (tipsOn) line += ` (stored) · globe lon ${round(gl[0], 2)}, lat ${round(gl[1], 2)}`;
    }
    status.textContent = line;
    undoBtn.disabled = !hist.canUndo;
    redoBtn.disabled = !hist.canRedo;
    for (const b of dlg.querySelectorAll<HTMLButtonElement>("button.tool")) b.setAttribute("aria-pressed", String(b.dataset.tool === tool));
    gridBtn.setAttribute("aria-pressed", String(gridOn));
    snapBtn.setAttribute("aria-pressed", String(snapOn));
    coastBtn.setAttribute("aria-pressed", String(coastActive()));
    // The spherical area is skipped mid-drag (it costs a few ms at 2,000 vertices) and refreshed on release.
    if (!hist.dragging || lastArea < 0) lastArea = parts_ ? areaPercent(mapGeometry(toGeometry(parts()), (p) => imageToGlobe(p, frame))) : 0;
    const area = lastArea;
    stats.textContent = `${n.toLocaleString()} vertices in ${parts_} part${parts_ === 1 ? "" : "s"} · about ${area < 0.01 ? area.toFixed(4) : area.toFixed(2)}% of the globe's surface`;
    stats.classList.toggle("error", !live && n >= WARN_VERTICES);
    if (!live && n >= WARN_VERTICES) stats.textContent += ` · close to the ${MAX_VERTICES.toLocaleString()}-vertex limit`;
  }

  /* ── Live globe preview ── */
  const previewId = () => (REGION_ID.test(id) ? id : "new-region");
  /** Province borders as stored: wrapped and rounded, within the position cap. */
  const storedLines = (lines: Position[][]): Position[][] => {
    let n = 0;
    return lines
      .filter((l) => l.length >= 2 && (n += l.length) <= PROVINCE_BORDER_MAX)
      .map((l) => l.map(([x, y]) => [round(wrapLon(x)), round(y)] as Position));
  };
  /** The legend and part colours the globe preview gets: editing together, squeezed to what one region may show. */
  const previewStyles = () =>
    live ? previewLegend(hist.state) : { legend: hist.state.props.legend.map((e) => ({ label: e.label.slice(0, LEGEND_LABEL_MAX), color: e.color })), styles: hist.state.styles };
  const regionNow = (): RegionData => ({
    id: previewId(),
    slot: slotName,
    name: "",
    color: hist.state.props.color,
    colorLabel: hist.state.props.colorLabel.trim().slice(0, LEGEND_LABEL_MAX),
    fillOpacity: hist.state.props.fillOpacity,
    label: hist.state.props.label,
    legendTitle: hist.state.props.legendTitle.slice(0, LEGEND_TITLE_MAX),
    ...(hist.state.props.nationalBorders ? { nationalBorders: true } : {}),
    legend: previewStyles().legend,
    ...(({ geometry, partLegend, partLabels, partLabelHidden }) => ({
      geometry,
      parts: partLegend,
      labels: partLabels.map((t) => t.slice(0, PART_LABEL_MAX)),
      ...(partLabelHidden.some(Boolean) ? { labelHidden: partLabelHidden } : {}),
    }))(
      toStyledGeometry(parts(), previewStyles().styles, hist.state.labels, hist.state.contested, hist.state.locked, hist.state.labelHidden),
    ),
    ...(hist.state.lines?.length ? { provinceBorders: storedLines(hist.state.lines) } : {}),
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
    borderIn.checked = s.nationalBorders === true;
    if (document.activeElement !== descIn) descIn.value = s.description;
    if (document.activeElement !== keyTitleIn) keyTitleIn.value = s.legendTitle;
    if (document.activeElement !== colorLabelIn) colorLabelIn.value = s.colorLabel;
    syncColours();
    idIn.disabled = !isNew;
    title.textContent = live ? `Edit together: ${live.map((x) => x.id).join(", ")}` : `${isNew ? "New region" : "Edit region"}: ${id || "(no id yet)"}`;
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
  colorLabelIn.addEventListener("input", () => (setProp("colorLabel", colorLabelIn.value.slice(0, LEGEND_LABEL_MAX), "Colour label"), changed()));
  opacityIn.addEventListener("input", () => (setProp("fillOpacity", Number(opacityIn.value), "Fill opacity"), changed()));
  labelIn.addEventListener("change", () => (setProp("label", labelIn.checked, "Label"), changed()));
  borderIn.addEventListener("change", () => (setProp("nationalBorders", borderIn.checked, "National borders"), changed()));
  descIn.addEventListener("input", () => (setProp("description", descIn.value, "Description"), changed()));
  keyTitleIn.addEventListener("input", () => (setProp("legendTitle", keyTitleIn.value.slice(0, LEGEND_TITLE_MAX), "Legend title"), changed()));

  /* ── Colours and legend ── */
  const entryName = (k: number) => (k === OWN_COLOUR ? hist.state.props.colorLabel.trim() || DEFAULT_COLOUR_NAME : hist.state.props.legend[k]?.label.trim() || `Colour ${k + 1}`);
  function setLegend(label: string, legend: EditorState["props"]["legend"], merge?: string): void {
    hist.apply(label, { ...hist.state, props: { ...hist.state.props, legend } }, merge);
    changed();
  }
  function addLegendEntry(): void {
    const l = hist.state.props.legend;
    if (l.length >= legendCap) return setMsg(`A legend can have at most ${LEGEND_MAX} colours.`, "error");
    setLegend("Add legend colour", [...l.map((e) => ({ ...e })), { label: "", color: nextLegendColour([hist.state.props.color, ...l.map((e) => e.color)]) }]);
    folders.querySelector<HTMLInputElement>(`.ed-folder[data-key="${l.length}"] input[type=text]`)?.focus();
  }
  function setPartStyle(p: number, k: number): void {
    // With several parts picked (Shift/Ctrl+click), the change applies to all of them.
    const ps = pickedNow().includes(p) ? pickedNow() : [p];
    const styles = [...hist.state.styles];
    for (const q of ps) styles[q] = k;
    hist.apply("Part colour", { ...hist.state, styles });
    setMsg(`${ps.length > 1 ? `${ps.length} parts` : `Part ${p + 1}`} moved to ${entryName(k)}.`, "ok");
    changed();
  }
  /** Bring forward (dir 1) or send backward (dir -1): part p moves past the nearest part it overlaps that way. */
  function moveLayer(p: number, dir: 1 | -1): void {
    const n = parts().length;
    const to = layerTarget(n, clashState().clashes.internal, p, dir);
    if (to < 0) return setMsg(dir > 0 ? `Part ${p + 1} is already the top layer.` : `Part ${p + 1} is already the bottom layer.`);
    // The part it now sits directly above (forward) or below (backward), at its new number.
    const other = dir > 0 ? to - 1 : to + 1;
    const wasOver = clashState().clashes.internal.some(([i, j]) => (i === p && j === to) || (j === p && i === to));
    hist.apply(dir > 0 ? "Bring forward" : "Send backward", reorderPart(hist.state, p, to));
    selection.clear();
    picked = [];
    hoverPart = -1;
    selPart = to;
    const where = wasOver ? `, ${dir > 0 ? "on top of" : "under"} ${partName(other)}` : "";
    setMsg(`Part ${p + 1} is now part ${to + 1}${where}.`, "ok");
    changed();
  }
  /** Editing together: moves part p (or every picked part, when it's one of them) to region `to`. Its colour stays. */
  function setPartOwner(p: number, to: string): void {
    if (!hist.state.owners || !live?.some((x) => x.id === to)) return;
    const ps = pickedNow().includes(p) ? pickedNow() : [p];
    const owners = [...hist.state.owners];
    const styles = [...hist.state.styles];
    for (const q of ps) {
      // A part in its old region's own colour takes its new region's own colour.
      const from = owners[q];
      const k = styles[q];
      if (from !== to && (k === OWN_COLOUR ? live[0].id === from : hist.state.props.legend[k]?.src === from && hist.state.props.legend[k]?.own)) {
        const own = ownEntry(hist.state, to);
        styles[q] = own >= 0 ? own : OWN_COLOUR;
      }
      owners[q] = to;
    }
    hist.apply("Move part to region", { ...hist.state, owners, styles });
    setMsg(`${ps.length > 1 ? `${ps.length} parts` : `Part ${p + 1}`} now belong${ps.length > 1 ? "" : "s"} to ${to}.`, "ok");
    changed();
  }
  function togglePartLock(p: number): void {
    if (p < 0 || p >= parts().length) return;
    const on = hist.state.locked[p] === false;
    hist.apply(on ? "Lock part" : "Unlock part", setLocked(hist.state, p, on));
    setMsg(on ? `Part ${p + 1} is locked: it won't move, but its vertices and midpoints still edit.` : `Part ${p + 1} is unlocked.`, "ok");
    changed();
  }
  /** Switches part p's label off or on in the embed (the text stays). */
  function togglePartLabel(p: number): void {
    if (p < 0 || p >= parts().length) return;
    const hide = hist.state.labelHidden[p] !== true;
    hist.apply(hide ? "Hide part label" : "Show part label", setLabelHidden(hist.state, p, hide));
    setMsg(hide ? `Part ${p + 1}'s label is hidden in the embed.` : `Part ${p + 1}'s label is shown in the embed.`, "ok");
    changed();
  }
  /** Switches the labels of every part in one colour folder off, or on when they are all off. */
  function toggleFolderLabels(members: number[]): void {
    const withText = members.filter((p) => hist.state.labels[p]?.trim());
    if (!withText.length) return;
    const hide = withText.some((p) => hist.state.labelHidden[p] !== true);
    hist.apply(hide ? "Hide labels" : "Show labels", setLabelsHidden(hist.state, members, hide));
    setMsg(hide ? "Labels of this colour are hidden in the embed." : "Labels of this colour are shown in the embed.", "ok");
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
  /** Colour folders the user folded away (by legend index, OWN_COLOUR for the region's own colour). */
  const folded = new Set<number>();
  function moveFolder(k: number, d: number): void {
    const j = k + d;
    if (j < 0 || j >= hist.state.props.legend.length) return;
    const a = folded.has(k);
    const b = folded.has(j);
    folded.delete(k);
    folded.delete(j);
    if (a) folded.add(j);
    if (b) folded.add(k);
    hist.apply("Reorder colours", moveLegendEntry(hist.state, k, d));
    changed();
  }
  function removeFolder(k: number): void {
    const shifted = [...folded].map((v) => (v > k ? v - 1 : v)).filter((v) => v !== k || !folded.has(k));
    folded.clear();
    for (const v of shifted) if (v !== k) folded.add(v);
    const n = hist.state.styles.filter((v) => v === k).length;
    hist.apply("Remove colour", live ? removeLiveEntry(hist.state, k) : removeLegendEntry(hist.state, k));
    setMsg(n ? `Colour removed; its ${n === 1 ? "part goes" : `${n} parts go`} to ${live ? "their region's own colour" : entryName(OWN_COLOUR)}.` : "Colour removed.", "ok");
    changed();
  }
  /** Clicks on a part row (not on its inputs): select that part; Shift or Ctrl/Cmd+click picks several. */
  function rowClick(p: number, ev: MouseEvent): void {
    setTool("select");
    if (ev.shiftKey || ev.ctrlKey || ev.metaKey) togglePick(p);
    else {
      picked = [];
      selectPart(p);
    }
  }
  /** One part's row: badge, label, colour (folder), then its actions. */
  function partRow(p: number): HTMLElement {
    const s = hist.state;
    const rings = s.parts[p];
    const sel = h("select", { ariaLabel: `Colour of part ${p + 1}`, title: "Move this part to another colour", dataset: { part: String(p) } });
    for (const k of [OWN_COLOUR, ...s.props.legend.map((_, i) => i)]) sel.append(h("option", { value: String(k), textContent: entryName(k) }));
    sel.addEventListener("change", () => setPartStyle(p, Number(sel.value)));
    const sw = h("i", { className: "ed-swatch ed-badge", textContent: String(p + 1), ariaHidden: "true" });
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
    const tiny = (text: string, title: string, act: string, onclick: (ev: MouseEvent) => void, extra = "") =>
      h("button", { type: "button", className: `ghost tiny${extra}`, textContent: text, title, dataset: { act }, onclick: (ev: MouseEvent) => (ev.stopPropagation(), onclick(ev)) });
    const n = s.parts.length;
    const acts = h(
      "span",
      { className: "ed-part-acts" },
      tiny("Select", `Select part ${p + 1} (Shift or Ctrl+click: pick several)`, "part-select", (ev) => rowClick(p, ev)),
      tiny("Centre", `Show part ${p + 1} on the map and the globe`, "part-centre", () => centrePart(p)),
      Object.assign(tiny("Forward", `Bring part ${p + 1} forward: on top of the next part it overlaps (])`, "part-forward", () => moveLayer(p, 1)), { disabled: p >= n - 1 }),
      Object.assign(tiny("Back", `Send part ${p + 1} backward: under the next part it overlaps ([)`, "part-backward", () => moveLayer(p, -1)), { disabled: p <= 0 }),
      tiny("Label", "", "part-label", () => togglePartLabel(p), " ed-labelbtn"),
      tiny("Lock", "", "part-lock", () => togglePartLock(p), " ed-lock"),
      tiny("Delete", `Delete part ${p + 1} (asks first)`, "part-delete", () => void askDeletePart(p), " danger"),
    );
    // Editing together: which region the part belongs to (and is saved to). Changing it moves the part.
    const ownerSel = live
      ? h(
          "select",
          { ariaLabel: `Region of part ${p + 1}`, title: "The region this part belongs to; pick another to move the part there", dataset: { partOwner: String(p) } },
          ...live.map((x) => h("option", { value: x.id, textContent: x.id, selected: s.owners?.[p] === x.id })),
        )
      : null;
    ownerSel?.addEventListener("change", () => setPartOwner(p, ownerSel.value));
    const row = h("div", { className: "ed-part-row", dataset: { row: String(p) } }, sw, lbl, sel, ownerSel, acts);
    // Shift/Ctrl+click picks parts: don't let the browser start a text selection across the rows.
    row.addEventListener("mousedown", (ev) => {
      if ((ev.shiftKey || ev.ctrlKey || ev.metaKey) && !(ev.target instanceof HTMLInputElement || ev.target instanceof HTMLSelectElement)) ev.preventDefault();
    });
    row.addEventListener("click", (ev) => {
      if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLSelectElement || ev.target instanceof HTMLButtonElement) return;
      rowClick(p, ev);
    });
    row.addEventListener("pointerenter", () => setHoverPart(p));
    row.addEventListener("pointerleave", () => setHoverPart(-1));
    return row;
  }
  /** One colour folder: a header (fold, colour, label, part count, + Part, and for added colours ↑ ↓ ×) and its parts. */
  function folder(k: number, members: number[]): HTMLElement {
    const s = hist.state;
    const own = k === OWN_COLOUR;
    let colour: HTMLInputElement;
    let name: HTMLInputElement;
    if (own) {
      colour = colorIn;
      name = colorLabelIn;
    } else {
      const e = s.props.legend[k];
      colour = h("input", { type: "color", value: e.color, ariaLabel: `Colour ${k + 1}`, dataset: { key: String(k) } });
      name = h("input", { type: "text", maxLength: LEGEND_LABEL_MAX, placeholder: `Colour ${k + 1}`, value: e.label, ariaLabel: `Label for colour ${k + 1}`, dataset: { key: String(k) } });
      colour.addEventListener("input", () => {
        const legend = hist.state.props.legend.map((x) => ({ ...x }));
        legend[k].color = colour.value.toLowerCase();
        setLegend("Legend colour", legend, `key-colour:${k}`);
      });
      name.addEventListener("input", () => {
        const legend = hist.state.props.legend.map((x) => ({ ...x }));
        legend[k].label = name.value.slice(0, LEGEND_LABEL_MAX);
        setLegend("Legend label", legend, `key-label:${k}`);
      });
    }
    const open = !folded.has(k);
    const body = h("div", { className: "ed-folder-body", hidden: !open });
    const fold = h("button", {
      type: "button",
      className: "ghost tiny ed-fold",
      textContent: open ? "▾" : "▸",
      title: open ? "Fold this colour's parts away" : "Show this colour's parts",
      ariaExpanded: String(open),
      dataset: { act: "fold" },
      onclick: () => {
        if (folded.has(k)) folded.delete(k);
        else folded.add(k);
        colourSig = "";
        syncColours();
      },
    });
    const count = h("span", { className: "muted small ed-count", textContent: `${members.length} part${members.length === 1 ? "" : "s"}`, title: "Parts drawn in this colour" });
    const add = h("button", {
      type: "button",
      className: "ghost tiny",
      textContent: "+ Part",
      title: "Draw a new part in this colour",
      dataset: { act: "folder-add-part" },
      onclick: () => {
        startDraw("part");
        newPartStyle = k;
        newPartOwner = live && !own ? (s.props.legend[k]?.src ?? null) : null;
      },
    });
    const labelsBtn = h("button", {
      type: "button",
      className: "ghost tiny",
      textContent: "Labels",
      title: "Show or hide the labels of every part in this colour",
      dataset: { act: "folder-labels" },
      onclick: () => toggleFolderLabels(members),
    });
    const head = h("div", { className: "ed-folder-head" }, fold, colour, name, count, labelsBtn, add);
    if (live) {
      const e = own ? null : s.props.legend[k];
      const from = own ? live[0].id : e?.src;
      head.append(h("span", { className: "badge ed-src", textContent: from ?? "new", title: from ? (own || e?.own ? `${from}'s own colour` : `A colour of ${from}`) : "Added here: saved into the legend of each region whose parts use it" }));
    }
    if (!own)
      head.append(
        Object.assign(btn("↑", "Move this colour up", () => moveFolder(k, -1), "key-up"), { disabled: k === 0 }),
        Object.assign(btn("↓", "Move this colour down", () => moveFolder(k, 1), "key-down"), { disabled: k === s.props.legend.length - 1 }),
        btn("×", `Remove this colour (its parts go to ${entryName(OWN_COLOUR)})`, () => removeFolder(k), "key-remove"),
      );
    body.append(...members.map((p) => partRow(p)));
    if (!members.length) body.append(h("p", { className: "muted small ed-empty", textContent: "No parts in this colour." }));
    return h("section", { className: `ed-folder${open ? "" : " folded"}`, dataset: { key: String(k) } }, head, body);
  }
  /** Rebuilds the folders and part rows only when their structure changes, so typing keeps focus. */
  let colourSig = "";
  function syncColours(): void {
    const s = hist.state;
    const sig = JSON.stringify([s.props.legend.length, s.styles, s.parts.map((r) => [r[0]?.length ?? 0, r.length]), [...folded], s.owners ?? null]);
    if (sig !== colourSig) {
      colourSig = sig;
      const keys = [OWN_COLOUR, ...s.props.legend.map((_, i) => i)];
      folders.replaceChildren(...keys.map((k) => folder(k, s.parts.flatMap((_, p) => ((s.styles[p] ?? OWN_COLOUR) === k ? [p] : [])))));
    }
    // Values that change without changing the structure.
    folders.querySelectorAll<HTMLInputElement>(".ed-folder-head input[data-key]").forEach((el) => {
      const e = s.props.legend[Number(el.dataset.key)];
      if (!e || document.activeElement === el) return;
      if (el.type === "color") el.value = e.color;
      else el.value = e.label;
    });
    folders.querySelectorAll<HTMLElement>(".ed-folder").forEach((fo) => {
      const b = fo.querySelector<HTMLButtonElement>("button[data-act=folder-labels]");
      if (!b) return;
      const members = s.parts.flatMap((_, p) => ((s.styles[p] ?? OWN_COLOUR) === Number(fo.dataset.key) ? [p] : []));
      const withText = members.filter((p) => s.labels[p]?.trim());
      const allOff = withText.length > 0 && withText.every((p) => s.labelHidden[p] === true);
      b.disabled = !withText.length;
      b.textContent = allOff ? "Labels off" : "Labels on";
      b.setAttribute("aria-pressed", String(!allOff));
    });
    const picks = pickedNow();
    folders.querySelectorAll<HTMLDivElement>(".ed-part-row").forEach((row) => {
      const p = Number(row.dataset.row);
      const k = s.styles[p] ?? OWN_COLOUR;
      const sel = row.querySelector<HTMLSelectElement>("select[data-part]")!;
      const lbl = row.querySelector<HTMLInputElement>("input[type=text]")!;
      if (document.activeElement !== lbl) lbl.value = s.labels[p] ?? "";
      // Option texts follow the colour labels as they're typed (rebuilding the rows would lose focus).
      for (const opt of sel.options) {
        const t = entryName(Number(opt.value));
        if (opt.textContent !== t) opt.textContent = t;
      }
      if (document.activeElement !== sel) sel.value = String(k);
      const badge = row.querySelector(".ed-swatch") as HTMLElement;
      badge.style.borderColor = partColour(p);
      row.classList.toggle("hot", p === hoverPart);
      row.classList.toggle("sel", p === selPart);
      row.classList.toggle("pick", picks.includes(p));
      row.querySelector("button[data-act=part-select]")?.setAttribute("aria-pressed", String(p === selPart));
      const lblOff = s.labelHidden[p] === true;
      row.classList.toggle("label-off", lblOff);
      const lblBtn = row.querySelector<HTMLButtonElement>("button[data-act=part-label]");
      if (lblBtn) {
        lblBtn.textContent = lblOff ? "Label off" : "Label on";
        lblBtn.title = lblOff ? `Show part ${p + 1}'s label in the embed again` : `Hide part ${p + 1}'s label in the embed (the text is kept)`;
        lblBtn.setAttribute("aria-pressed", String(!lblOff));
      }
      const locked = s.locked[p] !== false;
      row.classList.toggle("locked", locked);
      const lock = row.querySelector<HTMLButtonElement>("button[data-act=part-lock]");
      if (lock) {
        lock.textContent = locked ? "🔒 Locked" : "Lock";
        lock.title = locked ? `Unlock part ${p + 1} so it can be moved again (L)` : `Lock part ${p + 1}: it can't be moved, but its vertices and midpoints still edit (L)`;
        lock.setAttribute("aria-pressed", String(locked));
      }
    });
    addKeyBtn.disabled = s.props.legend.length >= legendCap;
  }

  /** After any state change: redraw, update the panel and the globe. */
  function changed(): void {
    // Drop selections that no longer exist.
    for (const [k, v] of selection) if (!parts()[v.p]?.[v.r]?.[v.i]) selection.delete(k);
    if (selPart >= parts().length) selPart = -1;
    // Any other edit while combining (undo, a delete in the Parts list…) makes the picked parts stale.
    if (combine && combine.version !== hist.version) closeCombine(true);
    syncPanel();
    undoBtn.disabled = !hist.canUndo;
    redoBtn.disabled = !hist.canRedo;
    draw();
    sendPreview();
  }

  /* ── Tools ── */
  /** Whether the drawing tools draw an open line (a split line or a province border) rather than an outline. */
  const lineTarget = () => target === "split" || target === "border";
  /** The drawing tool Add part, Cut and Split use: freehand until the polygon tool is picked. */
  let drawTool: "polygon" | "freehand" = "freehand";
  function setTool(t: Tool): void {
    if (drawing && t !== "polygon") drawing = null;
    tool = t;
    if (t !== "select") drawTool = t;
    if (t !== "polygon" && t !== "freehand") target = "part";
    canvas.style.cursor = t === "select" ? "default" : "crosshair";
    toggleSimplify(false);
    closeCombine(true);
    changed();
  }
  function drawHint(t: DrawTarget): string {
    const zone = "";
    if (t === "border")
      return drawTool === "freehand"
        ? "Drag a province border across the region; only the stretch inside it shows. It snaps to outlines and other borders. Press P for the polygon tool."
        : "Click points along the province border; double-click or Enter to finish. Points snap to outlines and other borders; click two points on one outline to follow it.";
    if (t === "split")
      return drawTool === "freehand"
        ? "Drag a line right across a part, from outside it to outside it; let go to split it. Press P for the polygon tool."
        : "Click points along a line right across a part, starting and ending outside it. Double-click or Enter to split.";
    if (t === "extend") {
      const which = extendTarget >= 0 ? `part ${extendTarget + 1}` : "the part you start in";
      return drawTool === "freehand"
        ? `Drag a shape that starts inside or touches ${which}; let go to add it. Press P for the polygon tool.`
        : `Click points around the land to add to ${which}, touching it. Double-click, Enter or click the first point to add it.`;
    }
    if (t === "cut")
      return drawTool === "freehand"
        ? "Drag around the area to cut away; let go to cut. Inside a part it makes a hole, right across a part it splits it."
        : "Click points around the area to cut away. Double-click, Enter or click the first point to cut.";
    if (drawTool === "freehand") return `${zone}Drag on the map to draw the outline; let go to close it. Along a border, the stroke follows it. Press P for the polygon tool.`;
    return `${zone}Click to add points. Double-click, Enter or click the lit-up first point to close. Click two points on one border to follow it (Tab: the other way round).`;
  }
  function startDraw(t: DrawTarget): void {
    closeCombine(true);
    if ((t === "cut" || t === "split" || t === "border") && !parts().length) return setMsg(`Draw a part first, then ${t === "border" ? "draw province borders in it" : `${t} it`}.`, "error");
    selLine = -1;
    target = t;
    drawing = null;
    tool = drawTool;
    canvas.style.cursor = "crosshair";
    setMsg(tipsOn ? drawHint(t) : "");
    changed();
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
    if (countVertices(parts()) + ring.length > vertexCap) {
      setMsg(`That would go over the ${MAX_VERTICES.toLocaleString()}-vertex limit.`, "error");
      return false;
    }
    if (target === "cut") return applyCut(cutParts(hist.state, [ring]), "Cut");
    if (target === "extend") return finishExtend(ring);
    const owner = newPartOwner ?? newOwner;
    let style = newPartStyle >= 0 && newPartStyle < hist.state.props.legend.length ? newPartStyle : OWN_COLOUR;
    // Editing together: the default colour of a new part is its own region's colour.
    if (live && style === OWN_COLOUR && ownEntry(hist.state, owner) >= 0) style = ownEntry(hist.state, owner);
    const s0 = hist.state;
    setParts(
      parts().length ? "Add part" : "Draw outline",
      addPart(parts(), ring),
      undefined,
      [...s0.styles, style],
      [...s0.labels, ""],
      [...s0.contested, -1],
      s0.locked,
      s0.labelHidden,
      s0.owners && [...s0.owners, owner],
    );
    setMsg(`Part ${parts().length} added to ${entryName(style)}${live ? ` in ${owner}` : ""}. Drag vertices to refine it.`, "ok");
    selPart = parts().length - 1;
    endDraw();
    return true;
  }
  function endDraw(): void {
    target = "part";
    newPartStyle = OWN_COLOUR;
    newPartOwner = null;
    extendTarget = -1;
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
    if (countVertices(res.state.parts) > vertexCap) {
      setMsg(`That would go over the ${MAX_VERTICES.toLocaleString()}-vertex limit.`, "error");
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

  /** Finishes a split line or a province border from the polygon or freehand tool. */
  function finishLine(line: Position[]): boolean {
    if (line.length < 2) {
      setMsg(`A ${target === "border" ? "province border" : "split line"} needs at least 2 points.`, "error");
      return false;
    }
    if (target === "border") return addBorder(line);
    return applyCut(splitParts(hist.state, line, undefined, ky), "Split");
  }
  /** Adds a province border (one undo step). */
  function addBorder(line: Position[]): boolean {
    const lines = hist.state.lines ?? [];
    const used = lines.reduce((n, l) => n + l.length, 0);
    if (used + line.length > PROVINCE_BORDER_MAX) {
      setMsg(`Province borders can have at most ${PROVINCE_BORDER_MAX.toLocaleString()} points in all.`, "error");
      return false;
    }
    const copy = lines.map((l) => l.map(([x, y]) => [x, y] as Position));
    const nl = line.map(([x, y]) => [x, y] as Position);
    // Starting (or ending) on the end of an existing border continues that border.
    const same = (a: Position, b: Position) => posKey(a) === posKey(b);
    const at = copy.findIndex((l) => same(l[l.length - 1], nl[0]) || same(l[0], nl[0]) || same(l[l.length - 1], nl[nl.length - 1]) || same(l[0], nl[nl.length - 1]));
    let sel = copy.length;
    if (at >= 0) {
      let base = copy[at];
      let add = nl;
      if (same(base[0], add[0]) || same(base[0], add[add.length - 1])) base = [...base].reverse(); // join at base's start: flip so the join is at its end
      if (!same(base[base.length - 1], add[0])) add = [...add].reverse();
      if (same(base[base.length - 1], add[0])) {
        const unwrapped = unwrapRing([...base, ...add.slice(1)]);
        copy[at] = unwrapped;
        sel = at;
      } else copy.push(nl);
    } else copy.push(nl);
    hist.apply(sel < lines.length ? "Extend province border" : "Add province border", { ...hist.state, lines: copy });
    selLine = sel;
    setMsg(sel < lines.length ? "Province border extended." : "Province border added. Click it to select it, drag its points, drag a midpoint to add one, Alt+click a point to remove it. Delete removes the border.", "ok");
    endDraw();
    return true;
  }
  /** A point or midpoint of the selected province border under the pointer: {k, pos, mid}. Points win over midpoints. */
  function hitLinePoint(x: number, y: number): { k: number; pos: Position; mid: boolean } | null {
    const line = (hist.state.lines ?? [])[selLine];
    if (!line) return null;
    const cl = wx(x);
    for (let k = line.length - 1; k >= 0; k--) {
      if (Math.hypot(sx(nearest(line[k][0], cl)) - x, sy(line[k][1]) - y) <= HIT) return { k, pos: line[k], mid: false };
    }
    for (let k = 0; k + 1 < line.length; k++) {
      const m: Position = [(line[k][0] + line[k + 1][0]) / 2, (line[k][1] + line[k + 1][1]) / 2];
      if (Math.hypot(sx(nearest(m[0], cl)) - x, sy(m[1]) - y) <= HIT - 1) return { k, pos: m, mid: true };
    }
    return null;
  }
  /** Snap targets for dragging a point of line l: everything but that line itself. */
  function lineDragSnap(l: number): { rings: SnapRing[]; skip: (ring: number) => boolean } {
    const rings = [...partRings(parts()), ...lineRings(), ...shownNbRings()];
    const mine = parts().reduce((n, rs) => n + rs.length, 0) + l;
    return { rings, skip: (i) => i === mine };
  }
  /** Removes point k of province border l (a border keeps at least 2 points: with 2 it deletes the border). */
  function deleteLinePoint(l: number, k: number): void {
    const lines = hist.state.lines ?? [];
    const line = lines[l];
    if (!line) return;
    if (line.length <= 2) return deleteBorder(l);
    hist.apply("Delete border point", { ...hist.state, lines: lines.map((q, i) => (i === l ? q.filter((_, j) => j !== k) : q.map(([x, y]) => [x, y] as Position))) });
    changed();
  }
  /** Deletes province border l (one undo step). */
  function deleteBorder(l: number): void {
    const lines = hist.state.lines ?? [];
    if (l < 0 || l >= lines.length) return;
    hist.apply("Delete province border", { ...hist.state, lines: lines.filter((_, i) => i !== l) });
    selLine = -1;
    setMsg("Province border deleted (undo brings it back).");
    changed();
  }
  /** The province border whose line passes within EDGE_HIT pixels of the point, or -1. */
  function hitBorder(x: number, y: number): number {
    const cl = wx(x);
    let best = -1;
    let bestD = EDGE_HIT;
    (hist.state.lines ?? []).forEach((line, l) => {
      for (let i = 1; i < line.length; i++) {
        const a = line[i - 1];
        const b = line[i];
        const shift = nearest((a[0] + b[0]) / 2, cl) - (a[0] + b[0]) / 2;
        const d = pointSegmentDistance(x, y, sx(a[0] + shift), sy(a[1]), sx(b[0] + shift), sy(b[1]));
        if (d <= bestD) {
          bestD = d;
          best = l;
        }
      }
    });
    return best;
  }

  /* ── Combine and extend ── */
  const partLabel = (p: number) => `part ${p + 1}${hist.state.labels[p]?.trim() ? ` (${hist.state.labels[p].trim()})` : ""}`;
  /** The Combine gap in map units (degrees of longitude, latitude scaled by ky), from screen pixels at this zoom. */
  const combineGap = () => Number(combRange.value) / view.k;
  /** combineParts, but a geometry-library failure becomes a message instead of an exception. */
  function tryMerge(f: () => MergeResult | string): MergeResult | string {
    try {
      return f();
    } catch (err) {
      console.warn("merge failed", err);
      return "The shapes are too tangled to merge here. Try a smaller gap, or simplify the parts first.";
    }
  }
  /** Bounding boxes of part outer rings, in unwrapped longitudes. */
  const partBox = (p: number) => {
    const r = parts()[p]?.[0] ?? [];
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const [x, y] of r) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    return { x0, y0, x1, y1 };
  };
  /** Parts whose boxes come within the gap of part p's (any copy of the map), and that can be combined with it. */
  function combineNeighbours(p: number): number[] {
    const a = partBox(p);
    const gx = combineGap();
    const gy = gx / ky;
    const out: number[] = [];
    parts().forEach((_, q) => {
      if (q === p || typeof combineKind(hist.state.contested, [p, q]) === "string") return;
      const b = partBox(q);
      const k = Math.round(((a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2) / 360) * 360;
      if (b.x0 + k > a.x1 + gx || b.x1 + k < a.x0 - gx || b.y0 > a.y1 + gy || b.y1 < a.y0 - gy) return;
      const res = tryMerge(() => combineParts(hist.state, [p, q], combineGap(), ky));
      if (typeof res !== "string") out.push(q);
    });
    return out;
  }
  /** "Combine…": opens the panel with the selected part and the parts touching it picked. */
  function openCombine(): void {
    if (parts().length < 2) return setMsg("Combine needs at least two parts.", "error");
    if (drawing) return;
    const pk = pickedNow();
    let p = selPart;
    if (pk.length < 2 && p < 0 && parts().length === 2) p = 0;
    if (pk.length < 2 && p < 0) return setMsg("Pick the parts to combine first: click one, then Shift+click the others. Then press C.", "error");
    if (tool !== "select") setTool("select");
    toggleSimplify(false);
    // The picked parts are what gets combined; with only one selected, its touching neighbours are offered.
    combine = { set: pk.length >= 2 ? [...pk] : [p, ...combineNeighbours(p)], res: "", version: hist.version };
    picked = [];
    combPanel.hidden = false;
    updateCombine();
    combRange.focus();
  }
  function closeCombine(quiet = false): void {
    if (!combine) return;
    combine = null;
    // Hiding the panel would drop the focus out of the dialog (and its shortcuts) if the slider had it.
    if (combPanel.contains(document.activeElement)) canvas.focus();
    combPanel.hidden = true;
    if (!quiet) setMsg("Combine cancelled.");
    draw();
  }
  function updateCombine(): void {
    if (!combine) return;
    combGapOut.textContent = ` ${combRange.value} px`;
    const set = combine.set;
    combine.res = set.length < 2 ? "Click another part on the map to combine it with " + partLabel(set[0]) + "." : tryMerge(() => combineParts(hist.state, set, combineGap(), ky));
    const res = combine.res;
    const names = set.map((q) => q + 1).join(", ");
    if (typeof res === "string") {
      combInfo.textContent = set.length < 2 ? res : `Parts ${names}: ${res}`;
      combInfo.className = `small ed-comb-info ${set.length < 2 ? "muted" : "error"}`;
    } else {
      combInfo.textContent = `Parts ${names} → one part (${partLabel(set[0])} keeps its place, colour and label)${res.filled ? ", gaps filled" : ""}.`;
      combInfo.className = "small ed-comb-info ok";
    }
    combApply.disabled = typeof res === "string";
    draw();
  }
  combRange.addEventListener("input", updateCombine);
  /** A click on the map while combining: adds or removes the part under the pointer. */
  function toggleCombinePart(here: number[], badge: number): void {
    if (!combine) return;
    const set = combine.set;
    const p = badge >= 0 ? badge : (here.find((q) => !set.includes(q)) ?? here.find((q) => set.includes(q) && q !== set[0]) ?? -1);
    if (p < 0) return;
    if (set.includes(p)) {
      if (p === set[0]) return setMsg(`${partLabel(p)} is the part the others combine into. Cancel to start from another part.`);
      combine.set = set.filter((q) => q !== p);
    } else {
      const why = combineKind(hist.state.contested, [...set, p]);
      if (typeof why === "string") return setMsg(why, "error");
      combine.set = [...set, p];
    }
    updateCombine();
  }
  function applyCombine(): void {
    if (!combine) return;
    const res = typeof combine.res === "string" ? combine.res : tryMerge(() => combineParts(hist.state, combine!.set, combineGap(), ky));
    if (typeof res === "string") return setMsg(res, "error");
    if (countVertices(res.state.parts) > vertexCap) return setMsg(`That would go over the ${MAX_VERTICES.toLocaleString()}-vertex limit.`, "error");
    const prob = res.problem ?? ringProblem([res.state.parts[res.into]])?.message.toLowerCase();
    if (prob) return setMsg(`Can't combine: ${prob}`, "error");
    const n = combine.set.length;
    hist.apply(`Combine ${n} parts`, res.state);
    selection.clear();
    closeCombine(true);
    selPart = res.into;
    setMsg(`Combined ${n} parts into ${partLabel(res.into)}${res.filled ? ", filling the gaps between them" : ""}. Ctrl+Z undoes it.`, "ok");
    changed();
    selectPart(res.into);
  }
  /** The Combine preview: picked parts outlined, the result drawn dashed over them. */
  function drawCombine(offs: number[]): void {
    if (!combine) return;
    g.save();
    g.lineWidth = 3;
    g.lineJoin = "round";
    g.strokeStyle = "#ffd400";
    g.beginPath();
    for (const p of combine.set) for (const ring of parts()[p] ?? []) traceRing(g, ring, sx, sy, offs);
    g.stroke();
    if (typeof combine.res !== "string") {
      const rings = combine.res.state.parts[combine.res.into];
      g.beginPath();
      for (const ring of rings) traceRing(g, ring, sx, sy, offs);
      g.fillStyle = "rgba(255,255,255,.18)";
      g.fill("evenodd");
      g.setLineDash([6, 4]);
      g.lineWidth = 2;
      g.strokeStyle = "#ffffff";
      g.stroke();
    }
    g.restore();
  }

  /** "Extend": draw land onto the selected part (or, with none selected, the part the shape starts in). */
  function startExtend(): void {
    if (!parts().length) return setMsg("Draw a part first, then extend it.", "error");
    extendTarget = selPart >= 0 ? selPart : parts().length === 1 ? 0 : -1;
    startDraw("extend");
  }
  function finishExtend(ring: Position[]): boolean {
    let p = extendTarget;
    if (p < 0) p = partAt(parts(), ring[0], hist.state.contested);
    if (p < 0) {
      setMsg("Start the shape inside the part you want to extend, or select the part first.", "error");
      return false;
    }
    const res = tryMerge(() => extendPart(hist.state, p, ring, EXTEND_GAP_PX / view.k, ky));
    if (typeof res === "string") {
      setMsg(res, "error");
      return false;
    }
    if (countVertices(res.state.parts) > vertexCap) {
      setMsg(`That would go over the ${MAX_VERTICES.toLocaleString()}-vertex limit.`, "error");
      return false;
    }
    const prob = res.problem ?? ringProblem([res.state.parts[res.into]])?.message.toLowerCase();
    if (prob) {
      setMsg(`Can't extend there: ${prob}`, "error");
      return false;
    }
    hist.apply(`Extend part ${p + 1}`, res.state);
    selection.clear();
    setMsg(`Extended ${partLabel(p)}. Drag vertices to refine it; Ctrl+Z undoes it.`, "ok");
    endDraw();
    selectPart(res.into);
    return true;
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
  /** The ring whose line passes within EDGE_HIT pixels of the point, nearest first; vertices and midpoints are tested before this. */
  function hitEdge(x: number, y: number): { p: number; r: number } | null {
    const cl = wx(x);
    let best: { p: number; r: number } | null = null;
    let bestD = EDGE_HIT;
    parts().forEach((rings, p) =>
      rings.forEach((ring, r) => {
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i];
          const b = ring[(i + 1) % ring.length];
          const shift = nearest((a[0] + b[0]) / 2, cl) - (a[0] + b[0]) / 2;
          const d = pointSegmentDistance(x, y, sx(a[0] + shift), sy(a[1]), sx(b[0] + shift), sy(b[1]));
          if (d <= bestD) {
            bestD = d;
            best = { p, r };
          }
        }
      }),
    );
    return best;
  }
  /** Selects every vertex of a ring (Shift adds to the selection). */
  function pickRing(ring: { p: number; r: number }, add: boolean): void {
    if (!add) selection.clear();
    for (const v of ringRefs(parts(), ring.p, ring.r)) selection.set(vkey(v), v);
    setMsg(ring.r === 0 ? `Outline of part ${ring.p + 1} selected: Delete removes the whole part (asks first).` : `Hole in part ${ring.p + 1} selected: Delete removes it.`);
  }
  /* ── Snapping, tracing along borders, attached vertices (see snap.ts) ── */
  /** The neighbours' rings, as snap targets (they never change while the editor is open). */
  const nbSnapRings: SnapRing[] = neighbours.flatMap((f, n) =>
    polygonsOf(f.geometry).flatMap((poly) => poly.map((r, ri) => snapRing(openRing(unwrapRing(r)), { kind: "neighbour", n, r: ri }))),
  );
  /** Only the neighbours switched on in the "Other regions" panel are snap targets: you can't snap to what you can't see. */
  const shownNbRings = (): SnapRing[] => nbSnapRings.filter((r) => r.src.kind === "neighbour" && overlays.visible(r.src.n));
  /** A neighbouring region's name, for the status line (plain text: names are untrusted). */
  const neighbourName = (n: number): string => {
    const f = neighbours[n];
    return f ? f.properties.name?.trim() || f.id : "another region";
  };
  let ringCache: { version: number; rings: SnapRing[] } = { version: -1, rings: [] };
  /** Every snap target for the current parts: the region's own rings, then the neighbours'. */
  function snapRings(): SnapRing[] {
    if (ringCache.version !== hist.version) ringCache = { version: hist.version, rings: [...partRings(parts()), ...lineRings(), ...shownNbRings(), ...coastRings()] };
    return ringCache.rings;
  }
  /** The coastline as snap targets, when coast snapping is on (at full detail, or simplified to `tol` degrees). */
  const coastRings = (tol = 0): SnapRing[] => (coast && coastOn ? (tol ? coast.ringsAt(tol) : coast.rings()) : []);
  /**
   * The nearest snap within reach: a vertex or line of a part, province border or region first;
   * only when there's none, the coast. Rings that `skip` returns true for are left out.
   */
  function snapIn(rings: readonly SnapRing[], pos: Position, skip?: (ring: number) => boolean): Snap | null {
    const sc = scale();
    const isCoast = (i: number) => rings[i].src.kind === "coast";
    const first = findSnap(rings, pos, sc, SNAP_PX, (i) => isCoast(i) || !!skip?.(i));
    if (first || !coastActive()) return first;
    return findSnap(rings, pos, sc, SNAP_PX, (i) => !isCoast(i) || !!skip?.(i));
  }
  /** The province borders as snap targets (open lines). */
  const lineRings = (): SnapRing[] => (hist.state.lines ?? []).map((l, i) => snapRing(l, { kind: "line", l: i }));
  const scale = () => ({ k: view.k, ky });
  /** Where a point would snap (null when snapping is off or nothing is near). */
  const snapAt = (pos: Position, rings: readonly SnapRing[] = snapRings(), skip: (ring: number) => boolean = extendSkip): Snap | null =>
    snapOn ? snapIn(rings, pos, skip) : null;
  /** Extending a part: its own outline isn't a snap target (the tool already joins a shape that touches or nearly touches it). */
  const extendSkip = (ri: number): boolean => {
    const src = snapRings()[ri]?.src;
    return target === "extend" && extendTarget >= 0 && src?.kind === "part" && src.p === extendTarget;
  };
  function snapName(sn: Snap, rings: readonly SnapRing[]): string {
    const src = rings[sn.ring]?.src;
    if (!src) return "";
    const what = sn.kind === "vertex" ? "vertex" : "line";
    if (src.kind === "part") return `${what} of ${src.r ? `a hole in ${partName(src.p)}` : partName(src.p)}`;
    if (src.kind === "line") return `${what} of province border ${src.l + 1}`;
    if (src.kind === "coast") return "the coast";
    return `${what} of region ${neighbourName(src.n)}`;
  }
  function toggleSnap(): void {
    snapOn = !snapOn;
    if (!snapOn) snapHint = null;
    try {
      localStorage.setItem(SNAP_PREF, snapOn ? "on" : "off");
    } catch {
      /* not remembered: fine */
    }
    setMsg(snapOn ? "Snapping on: points snap to other parts' and regions' vertices and lines. Hold Ctrl to place one freely." : "Snapping off.");
    draw();
  }
  /** Vertices of the region's own rings that sit on the same spot as another (attached), per state. */
  let glueCache: { version: number; index: ReturnType<typeof vertexIndex>; glued: Set<string> } = { version: -1, index: new Map(), glued: new Set() };
  function glue(): typeof glueCache {
    // While a drag moves vertices, the attached ones move together, so who is attached doesn't change.
    if (glueCache.version === hist.version || (hist.dragging && glueCache.version >= 0)) return glueCache;
    const index = vertexIndex(parts());
    const glued = new Set<string>();
    for (const list of index.values()) if (list.length > 1) for (const v of list) glued.add(vkey(v));
    glueCache = { version: hist.version, index, glued };
    return glueCache;
  }
  /** `refs` with the vertices attached to them. */
  const glued = (refs: VRef[]): VRef[] => withGlued(parts(), refs, glue().index);
  /** The border vertices to add between the last drawn point and `next`, when both snapped to the same ring. */
  function traceTo(next: Snap | null, from = drawSnaps[drawSnaps.length - 1]): Snap[] {
    if (!next || !from || from.ring !== next.ring || target === "split") return [];
    const rings = snapRings();
    const ring = rings[next.ring];
    if (!ring) return [];
    let tr = traceBetween(ring.pts, from, next, ky, traceFlip, ring.src.kind === "line");
    // The coast is traced finely: add only as many of its points as the screen shows.
    if (ring.src.kind === "coast" && tr.length > 2) {
      const all = [from.pos, ...tr.map((t) => t.pos), next.pos];
      // (Never finer than a pixel of the raster the coast was traced on: finer is just its stair-steps.)
      const tol = Math.max(0.75 / view.k, coast ? 360 / coast.data.width : 0);
      tr = thinTrace(all, tol, ky)
        .filter((i) => i > 0 && i < all.length - 1)
        .map((i) => tr[i - 1]);
    }
    return tr.map((t) => ({ pos: t.pos, ring: next.ring, at: t.at, kind: "vertex" as const }));
  }
  /** Whether a click at screen (x, y) would close the outline on its first point. */
  const closesAt = (x: number, y: number) => !!drawing && !lineTarget() && drawing.length >= 3 && Math.hypot(sx(drawing[0][0]) - x, sy(drawing[0][1]) - y) <= CLOSE_R;
  /** What the polygon tool would add on the next click (for the preview), and whether it follows a border. */
  function pendingTail(): { pts: Position[]; traced: boolean } | null {
    if (!drawing || !cursor || tool !== "polygon") return null;
    if (closesAt(sx(cursor[0]), sy(cursor[1]))) {
      const tr = traceTo(drawSnaps[0]);
      return { pts: [...tr.map((t) => t.pos), drawing[0]], traced: tr.length > 0 };
    }
    const sn = snapHint?.snap ?? null;
    const tr = traceTo(sn);
    return { pts: [...tr.map((t) => t.pos), sn ? sn.pos : cursor], traced: tr.length > 0 };
  }

  /* ── Edits ── */
  function deleteRefs(refs: VRef[], label = refs.length > 1 ? `Delete ${refs.length} vertices` : "Delete vertex"): void {
    if (!refs.length) return;
    // A vertex attached to other parts' vertices goes with them, so the shared border stays shared.
    refs = glued(refs);
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
      res.kept.map((p) => hist.state.locked[p] ?? true),
      res.kept.map((p) => hist.state.labelHidden[p] === true),
      hist.state.owners && res.kept.map((p) => hist.state.owners![p]),
    );
    selection.clear();
    if (res.removedParts) selPart = selPart >= 0 ? res.kept.indexOf(selPart) : -1;
    const orphans = zones.orphaned ? ` ${zones.orphaned === 1 ? "Its contested zone is" : `Its ${zones.orphaned} contested zones are`} now normal part${zones.orphaned === 1 ? "" : "s"}.` : "";
    setMsg(
      res.removedParts
        ? `A ring needs at least 3 vertices, so the whole part was deleted (undo brings it back).${orphans}`
        : res.removedHoles
          ? "Hole deleted (undo brings it back)."
          : "",
      res.removedParts ? "error" : res.removedHoles ? "ok" : "muted",
    );
    changed();
  }
  /** Deletes a whole part after a warning, every time. Undo brings it back. */
  async function askDeletePart(p: number): Promise<void> {
    const s = hist.state;
    if (p < 0 || p >= s.parts.length) return;
    const name = `Part ${p + 1}${s.labels[p]?.trim() ? ` (${s.labels[p].trim()})` : ""}`;
    const rings = s.parts[p];
    const verts = rings.reduce((n, r) => n + r.length, 0);
    const text = [
      `This deletes ${name} with all ${verts} of its vertices${rings.length > 1 ? ` and ${rings.length - 1} hole(s)` : ""}.`,
      s.parts.length === 1 ? "It's the only part, so the region will have no outline left." : "",
      "You can undo this with Ctrl+Z until you close the editor.",
    ]
      .filter(Boolean)
      .join(" ");
    if (!(await confirmBox(`Delete ${name}?`, text, "Delete part", "Keep it", true))) return;
    // The state may have moved on while the warning was open; only go ahead if it's the same part.
    if (hist.state !== s) return setMsg("The region changed while the warning was open, so nothing was deleted.", "error");
    const res = deleteParts(s.parts, [p]);
    const remapped = remapContested(s.contested, res.kept);
    // Province borders that lay in the deleted part go with it.
    const owners = lineCarry(s.parts, s.lines ?? [], s.contested).owners;
    const keptLines = (s.lines ?? []).filter((_, l) => owners[l] !== p);
    setParts(
      `Delete part ${p + 1}`,
      res.parts,
      `del-lines:${p}`,
      res.kept.map((k) => s.styles[k] ?? OWN_COLOUR),
      res.kept.map((k) => s.labels[k] ?? ""),
      remapped.contested,
      res.kept.map((k) => s.locked[k] ?? true),
      res.kept.map((k) => s.labelHidden[k] === true),
      s.owners && res.kept.map((k) => s.owners![k]),
    );
    if (keptLines.length !== (s.lines ?? []).length) hist.apply(`Delete part ${p + 1}`, { ...hist.state, lines: keptLines }, `del-lines:${p}`);
    selection.clear();
    selPart = -1;
    setMsg(`${name} deleted (undo brings it back).`);
    changed();
  }
  function nudge(dxPx: number, dyPx: number): void {
    const dLon = dxPx / view.k;
    const dLat = -dyPx / (view.k * ky);
    if (selection.size) {
      const refs = glued([...selection.values()]);
      const keys = new Set(refs.map(vkey));
      const next = parts().map((rings, p) => rings.map((ring, r) => ring.map((pt, i) => (keys.has(vkey({ p, r, i })) ? ([pt[0] + dLon, Math.max(-90, Math.min(90, pt[1] + dLat))] as Position) : pt))));
      const prob = ringProblem(next, refs);
      if (prob) return setMsg(prob.message, "error");
      // Same parts, same count: the province borders pinned to the nudged vertices go with them.
      const lb = lineBase(parts());
      hist.apply("Nudge", { ...hist.state, parts: next, lines: carryLines(lb.baseLines, lb.carry, parts(), next, []) }, "nudge");
    } else if (parts().length) {
      const one = selPart >= 0 && !!parts()[selPart];
      const plan = moveSet(one ? selPart : null);
      if ("refused" in plan) return setMsg(plan.refused, "error");
      const moved = translate(parts(), plan.parts, dLon, dLat);
      const lb = lineBase(parts());
      hist.apply(one ? "Nudge part" : "Nudge shape", { ...hist.state, parts: moved, lines: carryLines(lb.baseLines, lb.carry, parts(), moved, plan.parts) }, one ? "nudge-part" : "nudge");
    }
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
  /** Whether coast lines are snap targets right now. */
  const coastActive = () => !!coast && coastOn && snapOn;
  /** Coast lines on screen, simplified to about a pixel. */
  function drawCoast(offs: number[]): void {
    if (!coast) return;
    const tol = 1 / view.k;
    const w = canvas.width / (window.devicePixelRatio || 1);
    const hgt = canvas.height / (window.devicePixelRatio || 1);
    g.save();
    g.lineWidth = 1;
    g.strokeStyle = COAST_COLOUR;
    g.setLineDash([]);
    g.beginPath();
    for (const r of coast.ringsAt(tol)) {
      const [west, south, east, north] = r.box;
      if (sy(north) > hgt || sy(south) < 0) continue;
      for (const off of offs) {
        if (sx(east + off) < 0 || sx(west + off) > w) continue;
        r.pts.forEach(([x, y], i) => (i ? g.lineTo(sx(x + off), sy(y)) : g.moveTo(sx(x + off), sy(y))));
        g.closePath();
      }
    }
    g.stroke();
    g.restore();
  }
  function toggleCoast(): void {
    if (!coast) return;
    coastOn = !coastOn;
    try {
      localStorage.setItem(COAST_PREF, coastOn ? "on" : "off");
    } catch {
      /* not remembered: fine */
    }
    ringCache.version = -1;
    snapHint = null;
    if (coastOn && !snapOn) toggleSnap();
    setMsg(
      coastOn
        ? "Coast snapping on: points also snap to the coastline (amber) where no part or region is in reach. Click two points on the coast to follow it; hold Ctrl to place a point freely."
        : "Coast snapping off: points snap to parts and regions only.",
    );
    draw();
    updateStatus();
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
    if (!next) return setMsg(`Smoothing would go over the ${MAX_VERTICES.toLocaleString()}-vertex limit.`, "error");
    const prob = ringProblem(next);
    if (prob) return setMsg(`Can't smooth: ${prob.message.toLowerCase()}`, "error");
    setParts("Smooth", next);
    const n = countVertices(next);
    setMsg(`Smoothed: ${n.toLocaleString()} vertices.${n >= WARN_VERTICES ? ` Close to the ${MAX_VERTICES.toLocaleString()} limit.` : ""}`, n >= WARN_VERTICES ? "error" : "ok");
    changed();
  }

  /** The lines as they are and what carries them, for a drag that starts from `base` parts. */
  function lineBase(base: Parts): { baseLines: Position[][]; carry: LineCarry } {
    const baseLines = hist.state.lines ?? [];
    return { baseLines, carry: lineCarry(base, baseLines, hist.state.contested) };
  }
  /** Snap targets for dragging `refs`: everything but the rings they belong to (so nothing snaps to itself). */
  function dragSnap(base: Parts, refs: VRef[]): { rings: SnapRing[]; skip: (ring: number) => boolean } {
    const rings = [...partRings(base), ...lineRings(), ...shownNbRings(), ...coastRings()];
    const moving = new Set(refs.map((q) => `${q.p}:${q.r}`));
    return {
      rings,
      skip: (i) => {
        const src = rings[i].src;
        return src.kind === "part" && moving.has(`${src.p}:${src.r}`);
      },
    };
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
    if (combine) return void toggleCombinePart(partsAt(parts(), w0, hist.state.contested), hitBadge(x, y));
    const free = e.ctrlKey || e.metaKey;
    if (tool === "polygon") {
      const sn = free ? null : snapAt(w0);
      const at = sn ? sn.pos : w0;
      if (!drawing) {
        drawing = [at];
        drawSnaps = [sn];
      } else if (closesAt(x, y)) {
        // Closing on the first point: follow the border back to it when both ends are on one.
        const tr = free ? [] : traceTo(drawSnaps[0]);
        traceFlip = false;
        return void finishRing([...drawing, ...tr.map((t) => t.pos)]);
      } else {
        const last = drawing[drawing.length - 1];
        if (Math.hypot(sx(last[0]) - sx(at[0]), sy(last[1]) - sy(at[1])) > 2) {
          for (const t of traceTo(sn)) {
            drawing.push(t.pos);
            drawSnaps.push(t);
          }
          drawing.push(at);
          drawSnaps.push(sn);
        }
      }
      traceFlip = false;
      return draw();
    }
    if (tool === "freehand") {
      drag = { kind: "free", pts: [w0] };
      return draw();
    }
    // Select tool.
    edgePick = null;
    if (selLine >= 0 && !simplifyPreview) {
      const lh = hitLinePoint(x, y);
      if (lh) {
        const lines = hist.state.lines ?? [];
        if (lh.mid) {
          // A midpoint of the selected border: insert a point there and drag it.
          const next = lines.map((l) => l.map(([qx, qy]) => [qx, qy] as Position));
          next[selLine].splice(lh.k + 1, 0, [lh.pos[0], lh.pos[1]]);
          hist.begin();
          hist.preview({ ...hist.state, lines: next });
          drag = { kind: "lvertex", l: selLine, k: lh.k + 1, base: next, x0: x, y0: y, moved: true, ...lineDragSnap(selLine) };
          return changed();
        }
        if (e.altKey) return deleteLinePoint(selLine, lh.k);
        hist.begin();
        drag = { kind: "lvertex", l: selLine, k: lh.k, base: lines, x0: x, y0: y, moved: false, ...lineDragSnap(selLine) };
        return draw();
      }
    }
    const v = hitVertex(x, y);
    if (v) {
      if (e.altKey) return deleteRefs([v]);
      const k = vkey(v);
      const was = selection.has(k);
      if (!was) {
        if (!e.shiftKey) selection.clear();
        selection.set(k, v);
      }
      const chosen = [...selection.values()];
      // Attached vertices (other parts' vertices on the same spot) come along, unless Ctrl pulls this one free.
      const refs = free ? chosen : glued(chosen);
      const vp = parts()[v.p][v.r][v.i];
      beginClashDrag(refs.map((r) => r.p));
      hist.begin();
      drag = {
        kind: "vertex",
        base: parts(),
        refs,
        grab: v,
        x0: x,
        y0: y,
        w0: [nearest(vp[0], w0[0]), vp[1]],
        moved: false,
        label: chosen.length > 1 ? `Move ${chosen.length} vertices` : "Move vertex",
        toggle: was && e.shiftKey,
        ...dragSnap(parts(), refs),
        ...lineBase(parts()),
      };
      return draw();
    }
    const m = hitMidpoint(x, y);
    if (m) {
      // On a shared border the vertex goes into both sides, attached.
      const edges = [{ p: m.p, r: m.r, i: m.i }, ...(free ? [] : sharedEdges(parts(), m.p, m.r, m.i, glue().index))];
      beginClashDrag(edges.map((q) => q.p));
      hist.begin();
      const ins = edges.length > 1 ? insertOnEdges(parts(), edges, m.pos) : (({ parts: ps, v: nv }) => ({ parts: ps, refs: [nv] }))(insertVertex(parts(), m.p, m.r, m.i, m.pos));
      const grab = ins.refs.find((q) => q.p === m.p && q.r === m.r) ?? ins.refs[0];
      hist.preview({ ...hist.state, parts: ins.parts });
      selection = new Map([[vkey(grab), grab]]);
      drag = {
        kind: "vertex",
        base: ins.parts,
        refs: ins.refs,
        grab,
        x0: x,
        y0: y,
        w0: [nearest(m.pos[0], w0[0]), m.pos[1]],
        moved: true,
        label: "Insert vertex",
        toggle: false,
        ...dragSnap(ins.parts, ins.refs),
        ...lineBase(ins.parts),
      };
      changed();
      return;
    }
    // On a province border (and not on an outline): a click selects it, a drag draws a selection box.
    if (!e.altKey && !hitEdge(x, y) && hitBorder(x, y) >= 0) {
      drag = { kind: "box", x0: x, y0: y, x1: x, y1: y, add: e.shiftKey };
      return;
    }
    // On a line: a click selects its ring, a drag falls through to the usual part move / box select.
    if (!e.altKey) edgePick = hitEdge(x, y);
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
      if (e.shiftKey && !e.ctrlKey && !e.metaKey) return togglePick(p);
      const i = here.indexOf(p);
      if (picked.length && !pickedNow().includes(p)) picked = [];
      selectPart(p, here.length > 1 && i >= 0 ? `Part ${p + 1} (${i + 1} of ${here.length} here, Alt+click for the next)` : "");
      const whole = e.ctrlKey || e.metaKey;
      const plan = moveSet(whole ? null : p);
      // Locked: the drag draws a selection box instead (to pick the part's vertices), and says why.
      if ("refused" in plan) {
        drag = { kind: "box", x0: x, y0: y, x1: x, y1: y, add: e.shiftKey, refused: plan.refused };
        return;
      }
      const moving = plan.parts;
      beginClashDrag(moving ?? parts().map((_, k) => k));
      hist.begin();
      const baseLines = hist.state.lines ?? [];
      drag = { kind: "shape", base: parts(), part: moving, w0, moved: false, baseLines, carry: lineCarry(parts(), baseLines, hist.state.contested) };
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
    const free = e.ctrlKey || e.metaKey;
    if (tool === "polygon" || tool === "freehand") {
      const sn = free || simplifyPreview ? null : snapAt(cursor);
      snapHint = sn ? { snap: sn, rings: snapRings() } : null;
    }
    if (!drag) {
      if (tool === "select") {
        const over = hitVertex(x, y) || hitMidpoint(x, y) || hitEdge(x, y);
        const under = cursor ? partAt(parts(), cursor, hist.state.contested) : -1;
        canvas.style.cursor = spaceHeld ? "grab" : over ? "pointer" : under >= 0 && hist.state.locked[under] === false ? "move" : "default";
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
      if (drag.refused && Math.hypot(x - drag.x0, y - drag.y0) >= 3) {
        setMsg(drag.refused, "error");
        drag.refused = "";
      }
      return draw();
    }
    if (drag.kind === "free") {
      const last = drag.pts[drag.pts.length - 1];
      if (Math.hypot(sx(last[0]) - x, sy(last[1]) - y) >= 2) drag.pts.push([wx(x), wy(y)]);
      return draw();
    }
    if (drag.kind === "lvertex") {
      if (!drag.moved && Math.hypot(x - drag.x0, y - drag.y0) < 3) return;
      drag.moved = true;
      let at: Position = [cursor[0], cursor[1]];
      snapHint = null;
      if (snapOn && !free) {
        const t = findSnap(drag.rings, at, scale(), SNAP_PX, drag.skip);
        if (t) {
          at = t.pos;
          snapHint = { snap: t, rings: drag.rings };
        }
      }
      const old = drag.base[drag.l][drag.k];
      at = [nearest(at[0], old[0]), Math.max(-90, Math.min(90, at[1]))];
      const { l: dl, k: dk, base: dbase } = drag;
      const moved = at;
      hist.preview({ ...hist.state, lines: dbase.map((q, i) => (i === dl ? q.map((pt, j) => (j === dk ? moved : pt)) : q)) });
      return changed();
    }
    if (drag.kind === "shape") {
      drag.moved = true;
      const next = translate(drag.base, drag.part, cursor[0] - drag.w0[0], cursor[1] - drag.w0[1]);
      hist.preview({ ...hist.state, parts: next, lines: carryLines(drag.baseLines, drag.carry, drag.base, next, drag.part) });
      return changed();
    }
    // Vertex drag.
    if (!drag.moved && Math.hypot(x - drag.x0, y - drag.y0) < 3) return;
    drag.moved = true;
    let dLon = cursor[0] - drag.w0[0];
    let dLat = cursor[1] - drag.w0[1];
    snapHint = null;
    if (snapOn && !free) {
      const g0 = drag.base[drag.grab.p][drag.grab.r][drag.grab.i];
      const want: Position = [g0[0] + dLon, g0[1] + dLat];
      const t = snapIn(drag.rings, want, drag.skip);
      if (t) {
        dLon = t.pos[0] - g0[0];
        dLat = t.pos[1] - g0[1];
        snapHint = { snap: t, rings: drag.rings };
      }
    }
    const refs = drag.refs;
    // Only the rings holding a dragged vertex are rebuilt (indices per ring, no string keys: a 70,000-vertex ring would allocate 70,000 of them per move).
    const moved = new Map<string, Set<number>>();
    for (const v of refs) {
      const k = `${v.p}:${v.r}`;
      (moved.get(k) ?? moved.set(k, new Set()).get(k)!).add(v.i);
    }
    const next = drag.base.map((rings, p) =>
      rings.map((ring, r) => {
        const at = moved.get(`${p}:${r}`);
        return at ? ring.map((q, i) => (at.has(i) ? ([q[0] + dLon, Math.max(-90, Math.min(90, q[1] + dLat))] as Position) : q)) : ring;
      }),
    );
    problem = ringProblem(next, refs);
    hist.preview({ ...hist.state, parts: next, lines: carryLines(drag.baseLines, drag.carry, drag.base, next, []) });
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
    if (d?.kind === "vertex" || d?.kind === "lvertex") snapHint = null;
    if (!d) return;
    if (d.kind === "pan") canvas.style.cursor = spaceHeld ? "grab" : "default";
    if (d.kind === "box") {
      const [x0, x1] = [Math.min(d.x0, d.x1), Math.max(d.x0, d.x1)];
      const [y0, y1] = [Math.min(d.y0, d.y1), Math.max(d.y0, d.y1)];
      if (!d.add) selection.clear();
      // A plain click on empty map clears the selected part too.
      // (Not a click on a locked part: that click selected it.)
      const click = x1 - x0 <= 2 && y1 - y0 <= 2;
      if (click && !d.add && d.refused === undefined && !edgePick) selectPart(-1);
      if (click) {
        const bl = hitBorder(d.x0, d.y0);
        if (bl >= 0 && !edgePick) selLine = bl;
        else if (!edgePick && !d.add) selLine = -1;
      }
      if (click && edgePick) pickRing(edgePick, d.add);
      edgePick = null;
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
      // Stretches drawn along a border follow that border's own vertices (unless snapping is off or Ctrl is held).
      const follow = snapOn && !(e.ctrlKey || e.metaKey);
      // (The coast at about the sketch's own precision, so following it adds no more points than drawing would.)
      const rings = [...snapRings().filter((r) => r.src.kind !== "coast"), ...coastRings(tol / 2)];
      const traced = (closedRing: boolean) => followBorders(d.pts, (q) => snapIn(rings, q, extendSkip), rings, ky, tol, closedRing).pts;
      if (lineTarget()) {
        if (d.pts.length < 2) return draw();
        const line = follow ? traced(false) : douglasPeucker(d.pts.map(([px, py]) => [px, py * ky]), tol).map(([px, py]) => [px, py / ky] as Position);
        if (!finishLine(line)) draw();
        return;
      }
      if (d.pts.length < 3) return draw();
      const xs = d.pts.map((q) => sx(q[0]));
      const ys = d.pts.map((q) => sy(q[1]));
      if (Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) < MIN_STROKE) {
        setMsg("That stroke was too short to be an outline, so nothing was drawn.", "error");
        return draw();
      }
      // A stroke that overshoots its start and crosses itself there is trimmed back to the loop; it closes only here, on release.
      if (!finishRing(trimStrokeOvershoot(follow ? traced(true) : simple(d.pts), ky))) draw();
      return;
    }
    if (d.kind === "lvertex") {
      if (d.moved) hist.commit("Move border point");
      else hist.cancel();
      return changed();
    }
    if (d.kind === "shape") {
      canvas.style.cursor = "default";
      if (d.moved) hist.commit(d.part === null ? "Move region" : d.part.length > 1 ? "Move part and its zones" : "Move part");
      else {
        hist.cancel();
        if (edgePick) pickRing(edgePick, e.shiftKey);
      }
      edgePick = null;
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
    if (!drag) snapHint = null;
    setHoverPart(-1);
    draw();
  });
  canvas.addEventListener("dblclick", (e) => {
    if (tool !== "polygon" || !drawing) return;
    e.preventDefault();
    // The double-click's second click added a point on top of the previous one; drop it.
    const pts = drawing.filter((p, i) => i === 0 || Math.hypot(sx(p[0]) - sx(drawing![i - 1][0]), sy(p[1]) - sy(drawing![i - 1][1])) > 3);
    if (lineTarget()) {
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
  /** Backspace or right-click while drawing: take back the last point (repeatable, back to nothing). */
  function undoDrawPoint(): void {
    if (!drawing) return;
    drawing.pop();
    drawSnaps.length = drawing.length;
    if (!drawing.length) drawing = null;
    draw();
  }
  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault(); // the browser menu never opens on the map
    if (drawing) {
      hideMenu();
      return undoDrawPoint();
    }
    if (tool !== "select") return;
    const { x, y } = local(e);
    const v = hitVertex(x, y);
    if (!v) {
      // Inside a part: offer to delete the whole part.
      const here = partsAt(parts(), [wx(x), wy(y)], hist.state.contested);
      const badge = hitBadge(x, y);
      const p = badge >= 0 ? badge : here.includes(selPart) ? selPart : (here[0] ?? -1);
      if (p < 0) return hideMenu();
      selectPart(p);
      ctxMenu.replaceChildren(
        h("button", { type: "button", role: "menuitem", className: "danger-item", textContent: `Delete part ${p + 1}…`, onclick: () => (hideMenu(), void askDeletePart(p)) }),
      );
      ctxMenu.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      ctxMenu.hidden = false;
      (ctxMenu.firstElementChild as HTMLElement).focus();
      return;
    }
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
    if (e.key === "Enter" && combine && !drawing) {
      e.preventDefault();
      return applyCombine();
    }
    if (e.key === "Enter" && drawing) {
      e.preventDefault();
      return void (lineTarget() ? finishLine(drawing) : finishRing(drawing));
    }
    if (e.key === "Backspace" && drawing) {
      e.preventDefault();
      return undoDrawPoint();
    }
    if (e.key === "Tab" && drawing && tool === "polygon" && !mod) {
      // Trace the other way round the border the next click follows.
      e.preventDefault();
      traceFlip = !traceFlip;
      return draw();
    }
    if ((e.key === "Delete" || e.key === "Backspace") && tool === "select" && selection.size) {
      e.preventDefault();
      // A fully selected outline is a whole part: that goes through the same warning as deleting the part.
      const outlines = fullyChosenRings(parts(), [...selection.values()]).filter((q) => q.r === 0);
      if (outlines.length === 1) return void askDeletePart(outlines[0].p);
      if (outlines.length > 1) return setMsg("Several whole outlines are selected. Select one outline at a time to delete a part.", "error");
      return deleteRefs([...selection.values()]);
    }
    if ((e.key === "Delete" || e.key === "Backspace") && tool === "select" && selLine >= 0 && !selection.size && !drawing) {
      e.preventDefault();
      return deleteBorder(selLine);
    }
    if ((e.key === "Delete" || e.key === "Backspace") && tool === "select" && selPart >= 0 && !drawing) {
      e.preventDefault();
      return void askDeletePart(selPart);
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
    else if (k === "s") toggleSnap();
    else if (k === "l" && selPart >= 0) togglePartLock(selPart);
    else if ((e.key === "]" || e.key === "[") && selPart >= 0 && !drawing) moveLayer(selPart, e.key === "]" ? 1 : -1);
    else if (k === "c" && !drawing) openCombine();
    else if (k === "e" && !drawing) startExtend();
    else if (k === "o") toggleCoast();
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
    if (!overlays.panel.hidden) return overlays.close();
    if (combine) return closeCombine();
    if (drawing || drag?.kind === "free") {
      drawing = null;
      drag = null;
      setMsg("Outline cancelled.");
      return draw();
    }
    if (target === "extend" && (tool === "polygon" || tool === "freehand")) {
      setMsg("Extend cancelled.");
      return endDraw();
    }
    if (selection.size) {
      selection.clear();
      return draw();
    }
    if (picked.length) return clearPicks();
    if (selPart >= 0) return selectPart(-1);

    void tryClose();
  });

  function showHelp(): void {
    const m = modal("Keyboard shortcuts", "help-dlg");
    const cb = h("input", { type: "checkbox", checked: tipsOn, id: "tips-toggle" }) as HTMLInputElement;
    cb.addEventListener("change", () => {
      tipsOn = cb.checked;
      try {
        localStorage.setItem("ed-tips", tipsOn ? "on" : "off");
      } catch {
        /* ignore */
      }
      if (!tipsOn) setMsg("");
      else if (target) setMsg(drawHint(target));
      updateStatus();
    });
    m.body.append(h("label", { className: "muted small" }, cb, " Show drawing tips above the map"));
    m.body.append(h("dl", { className: "shortcuts" }, ...SHORTCUTS.flatMap(([k, v]) => [h("dt", {}, h("kbd", { textContent: k })), h("dd", { textContent: v })])));
  }

  function embed(): void {
    if (isNew) return alertBox("Save first", "Save the region before copying its embed code: the embed loads the saved region by its id.");
    openEmbedDialog({ region: { id, name: id, label: hist.state.props.label, hasLegend: hist.state.props.legend.length > 0 }, slot: slotName, slotTitle: slot.title ?? map?.name ?? slotName });
  }

  /* ── Save ── */
  /** Who created the region and when: kept from the saved region; the saver's own for a new one (also a duplicate or a combination). */
  let creator: Pick<RegionFeature["properties"], "created" | "createdBy"> | null = isNew
    ? null
    : { ...(o.feature?.properties.created ? { created: o.feature.properties.created } : {}), ...(o.feature?.properties.createdBy ? { createdBy: o.feature.properties.createdBy } : {}) };
  function creatorFields(fresh: boolean): Pick<RegionFeature["properties"], "created" | "createdBy"> {
    if (fresh || !creator) creator = { created: stamp(), createdBy: account() };
    return creator;
  }
  /**
   * The file for state `s` saved as region `fid`, without who saved it when (the caller adds that), or
   * why it can't be saved.
   */
  function featureOf(s: EditorState, fid: string): RegionFeature | string {
    const { geometry, partLegend, partLabels, partLabelHidden, partLocked } = toStyledGeometry(s.parts, s.styles, s.labels, s.contested, s.locked, s.labelHidden);
    const provinceLines = storedLines(s.lines ?? []);
    const errs = [
      ...checkGeometry(geometry),
      ...checkParts({ slot: slotName, map: slot.map, color: s.props.color, ...(provinceLines.length ? { provinceBorders: provinceLines } : {}) }, geometry, "Province borders"),
    ];
    if (errs.length) return errs[0];
    const props = s.props;
    return {
      $schema: "../../schema/region.schema.json",
      type: "Feature",
      id: fid,
      properties: {
        slot: slotName,
        map: slot.map,
        color: props.color,
        ...(props.colorLabel.trim() ? { colorLabel: props.colorLabel.trim().slice(0, LEGEND_LABEL_MAX) } : {}),
        fillOpacity: Math.round(props.fillOpacity * 100) / 100,
        label: props.label,
        ...(props.description.trim() ? { description: props.description.trim().slice(0, 500) } : {}),
        ...((props.legend.length || props.colorLabel.trim()) && props.legendTitle.trim() ? { legendTitle: props.legendTitle.trim().slice(0, LEGEND_TITLE_MAX) } : {}),
        ...(props.legend.length
          ? { legend: props.legend.map((e) => ({ label: e.label.trim().slice(0, LEGEND_LABEL_MAX), color: e.color })), partLegend }
          : {}),
        ...(partLabels.some((t) => t.trim()) ? { partLabels: partLabels.map((t) => t.trim().slice(0, PART_LABEL_MAX)) } : {}),
        ...(partLabelHidden.some(Boolean) && partLabels.some((t) => t.trim()) ? { partLabelHidden } : {}),
        ...(partLocked.some((l) => !l) ? { partLocked } : {}),
        ...(provinceLines.length ? { provinceBorders: provinceLines } : {}),
        ...(props.nationalBorders ? { nationalBorders: true } : {}),
      },
      geometry,
    };
  }
  let saving = false;
  async function save(): Promise<void> {
    if (saving) return;
    if (live) return saveLive();
    const s = hist.state;
    if (isNew) {
      if (!REGION_ID.test(id)) return setMsg("The id must be lowercase letters, digits and dashes.", "error"), idIn.focus();
      if (o.takenIds.has(id)) return setMsg(`The id "${id}" is taken. Choose another one.`, "error"), idIn.focus();
    }
    if (!s.parts.length) return setMsg("Draw the region first.", "error");
    const built = featureOf(s, id);
    if (typeof built === "string") return setMsg(built, "error");
    const feature: RegionFeature = { ...built, properties: { ...built.properties, updated: stamp(), ...creatorFields(isNew), updatedBy: account() } };
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

  /* ── Editing several regions together ── */
  /** Each region's file as the editor would write it (without the save stamps), to save only the regions that changed. */
  const coreText = (sp: { id: string; state: EditorState }): string => {
    const f = featureOf(sp.state, sp.id);
    return typeof f === "string" ? `!${f}` : serialize(f);
  };
  /** Live: what each region's file is as saved (in editor form), by id. */
  const baseline = new Map<string, string>(live ? splitLive(liveState(liveSources), liveSources).map((x) => [x.id, coreText(x)]) : []);
  const liveChanged = () => splitLive(hist.state, liveSources).filter((x) => coreText(x) !== baseline.get(x.id));

  async function saveLive(): Promise<void> {
    if (!live) return;
    const changedNow = liveChanged();
    if (!changedNow.length) return setMsg("Nothing to save: no region changed.", "ok");
    const bad = changedNow.find((x) => x.problem);
    if (bad) return setMsg(bad.problem!, "error");
    const files: { src: (typeof live)[number]; feature: RegionFeature; text: string; core: string }[] = [];
    for (const x of changedNow) {
      const src = live.find((y) => y.id === x.id)!;
      const built = featureOf(x.state, x.id);
      if (typeof built === "string") return setMsg(`${x.id}: ${built}`, "error");
      const sp = src.feature.properties;
      const feature: RegionFeature = {
        ...built,
        properties: {
          ...built.properties,
          updated: stamp(),
          ...(sp.created ? { created: sp.created } : {}),
          ...(sp.createdBy ? { createdBy: sp.createdBy } : {}),
          updatedBy: account(),
        },
      };
      files.push({ src, feature, text: serialize(feature), core: serialize(built) });
    }
    const ids = files.map((f) => f.src.id);
    saving = true;
    saveBtn.disabled = true;
    setMsg(`Saving ${ids.join(", ")}…`);
    try {
      const commitSha = await o.gh.commit(`Save region${ids.length > 1 ? "s" : ""} ${ids.join(", ")}`, async () => {
        const stale: string[] = [];
        await Promise.all(
          files.map(async (f) => {
            if ((await o.gh.fileSha(regionPath(f.src.id))) !== f.src.sha) stale.push(f.src.id);
          }),
        );
        if (stale.length) throw new Conflict(stale.sort().join(", "));
        return files.map((f) => ({ path: regionPath(f.src.id), content: f.text }));
      });
      for (const f of files) {
        f.src.sha = await gitBlobSha(f.text);
        f.src.feature = f.feature;
        baseline.set(f.src.id, f.core);
      }
      saved = JSON.stringify(hist.state);
      setMsg(`Saved ${ids.join(", ")} in commit ${commitSha.slice(0, 7)} to ${o.gh.branch}.`, "ok");
      syncPanel();
      void o.afterCommit(commitSha);
    } catch (e) {
      if (e instanceof Conflict) void liveConflict(e.message);
      else setMsg((e as Error).message, "error");
    } finally {
      saving = false;
      saveBtn.disabled = false;
    }
  }

  /** Opens the editor again on another set of regions, keeping unsaved changes of the ones that stay. */
  function reopen(sources: NonNullable<EditorOptions["live"]>["sources"]): void {
    if (!o.live) return;
    close();
    const ids = new Set(sources.map((x) => x.id));
    openEditor({ ...o, feature: sources[0].feature, sha: sources[0].sha, neighbours: o.live.neighboursFor(ids), live: { ...o.live, sources, view: { ...view } } });
  }

  async function liveConflict(which: string): Promise<void> {
    const reload = await confirmBox(
      "Changed on GitHub",
      `Someone changed ${which} on GitHub since you opened it. Reload every region from GitHub (your unsaved changes here are lost), or keep editing without saving over their change.`,
      "Reload from GitHub",
      "Keep editing",
    );
    if (!reload || !live) return setMsg("Not saved. The version on GitHub is newer.", "error");
    try {
      const fresh = await Promise.all(
        live.map(async (x) => {
          const f = await o.gh.readFile(regionPath(x.id)).catch(() => null);
          return f ? { id: x.id, sha: f.sha, feature: JSON.parse(f.text) as RegionFeature } : null;
        }),
      );
      const kept = fresh.filter((x): x is NonNullable<typeof x> => !!x);
      if (!kept.length) return close();
      reopen(kept);
    } catch (e) {
      setMsg((e as Error).message, "error");
    }
  }

  /** "Regions…": add regions to this view or take them out. */
  function openLiveRegions(): void {
    if (!live || !o.live) return;
    const pool = o.live.pool();
    const inView = new Set(live.map((x) => x.id));
    const changedIds = new Set(liveChanged().map((x) => x.id));
    const m = modal("Regions in this view", "combine-dlg");
    const boxes = new Map<string, HTMLInputElement>();
    const out = h("p", { className: "small", role: "status", ariaLive: "polite" });
    const go = h("button", { type: "button", textContent: "Apply", dataset: { action: "live-apply" } });
    const order = [...live.map((x) => x.id), ...pool.map((x) => x.id).filter((x) => !inView.has(x)).sort()];
    const list = h(
      "div",
      { className: "combine-list" },
      ...order.map((rid) => {
        const box = h("input", { type: "checkbox", value: rid, checked: inView.has(rid) });
        boxes.set(rid, box);
        box.addEventListener("change", update);
        return h("label", { className: "check" }, box, h("span", { textContent: rid }), changedIds.has(rid) ? h("span", { className: "badge warn", textContent: "unsaved changes" }) : null);
      }),
    );
    function picked(): string[] {
      return order.filter((rid) => boxes.get(rid)!.checked);
    }
    function update(): void {
      const ids = picked();
      const dropped = live!.map((x) => x.id).filter((rid) => !ids.includes(rid) && changedIds.has(rid));
      go.disabled = !ids.length || ids.length > MAX_LIVE;
      out.className = dropped.length || go.disabled ? "warn small" : "muted small";
      out.textContent = !ids.length
        ? "Keep at least one region."
        : ids.length > MAX_LIVE
          ? `At most ${MAX_LIVE} regions can be edited together (one save writes at most ${MAX_LIVE}).`
          : dropped.length
            ? `Taking out ${dropped.join(", ")} discards ${dropped.length > 1 ? "their" : "its"} unsaved changes. Save first to keep them.`
            : "Unsaved changes of the regions that stay are kept. Undo history starts again.";
    }
    go.addEventListener("click", () => {
      const ids = picked();
      if (!ids.length || ids.length > MAX_LIVE) return;
      // Unsaved changes of the regions that stay come along: the editor reopens from each one's current state.
      const now = new Map(splitLive(hist.state, liveSources).map((x) => [x.id, x]));
      const sources = ids.map((rid) => {
        const had = live!.find((x) => x.id === rid);
        if (had) return { id: rid, sha: had.sha, feature: had.feature, ...(changedIds.has(rid) ? { current: now.get(rid)!.state } : {}) };
        const p = pool.find((x) => x.id === rid)!;
        return { id: rid, sha: p.sha, feature: p.feature };
      });
      m.close();
      reopen(sources);
    });
    m.body.append(h("p", { className: "small", textContent: "Tick the regions to edit together. Only regions on this slot that you may edit are listed." }), list, out);
    m.foot.append(h("button", { type: "button", className: "ghost", textContent: "Cancel", onclick: m.close }), go);
    update();
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
      creator = { ...(fresh.properties.created ? { created: fresh.properties.created } : {}), ...(fresh.properties.createdBy ? { createdBy: fresh.properties.createdBy } : {}) };
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
  if (o.live?.view) {
    view = { ...o.live.view };
    touched = true;
  }
  setTool(parts().length ? "select" : "freehand");
  if (!parts().length && tipsOn) setMsg(drawHint("part"));
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
    selectedVertices: () => [...selection.values()],
    clashes: () => clashState().clashes,
    snapOn: () => snapOn,
    coastLines: () => coast?.data.lines.length ?? 0,
    coastOn: () => coastActive(),
    borders: () => clashState().spec.borders ?? null,
    lines: () => (hist.state.lines ?? []).map((l) => l.map((q) => [...q])),
    drawing: () => (drawing ? drawing.map((q) => [...q]) : null),
  };
}
