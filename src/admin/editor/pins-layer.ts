/**
 * The editor's pins layer: the slot's pins painted on the editor canvas, under the region's handles and badges, so a
 * region can be drawn with its places in view. A "Show pins" switch lives in the "Other regions" panel and is remembered
 * in this browser. Read-only and never takes a click or drag: hovering a pin shows its name and kind; pins are
 * changed in the Pins tab.
 */
import { h } from "../dom.ts";
import { PIN_ICON_PATHS, inkFor } from "../../shared/pin-icons.ts";
import { kindInfo, pinColor, type PinFeature } from "../../shared/pins.ts";

export const PINS_PREF = "wge.editor.pins";
const R = 11;

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

const paths = new Map<string, Path2D[]>();
const iconPaths = (kind: PinFeature["properties"]["kind"]): Path2D[] => {
  let p = paths.get(kind);
  if (!p) paths.set(kind, (p = PIN_ICON_PATHS[kind].map((d) => new Path2D(d))));
  return p;
};

export interface PinsLayer {
  /** The "Show pins" row, for the Other regions panel. */
  row: HTMLElement;
  /** The hover tooltip, for the map area. */
  tip: HTMLElement;
  on: () => boolean;
  /** Paints the markers (call before the region's handles); `offs` are the world-copy offsets in degrees. */
  draw: (g: CanvasRenderingContext2D, offs: number[]) => void;
  /** Shows the tooltip for the pin under the pointer (canvas CSS pixels), or hides it. */
  hover: (x: number, y: number, offs: number[]) => void;
  /** Re-reads the pins. */
  refresh: () => void;
}

export function createPinsLayer(o: { pins: () => PinFeature[]; sx: (lon: number) => number; sy: (lat: number) => number; changed: () => void }): PinsLayer {
  let on = load();
  let shown: PinFeature[] = [];
  const tip = h("div", { className: "ed-pin-tip", hidden: true });
  const box = h("input", { type: "checkbox", checked: on, name: "ed-pins-show" });
  const info = h("span", { className: "muted small" });
  const row = h("label", { className: "check ed-ov-pins", title: "Show this map's pins on the editor map (change them in the Pins tab)" }, box, "Show pins", info);

  function refresh(): void {
    shown = o.pins();
    box.disabled = !shown.length;
    info.textContent = shown.length ? ` (${shown.length})` : " (none on this map)";
  }

  function draw(g: CanvasRenderingContext2D, offs: number[]): void {
    if (!on) return;
    g.save();
    for (const p of shown) {
      const bg = pinColor(p.properties);
      const [lon, lat] = p.geometry.coordinates;
      const y = o.sy(lat);
      for (const off of offs) {
        const x = o.sx(lon + off);
        g.beginPath();
        g.arc(x, y, R, 0, Math.PI * 2);
        g.fillStyle = bg;
        g.fill();
        g.lineWidth = 2;
        g.strokeStyle = "rgba(255,255,255,.92)";
        g.stroke();
        g.save();
        g.translate(x - 7, y - 7);
        g.scale(14 / 24, 14 / 24);
        g.strokeStyle = inkFor(bg);
        g.lineWidth = 2;
        g.lineCap = "round";
        g.lineJoin = "round";
        for (const d of iconPaths(p.properties.kind)) g.stroke(d);
        g.restore();
      }
    }
    g.restore();
  }

  function hover(x: number, y: number, offs: number[]): void {
    let hit: PinFeature | null = null;
    if (on)
      for (const p of shown)
        for (const off of offs) if (Math.hypot(o.sx(p.geometry.coordinates[0] + off) - x, o.sy(p.geometry.coordinates[1]) - y) <= R + 2) hit = p;
    if (!hit) {
      tip.hidden = true;
      return;
    }
    tip.textContent = `${hit.properties.name || "(unnamed)"} · ${kindInfo(hit.properties.kind).label}`;
    tip.hidden = false;
    tip.style.left = `${Math.round(x + 14)}px`;
    tip.style.top = `${Math.round(y + 14)}px`;
  }

  box.addEventListener("change", () => {
    on = box.checked;
    save(on);
    if (!on) tip.hidden = true;
    o.changed();
  });
  refresh();
  return { row, tip, on: () => on, draw, hover, refresh };
}
