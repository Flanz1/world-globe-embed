/**
 * Turns a region into what raster.ts paints: a colour per part, and which later parts cover each part
 * where they overlap (parts are layers: the later part is drawn on top). Only a region's own parts are
 * ever compared: other regions on the slot are separate maps (a religion's spread, a kingdom's borders)
 * and never mark this one. Loaded with the viewers and the admin page, not the boot script.
 */
import { regionBorders } from "./borders.ts";
import { findClashes, prepare, type Prepared } from "./clash.ts";
import { polygonsOf, type Position, type Ring } from "./geo.ts";
import type { PaintSpec } from "./raster.ts";
import { OWN_COLOUR, regionLayers, type RegionData } from "./region.ts";

export type PaintInput = Pick<RegionData, "color" | "legend" | "parts" | "geometry" | "provinceBorders" | "nationalBorders">;

/** The colour each part is drawn in: its legend colour, else the region's. */
export function partColours(r: Pick<RegionData, "color" | "legend" | "parts">, n: number): string[] {
  return Array.from({ length: n }, (_, i) => {
    const k = r.parts[i] ?? OWN_COLOUR;
    return k >= 0 && k < r.legend.length ? r.legend[k].color : r.color;
  });
}

/** Where a region's own parts overlap each other, as pairs [i, j] with i < j. */
export interface Clashes {
  internal: [number, number][];
}

export function regionClashes(polys: Ring[][], prepared?: Prepared[]): Clashes {
  return { internal: findClashes(prepared ?? polys.map((p) => prepare(p))) };
}

/** A PaintSpec from a region and its overlaps (worked out with regionClashes, or by the caller incrementally). */
export function paintSpecOf(r: PaintInput, clashes: Clashes): PaintSpec {
  const polys = polygonsOf(r.geometry);
  // Only when the region asks for them: lines parts share exactly are national borders between different
  // legend colours, hidden within one (the parts read as one province). Otherwise parts that touch just
  // touch. Province borders are the region's own drawn lines.
  const borders = r.nationalBorders
    ? regionBorders(polys, (i) => r.parts[i] ?? OWN_COLOUR)
    : { hide: polys.map((poly) => poly.map(() => new Set<number>())), national: [] as Position[][] };
  const provincial = r.provinceBorders ?? [];
  const hidden = borders.hide.some((poly) => poly.some((h) => h.size));
  const shared = hidden || borders.national.length > 0 || provincial.length > 0;
  const plain = !clashes.internal.length && !shared;
  const colours = partColours(r, polys.length);
  const front: number[][] = polys.map(() => []);
  for (const [a, b] of clashes.internal) {
    if (!polys[a] || !polys[b] || a === b) continue;
    // The later part is the upper layer: it covers the earlier one.
    front[Math.min(a, b)].push(Math.max(a, b));
  }
  return {
    plain,
    layers: plain ? regionLayers(r) : [],
    parts: polys.map((rings, i) => ({ rings, color: colours[i], ...(shared && borders.hide[i].some((h) => h.size) ? { hide: borders.hide[i] } : {}) })),
    front,
    ...(shared ? { borders: { national: borders.national, provincial } } : {}),
  };
}

/** The embed's spec: the region's parts as layers. */
export function regionPaintSpec(r: PaintInput): PaintSpec {
  return paintSpecOf(r, regionClashes(polygonsOf(r.geometry)));
}
