/**
 * The map's coastline as snap targets for the region editor (data: shared/coast.ts, made by
 * scripts/lib/coast-mask.ts). Coast lines are an extra kind of SnapRing (src kind "coast"); the
 * editor only snaps to them when no vertex or line of a part or region is in range, so shared
 * borders keep priority.
 *
 * The traced coast is detailed (a point every pixel or two of a 16384 px map), so copies simplified
 * to the current zoom are kept for drawing, freehand following and tracing: what's added to a region
 * is never finer than the screen shows it.
 */
import { decodeCoast, type CoastData } from "../../shared/coast.ts";
import { simplifyRing, type Position } from "../../shared/geo.ts";
import { snapRing, type SnapRing } from "./snap.ts";

/** Coast data for a map, or null when it has none or it can't be loaded (the editor just goes without). */
export async function loadCoast(url: string | null): Promise<CoastData | null> {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return decodeCoast(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** Douglas–Peucker tolerance levels (degrees of longitude), each twice the one before. */
const LEVEL0 = 0.005;
const LEVELS = 10;

export class Coast {
  readonly data: CoastData;
  /** Latitude scale of the flat map (2 / aspect), so simplification matches what's on screen. */
  private readonly ky: number;
  private readonly full: SnapRing[];
  private readonly levels = new Map<number, SnapRing[]>();

  constructor(data: CoastData, ky: number) {
    this.data = data;
    this.ky = ky;
    this.full = data.lines.map((l, c) => snapRing(toPositions(l.pts), { kind: "coast", c }));
  }

  /** Every coast line at full detail. */
  rings(): SnapRing[] {
    return this.full;
  }

  /** Coast lines simplified to about `tol` degrees (rounded down to a level); lines smaller than that are left out. */
  ringsAt(tol: number): SnapRing[] {
    if (tol < LEVEL0) return this.full;
    const level = Math.min(LEVELS - 1, Math.floor(Math.log2(tol / LEVEL0)));
    let rings = this.levels.get(level);
    if (!rings) {
      const t = LEVEL0 * 2 ** level;
      rings = [];
      for (const r of this.full) {
        const [w, s, e, n] = r.box;
        if (e - w < t && (n - s) * this.ky < t) continue;
        const scaled = r.pts.map(([x, y]) => [x, y * this.ky] as Position);
        const pts = simplifyRing(scaled, t).map(([x, y]) => [x, y / this.ky] as Position);
        rings.push(snapRing(pts, r.src));
      }
      this.levels.set(level, rings);
    }
    return rings;
  }
}

function toPositions(flat: Float64Array): Position[] {
  const out: Position[] = new Array(flat.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = [flat[2 * i], flat[2 * i + 1]];
  return out;
}

/**
 * Thins a traced stretch of coast to `tol` degrees (latitude scaled by ky), keeping both ends.
 * `pts` are the stretch's points in order; returns the indices kept.
 */
export function thinTrace(pts: readonly Position[], tol: number, ky: number): number[] {
  const n = pts.length;
  if (n <= 2) return [...Array(n).keys()];
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const ax = pts[s][0];
    const ay = pts[s][1] * ky;
    const dx = pts[e][0] - ax;
    const dy = pts[e][1] * ky - ay;
    const len = Math.hypot(dx, dy);
    let best = -1;
    let bestD = tol;
    for (let i = s + 1; i < e; i++) {
      const px = pts[i][0] - ax;
      const py = pts[i][1] * ky - ay;
      const d = len ? Math.abs(px * dy - py * dx) / len : Math.hypot(px, py);
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([s, best], [best, e]);
    }
  }
  const out: number[] = [];
  keep.forEach((k, i) => k && out.push(i));
  return out;
}
