/** Region types and helpers shared by the build, the viewer and the admin page. */
import { BASE_DISTANCE, FOV_DEG, ZOOM_MAX, ZOOM_MIN, clamp } from "./params.ts";
import {
  MAX_VERTICES,
  boundingCap,
  geometryBounds,
  imageToGlobe,
  mapGeometry,
  partAnchors,
  polygonsOf,
  sphericalCentroid,
  type GlobeFrame,
  type Position,
  type RegionGeometry,
  type Ring,
} from "./geo.ts";
import type { Account } from "./access.ts";

export const REGION_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** #rgb or #rrggbb, nothing else (so it can never break out of a CSS or style context). */
export const REGION_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
export const DEFAULT_FILL_OPACITY = 0.35;
export const NAME_MAX = 80;
export const DESCRIPTION_MAX = 500;
/** Most legend entries per region, and the longest legend label. */
export const LEGEND_MAX = 16;
export const LEGEND_LABEL_MAX = 60;
export const LEGEND_TITLE_MAX = 40;
export const PART_LABEL_MAX = 80;
/** partLegend value for a part drawn in the region's own colour. */
export const OWN_COLOUR = -1;

/** One legend row: a colour some of the region's parts are drawn in, and what it means. */
export interface LegendEntry {
  label: string;
  color: string;
}

export interface RegionProperties {
  /** Legacy display name: shown as one label at the middle of the region when there are no partLabels. */
  name?: string;
  slot: string;
  map: string;
  color: string;
  fillOpacity?: number;
  label?: boolean;
  description?: string;
  /** Heading of the embed's legend; "Legend" when empty or missing. */
  legendTitle?: string;
  /** Extra colours, each with a label, shown as a legend in the embed. */
  legend?: LegendEntry[];
  /**
   * One entry per polygon of the geometry (a Polygon counts as one), in order: the index of the legend
   * entry whose colour that part is drawn in, or -1 for the region's own colour. Missing means all -1.
   */
  partLegend?: number[];
  /** One label per part (polygon), in order; "" for a part without one. */
  partLabels?: string[];
  /**
   * One entry per part, in order: -1 for a normal part, or k for a contested zone extending part k (a
   * normal part). The embed draws contested zones hatched. Missing means all -1.
   */
  partContested?: number[];
  /**
   * One entry per part, in order: true for a part locked in the admin editor (it can't be dragged or
   * nudged as a whole; its vertices still can), false for one left unlocked. Editor-only: the embed
   * ignores it. Locked is the default: a missing list or entry means locked.
   */
  partLocked?: boolean[];
  /** Province borders: open lines drawn inside the region (dotted in the embed). They don't change the parts. */
  provinceBorders?: Position[][];
  /**
   * Draw national borders: where two parts share a line exactly, a dark line on a light casing between
   * different legend colours (the line is left off between parts of one colour). Off unless true: parts
   * that touch just touch.
   */
  nationalBorders?: boolean;
  updated?: string;
  /** When the region was first saved. */
  created?: string;
  /** Who created it (missing on regions from before owners existed: those belong to the repository owner). */
  createdBy?: Account;
  /** Who saved this version. */
  updatedBy?: Account;
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
  /** Legend heading (may be empty) and rows (may be empty: no legend). */
  legendTitle: string;
  legend: LegendEntry[];
  /** Per polygon: legend index, or -1 for `color`. Same length as the geometry's polygon list. */
  parts: number[];
  /** Per polygon: its label ("" for none). All empty means: show `name` once, at the region's middle. */
  labels: string[];
  /** Per polygon: -1, or the normal part this contested zone extends. */
  contested: number[];
  geometry: RegionGeometry;
  /** Province borders (open lines), drawn dotted where they lie inside the region's parts. Missing: none. */
  provinceBorders?: Position[][];
  /** Draw national borders where parts share a line (see RegionProperties.nationalBorders). Missing: no. */
  nationalBorders?: boolean;
}

/** Most positions in a region's province borders, all lines together. */
export const PROVINCE_BORDER_MAX = 5000;

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
    name: p.name ?? "",
    color: p.color,
    fillOpacity: p.fillOpacity ?? DEFAULT_FILL_OPACITY,
    label: p.label ?? true,
    legendTitle: p.legendTitle ?? "",
    legend: (p.legend ?? []).map((e) => ({ label: e.label, color: e.color })),
    parts: normalizePartLegend(p.partLegend, polygonsOf(f.geometry).length, p.legend?.length ?? 0),
    labels: normalizePartLabels(p.partLabels, polygonsOf(f.geometry).length),
    contested: normalizePartContested(p.partContested, polygonsOf(f.geometry).length),
    geometry: f.geometry,
    ...(p.provinceBorders?.length ? { provinceBorders: p.provinceBorders.map((l) => l.map(([x, y]) => [x, y] as Position)) } : {}),
    ...(p.nationalBorders === true ? { nationalBorders: true } : {}),
  };
}

