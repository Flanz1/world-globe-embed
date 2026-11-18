/**
 * "Warp regions…": moves every region and pin of a slot from the map they were drawn on onto a redrawn map.
 *
 * Opt-in: only opened from the slot card's More… menu (maps + edit-others permission). Nothing opens it or
 * suggests it when a map changes, and the Regions tab's "drawn on a different map" badge is left alone.
 *
 * The admin clicks matching spots on the old map (left pane) and the new map (right pane); from 3+ pairs
 * shared/warp.ts fits the warp. The new pane previews every ticked region and pin warped, with the old outlines
 * as an onion-skin overlay. Apply writes the warped files in batches (the admin API takes a limited number of
 * region files per save), each region and pin re-read fresh so a save made meanwhile isn't lost.
 * The placed points are kept in this browser (localStorage) until applied.
 */
import { h } from "./dom.ts";
import { modal } from "./region-dialogs.ts";
import { loadMapImage } from "./images.ts";
import { account, canEdit, currentUser } from "./session.ts";
import { regionEntries, serialize, stamp } from "./regions.ts";
import { pinEntries } from "./pins.ts";
import type { GitHub, FileChange } from "./github.ts";
import type { MapMeta, Slot } from "../shared/types.ts";
import type { RegionFeature } from "../shared/region.ts";
import { pinPath, type PinFeature } from "../shared/pins.ts";
import { regionsPerCommit } from "../shared/categories.ts";
import { stringifyCompact } from "../shared/json.ts";
import { traceGeometry } from "../shared/raster.ts";
import { mapGeometry, polygonsOf, round, type Position, type RegionGeometry } from "../shared/geo.ts";
import { MIN_PAIRS, fitWarp, warpPoint, warpShape, type WarpFit, type WarpPair } from "../shared/warp.ts";

export interface WarpDeps {
  gh: () => GitHub;
  maps: () => MapMeta[];
  /** After the last save: status, run polling and a reload of the page's data. */
  afterCommit: (sha: string) => Promise<void>;
}

/** A pair as it is being placed: one side may still be missing. */
interface Spot {
  from?: Position;
  to?: Position;
}

interface Item {
  kind: "region" | "pin";
  id: string;
  path: string;
  name: string;
  /** Why this one can't be moved by this person (empty = can). */
  why: string;
  on: boolean;
  geometry?: RegionGeometry;
  provinceBorders?: Position[][];
  at?: Position;
  color: string;
}

const PAIR_COLOURS = ["#e8b04a", "#5ec8e0", "#e07a9a", "#8fd07a", "#b49af0", "#f08a5d", "#6fd6b8", "#d6d06f"];
/** Sets style properties through the CSSOM (the admin page's CSP refuses inline style attributes). */
function styled<T extends HTMLElement>(el: T, css: Record<string, string>): T {
  for (const [k, v] of Object.entries(css)) el.style.setProperty(k, v);
  return el;
}
const colourOf = (i: number) => PAIR_COLOURS[i % PAIR_COLOURS.length];
const DRAFT = (slug: string, from: string, to: string) => `wge-warp:${slug}:${from}:${to}`;

interface Draft {
  spots: Spot[];
  straight: boolean;
  smooth: number;
}

function loadDraft(key: string): Draft | null {
  try {
    const j = JSON.parse(localStorage.getItem(key) ?? "null") as { spots?: Spot[]; straight?: boolean; smooth?: number } | null;
    if (!j || !Array.isArray(j.spots)) return null;
    const ok = (p: unknown): p is Position => Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === "number" && Number.isFinite(v));
    return { spots: j.spots.map((s) => ({ ...(ok(s.from) ? { from: s.from } : {}), ...(ok(s.to) ? { to: s.to } : {}) })), straight: !!j.straight, smooth: Number(j.smooth) || 0 };
  } catch {
    return null;
  }
}
function saveDraft(key: string, d: Draft | null): void {
  try {
    if (!d || !d.spots.length) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(d));
  } catch {
    /* No storage: points just aren't kept. */
  }
}

/* ── A pannable, zoomable flat map ── */

interface PaneOptions {
  label: string;
  /** Draws the shapes over the map, in this pane's coordinates. */
  paint: (ctx: CanvasRenderingContext2D, x: (lon: number) => number, y: (lat: number) => number, scale: number) => void;
  /** A click (not a drag) at a map spot. */
  place: (p: Position) => void;
}

