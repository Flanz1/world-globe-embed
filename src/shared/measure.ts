/**
 * Real-size maths for the embed's ruler and the editor's area readout. Points are [lon, lat] on the globe
 * (after padding and prime-meridian shift, i.e. imageToGlobe), and the world's radius is set once per slot.
 */
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