/** Province borders from outside the page: lines of at least 2 positions in range, PROVINCE_BORDER_MAX in all; else null. */
export function parseProvinceBorders(v: unknown): Position[][] | null {
  if (!Array.isArray(v) || v.length > 500) return null;
  const budget = { n: PROVINCE_BORDER_MAX };
  const out: Position[][] = [];
  for (const l of v) {
    const line = parseRing(l, budget);
    if (!line || line.length < 2) return null;
    out.push(line);
  }
  return out;
}

/**
 * partContested padded or cut to `n` parts. Anything that isn't a valid zone becomes -1 (normal): out
 * of range, pointing at itself, or pointing at a part that is itself a contested zone.
 */
export function normalizePartContested(v: readonly unknown[] | undefined, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const k = v?.[i];
    out.push(typeof k === "number" && Number.isInteger(k) && k >= 0 && k < n && k !== i ? k : OWN_COLOUR);
  }
  // No chains: a zone must extend a normal part.
  const first = [...out];
  return first.map((k) => (k >= 0 && first[k] !== OWN_COLOUR ? OWN_COLOUR : k));
}

/** partLocked padded or cut to `n` parts. Locked is the default: only an explicit `false` unlocks a part. */
export function normalizePartLocked(v: readonly unknown[] | undefined, n: number): boolean[] {
  return Array.from({ length: n }, (_, i) => v?.[i] !== false);
}

/** Problems with a saved region's partContested (beyond what the schema checks). */
export function checkParts(p: RegionProperties, g: RegionGeometry, where: string): string[] {
  const errors: string[] = [];
  const pb = p.provinceBorders;
  if (pb !== undefined && parseProvinceBorders(pb) === null) {
    const n = Array.isArray(pb) ? pb.reduce((m: number, l: unknown) => m + (Array.isArray(l) ? l.length : 0), 0) : 0;
    errors.push(
      n > PROVINCE_BORDER_MAX
        ? `${where}: "provinceBorders" has ${n} positions; at most ${PROVINCE_BORDER_MAX} in all`
        : `${where}: "provinceBorders" must be lines of at least 2 [lon, lat] positions within range`,
    );
  }
  const c = p.partContested;
  if (!c) return errors;
  const n = polygonsOf(g).length;
  if (c.length !== n)
    errors.push(`${where}: "partContested" has ${c.length} entr${c.length === 1 ? "y" : "ies"} but the geometry has ${n} part${n === 1 ? "" : "s"}; it needs one per part (-1 for a normal part)`);
  c.forEach((k, i) => {
    if (typeof k !== "number" || !Number.isInteger(k)) return void errors.push(`${where}: "partContested" entry ${i} must be a whole number`);
    if (k === OWN_COLOUR) return;
    if (k < 0 || k >= n) errors.push(`${where}: "partContested" entry ${i} is ${k}, but there ${n === 1 ? "is 1 part" : `are ${n} parts`} (use -1 for a normal part, or the index of the part it extends, counted from 0)`);
    else if (k === i) errors.push(`${where}: "partContested" entry ${i} points at itself; a contested zone extends another part`);
    else if (c[k] !== OWN_COLOUR) errors.push(`${where}: "partContested" entry ${i} points at part ${k}, which is itself a contested zone; a zone must extend a normal part`);
  });
  return errors;
}

/** partLabels padded or cut to `n` parts (missing or non-text entries become ""). */
export function normalizePartLabels(v: readonly unknown[] | undefined, n: number): string[] {
  return Array.from({ length: n }, (_, i) => (typeof v?.[i] === "string" ? (v[i] as string).slice(0, PART_LABEL_MAX) : ""));
}

/** partLegend padded or cut to `n` parts, with anything out of range turned into -1. */
export function normalizePartLegend(v: readonly number[] | undefined, n: number, legendLength: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const k = v?.[i];
    out.push(typeof k === "number" && Number.isInteger(k) && k >= 0 && k < legendLength ? k : OWN_COLOUR);
  }
  return out;
}

/** Problems with a saved region's legend and partLegend (beyond what the schema checks). */
export function checkLegend(p: RegionProperties, g: RegionGeometry, where: string): string[] {
  const errors: string[] = [];
  const n = p.legend?.length ?? 0;
  const parts = polygonsOf(g).length;
  if (p.partLegend) {
    if (p.partLegend.length !== parts)
      errors.push(`${where}: "partLegend" has ${p.partLegend.length} entr${p.partLegend.length === 1 ? "y" : "ies"} but the geometry has ${parts} part${parts === 1 ? "" : "s"}; it needs one per part`);
    p.partLegend.forEach((k, i) => {
      if (k !== OWN_COLOUR && (k < 0 || k >= n)) errors.push(`${where}: "partLegend" entry ${i} is ${k}, but the legend has ${n} entr${n === 1 ? "y" : "ies"} (use -1 for the region's own colour)`);
    });
  }
  if (p.partLabels && p.partLabels.length !== parts)
    errors.push(`${where}: "partLabels" has ${p.partLabels.length} entr${p.partLabels.length === 1 ? "y" : "ies"} but the geometry has ${parts} part${parts === 1 ? "" : "s"}; it needs one per part ("" for no label)`);
  return errors;
}

