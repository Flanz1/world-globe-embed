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

/** Applies query-string overrides (grid, rotate, bg, lat, lon, zoom, controls, legend). */
export function applyParams<T extends ViewDefaults>(base: T, search: string): T {
  const q = new URLSearchParams(search);
  const out = { ...base };
  const set = <K extends keyof ViewDefaults>(k: K, v: ViewDefaults[K] | undefined) => {
    if (v !== undefined) out[k] = v as T[K];
  };
  set("grid", bool(q.get("grid")));
  set("rotate", bool(q.get("rotate")));
  set("controls", bool(q.get("controls")));
  set("legend", bool(q.get("legend")));
  set("bg", parseBg(q.get("bg")));
  set("lat", num(q.get("lat"), -90, 90));
  set("lon", num(q.get("lon"), -180, 180));
  set("zoom", num(q.get("zoom"), ZOOM_MIN, ZOOM_MAX));
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
