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
  geometryBounds,
  globeToImage,
  imageToGlobe,
  mapGeometry,
  pointInRing,
  polygonsOf,
  round,
  simplifyRing,
  type Position,
  type RegionGeometry,
} from "../../shared/geo.ts";
import { paintRegion, traceGeometry, traceRing } from "../../shared/raster.ts";
import { REGION_COLOR, REGION_ID, DEFAULT_FILL_OPACITY, flatFit, flatMinK, slugify, uniqueId, type RegionData, type RegionFeature } from "../../shared/region.ts";
import { clampPadding } from "../../shared/params.ts";
import type { MapMeta, SlotsFile } from "../../shared/types.ts";
import { h } from "../dom.ts";
import type { GitHub } from "../github.ts";
import { loadMapImage } from "../images.ts";
import { alertBox, confirmBox, modal, openEmbedDialog, previewUrl, sendRegion } from "../region-dialogs.ts";
import { oneLine, regionPath, serialize, stamp } from "../regions.ts";
import {
  History,
  addHole,
  addPart,
  countVertices,
  deleteVertices,
  insertVertex,
  partAt,
  partsFromGeometry,
  ringProblem,
  simplifyParts,
  smoothParts,
  toGeometry,
  translate,
  vkey,
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

export const SHORTCUTS: [string, string][] = [
  ["V / P / F", "Select, polygon and freehand tools"],
  ["Click (polygon)", "Add a point; double-click, Enter or click the first point to close"],
  ["Backspace (drawing)", "Remove the last point"],
  ["Esc", "Cancel the outline being drawn, or clear the selection"],
  ["Drag a vertex", "Move it; hold Shift to snap to a neighbouring region's vertex"],
  ["Drag a midpoint", "Insert a vertex there"],
  ["Alt+click / right-click", "Delete a vertex"],
  ["Shift+click, box drag", "Select several vertices"],
  ["Delete / Backspace", "Delete the selected vertices"],
  ["Drag inside the fill", "Move the whole shape; Ctrl+drag moves one part"],
  ["Arrow keys", "Nudge the selection (or the shape) 1 px; Shift for 10 px"],
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

  const fp = o.feature?.properties;
  const hist = new History({
    parts: o.feature ? partsFromGeometry(o.feature.geometry) : [],
    props: {
      name: fp?.name ?? "",
      color: fp && REGION_COLOR.test(fp.color) ? expandHex(fp.color) : "#c0392b",
      fillOpacity: fp?.fillOpacity ?? DEFAULT_FILL_OPACITY,
      label: fp?.label ?? true,
      description: fp?.description ?? "",
    },
  });
  let id = o.feature?.id ?? "";
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

  const toolBtn = (t: Tool, text: string, key: string) =>
    h("button", { type: "button", className: "ghost tool", textContent: text, title: `${text} (${key})`, dataset: { tool: t }, onclick: () => setTool(t) });
  const btn = (text: string, title: string, onclick: () => void, data = "") =>
    h("button", { type: "button", className: "ghost", textContent: text, title, onclick, dataset: data ? { act: data } : {} });
  const undoBtn = btn("Undo", "Undo (Ctrl+Z)", () => undo(), "undo");
  const redoBtn = btn("Redo", "Redo (Ctrl+Shift+Z or Ctrl+Y)", () => redo(), "redo");
  const gridBtn = btn("Grid", "Show the globe's 15° grid (G)", () => toggleGrid(), "grid");
  const simplifyBtn = btn("Simplify…", "Fewer vertices, same shape", () => toggleSimplify(), "simplify");
  const smoothBtn = btn("Smooth", "Round the corners (one Chaikin pass; doubles the vertices)", () => smooth(), "smooth");

  const nameIn = h("input", { type: "text", maxLength: 80, required: true, placeholder: "e.g. Kingdom of Vael", value: hist.state.props.name, name: "name" });
  const idIn = h("input", { type: "text", maxLength: 64, spellcheck: false, value: id, name: "id", pattern: "[a-z0-9][a-z0-9\\-]{0,63}" });
  const colorIn = h("input", { type: "color", value: hist.state.props.color, name: "color" });
  const opacityIn = h("input", { type: "range", min: "0", max: "1", step: "0.05", value: String(hist.state.props.fillOpacity), name: "opacity" });
  const opacityOut = h("output", {});
  const labelIn = h("input", { type: "checkbox", checked: hist.state.props.label, name: "label" });
  const descIn = h("textarea", { maxLength: 500, rows: 3, value: hist.state.props.description, name: "description" });
  const stats = h("p", { className: "muted small ed-stats" });
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
      toolBtn("select", "Select", "V"),
      toolBtn("polygon", "Polygon", "P"),
      toolBtn("freehand", "Freehand", "F"),
      h("span", { className: "sep" }),
      btn("Add part", "Draw another polygon (an island or exclave)", () => startDraw("part"), "add-part"),
      btn("Cut hole", "Draw a hole inside a part", () => startDraw("hole"), "cut-hole"),
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
        h("label", {}, "Name", nameIn),
        h("label", {}, "Id (permanent; embeds use it)", idIn),
        h("p", { className: "muted small", textContent: `Slot: ${slotName} · map: ${slot.map}` }),
        h("div", { className: "row" }, h("label", { className: "inline" }, "Colour", colorIn), h("label", { className: "inline grow" }, "Fill", opacityIn, opacityOut)),
        h("label", { className: "check" }, labelIn, "Show label in embed"),
        h("label", {}, "Description (plain text)", descIn),
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

  /* ── Map image (2048, or 4096 when zoomed far in on a large screen) ── */
  let img: HTMLImageElement | null = null;
  let imgW = 0;
  let upgrading = false;
  if (map) void loadMapImage(map, 2048).then((i) => ((img = i), (imgW = 2048), draw()), () => setMsg("The map image isn't deployed yet; you can still draw.", "error"));
  function maybeUpgrade(): void {
    if (!map || upgrading || imgW >= 4096 || !map.sizes["4096"]) return;
    if (360 * view.k * (window.devicePixelRatio || 1) < 3000 || innerWidth < 1100) return;
    upgrading = true;
    void loadMapImage(map, 4096).then((i) => ((img = i), (imgW = 4096), draw()), () => {});
  }

  /* ── State ── */
  let tool: Tool = "select";
  let target: "part" | "hole" = "part";
  let drawing: Position[] | null = null;
  let cursor: Position | null = null;
  let selection = new Map<string, VRef>();
  let problem: RingProblem | null = null;
  let gridOn = false;
  let simplifyPreview: Parts | null = null;
  let spaceHeld = false;
  type Drag =
    | { kind: "vertex"; base: Parts; refs: VRef[]; grab: VRef; x0: number; y0: number; w0: Position; moved: boolean; label: string; toggle: boolean }
    | { kind: "shape"; base: Parts; part: number | null; w0: Position; moved: boolean }
    | { kind: "pan"; x0: number; y0: number; v0: typeof view }
    | { kind: "box"; x0: number; y0: number; x1: number; y1: number; add: boolean }
    | { kind: "free"; pts: Position[] }
    | null;
  let drag: Drag = null;
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch: { d: number; mx: number; my: number } | null = null;

  const parts = () => hist.state.parts;
  const setParts = (label: string, next: Parts, merge?: string) => hist.apply(label, { ...hist.state, parts: next }, merge);

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
    if (p.length) {
      paintRegion(g, asGeometry(parts()), sx, sy, offs, { color: s.color, fillOpacity: simplifyPreview ? s.fillOpacity * 0.4 : s.fillOpacity, lineWidth: 2 }, { w, h: hh });
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
    let line = `${tool === "select" ? "Select" : tool === "polygon" ? (target === "hole" ? "Cut hole" : "Polygon") : "Freehand"} · ${n} vertices`;
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
    name: hist.state.props.name.slice(0, 80),
    color: hist.state.props.color,
    fillOpacity: hist.state.props.fillOpacity,
    label: hist.state.props.label,
    geometry: toGeometry(parts()),
  });
  let previewRaf = 0;
  let lastSent = -1;
  function sendPreview(centre = false): void {
    if (centre) return sendRegion(frameEl, regionNow(), true);
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
    if (document.activeElement !== nameIn) nameIn.value = s.name;
    colorIn.value = s.color;
    opacityIn.value = String(s.fillOpacity);
    opacityOut.value = `${Math.round(s.fillOpacity * 100)}%`;
    labelIn.checked = s.label;
    if (document.activeElement !== descIn) descIn.value = s.description;
    idIn.disabled = !isNew;
    title.textContent = `${isNew ? "New region" : "Edit region"}: ${s.name || "(unnamed)"}`;
  }
  const setProp = <K extends keyof EditorState["props"]>(k: K, v: EditorState["props"][K], label: string) =>
    hist.apply(label, { ...hist.state, props: { ...hist.state.props, [k]: v } }, `prop:${k}`);
  nameIn.addEventListener("input", () => {
    setProp("name", nameIn.value, "Rename");
    if (isNew && !idTouched) {
      id = uniqueId(nameIn.value || "region", o.takenIds);
      idIn.value = id;
    }
    changed();
  });
  let idTouched = !!o.feature;
  idIn.addEventListener("input", () => {
    idTouched = true;
    id = idIn.value.trim();
  });
  idIn.addEventListener("change", () => {
    id = slugify(idIn.value) || id;
    idIn.value = id;
    changed();
  });
  colorIn.addEventListener("input", () => (setProp("color", colorIn.value.toLowerCase(), "Colour"), changed()));
  opacityIn.addEventListener("input", () => (setProp("fillOpacity", Number(opacityIn.value), "Fill opacity"), changed()));
  labelIn.addEventListener("change", () => (setProp("label", labelIn.checked, "Label"), changed()));
  descIn.addEventListener("input", () => (setProp("description", descIn.value, "Description"), changed()));

  /** After any state change: redraw, update the panel and the globe. */
  function changed(): void {
    // Drop selections that no longer exist.
    for (const [k, v] of selection) if (!parts()[v.p]?.[v.r]?.[v.i]) selection.delete(k);
    syncPanel();
    undoBtn.disabled = !hist.canUndo;
    redoBtn.disabled = !hist.canRedo;
    draw();
    sendPreview();
  }

  /* ── Tools ── */
  function setTool(t: Tool): void {
    if (drawing && t !== "polygon") drawing = null;
    tool = t;
    if (t !== "polygon" && t !== "freehand") target = "part";
    canvas.style.cursor = t === "select" ? "default" : "crosshair";
    toggleSimplify(false);
    changed();
  }
  function startDraw(t: "part" | "hole"): void {
    if (t === "hole" && !parts().length) return setMsg("Draw a part first, then cut a hole inside it.", "error");
    target = t;
    drawing = null;
    tool = "polygon";
    canvas.style.cursor = "crosshair";
    setMsg(t === "hole" ? "Click inside a part to start the hole." : "Click to add points. Double-click, Enter or click the first point to close.");
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
    if (countVertices(parts()) + ring.length > MAX_VERTICES) {
      setMsg(`That would go over the ${MAX_VERTICES}-vertex limit.`, "error");
      return false;
    }
    if (target === "hole") {
      const p = parts().findIndex((rings) => rings[0] && pointInRing(ring[0], rings[0]));
      if (p < 0 || !ring.every((pt) => pointInRing(pt, parts()[p][0]))) {
        setMsg("A hole has to be drawn completely inside a part.", "error");
        return false;
      }
      setParts("Cut hole", addHole(parts(), ring)!);
    } else setParts(parts().length ? "Add part" : "Draw outline", addPart(parts(), ring));
    setMsg(`${target === "hole" ? "Hole" : "Outline"} added. Drag vertices to refine it.`, "ok");
    target = "part";
    drawing = null;
    tool = "select";
    canvas.style.cursor = "default";
    changed();
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
    setParts(label, res.parts);
    selection.clear();
    setMsg(
      res.removedParts
        ? "A ring needs at least 3 vertices, so the whole part was deleted (undo brings it back)."
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
    } else if (parts().length) setParts("Nudge shape", translate(parts(), null, dLon, dLat), "nudge");
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
      if (!drawing) {
        if (target === "hole") {
          const p = partAt(parts(), w0);
          if (p < 0 && !parts().some((rings) => rings[0] && pointInRing(w0, rings[0]))) return setMsg("Start the hole inside a part.", "error");
        }
        drawing = [w0];
      } else {
        const f = drawing[0];
        if (drawing.length >= 3 && Math.hypot(sx(f[0]) - x, sy(f[1]) - y) <= HIT) return void finishRing(drawing);
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
      hist.begin();
      drag = { kind: "vertex", base: parts(), refs, grab: v, x0: x, y0: y, w0: [nearest(vp[0], w0[0]), vp[1]], moved: false, label: refs.length > 1 ? `Move ${refs.length} vertices` : "Move vertex", toggle: was && e.shiftKey };
      return draw();
    }
    const m = hitMidpoint(x, y);
    if (m) {
      hist.begin();
      const ins = insertVertex(parts(), m.p, m.r, m.i, m.pos);
      hist.preview({ ...hist.state, parts: ins.parts });
      selection = new Map([[vkey(ins.v), ins.v]]);
      drag = { kind: "vertex", base: ins.parts, refs: [ins.v], grab: ins.v, x0: x, y0: y, w0: [nearest(m.pos[0], w0[0]), m.pos[1]], moved: true, label: "Insert vertex", toggle: false };
      changed();
      return;
    }
    const p = partAt(parts(), w0);
    if (p >= 0) {
      hist.begin();
      drag = { kind: "shape", base: parts(), part: e.ctrlKey || e.metaKey ? p : null, w0, moved: false };
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
        canvas.style.cursor = spaceHeld ? "grab" : over ? "pointer" : partAt(parts(), cursor) >= 0 ? "move" : "default";
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
      if (d.pts.length < 3) return draw();
      // Simplify the sketch: Douglas–Peucker at about 2 screen pixels.
      const tol = 2 / view.k;
      const ring = simplifyRing(d.pts.map(([px, py]) => [px, py * ky]), tol).map(([px, py]) => [px, py / ky] as Position);
      if (!finishRing(ring)) draw();
      return;
    }
    if (d.kind === "shape") {
      canvas.style.cursor = "default";
      if (d.moved) hist.commit(d.part === null ? "Move shape" : "Move part");
      else hist.cancel();
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
      changed();
    }
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("pointerleave", () => {
    cursor = null;
    draw();
  });
  canvas.addEventListener("dblclick", (e) => {
    if (tool !== "polygon" || !drawing) return;
    e.preventDefault();
    // The double-click's second click added a point on top of the previous one; drop it.
    const pts = drawing.filter((p, i) => i === 0 || Math.hypot(sx(p[0]) - sx(drawing![i - 1][0]), sy(p[1]) - sy(drawing![i - 1][1])) > 3);
    if (pts.length >= 3) finishRing(pts);
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
      return void finishRing(drawing);
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
    void tryClose();
  });

  function showHelp(): void {
    const m = modal("Keyboard shortcuts", "help-dlg");
    m.body.append(h("dl", { className: "shortcuts" }, ...SHORTCUTS.flatMap(([k, v]) => [h("dt", {}, h("kbd", { textContent: k })), h("dd", { textContent: v })])));
  }

  function embed(): void {
    if (isNew) return alertBox("Save first", "Save the region before copying its embed code: the embed loads the saved region by its id.");
    openEmbedDialog({ region: { id, name: hist.state.props.name, label: hist.state.props.label }, slot: slotName, slotTitle: slot.title ?? map?.name ?? slotName });
  }

  /* ── Save ── */
  let saving = false;
  async function save(): Promise<void> {
    if (saving) return;
    const s = hist.state;
    const name = s.props.name.trim();
    if (!name) return setMsg("Give the region a name first.", "error"), nameIn.focus();
    if (isNew) {
      if (!REGION_ID.test(id)) return setMsg("The id must be lowercase letters, digits and dashes.", "error"), idIn.focus();
      if (o.takenIds.has(id)) return setMsg(`The id "${id}" is taken. Choose another one.`, "error"), idIn.focus();
    }
    if (!s.parts.length) return setMsg("Draw the region first.", "error");
    const geometry = toGeometry(s.parts);
    const errs = checkGeometry(geometry);
    if (errs.length) return setMsg(errs[0], "error");
    const props = s.props;
    const feature: RegionFeature = {
      $schema: "../../schema/region.schema.json",
      type: "Feature",
      id,
      properties: {
        name,
        slot: slotName,
        map: slot.map,
        color: props.color,
        fillOpacity: Math.round(props.fillOpacity * 100) / 100,
        label: props.label,
        ...(props.description.trim() ? { description: props.description.trim().slice(0, 500) } : {}),
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
      const commitSha = await o.gh.commit(`Save region "${oneLine(name)}" (${id})`, async () => {
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
      hist.apply("Reload from GitHub", {
        parts: partsFromGeometry(fresh.geometry),
        props: {
          name: fresh.properties.name,
          color: REGION_COLOR.test(fresh.properties.color) ? expandHex(fresh.properties.color) : hist.state.props.color,
          fillOpacity: fresh.properties.fillOpacity ?? DEFAULT_FILL_OPACITY,
          label: fresh.properties.label ?? true,
          description: fresh.properties.description ?? "",
        },
      });
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
  setTool(parts().length ? "select" : "polygon");
  if (!parts().length) setMsg("Click on the map to start the outline. Double-click, Enter or click the first point to close it.");
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
  };
}