class Pane {
  readonly el: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  readonly marks: HTMLDivElement;
  readonly empty: HTMLParagraphElement;
  img: HTMLImageElement | null = null;
  aspect = 2;
  /** View centre in image units (u, v in 0..1) and pixels per image height. */
  cu = 0.5;
  cv = 0.5;
  s = 0;
  /** Showing the whole map (kept so on resize). */
  private fitted = true;
  private w = 0;
  private hgt = 0;
  private raf = 0;
  private ro: ResizeObserver;
  constructor(private o: PaneOptions) {
    this.canvas = h("canvas", { className: "wp-canvas" });
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute("aria-label", o.label);
    this.marks = h("div", { className: "wp-marks" });
    this.empty = h("p", { className: "wp-pane-note muted small", hidden: true });
    this.el = h("div", { className: "wp-pane", tabIndex: 0, ariaLabel: `${o.label}: drag to pan, scroll or pinch to zoom, click to place a point; + and - zoom` }, this.canvas, this.marks, this.empty);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.el);
    this.wire();
  }
  destroy(): void {
    this.ro.disconnect();
    cancelAnimationFrame(this.raf);
  }
  setImage(img: HTMLImageElement | null, aspect: number): void {
    this.img = img;
    this.aspect = aspect || 2;
    this.fit();
  }
  /** Whole map in view. */
  fit(): void {
    if (!this.w || !this.hgt) return;
    this.s = Math.min(this.hgt, this.w / this.aspect) * 0.96;
    this.cu = 0.5;
    this.cv = 0.5;
    this.fitted = true;
    this.draw();
  }
  /** Same view as another pane (in map terms), for "Match views". */
  follow(p: Pane): void {
    this.cu = p.cu;
    this.cv = p.cv;
    this.s = p.s;
    this.fitted = false;
    this.draw();
  }
  private resize(): void {
    const r = this.el.getBoundingClientRect();
    const first = !this.w;
    this.w = Math.max(1, Math.round(r.width));
    this.hgt = Math.max(1, Math.round(r.height));
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.hgt * dpr);
    if (first || !this.s || this.fitted) this.fit();
    else this.draw();
  }
  /** Screen px (relative to the pane) of a map spot. */
  toScreen([lon, lat]: Position): [number, number] {
    const u = (lon + 180) / 360;
    const v = (90 - lat) / 180;
    let du = u - this.cu;
    du -= Math.round(du);
    return [this.w / 2 + du * this.s * this.aspect, this.hgt / 2 + (v - this.cv) * this.s];
  }
  toMap(px: number, py: number): Position {
    const u = this.cu + (px - this.w / 2) / (this.s * this.aspect);
    const v = this.cv + (py - this.hgt / 2) / this.s;
    let lon = u * 360 - 180;
    lon = ((((lon + 180) % 360) + 360) % 360) - 180;
    return [lon, Math.max(-90, Math.min(90, 90 - v * 180))];
  }
  zoomAt(px: number, py: number, f: number): void {
    const before = [this.cu + (px - this.w / 2) / (this.s * this.aspect), this.cv + (py - this.hgt / 2) / this.s];
    const min = Math.min(this.hgt, this.w / this.aspect) * 0.5;
    this.s = Math.max(min, Math.min(this.s * f, this.hgt * 400));
    this.cu = before[0] - (px - this.w / 2) / (this.s * this.aspect);
    this.cv = before[1] - (py - this.hgt / 2) / this.s;
    this.fitted = false;
    this.clamp();
    this.draw();
  }
  pan(dx: number, dy: number): void {
    this.cu -= dx / (this.s * this.aspect);
    this.cv -= dy / this.s;
    this.fitted = false;
    this.clamp();
    this.draw();
  }
  private clamp(): void {
    this.cu -= Math.floor(this.cu);
    const half = this.hgt / 2 / this.s;
    this.cv = half >= 0.5 ? 0.5 : Math.max(half, Math.min(1 - half, this.cv));
  }
  draw(): void {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.paint());
  }
  private paint(): void {
    const ctx = this.canvas.getContext("2d");
    if (!ctx || !this.s) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.hgt);
    const W = this.s * this.aspect;
    const left = this.w / 2 - this.cu * W;
    const top = this.hgt / 2 - this.cv * this.s;
    for (const k of [-1, 0, 1]) {
      const x0 = left + k * W;
      if (x0 > this.w || x0 + W < 0) continue;
      if (this.img) {
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(this.img, x0, top, W, this.s);
      } else {
        ctx.strokeStyle = "rgba(255,255,255,0.25)";
        ctx.strokeRect(x0 + 0.5, top + 0.5, W - 1, this.s - 1);
      }
    }
    // Shapes are traced once per turn east and west too (offsets), like the copies of the image above.
    const x = (lon: number) => left + ((lon + 180) / 360) * W;
    const y = (lat: number) => top + ((90 - lat) / 180) * this.s;
    this.o.paint(ctx, x, y, W / 360);
  }
  private wire(): void {
    const pts = new Map<number, { x: number; y: number }>();
    let moved = 0;
    let pinch = 0;
    const local = (e: PointerEvent | WheelEvent) => {
      const r = this.el.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top] as const;
    };
    this.el.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).closest(".wp-mark")) return;
      this.el.setPointerCapture(e.pointerId);
      const [x, y] = local(e);
      pts.set(e.pointerId, { x, y });
      if (pts.size === 1) moved = 0;
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
    this.el.addEventListener("pointermove", (e) => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      const [x, y] = local(e);
      if (pts.size === 2) {
        p.x = x;
        p.y = y;
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch) this.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinch);
        pinch = d;
        moved = 99;
        return;
      }
      moved += Math.abs(x - p.x) + Math.abs(y - p.y);
      this.pan(x - p.x, y - p.y);
      p.x = x;
      p.y = y;
    });
    const up = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      const single = pts.size === 1;
      pts.delete(e.pointerId);
      if (single && moved < 5 && e.type === "pointerup") {
        const [x, y] = local(e);
        this.o.place(this.toMap(x, y));
      }
    };
    this.el.addEventListener("pointerup", up);
    this.el.addEventListener("pointercancel", up);
    this.el.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const [x, y] = local(e);
        this.zoomAt(x, y, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)));
      },
      { passive: false },
    );
    this.el.addEventListener("keydown", (e) => {
      if (e.target !== this.el) return;
      const step = e.shiftKey ? 120 : 40;
      if (e.key === "+" || e.key === "=") this.zoomAt(this.w / 2, this.hgt / 2, 1.4);
      else if (e.key === "-") this.zoomAt(this.w / 2, this.hgt / 2, 1 / 1.4);
      else if (e.key === "ArrowLeft") this.pan(step, 0);
      else if (e.key === "ArrowRight") this.pan(-step, 0);
      else if (e.key === "ArrowUp") this.pan(0, step);
      else if (e.key === "ArrowDown") this.pan(0, -step);
      else if (e.key === "Enter" || e.key === " ") this.o.place(this.toMap(this.w / 2, this.hgt / 2));
      else return;
      e.preventDefault();
    });
  }
}

