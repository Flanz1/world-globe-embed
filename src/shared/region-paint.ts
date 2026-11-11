/**
 * Turns a region into what raster.ts paints: colours per part, contested zones, and where parts overlap
 * (with each other, and with the other regions in its `clash` data). Loaded with the viewers and the
 * admin page, not the boot script.
 */
import { findClashes, findClashesBetween, prepare, type Prepared } from "./clash.ts";
import { openRing, polygonsOf, round, simplifyRing, unwrapRing, wrapLon, type Position, type Ring } from "./geo.ts";
import type { PaintSpec } from "./raster.ts";
import { CLASH_MAX_VERTICES, OWN_COLOUR, regionLayers, type RegionData } from "./region.ts";

export type PaintInput = Pick<RegionData, "color" | "legend" | "parts" | "contested" | "geometry">;

/** The colour each part is drawn in: its legend colour, else (for a contested zone) its parent's, else the region's. */
export function partColours(r: Pick<RegionData, "color" | "legend" | "parts" | "contested">, n: number): string[] {
  const own = (i: number): string | null => {
    const k = r.parts[i] ?? OWN_COLOUR;
    return k >= 0 && k < r.legend.length ? r.legend[k].color : null;
  };
  return Array.from({ length: n }, (_, i) => {
    const c = own(i);
    if (c) return c;
    const parent = r.contested[i] ?? OWN_COLOUR;
    return parent >= 0 && parent < n ? (own(parent) ?? r.color) : r.color;
  });
}

/** Where a region's parts clash: among themselves, and [own part, other polygon] with `others`. */
export interface Clashes {
  internal: [number, number][];
  external: [number, number][];
}

export function regionClashes(polys: Ring[][], others: Ring[][] = [], prepared?: { own?: Prepared[]; others?: Prepared[] }): Clashes {
  const own = prepared?.own ?? polys.map((p) => prepare(p));
  const ext = prepared?.others ?? others.map((p) => prepare(p));
  return { internal: findClashes(own), external: findClashesBetween(own, ext) };
}

/** A PaintSpec from a region and its clashes (worked out with regionClashes, or by the caller incrementally). */
export function paintSpecOf(r: PaintInput, clashes: Clashes, others: Ring[][] = []): PaintSpec {
  const polys = polygonsOf(r.geometry);
  const contested = polys.map((_, i) => (r.contested[i] ?? OWN_COLOUR) >= 0);
  const plain = !contested.some(Boolean) && !clashes.internal.length && !clashes.external.length;
  const colours = partColours(r, polys.length);
  const partners: Ring[][][] = polys.map(() => []);
  const hatches: PaintSpec["hatches"] = [];
  for (const [i, j] of clashes.internal) {
    if (!polys[i] || !polys[j]) continue;
    partners[i].push(polys[j]);
    partners[j].push(polys[i]);
    // In the colour of whichever is drawn on top (contested zones go last).
    const top = contested[i] && !contested[j] ? i : j;
    hatches.push({ a: polys[i], b: polys[j], color: colours[top] });
  }
  for (const [i, e] of clashes.external) {
    if (!polys[i] || !others[e]) continue;
    partners[i].push(others[e]);
    hatches.push({ a: polys[i], b: others[e], color: colours[i] });
  }
  return {
    plain,
    layers: plain ? regionLayers(r) : [],
    parts: polys.map((rings, i) => ({ rings, color: colours[i], contested: contested[i] })),
    partners,
    hatches,
  };
}

/** The embed's spec: clashes among the region's own parts, plus (unless turned off) with its build-time clash data. */
export function regionPaintSpec(r: PaintInput & Pick<RegionData, "clash">, useClash = true): PaintSpec {
  const others = useClash ? (r.clash ?? []) : [];
  return paintSpecOf(r, regionClashes(polygonsOf(r.geometry), others), others);
}

/** Whether the legend should get its "Contested" row. */
export const hasContestedMarks = (spec: PaintSpec): boolean => !spec.plain;

/** Rounded, open, wrapped rings of a polygon, as the `clash` field stores them. */
export const clashPolygon = (poly: readonly Ring[]): Ring[] => poly.map((r) => openRing(r).map(([x, y]) => [round(wrapLon(x)), round(y)] as Position));

const clashCount = (ps: Ring[][]) => ps.reduce((n, p) => n + p.reduce((m, r) => m + r.length, 0), 0);

/** Simplifies (then, as a last resort, drops) clash polygons until they fit `max` positions. */
export function capClash(polys: Ring[][], max = CLASH_MAX_VERTICES): Ring[][] {
  let cur = polys;
  for (let tol = 0.005; clashCount(cur) > max && tol <= 5; tol *= 2) {
    cur = polys
      .map((p) =>
        p
          // Simplified in the unwrapped frame, then wrapped and rounded again.
          .map((r) => simplifyRing(unwrapRing(r), tol).map(([x, y]) => [round(wrapLon(x)), round(y)] as Position))
          .filter((r, i) => i === 0 || r.length >= 3),
      )
      .filter((p) => p[0].length >= 3);
  }
  while (clashCount(cur) > max && cur.length) cur = cur.slice(0, -1);
  return cur;
}
