/**
 * Region embed UI shared by the globe and flat viewers: the view lock, the region label and the
 * "Region not found" note. Region strings are only ever set with textContent.
 */
import type { Position } from "../shared/geo.ts";
import { mergeRegions, type LabelPoint, type LegendEntry, type RegionData } from "../shared/region.ts";

export interface Lock {
  readonly locked: boolean;
  set(locked: boolean): void;
  /** The region failed to load: drop the lock and hide its button. */
  remove(): void;
}

/** Most time a re-lock may take to ease back to the selected position. */
export const RELOCK_MS = 250;

/**
 * The padlock button. While locked, the viewer ignores drag, wheel and pinch, and the canvas lets
 * gestures through (touch-action: auto, no preventDefault), so the article around the embed scrolls.
 */
export function setupLock(canvas: HTMLCanvasElement, initial: boolean, onChange: (locked: boolean) => void): Lock {
  const btn = document.getElementById("btn-lock") as HTMLButtonElement | null;
  let locked = initial;
  const apply = () => {
    canvas.style.touchAction = locked ? "auto" : "none";
    canvas.style.cursor = locked ? "default" : "";
    canvas.dataset.locked = String(locked);
    if (btn) {
      const label = locked ? "Unlock view" : "Lock view";
      btn.setAttribute("aria-pressed", String(locked));
      btn.setAttribute("aria-label", label);
      btn.title = label;
    }
  };
  btn?.addEventListener("click", () => {
    locked = !locked;
    apply();
    onChange(locked);
  });
  apply();
  return {
    get locked() {
      return locked;
    },
    set(v: boolean) {
      locked = v;
      apply();
    },
    remove() {
      locked = false;
      apply();
      if (btn) btn.hidden = true;
      const ui = document.getElementById("ui");
      if (ui && [...ui.querySelectorAll("button")].every((b) => b.hidden)) ui.hidden = true;
    },
  };
}

export function regionNote(text: string): void {
  if (document.querySelector(".rnote")) return;
  const p = document.createElement("p");
  p.className = "rnote";
  p.textContent = text;
  document.body.append(p);
}

/** How a label fits its part on screen: text direction (radians counter-clockwise from east), and the room along and across it, in px. */
export interface LabelFit {
  angle: number;
  len: number;
  wid: number;
}
/** Label text size bounds, px: scaled to the part's size between these. */
const LABEL_MIN = 11;
const LABEL_MIN_TILT = 12;
const LABEL_MAX = 26;
const LABEL_BASE = 12;
const TILT_MAX = (70 * Math.PI) / 180;

/** An HTML label (textContent only) that is kept clear of the control buttons. */
export function makeLabel(stage: HTMLElement): { setText(t: string): void; place(x: number, y: number, visible: boolean, fit?: LabelFit): void; el: HTMLDivElement; box: { x0: number; y0: number; x1: number; y1: number } | null; rank: number } {
  const el = document.createElement("div");
  el.className = "rlabel";
  el.hidden = true;
  el.setAttribute("aria-hidden", "true");
  stage.append(el);
  let text = "";
  let natural: { w: number; h: number } | null = null;
  let size = 0;
  const self = {
    el,
    box: null as { x0: number; y0: number; x1: number; y1: number } | null,
    rank: 0,
    setText(t: string) {
      text = t;
      el.textContent = t;
      natural = null;
      size = 0;
    },
    place(x: number, y: number, visible: boolean, fit?: LabelFit) {
      el.hidden = !visible || !text;
      self.box = null;
      if (el.hidden) return;
      // Size: the largest text that fits the part (with a margin), kept between the bounds. Measured once at the base size.
      let px = LABEL_BASE;
      if (fit && fit.len > 0 && fit.wid > 0) {
        if (!natural) {
          el.style.fontSize = `${LABEL_BASE}px`;
          size = LABEL_BASE;
          natural = { w: el.offsetWidth, h: el.offsetHeight };
        }
        const k = Math.min((fit.len * 0.85) / Math.max(1, natural.w), (fit.wid * 0.7) / Math.max(1, natural.h));
        const tilt = Math.abs(fit.angle) > 0.01;
        px = Math.round(Math.min(LABEL_MAX, Math.max(tilt ? LABEL_MIN_TILT : LABEL_MIN, LABEL_BASE * k)));
        // Whole-pixel steps with a little hysteresis: a one-pixel wobble while zooming keeps the old size.
        if (size && Math.abs(px - size) < 2 && px >= (tilt ? LABEL_MIN_TILT : LABEL_MIN) && size >= (tilt ? LABEL_MIN_TILT : LABEL_MIN)) px = size;
        self.rank = fit.len * fit.wid;
      }
      if (px !== size) {
        el.style.fontSize = `${px}px`;
        size = px;
      }
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const W = stage.clientWidth;
      const H = stage.clientHeight;
      const a = fit?.angle ?? 0;
      // Half the label's box once turned: what has to stay inside the stage.
      const hw = (Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a))) / 2;
      const hh = (Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a))) / 2;
      const cx = Math.min(Math.max(4 + hw, x), Math.max(4 + hw, W - hw - 4));
      let cy = Math.min(Math.max(4 + hh, y), Math.max(4 + hh, H - hh - 4));
      const ui = document.getElementById("ui");
      if (ui && !ui.hidden) {
        const r = ui.getBoundingClientRect();
        const s = stage.getBoundingClientRect();
        const ux = r.left - s.left - 4;
        const uy = r.top - s.top - 4;
        // Overlapping the button cluster: move just above it.
        if (cx + hw > ux && cy + hh > uy) cy = uy - hh;
      }
      el.style.transform = `translate(${Math.round(cx - w / 2)}px,${Math.round(cy - h / 2)}px) rotate(${(-a).toFixed(4)}rad)`;
      self.box = { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh };
      el.style.opacity = "";
    },
  };
  return self;
}


