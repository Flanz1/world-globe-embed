/**
 * Region embed UI shared by the globe and flat viewers: the view lock, the region label and the
 * "Region not found" note. Region strings are only ever set with textContent.
 */
import type { Position } from "../shared/geo.ts";
import { mergeRegions, type LabelPoint, type LegendEntry, type RegionData } from "../shared/region.ts";
import { legendRowsFor } from "../shared/region-paint.ts";
import { leftStack } from "./stack.ts";

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
      btn.setAttribute("aria-pressed", String(locked));
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
const LABEL_MIN = 12;
const LABEL_MIN_TILT = 12;
const LABEL_MAX = 26;
const LABEL_BASE = 12;
/** Farthest a label slides to clear the legend, buttons or a pin, px; past this it fades instead. */
const MAX_SLIDE = 110;
const TILT_MAX = (70 * Math.PI) / 180;

/** An HTML label (textContent only) that is kept clear of the control buttons. */
export function makeLabel(stage: HTMLElement): { setText(t: string): void; place(x: number, y: number, visible: boolean, fit?: LabelFit): void; el: HTMLDivElement; box: { x0: number; y0: number; x1: number; y1: number } | null; rank: number; shove(dx: number, dy: number): void; shrink(): boolean } {
  const el = document.createElement("div");
  el.className = "rlabel";
  el.hidden = true;
  el.setAttribute("aria-hidden", "true");
  stage.append(el);
  let text = "";
  let natural: { w: number; h: number } | null = null;
  let size = 0;
  let last: { cx: number; cy: number; w: number; h: number; a: number; min: number; box: { x0: number; y0: number; x1: number; y1: number } } | null = null;
  const self = {
    el,
    box: null as { x0: number; y0: number; x1: number; y1: number } | null,
    rank: 0,
    /** Moves the placed label by (dx, dy) px from where place() put it. */
    shove(dx: number, dy: number) {
      if (!self.box || !last) return;
      el.style.transform = `translate(${Math.round(last.cx + dx - last.w / 2)}px,${Math.round(last.cy + dy - last.h / 2)}px) rotate(${(-last.a).toFixed(4)}rad)`;
      self.box = { x0: last.box.x0 + dx, y0: last.box.y0 + dy, x1: last.box.x1 + dx, y1: last.box.y1 + dy };
    },
    /** One even-pixel step smaller (down to the minimum), about the same centre. False when already at the minimum. */
    shrink() {
      if (!self.box || !last || size - 2 < last.min) return false;
      size -= 2;
      el.style.fontSize = `${size}px`;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const a = last.a;
      const hw = (Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a))) / 2;
      const hh = (Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a))) / 2;
      const cx = (self.box.x0 + self.box.x1) / 2;
      const cy = (self.box.y0 + self.box.y1) / 2;
      el.style.transform = `translate(${Math.round(cx - w / 2)}px,${Math.round(cy - h / 2)}px) rotate(${(-a).toFixed(4)}rad)`;
      self.box = { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh };
      last = { cx, cy, w, h, a, min: last.min, box: self.box };
      return true;
    },
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
        // Even-pixel steps: the same view always gives the same size (no history), and a one-pixel wobble while zooming doesn't change it.
        const min = tilt ? LABEL_MIN_TILT : LABEL_MIN;
        px = Math.min(LABEL_MAX, Math.max(min, Math.round((LABEL_BASE * k) / 2) * 2));
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
      last = { cx, cy, w, h, a, min: fit && fit.len > 0 && fit.wid > 0 && Math.abs(a) > 0.01 ? LABEL_MIN_TILT : LABEL_MIN, box: self.box };
      el.style.opacity = "";
    },
  };
  return self;
}


/** One section of the legend's layer switches: the regions it switches (ids), its name and the colours it lists. */
export interface LegendSection {
  ids: string[];
  name: string;
  rows: readonly LegendEntry[];
}

/** Rows of a section: its colours, a name once however many of its regions use it. */
export function mergeRows(rows: readonly LegendEntry[]): LegendEntry[] {
  const seen = new Set<string>();
  return rows.filter((e) => !seen.has(e.label.trim().toLowerCase()) && !!seen.add(e.label.trim().toLowerCase()));
}

/**
 * The region's legend: a colour swatch and a label per entry, top centre, folded and unfolded with its
 * header button. Labels are set with textContent; colours are validated #rgb/#rrggbb before they get here.
 */
