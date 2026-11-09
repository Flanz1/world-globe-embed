/** Region types and helpers shared by the build, the viewer and the admin page. */
import { BASE_DISTANCE, FOV_DEG, ZOOM_MAX, ZOOM_MIN, clamp } from "./params.ts";
import {
  MAX_VERTICES,
  boundingCap,
  geometryBounds,
  imageToGlobe,
  mapGeometry,
  type GlobeFrame,
  type Position,
  type RegionGeometry,
  type Ring,
} from "./geo.ts";

export const REGION_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** #rgb or #rrggbb, nothing else (so it can never break out of a CSS or style context). */
export const REGION_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
export const DEFAULT_FILL_OPACITY = 0.35;
export const NAME_MAX = 80;
export const DESCRIPTION_MAX = 500;

export interface RegionProperties {
  name: string;
  slot: string;
  map: string;
  color: string;
  fillOpacity?: number;
  label?: boolean;
  description?: string;
  updated?: string;
}

/** content/regions/<id>.json */
export interface RegionFeature {
  $schema?: string;
  type: "Feature";
  id: string;
  properties: RegionProperties;
  geometry: RegionGeometry;
}

/** What an embed loads: regions/<id>.json in the built site (and the preview's postMessage payload). */
export interface RegionData {
  id: string;
  slot: string;
  name: string;
  color: string;
  fillOpacity: number;
  label: boolean;
  geometry: RegionGeometry;
}

/** Inlined per region into its slot page so the poster can face it before anything loads. */
export interface RegionIndexEntry {
  /** Globe-frame [lon, lat] the camera faces. */
  c: [number, number];
  /** Zoom that fits the region. */
  z: number;
  /** Map-image-frame bounds [west, south, east, north] for the flat view (east may exceed 180). */
  b: [number, number, number, number];
}