/* ── The dialog ── */

/** Regions and pins of a slot, as the warp list shows them. */
function itemsOf(slug: string, fromMap: string): Item[] {
  const out: Item[] = [];
  for (const e of regionEntries()) {
    const f = e.feature;
    if (!f || f.properties.slot !== slug || f.properties.map !== fromMap) continue;
    const why = canEdit(f) ? "" : "You can't edit this region (someone else made it).";
    out.push({ kind: "region", id: e.id, path: e.path, name: f.properties.name || e.id, why, on: !why, geometry: f.geometry, provinceBorders: f.properties.provinceBorders, color: f.properties.color || "#c33" });
  }
  for (const e of pinEntries()) {
    const f = e.feature;
    if (!f || f.properties.slot !== slug || f.properties.map !== fromMap) continue;
    const why = canEdit(f) ? "" : "You can't edit this pin (someone else placed it).";
    out.push({ kind: "pin", id: e.id, path: pinPath(e.id), name: f.properties.name || e.id, why, on: !why, at: f.geometry.coordinates, color: f.properties.color || "#fff" });
  }
  out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "region" ? -1 : 1));
  return out;
}

/** The maps this slot's regions and pins were drawn on, most used first (the slot's own map last). */
function fromMaps(slug: string, slotMap: string): { id: string; n: number }[] {
  const count = new Map<string, number>();
  for (const e of regionEntries()) if (e.feature?.properties.slot === slug) count.set(e.feature.properties.map, (count.get(e.feature.properties.map) ?? 0) + 1);
  for (const e of pinEntries()) if (e.feature?.properties.slot === slug) count.set(e.feature.properties.map, (count.get(e.feature.properties.map) ?? 0) + 1);
  if (!count.has(slotMap)) count.set(slotMap, 0);
  return [...count].map(([id, n]) => ({ id, n })).sort((a, b) => (a.id === slotMap ? 1 : b.id === slotMap ? -1 : b.n - a.n));
}

/** Who may open the tool. */
export const canWarp = (): boolean => {
  const me = currentUser();
  return !!me && (me.owner || (me.permissions.includes("maps") && me.permissions.includes("editOthers")));
};