export function makeLegend(stage: HTMLElement): {
  set(entries: readonly LegendEntry[], title: string, contested?: boolean): void;
  /**
   * Layer sections (set again to rebuild): a switch per section to show or hide its regions, with its colour keys
   * underneath (folded away while it is off).
   */
  layers(sections: readonly LegendSection[], hidden: ReadonlySet<string>, onToggle: (ids: string[], show: boolean) => void): void;
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
  box.append(head, list, layerBox);
  leftStack(stage).append(box);
  let count = 0;
  // Short embeds (the 360x240 Obsidian size) start folded so the legend doesn't cover the map.
  let open = innerHeight >= 300;
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
    layers(sections, hidden, onToggle) {
      const blocks = sections.map((sec) => {
        const block = document.createElement("div");
        block.className = "rgroup";
        const label = document.createElement("label");
        label.className = "rgroup-head";
        const t = document.createElement("span");
        t.textContent = sec.name;
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.setAttribute("role", "switch");
        cb.checked = !sec.ids.every((id) => hidden.has(id));
        label.append(t, cb);
        block.append(label);
        const keys = mergeRows(sec.rows).map((e) => {
          const li = document.createElement("li");
          const sw = document.createElement("i");
          sw.style.background = e.color;
          const k = document.createElement("span");
          k.textContent = e.label;
          li.append(sw, k);
          return li;
        });
        if (keys.length) {
          const ul = document.createElement("ul");
          ul.className = "rgroup-keys";
          ul.hidden = !cb.checked;
          ul.append(...keys);
          block.append(ul);
          cb.addEventListener("change", () => (ul.hidden = !cb.checked));
        }
        cb.addEventListener("change", () => onToggle(sec.ids, cb.checked));
        return block;
      });
      layerBox.replaceChildren(...blocks);
      apply();
      box.hidden = !count && !blocks.length;
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
    /**
     * After placing every label: a label under the legend, the corner buttons or a pin marker slides to the nearest
     * clear spot beside it, and fades only when there is none. Where two pills overlap, the one on the larger
     * part stays and the other slides or fades.
     */
    settle(root) {
      type Box = { x0: number; y0: number; x1: number; y1: number };
      const s = root.getBoundingClientRect();
      const fixed: Box[] = [];
      const add = (e: Element | null | undefined) => {
        if (!e || (e as HTMLElement).hidden) return;
        const r = e.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) fixed.push({ x0: r.left - s.left - 2, y0: r.top - s.top - 2, x1: r.right - s.left + 2, y1: r.bottom - s.top + 2 });
      };
      // The left panel stack (legend, pin panels) panel by panel, and the corner buttons.
      root.querySelectorAll(":scope > .rstack > *").forEach(add);
      add(root.querySelector("#ui") ?? document.querySelector("#ui"));
      root.querySelectorAll(".wpin").forEach(add);
      const W = root.clientWidth;
      const H = root.clientHeight;
      const hit = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
      const placed: Box[] = [];
      for (const l of [...pool].filter((l) => l.box).sort((a, b) => b.rank - a.rank)) {
        const clear = (b: Box) => b.x0 >= 0 && b.y0 >= 0 && b.x1 <= W && b.y1 <= H && ![...fixed, ...placed].some((k) => hit(b, k));
        // At its size, then one step smaller at a time down to the minimum: stay put, else slide clear of the panel/pins, else shrink; fade only when nothing fits.
        let b = l.box!;
        let ok = false;
        for (;;) {
          if (clear(b)) {
            ok = true;
            break;
          }
          // Only the legend, buttons and pins make a label slide; a clash with another label shrinks, then fades the smaller one.
          const obstacles = fixed.filter((k) => hit(b, k));
          if (obstacles.length) {
            const tries: [number, number][] = obstacles.flatMap((k): [number, number][] => [
              [k.x1 - b.x0, 0],
              [k.x0 - b.x1, 0],
              [0, k.y1 - b.y0],
              [0, k.y0 - b.y1],
            ]);
            // Also the sides of the obstacles' joint box, for a spot that clears several at once.
            const joint = {
              x0: Math.min(...obstacles.map((k) => k.x0)),
              y0: Math.min(...obstacles.map((k) => k.y0)),
              x1: Math.max(...obstacles.map((k) => k.x1)),
              y1: Math.max(...obstacles.map((k) => k.y1)),
            };
            tries.push([joint.x1 - b.x0, 0], [joint.x0 - b.x1, 0], [0, joint.y1 - b.y0], [0, joint.y0 - b.y1]);
            const moved = tries
              .map(([dx, dy]) => ({ dx, dy, m: { x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 + dx, y1: b.y1 + dy } }))
              .filter((t) => Math.hypot(t.dx, t.dy) <= MAX_SLIDE && clear(t.m))
              .sort((p, q) => Math.hypot(p.dx, p.dy) - Math.hypot(q.dx, q.dy))[0];
            if (moved) {
              l.shove(moved.dx, moved.dy);
              b = moved.m;
              ok = true;
              break;
            }
          }
          if (!l.shrink()) break;
          b = l.box!;
        }
        if (!ok) {
          l.el.style.opacity = "0";
          continue;
        }
        l.el.style.opacity = "";
        placed.push(b);
      }
    },
  };
}