/**
 * The region's legend: a colour swatch and a label per entry, top left, folded and unfolded with its
 * header button. Labels are set with textContent; colours are validated #rgb/#rrggbb before they get here.
 */
export function makeLegend(stage: HTMLElement): {
  set(entries: readonly LegendEntry[], title: string, contested?: boolean): void;
  /** Stacked regions: a checkbox per region to show or hide it (set again to rebuild). */
  layers(items: readonly { id: string; name: string }[], hidden: ReadonlySet<string>, onToggle: (id: string, show: boolean) => void, title?: string): void;
} {
  const box = document.createElement("div");
  box.className = "rkey";
  box.hidden = true;
  const head = document.createElement("button");
  head.type = "button";
  head.className = "rkey-head";
  head.setAttribute("aria-expanded", "true");
  const list = document.createElement("ul");
  list.id = "rkey-list";
  head.setAttribute("aria-controls", list.id);
  const layerBox = document.createElement("div");
  layerBox.className = "rlayers";
  layerBox.hidden = true;
  box.append(head, layerBox, list);
  stage.append(box);
  let count = 0;
  let open = true;
  const apply = () => {
    head.setAttribute("aria-expanded", String(open));
    head.title = open ? "Hide legend" : "Show legend";
    list.hidden = !open;
    layerBox.hidden = !open || !layerBox.childElementCount;
  };
  head.addEventListener("click", () => {
    open = !open;
    apply();
  });
  // Clicks and drags on the legend shouldn't reach the viewer under it.
  for (const t of ["pointerdown", "wheel"] as const) box.addEventListener(t, (e) => e.stopPropagation());
  apply();
  return {
    layers(items, hidden, onToggle, title) {
      const boxes = items.map((it) => {
        const label = document.createElement("label");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = !hidden.has(it.id);
        cb.addEventListener("change", () => onToggle(it.id, cb.checked));
        const t = document.createElement("span");
        t.textContent = it.name;
        label.append(cb, t);
        return label;
      });
      const head = document.createElement("div");
      head.className = "rlayers-head";
      head.textContent = title?.trim() || "Layers";
      layerBox.replaceChildren(...(boxes.length ? [head, ...boxes] : []));
      apply();
      box.hidden = !count && !boxes.length;
    },
    set(entries, title, contested = false) {
      head.textContent = title || "Legend";
      const rows = entries.map((e) => {
        const li = document.createElement("li");
        const sw = document.createElement("i");
        sw.style.background = e.color;
        const t = document.createElement("span");
        t.textContent = e.label;
        li.append(sw, t);
        return li;
      });
      if (contested) {
        // Hatching: where parts of different colours overlap.
        const li = document.createElement("li");
        li.className = "rkey-contested";
        const sw = document.createElement("i");
        sw.className = "dash";
        const t = document.createElement("span");
        t.textContent = "Contested";
        li.append(sw, t);
        rows.push(li);
      }
      list.replaceChildren(...rows);
      count = rows.length;
      box.hidden = !count && layerBox.hidden;
    },
  };
}

/**
 * Where a label goes on screen and how it fits: `project` maps a map-image position to screen px. The text
 * direction and the room along and across it come from projecting one degree along each axis, so this serves
 * the flat map and the globe (where the axis bends with the view). Text that isn't tilted stays level.
 */
