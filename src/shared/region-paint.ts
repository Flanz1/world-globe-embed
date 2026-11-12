/**
 * Turns a region into what raster.ts paints: colours per part, contested zones, and where its parts
 * overlap each other. Only a region's own parts are ever compared: other regions on the slot are
 * separate maps (a religion's spread, a kingdom's borders) and never mark this one. Loaded with the
 * viewers and the admin page, not the boot script.
 */
import { findClashes, prepare, type Prepared } from "./clash.ts";
import { polygonsOf, type Ring } from "./geo.ts";
import type { PaintSpec } from "./raster.ts";
import { OWN_COLOUR, regionLayers, type RegionData } from "./region.ts";

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

/** Where a region's own parts clash with each other, as pairs [i, j] with i < j. */
export interface Clashes {
  internal: [number, number][];
}

export function regionClashes(polys: Ring[][], prepared?: Prepared[]): Clashes {
  return { internal: findClashes(prepared ?? polys.map((p) => prepare(p))) };
}

/** A PaintSpec from a region and its clashes (worked out with regionClashes, or by the caller incrementally). */
export function paintSpecOf(r: PaintInput, clashes: Clashes): PaintSpec {
  const polys = polygonsOf(r.geometry);
  const contested = polys.map((_, i) => (r.contested[i] ?? OWN_COLOUR) >= 0);
  const plain = !contested.some(Boolean) && !clashes.internal.length;
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
  return {
    plain,
    layers: plain ? regionLayers(r) : [],
    parts: polys.map((rings, i) => ({ rings, color: colours[i], contested: contested[i] })),
    partners,
    hatches,
  };
}

/** The embed's spec: contested zones and the clashes among the region's own parts. */
export function regionPaintSpec(r: PaintInput): PaintSpec {
  return paintSpecOf(r, regionClashes(polygonsOf(r.geometry)));
}

/** Whether the legend should get its "Contested" row. */
export const hasContestedMarks = (spec: PaintSpec): boolean => !spec.plain;
