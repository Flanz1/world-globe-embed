/**
 * Region embed UI shared by the globe and flat viewers: the view lock, the region label and the
 * "Region not found" note. Region strings are only ever set with textContent.
 */
import type { LegendEntry } from "../shared/region.ts";

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

/** An HTML label (textContent only) that is kept clear of the control buttons. */
export function makeLabel(stage: HTMLElement): { setText(t: string): void; place(x: number, y: number, visible: boolean): void; el: HTMLDivElement } {
  const el = document.createElement("div");
  el.className = "rlabel";
  el.hidden = true;
  el.setAttribute("aria-hidden", "true");
  stage.append(el);
  let text = "";
  return {
    el,
    setText(t: string) {
      text = t;
      el.textContent = t;
    },
    place(x: number, y: number, visible: boolean) {
      el.hidden = !visible || !text;
      if (el.hidden) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const W = stage.clientWidth;
      const H = stage.clientHeight;
      const left = Math.min(Math.max(4, x - w / 2), W - w - 4);
      let top = Math.min(Math.max(4, y - h / 2), H - h - 4);
      const ui = document.getElementById("ui");
      if (ui && !ui.hidden) {
        const r = ui.getBoundingClientRect();
        const s = stage.getBoundingClientRect();
        const ux = r.left - s.left - 4;
        const uy = r.top - s.top - 4;
        // Overlapping the button cluster: move just above it.
        if (left + w > ux && top + h > uy) top = uy - h;
      }
      el.style.transform = `translate(${Math.round(left)}px,${Math.round(top)}px)`;
    },
  };
}

/**
 * The region's legend: a colour swatch and a label per entry, top left, folded and unfolded with its
 * header button. Labels are set with textContent; colours are validated #rgb/#rrggbb before they get here.
 */
export function makeLegend(stage: HTMLElement): { set(entries: readonly LegendEntry[], title: string): void } {
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
  box.append(head, list);
  stage.append(box);
  let open = true;
  const apply = () => {
    head.setAttribute("aria-expanded", String(open));
    head.title = open ? "Hide legend" : "Show legend";
    list.hidden = !open;
  };
  head.addEventListener("click", () => {
    open = !open;
    apply();
  });
  // Clicks and drags on the legend shouldn't reach the viewer under it.
  for (const t of ["pointerdown", "wheel"] as const) box.addEventListener(t, (e) => e.stopPropagation());
  apply();
  return {
    set(entries, title) {
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
      list.replaceChildren(...rows);
      box.hidden = !entries.length;
    },
  };
}

/** Several labels (one per labelled part), each placed like makeLabel's. */
export function makeLabels(stage: HTMLElement): { set(texts: string[]): void; place(i: number, x: number, y: number, visible: boolean): void } {
  const pool: ReturnType<typeof makeLabel>[] = [];
  return {
    set(texts) {
      while (pool.length < texts.length) pool.push(makeLabel(stage));
      pool.forEach((l, i) => {
        l.setText(texts[i] ?? "");
        if (i >= texts.length) l.place(0, 0, false);
      });
    },
    place(i, x, y, visible) {
      pool[i]?.place(x, y, visible);
    },
  };
}

export const prefersReducedMotion = (): boolean => matchMedia("(prefers-reduced-motion: reduce)").matches;
