/**
 * Turns a region into what raster.ts paints: a colour per part, which parts overlap which, and the
 * contested land where parts of different colours overlap. Only a region's own parts are ever compared:
 * other regions on the slot are separate maps (a religion's spread, a kingdom's borders) and never mark
 * this one. Loaded with the viewers and the admin page, not the boot script.
 */
import { regionBorders } from "./borders.ts";
import { findClashes, prepare, type Prepared } from "./clash.ts";
import { polygonsOf, type Position, type Ring } from "./geo.ts";
import type { PaintSpec } from "./raster.ts";
import { OWN_COLOUR, regionLayers, type RegionData } from "./region.ts";

export type PaintInput = Pick<RegionData, "color" | "legend" | "parts" | "occupied" | "geometry" | "provinceBorders" | "nationalBorders">;

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

/** At most this many contested areas are drawn (a safety cap: real regions have a handful). */
const CELL_MAX = 4000;

/**
 * Contested land: every set of parts that all overlap each other and have two or more colours between
 * them, with the other parts overlapping any of them (to leave out, so each area is painted once). They
 * get equal stripes of every colour, in part order.
 */
export function contestedCells(colours: readonly string[], overlaps: readonly number[][]): PaintSpec["cells"] {
  const cells: PaintSpec["cells"] = [];
  const nb = overlaps.map((o) => new Set(o));
  const grow = (set: number[], cand: number[]): void => {
    for (let k = 0; k < cand.length && cells.length < CELL_MAX; k++) {
      const v = cand[k];
      const next = [...set, v];
      const distinct = [...new Set(next.map((i) => colours[i]))];
      if (next.length >= 2 && distinct.length >= 2) {
        const around = new Set<number>();
        for (const i of next) for (const j of overlaps[i]) around.add(j);
        for (const i of next) around.delete(i);
        cells.push({ parts: next, outside: [...around].sort((a, b) => a - b), colors: distinct });
      }
      grow(next, cand.slice(k + 1).filter((u) => nb[v].has(u)));
    }
  };
  for (let v = 0; v < overlaps.length; v++) grow([v], overlaps[v].filter((u) => u > v));
  return cells;
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
  const occupied = polys.map((_, i) => r.occupied?.[i] === true);
  const plain = !clashes.internal.length && !shared;
  const colours = partColours(r, polys.length);
  const front: number[][] = polys.map(() => []);
  const overlaps: number[][] = polys.map(() => []);
  for (const [a, b] of clashes.internal) {
    if (!polys[a] || !polys[b] || a === b) continue;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    front[lo].push(hi);
    overlaps[lo].push(hi);
    overlaps[hi].push(lo);
  }
  for (const o of overlaps) o.sort((a, b) => a - b);
  return {
    plain,
    layers: plain ? regionLayers(r) : [],
    parts: polys.map((rings, i) => ({
      rings,
      color: colours[i],
      ...(occupied[i] ? { occupied: true } : {}),
      ...(shared && borders.hide[i].some((h) => h.size) ? { hide: borders.hide[i] } : {}),
    })),
    front,
    overlaps,
    cells: contestedCells(colours, overlaps),
    ...(shared ? { borders: { national: borders.national, provincial } } : {}),
  };
}

/** The embed's spec: the region's parts and where they overlap. */
export function regionPaintSpec(r: PaintInput): PaintSpec {
  return paintSpecOf(r, regionClashes(polygonsOf(r.geometry)));
}

/** Whether the legend gets its "Contested" row: some parts of different colours overlap (occupied areas included). */
export const hasContestedMarks = (spec: PaintSpec): boolean => spec.cells.length > 0;
