import type { ViewDefaults } from "./types.ts";

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Normalises a bg value; anything that isn't "transparent" or a hex colour is rejected. */
export function parseBg(v: string | null | undefined): string | undefined {
  if (v == null) return undefined;
  const s = v.trim();
  if (s === "transparent") return s;
  const hex = s.startsWith("#") ? s : `#${s}`;
  return HEX.test(hex) ? hex : undefined;
}

/** A #hex colour, or undefined. */
export function parseHex(v: string | null | undefined): string | undefined {
  const b = parseBg(v);
  return b && b !== "transparent" ? b : undefined;
}

export const MAX_PAD = 49;

/** Keeps north + south padding below 98% so some of the map is always visible. */
export function clampPadding(north: number, south: number): { north: number; south: number } {
  const n = clamp(north, 0, MAX_PAD);
  const s = clamp(south, 0, MAX_PAD);
  return { north: n, south: s };
}

function bool(v: string | null): boolean | undefined {
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return undefined;
}

function num(v: string | null, lo: number, hi: number): number | undefined {
  if (v == null || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? clamp(n, lo, hi) : undefined;
}

/** "globe" or "flat", or undefined for anything else. */
export function parseView(v: string | null | undefined): ViewDefaults["view"] | undefined {
  return v === "globe" || v === "flat" ? v : undefined;
}

/** Applies query-string overrides (view, grid, rotate, bg, lat, lon, zoom, controls, legend, north, south, pole). */
export function applyParams<T extends ViewDefaults>(base: T, search: string): T {
  const q = new URLSearchParams(search);
  const out = { ...base };
  const set = <K extends keyof ViewDefaults>(k: K, v: ViewDefaults[K] | undefined) => {
    if (v !== undefined) out[k] = v as T[K];
  };
  set("view", parseView(q.get("view")));
  set("grid", bool(q.get("grid")));
  set("rotate", bool(q.get("rotate")));
  set("controls", bool(q.get("controls")));
  set("legend", bool(q.get("legend")));
  set("bg", parseBg(q.get("bg")));
  set("lat", num(q.get("lat"), -90, 90));
  set("lon", num(q.get("lon"), -180, 180));
  set("zoom", num(q.get("zoom"), ZOOM_MIN, ZOOM_MAX));
  set("north", num(q.get("north"), 0, MAX_PAD));
  set("south", num(q.get("south"), 0, MAX_PAD));
  set("pole", parseHex(q.get("pole")));
  set("shift", num(q.get("shift"), -180, 180));
  return out;
}

/* ── Camera framing, shared by the poster (pre-WebGL) and the 3D scene so they line up exactly ── */

export const FOV_DEG = 50;
/** Camera distance at zoom 1, same as the desktop visualizer. */
export const BASE_DISTANCE = 2.8;
export const MIN_DISTANCE = 1.25;
export const MAX_DISTANCE = 6;
export const ZOOM_MIN = BASE_DISTANCE / MAX_DISTANCE;
export const ZOOM_MAX = BASE_DISTANCE / MIN_DISTANCE;

export const distanceForZoom = (zoom: number): number =>
  clamp(BASE_DISTANCE / zoom, MIN_DISTANCE, MAX_DISTANCE);

/**
 * On-screen globe diameter as a fraction of min(viewport width, height).
 * The camera keeps a 50° field of view across the viewport's shorter side,
 * so a unit sphere at distance d has angular radius asin(1/d).
 */
export const diameterFraction = (distance: number): number =>
  Math.tan(Math.asin(1 / distance)) / Math.tan((FOV_DEG / 2) * (Math.PI / 180));

/** CSS values that place the LQIP poster inside the padded band, matching the 3D globe. */
export function posterVars(v: { lon: number; north: number; south: number; shift?: number }): Record<string, string> {
  const { north, south } = clampPadding(v.north, v.south);
  const band = 100 - north - south;
  // The poster shows half the map centred on `lon`; a positive shift (degrees) moves the map east.
  const f = (v.lon + 180) / 360 - (v.shift ?? 0) / 360;
  return {
    "--px": `${((f - 0.25) * 200).toFixed(2)}%`,
    "--ph": `${band.toFixed(2)}%`,
    "--py": `${north + south > 0 ? ((north / (north + south)) * 100).toFixed(2) : 50}%`,
  };
}