export function regionData(f: RegionFeature): RegionData {
  const p = f.properties;
  return {
    id: f.id,
    slot: p.slot,
    name: p.name,
    color: p.color,
    fillOpacity: p.fillOpacity ?? DEFAULT_FILL_OPACITY,
    label: p.label ?? true,
    geometry: f.geometry,
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parseRing(v: unknown, budget: { n: number }): Ring | null {
  if (!Array.isArray(v) || v.length > MAX_VERTICES + 1) return null;
  const out: Ring = [];
  for (const p of v) {
    if (!Array.isArray(p) || p.length !== 2) return null;
    const [x, y] = p as unknown[];
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (x < -180 || x > 180 || y < -90 || y > 90) return null;
    if (--budget.n < 0) return null;
    out.push([x, y]);
  }
  return out;
}

function parsePolygon(v: unknown, budget: { n: number }): Ring[] | null {
  if (!Array.isArray(v) || !v.length || v.length > 1000) return null;
  const out: Ring[] = [];
  for (const r of v) {
    const ring = parseRing(r, budget);
    if (!ring) return null;
    out.push(ring);
  }
  return out;
}

/** Geometry from untrusted data: right shape, finite numbers in range, and within the vertex cap. */
export function parseGeometry(v: unknown): RegionGeometry | null {
  if (!isObj(v)) return null;
  // Positions, closing ones included: at most the vertex cap plus one closing position per ring.
  const budget = { n: MAX_VERTICES * 2 };
  if (v.type === "Polygon") {
    const c = parsePolygon(v.coordinates, budget);
    return c ? { type: "Polygon", coordinates: c } : null;
  }
  if (v.type === "MultiPolygon") {
    if (!Array.isArray(v.coordinates) || !v.coordinates.length || v.coordinates.length > 1000) return null;
    const polys: Ring[][] = [];
    for (const p of v.coordinates) {
      const poly = parsePolygon(p, budget);
      if (!poly) return null;
      polys.push(poly);
    }
    return { type: "MultiPolygon", coordinates: polys };
  }
  return null;
}

/**
 * Validates region data from outside the page (a fetched regions/<id>.json, or a postMessage from the
 * admin page). Everything is checked and copied; anything unexpected gives null. Strings are only ever
 * used as text.
 */
export function parseRegionData(v: unknown): RegionData | null {
  if (!isObj(v)) return null;
  const { id, slot, name, color, fillOpacity, label, geometry } = v;
  if (typeof id !== "string" || !REGION_ID.test(id)) return null;
  if (typeof slot !== "string" || !REGION_ID.test(slot)) return null;
  if (typeof name !== "string" || name.length > NAME_MAX) return null;
  if (typeof color !== "string" || !REGION_COLOR.test(color)) return null;
  if (typeof fillOpacity !== "number" || !Number.isFinite(fillOpacity) || fillOpacity < 0 || fillOpacity > 1) return null;
  if (typeof label !== "boolean") return null;
  const g = parseGeometry(geometry);
  if (!g) return null;
  return { id, slot, name, color, fillOpacity, label, geometry: g };
}

/* ── Framing ── */

/** Fraction of the view's shorter side the region's bounding cap should fill. */
export const FIT_FRACTION = 0.6;

/** Zoom at which a bounding cap of `radiusDeg` fills FIT_FRACTION of the view. */
export function zoomForCap(radiusDeg: number): number {
  const r = clamp(radiusDeg, 0.05, 180) * (Math.PI / 180);
  if (r >= Math.PI / 2) return ZOOM_MIN;
  // A cap point at angle r from the centre, seen from distance d: tan α = sin r / (d − cos r).
  const d = Math.cos(r) + Math.sin(r) / (FIT_FRACTION * Math.tan(((FOV_DEG / 2) * Math.PI) / 180));
  return clamp(BASE_DISTANCE / d, ZOOM_MIN, ZOOM_MAX);
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Where the globe should face, and how far in, to frame the region (globe frame, after padding and shift). */
export function regionFit(g: RegionGeometry, frame: GlobeFrame): { lon: number; lat: number; zoom: number; centre: Position; radius: number } {
  const onGlobe = mapGeometry(g, (p) => imageToGlobe(p, frame));
  const { centre, radius } = boundingCap(onGlobe);
  return { lon: r2(centre[0]), lat: r2(centre[1]), zoom: Math.round(zoomForCap(radius) * 1000) / 1000, centre, radius };
}

export function regionIndexEntry(g: RegionGeometry, frame: GlobeFrame): RegionIndexEntry {
  const fit = regionFit(g, frame);
  const b = geometryBounds(g).map(r2) as [number, number, number, number];
  return { c: [fit.lon, fit.lat], z: fit.zoom, b };
}

/* ── Flat view framing, shared by the boot script's poster and the flat renderer so they line up ── */

export const FLAT_MARGIN = 0.15;
/** Most screen pixels per degree of longitude in the flat view. */
export const FLAT_K_MAX = 60;

export interface FlatView {
  /** Map-image-frame lon/lat at the centre of the screen (lon may leave ±180; the map repeats). */
  cx: number;
  cy: number;
  /** Screen pixels per degree of longitude. Latitude uses k * 2 / aspect, so the image keeps its proportions. */
  k: number;
}

/** Smallest k that still shows the whole map. */
export const flatMinK = (aspect: number, vw: number, vh: number): number => Math.min(vw / 360, vh / (180 * (2 / aspect)));

/** Frames the bounds [west, south, east, north] with FLAT_MARGIN on every side. */
export function flatFit(b: [number, number, number, number], aspect: number, vw: number, vh: number): FlatView {
  const ky = 2 / aspect;
  const bw = Math.max(0.5, b[2] - b[0]) * (1 + 2 * FLAT_MARGIN);
  const bh = Math.max(0.5, b[3] - b[1]) * (1 + 2 * FLAT_MARGIN);
  const k = clamp(Math.min(vw / bw, vh / (bh * ky)), flatMinK(aspect, vw, vh), FLAT_K_MAX);
  return { cx: (b[0] + b[2]) / 2, cy: (b[1] + b[3]) / 2, k };
}

/* ── Ids ── */

export function slugify(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

/** A free id for a new region based on `base` (e.g. from its name). */
export function uniqueId(base: string, taken: Set<string>): string {
  const b = slugify(base) || "region";
  if (!taken.has(b)) return b;
  for (let i = 2; ; i++) {
    const suffix = `-${i}`;
    const id = b.slice(0, 64 - suffix.length).replace(/-+$/, "") + suffix;
    if (!taken.has(id)) return id;
  }
}

/** `<id>-copy`, `<id>-copy-2`, … */
export function copyId(id: string, taken: Set<string>): string {
  for (let i = 1; ; i++) {
    const suffix = i === 1 ? "-copy" : `-copy-${i}`;
    const c = id.slice(0, 64 - suffix.length).replace(/-+$/, "") + suffix;
    if (!taken.has(c)) return c;
  }
}