/**
 * Stacked regions (?regions=a,b,c): which are shown. `of(r)` is the region to paint: r without the hidden
 * ones, the same object for the same state (so painters can cache on it). The last one can't be hidden.
 */
export function makeVisibility(): { hidden: Set<string>; /** Ids of regions with a legend section of their own (layer groups): their colours are not in the main list. */ grouped: Set<string>; of(r: RegionData): RegionData } {
  const hidden = new Set<string>();
  const grouped = new Set<string>();
  let last: { r: RegionData; key: string; out: RegionData } | null = null;
  return {
    hidden,
    grouped,
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

/** The main legend list: the colours of what is shown, minus the regions that list theirs in a layer section. */
export function mainLegendRows(shown: RegionData, visible: { grouped: ReadonlySet<string> }): LegendEntry[] {
  if (!visible.grouped.size) return legendRowsFor(shown);
  if (!shown.members) return visible.grouped.has(shown.id) ? [] : legendRowsFor(shown);
  return legendRowsFor(shown, (m) => !visible.grouped.has(m.id));
}

/**
 * The legend's layer switches. A layer group (`layers.groups`: name + member ids) is one section with one switch and
 * its members' colours; any other region gets a switch of its own, named by `layers.names` (else its name or id).
 * The last shown region stays on (its switch snaps back).
 */
export function setupLayers(
  legend: { layers: ReturnType<typeof makeLegend>["layers"] },
  r: RegionData,
  visible: ReturnType<typeof makeVisibility>,
  redraw: () => void,
  layers?: { names: Record<string, string>; title: string; hidden: string[]; own?: boolean; groups?: { n: string; ids: string[] }[] },
): void {
  const members = r.members;
  visible.grouped.clear();
  if (!members) return legend.layers([], visible.hidden, () => {});
  // A region over its underlays (r.clip) is always shown, with no toggle, unless it is given one of its own (layers.own).
  const top = r.clip && !layers?.own ? members[members.length - 1] : undefined;
  const byId = new Map(members.map((m) => [m.id, m]));
  const taken = new Set<string>();
  const sections: LegendSection[] = [];
  for (const g of layers?.groups ?? []) {
    const ids = g.ids.filter((id) => byId.has(id) && id !== top?.id && !taken.has(id));
    if (!ids.length || !g.n.trim()) continue;
    ids.forEach((id) => (taken.add(id), visible.grouped.add(id)));
    const set = new Set(ids);
    sections.push({ ids, name: g.n.trim(), rows: legendRowsFor(r, (m) => set.has(m.id)) });
  }
  // Regions outside any group: a switch each, in order.
  for (const m of members) if (m !== top && !taken.has(m.id)) sections.push({ ids: [m.id], name: layers?.names[m.id]?.trim() || m.name || m.id, rows: [] });
  visible.hidden.clear();
  for (const id of layers?.hidden ?? []) if (id !== top?.id) visible.hidden.add(id);
  const build = (): void =>
    legend.layers(sections, visible.hidden, (ids, show) => {
      if (show) ids.forEach((id) => visible.hidden.delete(id));
      else if (top || members.length - new Set([...visible.hidden, ...ids]).size >= 1) ids.forEach((id) => visible.hidden.add(id));
      else return build();
      redraw();
    });
  build();
}