export function openWarp(deps: WarpDeps, slug: string, slot: Slot): void {
  const maps = deps.maps();
  const mapOf = (id: string) => maps.find((m) => m.id === id);
  const toMap = slot.map;
  const choices = fromMaps(slug, toMap);
  let fromMap = choices[0].id;

  const m = modal("Warp regions", "warp-dlg");
  const dlg = m.dlg;
  dlg.classList.remove("small-dlg");
  dlg.classList.add("warp");

  // ── Head bar: maps and fit options ──
  const fromSel = h(
    "select",
    { name: "from-map", ariaLabel: "Map the regions were drawn on" },
    ...choices.map((c) => h("option", { value: c.id, textContent: `${mapOf(c.id)?.name ?? c.id} (${c.id})${c.id === toMap ? ", the slot's own map" : ""} · ${c.n}`, selected: c.id === fromMap })),
  );
  const straight = h("button", { type: "button", className: "ghost", textContent: "Straight only", dataset: { action: "straight" }, title: "Only move, turn, scale and shear: no bending" });
  straight.setAttribute("aria-pressed", "false");
  const smooth = h("input", { type: "range", min: "0", max: "100", step: "1", value: "0", name: "smoothness", id: "wp-smooth" });
  const smoothVal = h("output", { className: "small", textContent: "0" });
  const bar = h(
    "div",
    { className: "wp-bar" },
    h("label", { className: "wp-field" }, h("span", { className: "small muted", textContent: "From map (drawn on)" }), fromSel),
    h("span", { className: "wp-arrow", ariaHidden: "true", textContent: "→" }),
    h("div", { className: "wp-field" }, h("span", { className: "small muted", textContent: "To map (the slot shows)" }), h("strong", { textContent: `${mapOf(toMap)?.name ?? toMap} (${toMap})` })),
    straight,
    h("label", { className: "wp-smooth" }, h("span", { className: "small", textContent: "Smoothness" }), smooth, smoothVal),
  );

  // ── Segmented switch for narrow screens ──
  const views = ["old", "new", "points", "preview"] as const;
  type View = (typeof views)[number];
  let view: View = "old";
  const seg = h("div", { className: "wp-seg seg", role: "group", ariaLabel: "Show" });
  const segBtn = new Map<View, HTMLButtonElement>();
  for (const v of views) {
    const b = h("button", { type: "button", className: "ghost", textContent: v === "old" ? "Old" : v === "new" ? "New" : v === "points" ? "Points" : "Preview", dataset: { view: v } });
    b.addEventListener("click", () => setView(v));
    segBtn.set(v, b);
    seg.append(b);
  }

  // ── State ──
  let key = DRAFT(slug, fromMap, toMap);
  const draft = loadDraft(key);
  let spots: Spot[] = draft?.spots ?? [];
  let selected = -1;
  let items = itemsOf(slug, fromMap);
  let fit: WarpFit | null = null;
  let fitWhy = "";
  let warped = new Map<string, { geometry?: RegionGeometry; at?: Position }>();
  let overlay = 0.5;
  let busy = false;
  if (draft) {
    straight.setAttribute("aria-pressed", String(draft.straight));
    smooth.value = String(draft.smooth);
  }
  const options = () => ({ straight: straight.getAttribute("aria-pressed") === "true", smoothness: Number(smooth.value) });
  const pairs = (): { pair: WarpPair; spot: number }[] => spots.flatMap((s, i) => (s.from && s.to ? [{ pair: { from: s.from, to: s.to }, spot: i }] : []));

  // ── Panes ──
  const paintShapes = (ctx: CanvasRenderingContext2D, x: (lon: number) => number, y: (lat: number) => number, scale: number, which: "old" | "new" | "overlay") => {
    const offsets = [-360, 0, 360];
    for (const it of items) {
      if (!it.on && which !== "old") continue;
      const w = which === "new" ? warped.get(it.path) : undefined;
      const geom = which === "new" ? w?.geometry : it.geometry;
      const at = which === "new" ? w?.at : it.at;
      if (it.kind === "region" && geom) {
        ctx.beginPath();
        traceGeometry(ctx, geom, x, y, offsets);
        if (which === "new") {
          ctx.globalAlpha = 0.3;
          ctx.fillStyle = it.color;
          ctx.fill("evenodd");
          ctx.globalAlpha = 1;
        }
        ctx.lineWidth = which === "overlay" ? 1 : 1.5;
        ctx.setLineDash(which === "overlay" ? [4, 3] : []);
        ctx.strokeStyle = which === "overlay" ? "#fff" : it.color;
        ctx.globalAlpha = which === "old" ? (it.on ? 0.9 : 0.35) : 1;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      } else if (it.kind === "pin" && at) {
        for (const off of offsets) {
          ctx.beginPath();
          ctx.arc(x(at[0] + off), y(at[1]), Math.max(3, Math.min(6, scale * 0.6)), 0, Math.PI * 2);
          ctx.fillStyle = which === "overlay" ? "rgba(255,255,255,0.7)" : it.color;
          ctx.fill();
          ctx.strokeStyle = "rgba(0,0,0,0.8)";
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    }
  };
  const oldPane = new Pane({
    label: "Old map",
    paint: (ctx, x, y, s) => paintShapes(ctx, x, y, s, "old"),
    place: (p) => place("from", p),
  });
  let previewOnly = false;
  const newPane = new Pane({
    label: "New map",
    paint: (ctx, x, y, s) => {
      if (fit) paintShapes(ctx, x, y, s, "new");
      if (overlay > 0) {
        ctx.save();
        ctx.globalAlpha = overlay;
        paintShapes(ctx, x, y, s, "overlay");
        ctx.restore();
      }
    },
    place: (p) => {
      if (!previewOnly) place("to", p);
    },
  });
  const overlayIn = h("input", { type: "range", min: "0", max: "100", step: "5", value: String(overlay * 100), name: "overlay", id: "wp-overlay" });
  const overlayVal = h("output", { className: "small", textContent: `${Math.round(overlay * 100)}%` });
  overlayIn.addEventListener("input", () => {
    overlay = Number(overlayIn.value) / 100;
    overlayVal.textContent = `${overlayIn.value}%`;
    newPane.draw();
  });
  const fitBtn = (p: Pane) => h("button", { type: "button", className: "ghost tiny", textContent: "Whole map", onclick: () => p.fit() });
  const matchBtn = h("button", { type: "button", className: "ghost tiny", textContent: "Match old view", title: "Show the same part of the world as the old map pane", onclick: () => newPane.follow(oldPane) });
  const oldHead = h("div", { className: "wp-pane-head" }, h("h3", { textContent: "Old map" }), h("span", { className: "small muted wp-old-name" }), fitBtn(oldPane));
  const newHead = h(
    "div",
    { className: "wp-pane-head" },
    h("h3", { textContent: "New map" }),
    h("label", { className: "wp-overlay" }, h("span", { className: "small", textContent: "Old regions" }), overlayIn, overlayVal),
    matchBtn,
    fitBtn(newPane),
  );
  const oldCol = h("section", { className: "wp-col wp-col-old", ariaLabel: "Old map" }, oldHead, oldPane.el);
  const newCol = h("section", { className: "wp-col wp-col-new", ariaLabel: "New map" }, newHead, newPane.el);

  // ── Side strip: points and what moves ──
  const hint = h("p", { className: "small muted wp-hint" });
  const list = h("ol", { className: "wp-points", ariaLabel: "Point pairs" });
  const clear = h("button", { type: "button", className: "ghost text", textContent: "Clear points", dataset: { action: "clear" } });
  const fitNote = h("p", { className: "small wp-fit-note", role: "status" });
  const whatList = h("ul", { className: "wp-items" });
  const what = h("details", { className: "wp-what" }, h("summary", { textContent: "What moves" }), whatList);
  const side = h(
    "aside",
    { className: "wp-side", ariaLabel: "Points" },
    h("div", { className: "wp-side-head" }, h("h3", { textContent: "Points" }), clear),
    hint,
    list,
    fitNote,
    what,
  );
  const grid = h("div", { className: "wp-grid", dataset: { view } }, oldCol, newCol, side);

  // ── Footer ──
  const status = h("p", { className: "wp-status small", ariaLive: "polite" });
  const alert = h("div", { className: "wp-alert", role: "alert", hidden: true });
  const cancel = h("button", { type: "button", className: "ghost", textContent: "Cancel", onclick: () => m.close() });
  const apply = h("button", { type: "button", textContent: "Apply warp", dataset: { action: "apply" } });
  m.body.replaceWith(h("div", { className: "wp-body" }, bar, seg, grid));
  m.foot.append(h("div", { className: "wp-foot-text" }, status, alert), cancel, apply);
  const closeBtn = dlg.querySelector<HTMLButtonElement>(".pv-head button")!;
  dlg.addEventListener("cancel", (e) => {
    if (busy) e.preventDefault();
  });

  function setView(v: View): void {
    view = v;
    grid.dataset.view = v;
    previewOnly = v === "preview";
    grid.classList.toggle("previewing", previewOnly);
    for (const [k, b] of segBtn) b.setAttribute("aria-pressed", String(k === v));
    renderMarks();
  }

  function place(side: "from" | "to", p: Position): void {
    if (busy) return;
    // Fill the missing side of the selected pair, else of the newest unfinished pair, else start a new one.
    let i = selected >= 0 && !spots[selected]?.[side] ? selected : spots.findIndex((s) => !s[side] && (s.from || s.to));
    if (i < 0) {
      spots.push({});
      i = spots.length - 1;
    }
    spots[i] = { ...spots[i], [side]: p };
    selected = i;
    // On a phone, flip to the other map for the matching spot.
    if (window.matchMedia("(max-width: 767px)").matches && !(spots[i].from && spots[i].to)) setView(side === "from" ? "new" : "old");
    changed();
  }

  function remove(i: number): void {
    spots.splice(i, 1);
    selected = Math.min(selected, spots.length - 1);
    changed();
  }

  let refitTimer = 0;
  function changed(refit = true): void {
    saveDraft(key, { spots, straight: options().straight, smooth: options().smoothness });
    if (refit) {
      const ps = pairs();
      const r = ps.length >= MIN_PAIRS ? fitWarp(ps.map((p) => p.pair), options()) : null;
      fit = r?.ok ? r.fit : null;
      fitWhy = !r ? `Add at least ${MIN_PAIRS} point pairs.` : r.ok ? "" : r.why;
      clearTimeout(refitTimer);
      // Warp the preview shapes (vertices only, no extra points: that's done on Apply).
      refitTimer = window.setTimeout(() => {
        warped = new Map();
        if (fit) for (const it of items) if (it.on) warped.set(it.path, it.kind === "region" ? { geometry: mapGeometry(it.geometry!, (q) => warpPoint(fit!, q)) } : { at: warpPoint(fit!, it.at!) });
        newPane.draw();
      }, 0);
    }
    renderList();
    renderMarks();
    renderFoot();
    oldPane.draw();
    newPane.draw();
  }

  const radius = slot.radius ?? 0;
  const toMeta = mapOf(toMap);
  /** An error in degrees on the sphere, in words: km when the slot has a world radius, else pixels of the new map. */
  const errText = (deg: number) => (radius ? `${round((deg * Math.PI * radius) / 180, deg * radius > 5000 ? 0 : 1)} km` : `${round((deg * (toMeta?.width ?? 4096)) / 360, 1)} px`);

  function renderList(): void {
    const ps = pairs();
    const checks = new Map<number, number | null>();
    if (fit) ps.forEach((p, k) => checks.set(p.spot, fit!.check[k]));
    const vals = [...checks.values()].filter((v): v is number => v !== null);
    const worst = vals.length >= 2 ? Math.max(...vals) : -1;
    list.replaceChildren(
      ...spots.map((s, i) => {
        const c = checks.get(i);
        const done = !!(s.from && s.to);
        // Only worth naming when it's more than rounding (a perfect fit has every error at 0).
        const isWorst = c !== undefined && c !== null && c === worst && worst > 1e-4;
        const info = !done
          ? h("span", { className: "small muted", textContent: s.from ? "Now click the same spot on the new map" : "Now click the same spot on the old map" })
          : c === undefined || c === null
            ? h("span", { className: "small muted", textContent: fit ? "Error shows from 4 pairs" : "" })
            : h(
                "span",
                { className: `small${isWorst ? " wp-worst" : ""}` },
                isWorst ? h("span", { className: "wp-warn-icon", ariaHidden: "true", textContent: "⚠ " }) : null,
                `${isWorst ? "Largest error: " : "Error "}${errText(c)}`,
              );
        const row = h(
          "li",
          { className: `wp-point${i === selected ? " selected" : ""}${done ? "" : " open"}`, dataset: { index: String(i) } },
          styled(h("button", { type: "button", className: "wp-num ghost", textContent: String(i + 1), ariaLabel: `Select point ${i + 1}`, ariaPressed: String(i === selected), onclick: () => select(i) }), { "--wp-c": colourOf(i) }),
          info,
          h("button", { type: "button", className: "ghost danger tiny", textContent: "Delete", ariaLabel: `Delete point pair ${i + 1}`, onclick: () => remove(i) }),
        );
        return row;
      }),
    );
    clear.disabled = !spots.length;
    hint.textContent = spots.length
      ? ps.length < MIN_PAIRS
        ? `Place ${MIN_PAIRS - ps.length} more pair${MIN_PAIRS - ps.length > 1 ? "s" : ""}: click a spot on the old map, then the same spot on the new map.`
        : "Add more pairs where the new map differs most. A pair with a much larger error than the others is probably misplaced."
      : "Click a spot you can recognise on the old map (a cape, a river mouth, a city), then the same spot on the new map. Place at least 3 pairs, spread out.";
    fitNote.textContent = ps.length >= MIN_PAIRS && fitWhy ? fitWhy : "";
    fitNote.classList.toggle("error", !!fitWhy && ps.length >= MIN_PAIRS);
  }

  function select(i: number): void {
    selected = selected === i ? -1 : i;
    renderList();
    renderMarks();
  }

  /** Markers as focusable buttons over the canvases. */
  function renderMarks(): void {
    for (const [pane, side] of [[oldPane, "from"], [newPane, "to"]] as const) {
      const show = !(pane === newPane && previewOnly);
      pane.marks.replaceChildren(
        ...(!show
          ? []
          : spots.flatMap((s, i) => {
              const p = s[side];
              if (!p) return [];
              const [x, y] = pane.toScreen(p);
              const b = styled(
                h("button", {
                  type: "button",
                  className: `wp-mark${i === selected ? " selected" : ""}`,
                  textContent: String(i + 1),
                  ariaLabel: `Point ${i + 1} on the ${side === "from" ? "old" : "new"} map: arrow keys nudge it (Shift for 10 px), Delete removes the pair`,
                  dataset: { index: String(i), side },
                }),
                { left: `${x}px`, top: `${y}px`, "--wp-c": colourOf(i) },
              );
              b.setAttribute("aria-pressed", String(i === selected));
              wireMark(b, pane, i, side);
              return [b];
            })),
      );
    }
  }

  function wireMark(b: HTMLButtonElement, pane: Pane, i: number, side: "from" | "to"): void {
    let drag: { x: number; y: number; moved: number } | null = null;
    b.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      b.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, moved: 0 };
    });
    b.addEventListener("pointermove", (e) => {
      if (!drag) return;
      drag.moved += Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y);
      drag.x = e.clientX;
      drag.y = e.clientY;
      if (drag.moved < 3) return;
      const r = pane.el.getBoundingClientRect();
      spots[i] = { ...spots[i], [side]: pane.toMap(e.clientX - r.left, e.clientY - r.top) };
      b.style.left = `${e.clientX - r.left}px`;
      b.style.top = `${e.clientY - r.top}px`;
      pane.draw();
    });
    b.addEventListener("pointerup", () => {
      const was = drag;
      drag = null;
      if (!was) return;
      if (was.moved < 3) select(i);
      else {
        selected = i;
        changed();
      }
    });
    b.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 10 : 1;
      const d = e.key === "ArrowLeft" ? [-step, 0] : e.key === "ArrowRight" ? [step, 0] : e.key === "ArrowUp" ? [0, -step] : e.key === "ArrowDown" ? [0, step] : null;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        remove(i);
        return;
      }
      if (!d) return;
      e.preventDefault();
      const [x, y] = pane.toScreen(spots[i][side]!);
      spots[i] = { ...spots[i], [side]: pane.toMap(x + d[0], y + d[1]) };
      selected = i;
      changed();
      pane.marks.querySelector<HTMLButtonElement>(`.wp-mark[data-index="${i}"]`)?.focus();
    });
  }

  // Keep markers glued to the map while panning and zooming.
  for (const p of [oldPane, newPane]) {
    const draw = p.draw.bind(p);
    p.draw = () => {
      draw();
      requestAnimationFrame(() => renderMarksOf(p));
    };
  }
  function renderMarksOf(pane: Pane): void {
    for (const b of pane.marks.querySelectorAll<HTMLButtonElement>(".wp-mark")) {
      const s = spots[Number(b.dataset.index)];
      const p = s?.[b.dataset.side as "from" | "to"];
      if (!p) continue;
      const [x, y] = pane.toScreen(p);
      b.style.left = `${x}px`;
      b.style.top = `${y}px`;
    }
  }

  function renderItems(): void {
    whatList.replaceChildren(
      ...(items.length
        ? items.map((it) => {
            const box = h("input", { type: "checkbox", checked: it.on, disabled: !!it.why, name: `move-${it.kind}-${it.id}` });
            box.addEventListener("change", () => {
              it.on = box.checked;
              changed();
            });
            return h(
              "li",
              {},
              h(
                "label",
                { title: it.why },
                box,
                styled(h("span", { className: "wp-swatch", ariaHidden: "true" }), { background: it.color }),
                ` ${it.name} `,
                h("span", { className: "small muted", textContent: it.kind === "pin" ? "pin" : it.id }),
                it.why ? h("span", { className: "small muted", textContent: ` · ${it.why}` }) : null,
              ),
            );
          })
        : [h("li", { className: "muted small", textContent: "Nothing on this slot was drawn on that map." })]),
    );
    const r = items.filter((i) => i.kind === "region");
    const p = items.filter((i) => i.kind === "pin");
    (what.firstElementChild as HTMLElement).textContent = `What moves (${r.filter((i) => i.on).length} of ${r.length} regions, ${p.filter((i) => i.on).length} of ${p.length} pins)`;
  }

  function counts(): { regions: number; pins: number } {
    return { regions: items.filter((i) => i.on && i.kind === "region").length, pins: items.filter((i) => i.on && i.kind === "pin").length };
  }
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const perSave = () => Math.max(1, regionsPerCommit(!!currentUser()?.owner) - 2);

  function renderFoot(): void {
    renderItems();
    const c = counts();
    const n = c.regions + c.pins;
    const why = busy ? "Saving…" : !fit ? fitWhy || `Add at least ${MIN_PAIRS} point pairs.` : !n ? "Tick at least one region or pin under What moves." : "";
    apply.disabled = !!why;
    apply.title = why || "Move the ticked regions and pins onto the new map";
    if (!busy) status.textContent = fit ? `${plural(c.regions, "region")} and ${plural(c.pins, "pin")} will move onto ${toMap}.` : why;
  }

  fromSel.addEventListener("change", () => {
    fromMap = fromSel.value;
    key = DRAFT(slug, fromMap, toMap);
    const d = loadDraft(key);
    spots = d?.spots ?? [];
    if (d) {
      straight.setAttribute("aria-pressed", String(d.straight));
      smooth.value = String(d.smooth);
      smoothVal.textContent = smooth.value;
    }
    selected = -1;
    items = itemsOf(slug, fromMap);
    void loadOld();
    changed();
  });
  straight.addEventListener("click", () => {
    const on = straight.getAttribute("aria-pressed") !== "true";
    straight.setAttribute("aria-pressed", String(on));
    smooth.disabled = on;
    changed();
  });
  smooth.addEventListener("input", () => {
    smoothVal.textContent = smooth.value;
    changed();
  });
  clear.addEventListener("click", () => {
    spots = [];
    selected = -1;
    changed();
  });

  async function loadOld(): Promise<void> {
    const meta = mapOf(fromMap);
    const name = oldHead.querySelector(".wp-old-name")!;
    name.textContent = meta ? `${meta.name} (${meta.id})` : fromMap;
    oldPane.empty.hidden = true;
    let img: HTMLImageElement | null = null;
    if (meta && fromMap !== toMap) img = await loadMapImage(meta, 4096).catch(() => null);
    if (fromMap === toMap || !img) {
      // The old picture is gone (replaced under the same id) or never was: match the old outlines instead.
      oldPane.empty.hidden = false;
      oldPane.empty.textContent =
        fromMap === toMap ? "These regions were drawn on this map's earlier image, which was replaced: match their outlines to the new picture." : "The old map's image isn't available: match the outlines instead.";
    }
    oldPane.setImage(img, meta?.aspect ?? toMeta?.aspect ?? 2);
  }
  void loadOld();
  if (toMeta) void loadMapImage(toMeta, 4096).then((img) => newPane.setImage(img, toMeta.aspect), () => newPane.setImage(null, toMeta.aspect));

  smoothVal.textContent = smooth.value;
  smooth.disabled = options().straight;
  setView("old");
  changed();
  dlg.addEventListener("close", () => {
    oldPane.destroy();
    newPane.destroy();
    clearTimeout(refitTimer);
  });

  /* ── Apply ── */

  /** Rewrites one region or pin file for the new map, from its current text. null = nothing to do (moved already, or gone). */
  function rewrite(it: Item, text: string, f: WarpFit): { content: string } | { problem: string } | null {
    if (it.kind === "pin") {
      const p = JSON.parse(text) as PinFeature;
      if (p.properties.map !== fromMap) return null;
      const [lon, lat] = warpPoint(f, p.geometry.coordinates);
      const next: PinFeature = { ...p, properties: { ...p.properties, map: toMap, updatedBy: account(), updated: stamp() }, geometry: { type: "Point", coordinates: [round(lon), round(lat)] } };
      return { content: stringifyCompact(next) + "\n" };
    }
    const r = JSON.parse(text) as RegionFeature;
    if (r.properties.map !== fromMap) return null;
    const w = warpShape(f, r.geometry, r.properties.provinceBorders);
    if (w.problems.length) return { problem: w.problems[0] };
    const props = { ...r.properties, map: toMap, updatedBy: account(), updated: stamp() };
    if (w.provinceBorders) props.provinceBorders = w.provinceBorders;
    // Same number of parts as before, so the per-part arrays (labels, locks, colours…) still line up.
    if (polygonsOf(w.geometry).length !== polygonsOf(r.geometry).length) return { problem: "a part was lost" };
    return { content: serialize({ ...r, properties: props, geometry: w.geometry }) };
  }

  /** Checks every ticked region against the full warp before anything is saved. */
  function dryRun(f: WarpFit): { item: Item; problem: string }[] {
    const bad: { item: Item; problem: string }[] = [];
    for (const it of items) {
      if (!it.on || it.kind !== "region") continue;
      const w = warpShape(f, it.geometry!, it.provinceBorders);
      if (w.problems.length) bad.push({ item: it, problem: w.problems[0] });
    }
    return bad;
  }

  apply.addEventListener("click", () => void run(items.filter((i) => i.on)));

  async function run(todo: Item[]): Promise<void> {
    if (!fit || busy || !todo.length) return;
    const f = fit;
    const bad = dryRun(f);
    const badSet = new Set(bad.map((b) => b.item.path));
    const go = todo.filter((i) => !badSet.has(i.path));
    const per = perSave();
    const saves = Math.ceil(go.length / per);
    const nr = go.filter((i) => i.kind === "region").length;
    const np = go.length - nr;
    const ok = await confirmWarp(
      go.length
        ? `Moves ${plural(nr, "region")} and ${plural(np, "pin")} from ${fromMap} onto ${toMap}, in ${plural(saves, "save")}. You can bring back any region's old outline from its History.`
        : "Nothing can move with these points.",
      bad.map((b) => `${b.item.name}: ${b.problem}`),
      go.length > 0,
    );
    if (!ok) return;
    busy = true;
    alert.hidden = true;
    closeBtn.disabled = true;
    closeBtn.title = "Wait until the warp is saved";
    cancel.disabled = true;
    renderFoot();
    const gh = deps.gh();
    const moved: Item[] = [];
    const skipped: string[] = [];
    let last = "";
    let failed: Error | null = null;
    const batches: Item[][] = [];
    for (let i = 0; i < go.length; i += per) batches.push(go.slice(i, i + per));
    for (let b = 0; b < batches.length; b++) {
      status.textContent = `Saving ${b + 1} of ${batches.length}…`;
      const batch = batches[b];
      try {
        let wrote: Item[] = [];
        const sha = await gh.commit(`Warp ${plural(batch.filter((i) => i.kind === "region").length, "region")} and ${plural(batch.filter((i) => i.kind === "pin").length, "pin")} from map "${fromMap}" onto "${toMap}" (${pairs().length} point pairs${batches.length > 1 ? `, part ${b + 1} of ${batches.length}` : ""})`, async () => {
          wrote = [];
          const changes: FileChange[] = [];
          for (const it of batch) {
            let text: string;
            try {
              text = (await gh.readFile(it.path)).text;
            } catch {
              skipped.push(`${it.name}: it was deleted meanwhile`);
              continue;
            }
            const r = rewrite(it, text, f);
            if (!r) continue;
            if ("problem" in r) {
              skipped.push(`${it.name}: ${r.problem}`);
              continue;
            }
            changes.push({ path: it.path, content: r.content });
            wrote.push(it);
          }
          if (!changes.length) throw new Nothing();
          return changes;
        });
        last = sha;
        moved.push(...wrote);
      } catch (e) {
        if (e instanceof Nothing) continue;
        failed = e as Error;
        break;
      }
    }
    busy = false;
    closeBtn.disabled = false;
    closeBtn.title = "";
    cancel.disabled = false;
    const movedSet = new Set(moved.map((i) => i.path));
    // What's left on the old map stays in the list (unticked ones too), so a retry only does the rest.
    items = items.filter((i) => !movedSet.has(i.path));
    if (failed) {
      const rest = go.filter((i) => !movedSet.has(i.path));
      alert.hidden = false;
      alert.replaceChildren(
        h("p", { className: "error", textContent: `Saving stopped: ${failed.message}` }),
        h("p", { className: "small", textContent: moved.length ? `Moved: ${moved.map((i) => i.name).join(", ")}.` : "Nothing was moved." }),
        h("p", { className: "small", textContent: `Not moved: ${rest.map((i) => i.name).join(", ")}.` }),
        h("button", { type: "button", className: "ghost", textContent: "Try the rest again", dataset: { action: "retry" }, onclick: () => void run(rest) }),
      );
    } else if (skipped.length || bad.length) {
      alert.hidden = false;
      alert.replaceChildren(h("p", { className: "small", textContent: `Not moved: ${[...bad.map((b) => `${b.item.name}: ${b.problem}`), ...skipped].join("; ")}.` }));
    }
    status.textContent = moved.length ? `Moved ${plural(moved.filter((i) => i.kind === "region").length, "region")} and ${plural(moved.filter((i) => i.kind === "pin").length, "pin")} onto ${toMap}.` : failed ? "" : "Nothing needed moving.";
    if (moved.length && !failed && go.every((i) => movedSet.has(i.path))) saveDraft(key, null);
    warped = new Map();
    changed();
    status.textContent = moved.length ? `Moved ${plural(moved.filter((i) => i.kind === "region").length, "region")} and ${plural(moved.filter((i) => i.kind === "pin").length, "pin")} onto ${toMap}.` : status.textContent;
    if (last) await deps.afterCommit(last);
  }
}

class Nothing extends Error {}

/** The confirm step: what will happen, and what can't move (with why). */
function confirmWarp(text: string, cant: string[], canGo: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const m = modal("Apply warp");
    let answer = false;
    m.body.append(h("p", { textContent: text }));
    if (cant.length)
      m.body.append(
        h("p", { className: "small", textContent: `${cant.length === 1 ? "One region" : `${cant.length} regions`} can't move with these points and will stay as they are:` }),
        h("ul", { className: "small wp-cant" }, ...cant.map((c) => h("li", { textContent: c }))),
        h("p", { className: "small muted", textContent: "Add a pair near them, or raise Smoothness, and try again for those." }),
      );
    m.foot.append(h("button", { type: "button", className: "ghost", textContent: "Cancel", onclick: m.close }));
    if (canGo) m.foot.append(h("button", { type: "button", textContent: "Apply warp", dataset: { action: "confirm-warp" }, onclick: () => ((answer = true), m.close()) }));
    m.dlg.addEventListener("close", () => resolve(answer));
  });
}

