/**
 * The editor's pins layer: the slot's pins drawn as markers over the map canvas, so a region can be drawn with its
 * places in view. A "Show pins" switch lives in the "Other regions" panel and is remembered in this browser.
 * The markers are read-only; pins are still changed in the Pins tab.
 */
import { h } from "../dom.ts";
import { pinIcon, inkFor } from "../../shared/pin-icons.ts";
import { kindInfo, pinColor, type PinFeature } from "../../shared/pins.ts";

export const PINS_PREF = "wge.editor.pins";

const load = (): boolean => {
  try {
    return localStorage.getItem(PINS_PREF) === "1";
  } catch {
    return false;
  }
};
const save = (on: boolean): void => {
  try {
    localStorage.setItem(PINS_PREF, on ? "1" : "0");
  } catch {
    /* not remembered: fine */
  }
};

export interface PinsLayer {
  /** The marker layer, for the map area (pointer events only on the markers). */
  el: HTMLElement;
  /** The "Show pins" row, for the Other regions panel. */
  row: HTMLElement;
  /** Repositions the markers (call after the view or the size changed). */
  update: () => void;
  /** Re-reads the pins (call when they may have changed). */
  refresh: () => void;
}

export function createPinsLayer(o: { pins: () => PinFeature[]; sx: (lon: number) => number; sy: (lat: number) => number; size: () => { w: number; h: number } }): PinsLayer {
  let on = load();
  let shown: PinFeature[] = [];
  const el = h("div", { className: "ed-pins", hidden: !on });
  const markers = new Map<string, HTMLButtonElement>();
  const box = h("input", { type: "checkbox", checked: on, name: "ed-pins-show" });
  const info = h("span", { className: "muted small" });
  const row = h("label", { className: "check ed-ov-pins", title: "Show this map's pins on the editor map (change them in the Pins tab)" }, box, "Show pins", info);

  function refresh(): void {
    shown = o.pins();
    info.textContent = ` (${shown.length})`;
    box.disabled = !shown.length;
    info.textContent = shown.length ? ` (${shown.length})` : " (none on this map)";
    const ids = new Set(shown.map((p) => p.id));
    for (const [id, b] of markers) {
      if (!ids.has(id)) {
        b.remove();
        markers.delete(id);
      }
    }
    for (const p of shown) {
      let b = markers.get(p.id);
      if (!b) {
        b = h("button", { type: "button", className: "pn-marker ed-pin", tabIndex: -1 });
        b.addEventListener("click", () => {
          const open = b!.getAttribute("aria-pressed") === "true";
          for (const m of markers.values()) m.setAttribute("aria-pressed", "false");
          b!.setAttribute("aria-pressed", String(!open));
        });
        markers.set(p.id, b);
        el.append(b);
      }
      const bg = pinColor(p.properties);
      b.style.background = bg;
      b.style.color = inkFor(bg);
      b.replaceChildren(pinIcon(p.properties.kind, 12));
      const label = `${p.properties.name || "(unnamed)"}, ${kindInfo(p.properties.kind).label}`;
      b.title = label;
      b.setAttribute("aria-label", label);
    }
    update();
  }

  function update(): void {
    el.hidden = !on;
    if (!on) return;
    const { w, h: hh } = o.size();
    for (const p of shown) {
      const b = markers.get(p.id);
      if (!b) continue;
      const [lon, lat] = p.geometry.coordinates;
      const x = o.sx(lon);
      const y = o.sy(lat);
      b.hidden = x < -14 || y < -14 || x > w + 14 || y > hh + 14;
      if (!b.hidden) b.style.transform = `translate(${Math.round(x - 13)}px,${Math.round(y - 13)}px)`;
    }
  }

  box.addEventListener("change", () => {
    on = box.checked;
    save(on);
    update();
  });
  refresh();
  return { el, row, update, refresh };
}