/**
 * Where the embed puts text: one label per part that has one (at a point inside that part), or, for a
 * region without part labels, its name once at the middle of the region. Map-image frame.
 */
export function regionLabelPoints(r: Pick<RegionData, "name" | "labels" | "geometry">): { text: string; at: Position }[] {
  if (r.labels.some((t) => t.trim())) {
    const at = partAnchors(r.geometry);
    return r.labels.flatMap((t, i) => (t.trim() && at[i] ? [{ text: t, at: at[i]! }] : []));
  }
  return r.name.trim() ? [{ text: r.name, at: sphericalCentroid(r.geometry) }] : [];
}

/** A region as fill layers: its parts grouped by colour, region colour first, then legend order. */
export function regionLayers(r: Pick<RegionData, "color" | "legend" | "parts" | "geometry">): { color: string; geometry: RegionGeometry }[] {
  const polys = polygonsOf(r.geometry);
  const groups = new Map<number, Ring[][]>();
  polys.forEach((poly, i) => {
    const k = r.parts[i] ?? OWN_COLOUR;
    const key = k >= 0 && k < r.legend.length ? k : OWN_COLOUR;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(poly);
  });
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([k, coordinates]) => ({ color: k === OWN_COLOUR ? r.color : r.legend[k].color, geometry: { type: "MultiPolygon" as const, coordinates } }));
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parseRing(v: unknown, budget: { n: number }): Ring | null {
  if (!Array.isArray(v) || v.length > MAX_VERTICES + 1 || v.length > budget.n) return null;
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
    // An empty MultiPolygon is allowed here (the editor sends one when every part was deleted); saved files need at least one part.
    if (!Array.isArray(v.coordinates) || v.coordinates.length > 1000) return null;
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
  const { id, slot, name, color, fillOpacity, label, geometry, legend, legendTitle, parts, labels, contested, provinceBorders, nationalBorders } = v;
  if (typeof id !== "string" || !REGION_ID.test(id)) return null;
  if (typeof slot !== "string" || !REGION_ID.test(slot)) return null;
  if (typeof name !== "string" || name.length > NAME_MAX) return null;
  if (typeof color !== "string" || !REGION_COLOR.test(color)) return null;
  if (typeof fillOpacity !== "number" || !Number.isFinite(fillOpacity) || fillOpacity < 0 || fillOpacity > 1) return null;
  if (typeof label !== "boolean") return null;
  const g = parseGeometry(geometry);
  if (!g) return null;
  if (legendTitle !== undefined && (typeof legendTitle !== "string" || legendTitle.length > LEGEND_TITLE_MAX)) return null;
  const lg: LegendEntry[] = [];
  if (legend !== undefined) {
    if (!Array.isArray(legend) || legend.length > LEGEND_MAX) return null;
    for (const e of legend) {
      if (!isObj(e) || typeof e.label !== "string" || e.label.length > LEGEND_LABEL_MAX) return null;
      if (typeof e.color !== "string" || !REGION_COLOR.test(e.color)) return null;
      lg.push({ label: e.label, color: e.color });
    }
  }
  const n = polygonsOf(g).length;
  if (parts !== undefined) {
    if (!Array.isArray(parts) || parts.length !== n) return null;
    if (!parts.every((k) => typeof k === "number" && Number.isInteger(k) && k >= OWN_COLOUR && k < lg.length)) return null;
  }
  if (labels !== undefined) {
    if (!Array.isArray(labels) || labels.length !== n) return null;
    if (!labels.every((t) => typeof t === "string" && t.length <= PART_LABEL_MAX)) return null;
  }
  return {
    id,
    slot,
    name,
    color,
    fillOpacity,
    label,
    legendTitle: legendTitle ?? "",
    legend: lg,
    parts: parts ? [...(parts as number[])] : new Array<number>(n).fill(OWN_COLOUR),
    labels: labels ? [...(labels as string[])] : new Array<string>(n).fill(""),
    // Older data has none; malformed entries become normal parts. A `clash` field from older builds
    // (overlaps with other regions) is ignored: regions are separate maps and never mark each other.
    contested: normalizePartContested(Array.isArray(contested) && contested.length === n ? contested : undefined, n),
    geometry: g,
    // Malformed province borders are dropped (the region still loads).
    ...(provinceBorders !== undefined && parseProvinceBorders(provinceBorders)?.length ? { provinceBorders: parseProvinceBorders(provinceBorders)! } : {}),
    ...(nationalBorders === true ? { nationalBorders: true } : {}),
  };
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