export function labelOnScreen(pt: LabelPoint, project: (p: Position) => { x: number; y: number }): { x: number; y: number; fit?: LabelFit } {
  const p0 = project(pt.at);
  if (!(pt.length > 0 && pt.width > 0)) return p0;
  const c = Math.cos(pt.angle);
  const s = Math.sin(pt.angle);
  const pu = project([pt.at[0] + c, pt.at[1] + s]);
  const pv = project([pt.at[0] - s, pt.at[1] + c]);
  let angle = 0;
  if (pt.tilted) {
    angle = Math.atan2(-(pu.y - p0.y), pu.x - p0.x);
    if (angle > Math.PI / 2) angle -= Math.PI;
    else if (angle <= -Math.PI / 2) angle += Math.PI;
    // Never steeper than 70° from level.
    angle = Math.max(-TILT_MAX, Math.min(TILT_MAX, angle));
  }
  return { ...p0, fit: { angle, len: pt.length * Math.hypot(pu.x - p0.x, pu.y - p0.y), wid: pt.width * Math.hypot(pv.x - p0.x, pv.y - p0.y) } };
}

/** Several labels (one per labelled part), each placed like makeLabel's. */
export function makeLabels(stage: HTMLElement): { set(texts: string[]): void; place(i: number, x: number, y: number, visible: boolean, fit?: LabelFit): void; settle(stage: HTMLElement): void } {
  const pool: ReturnType<typeof makeLabel>[] = [];
  return {
    set(texts) {
      while (pool.length < texts.length) pool.push(makeLabel(stage));
      pool.forEach((l, i) => {
        l.setText(texts[i] ?? "");
        if (i >= texts.length) l.place(0, 0, false);
      });
    },
    place(i, x, y, visible, fit) {
      pool[i]?.place(x, y, visible, fit);
    },
    /** After placing every label: where two pills overlap, the one on the larger part stays and the other fades; nothing sits under the legend or buttons. */
    settle(root) {
      const s = root.getBoundingClientRect();
      const keep: { x0: number; y0: number; x1: number; y1: number }[] = [];
      for (const sel of [".rkey", "#ui"]) {
        const e = root.querySelector<HTMLElement>(sel) ?? document.querySelector<HTMLElement>(sel);
        if (!e || e.hidden) continue;
        const r = e.getBoundingClientRect();
        keep.push({ x0: r.left - s.left, y0: r.top - s.top, x1: r.right - s.left, y1: r.bottom - s.top });
      }
      const hit = (a: { x0: number; y0: number; x1: number; y1: number }, b: typeof a) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
      for (const l of [...pool].filter((l) => l.box).sort((a, b) => b.rank - a.rank)) {
        const clash = keep.some((k) => hit(l.box!, k));
        l.el.style.opacity = clash ? "0" : "";
        if (!clash) keep.push(l.box!);
      }
    },
  };
}

export const prefersReducedMotion = (): boolean => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Stacked regions (?regions=a,b,c): which are shown. `of(r)` is the region to paint: r without the hidden
 * ones, the same object for the same state (so painters can cache on it). The last one can't be hidden.
 */
export function makeVisibility(): { hidden: Set<string>; of(r: RegionData): RegionData } {
  const hidden = new Set<string>();
  let last: { r: RegionData; key: string; out: RegionData } | null = null;
  return {
    hidden,
    of(r) {
      if (!r.members || !hidden.size) return r;
      const key = [...hidden].sort().join(",");
      if (last && last.r === r && last.key === key) return last.out;
      const shown = r.members.filter((m) => !hidden.has(m.id) && !(m.underOf && hidden.has(m.underOf)));
      const topHidden = !!r.clip && hidden.has(r.members[r.members.length - 1].id);
      const out = shown.length ? mergeRegions(shown, r.clip && !topHidden) : r;
      last = { r, key, out };
      return out;
    },
  };
}

/**
 * Stacked regions: the show/hide checkboxes in the legend, named by the region's own settings (`layers.names`,
 * else the region's name or id) under `layers.title`. The last shown region stays on (its box snaps back).
 */
export function setupLayers(
  legend: { layers: ReturnType<typeof makeLegend>["layers"] },
  r: RegionData,
  visible: ReturnType<typeof makeVisibility>,
  redraw: () => void,
  layers?: { names: Record<string, string>; title: string; hidden: string[]; own?: boolean },
): void {
  const members = r.members;
  if (!members) return legend.layers([], visible.hidden, () => {});
  // A region over its underlays (r.clip) is always shown, with no toggle, unless it's given one of its own (layers.own).
  const top = r.clip && !layers?.own ? members[members.length - 1] : undefined;
  const items = members.filter((m) => m !== top).map((m) => ({ id: m.id, name: layers?.names[m.id]?.trim() || m.name || m.id }));
  visible.hidden.clear();
  for (const id of layers?.hidden ?? []) if (id !== top?.id) visible.hidden.add(id);
  const build = (): void =>
    legend.layers(
      items,
      visible.hidden,
      (id, show) => {
        if (show) visible.hidden.delete(id);
        else if (top || members.length - visible.hidden.size > 1) visible.hidden.add(id);
        else return build();
        redraw();
      },
      layers?.title,
    );
  build();
}
