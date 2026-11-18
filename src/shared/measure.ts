/**
 * Real-size maths for the embed's ruler and the editor's area readout. Points are [lon, lat] on the globe
 * (after padding and prime-meridian shift, i.e. imageToGlobe), and the world's radius is set once per slot.
 */
import type { TravelSpeed } from "./types.ts";
import { angleBetween, sphericalRingArea, toLonLat, toVec, type Position } from "./geo.ts";

export const KM_PER_MI = 1.609344;
export const EARTH_RADIUS_KM = 6371;
/** Smallest and largest radius a slot may set (km). */
export const MIN_RADIUS_KM = 100;
export const MAX_RADIUS_KM = 1_000_000;

export type DistUnit = "km" | "mi";

const DEG = Math.PI / 180;

export const validRadius = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= MIN_RADIUS_KM && v <= MAX_RADIUS_KM;

/** Great-circle distance in km between two globe positions. */
export const distanceKm = (a: Position, b: Position, radiusKm: number): number => angleBetween(a, b) * DEG * radiusKm;

/** Length in km of the great-circle path through the points, in order. */
export function pathKm(points: readonly Position[], radiusKm: number): number {
  let sum = 0;
  for (let i = 1; i < points.length; i++) sum += distanceKm(points[i - 1], points[i], radiusKm);
  return sum;
}

/** Fraction of the whole sphere (0–1) enclosed by a ring whose edges are great-circle arcs. The smaller side counts. */
export function ringSphereFraction(points: readonly Position[]): number {
  if (points.length < 3) return 0;
  const a = Math.abs(sphericalRingArea(points as Position[]));
  return Math.min(a, 4 * Math.PI - a) / (4 * Math.PI);
}

/** Area in km² of the ring (great-circle edges), the smaller side. */
export const ringAreaKm2 = (points: readonly Position[], radiusKm: number): number => ringSphereFraction(points) * 4 * Math.PI * radiusKm * radiusKm;

/** Perimeter in km of the closed ring. */
export function perimeterKm(points: readonly Position[], radiusKm: number): number {
  return points.length < 2 ? 0 : pathKm(points, radiusKm) + (points.length > 2 ? distanceKm(points[points.length - 1], points[0], radiusKm) : 0);
}

/** Whole-sphere surface in km². */
export const sphereAreaKm2 = (radiusKm: number): number => 4 * Math.PI * radiusKm * radiusKm;

/** Points along the great circle from a to b (both included), at most `stepDeg` apart. */
export function geodesic(a: Position, b: Position, stepDeg = 1.5): Position[] {
  const va = toVec(a);
  const vb = toVec(b);
  const ang = angleBetween(a, b);
  const n = Math.max(1, Math.ceil(ang / stepDeg));
  if (ang < 1e-9 || ang > 180 - 1e-6) return [a, b];
  const w = ang * DEG;
  const s = Math.sin(w);
  const out: Position[] = [a];
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const ka = Math.sin((1 - t) * w) / s;
    const kb = Math.sin(t * w) / s;
    out.push(toLonLat([ka * va[0] + kb * vb[0], ka * va[1] + kb * vb[1], ka * va[2] + kb * vb[2]]));
  }
  out.push(b);
  return out;
}

/** Speeds the admin's preview dialog offers, in km per day. */
export const TRAVEL_PRESETS = [
  { id: "foot", label: "On foot", kmPerDay: 30 },
  { id: "horse", label: "Horse", kmPerDay: 50 },
  { id: "cart", label: "Cart", kmPerDay: 25 },
  { id: "ship", label: "Sailing ship", kmPerDay: 100 },
] as const;
export const MAX_TRAVEL_SPEEDS = 6;
export const MAX_TRAVEL_LABEL = 24;
export const MIN_KM_PER_DAY = 0.1;
export const MAX_KM_PER_DAY = 100_000;

export const validKmPerDay = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= MIN_KM_PER_DAY && v <= MAX_KM_PER_DAY;

/** Keeps the usable entries (non-empty label, valid speed) of whatever a slot holds, at most MAX_TRAVEL_SPEEDS. */
export function cleanTravel(v: unknown): TravelSpeed[] {
  if (!Array.isArray(v)) return [];
  const out: TravelSpeed[] = [];
  for (const e of v) {
    const label = typeof e?.label === "string" ? e.label.trim().slice(0, MAX_TRAVEL_LABEL) : "";
    if (label && validKmPerDay(e.kmPerDay)) out.push({ label, kmPerDay: e.kmPerDay });
    if (out.length >= MAX_TRAVEL_SPEEDS) break;
  }
  return out;
}

const DAYS_PER_MONTH = 30.4375;
const DAYS_PER_YEAR = 365.25;

/**
 * A travel time in words for worlds far bigger than Earth: "under a day", "9 days", "about 5 weeks (37 days)",
 * "about 11 months (330 days)", "about 1.5 years (526 days)". `how` ("on foot") goes before the exact days.
 */
export function formatDuration(days: number, how = ""): string {
  if (!Number.isFinite(days) || days < 0) return "";
  const n = (v: number, d = 0) => trim(v, d);
  const tail = how ? ` ${how}` : "";
  if (days < 1) return `under a day${tail}`;
  if (days < 14) return `${n(Math.round(days))} day${Math.round(days) === 1 ? "" : "s"}${tail}`;
  const exact = `(${n(Math.round(days))} days)`;
  if (days < 60) return `about ${n(Math.round(days / 7))} weeks${tail} ${exact}`;
  if (days < DAYS_PER_YEAR) return `about ${n(Math.round(days / DAYS_PER_MONTH))} months${tail} ${exact}`;
  const years = days / DAYS_PER_YEAR;
  const y = years < 10 ? Math.round(years * 2) / 2 : Math.round(years);
  return `about ${n(y, 1)} year${y === 1 ? "" : "s"}${tail} ${exact}`;
}

const trim = (n: number, digits: number) => n.toLocaleString("en", { maximumFractionDigits: digits });

/** "1,234 km", "12.5 km", "830 m"-free: small values keep decimals instead. */
export function formatLength(km: number, unit: DistUnit): string {
  const v = unit === "mi" ? km / KM_PER_MI : km;
  return `${trim(v, v < 10 ? 2 : v < 100 ? 1 : 0)} ${unit}`;
}

/** "12.3 million km²", "4,560 mi²". */
export function formatArea(km2: number, unit: DistUnit): string {
  const v = unit === "mi" ? km2 / (KM_PER_MI * KM_PER_MI) : km2;
  const u = unit === "mi" ? "mi²" : "km²";
  if (v >= 1e6) return `${trim(v / 1e6, 2)} million ${u}`;
  return `${trim(v, v < 10 ? 2 : v < 100 ? 1 : 0)} ${u}`;
}

/** "2.4%", "0.012%": enough digits to read the size, whatever it is. */
export const formatPercent = (fraction: number): string => {
  const p = fraction * 100;
  return `${trim(p, p < 0.1 ? 4 : p < 10 ? 2 : 1)}%`;
};
