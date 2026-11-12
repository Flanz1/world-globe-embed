/**
 * Shared borders: lines two parts of a region share exactly. Between parts of different legend colours
 * they're national borders; between parts of the same colour the parts read as one (the line isn't
 * drawn at all). Two lines are shared when they join the same two positions (either way round); the
 * editor's snapping and border tracing make them so. Other regions on the slot are separate maps and
 * never count. Province borders are separate lines the editor draws (RegionData.provinceBorders).
 *
 * Rings may be open or closed (a closing position is ignored). Edge i of a ring runs from its open
 * ring's vertex i to vertex i + 1 (wrapping), so the indices match tracing the closed ring.
 */
import { openRing, unwrapRing, type Position, type Ring } from "./geo.ts";

/** A key for a position, the same in every copy of the map. */
const pkey = ([x, y]: Position): string => `${Math.round((((x % 360) + 360) % 360) * 1e6) % 360000000}:${Math.round(y * 1e6)}`;
/** A key for a line, the same either way round. */
const ekey = (a: Position, b: Position): string => {
  const ka = pkey(a);
  const kb = pkey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
};

/** Edge keys of one ring (open), in order. Zero-length lines get "". */
function ringKeys(open: Ring): string[] {
  const n = open.length;
  return open.map((p, i) => {
    const q = open[(i + 1) % n];
    return pkey(p) === pkey(q) ? "" : ekey(p, q);
  });
}

/**
 * Runs of consecutive shared edges of a ring, as open polylines (positions as given). A ring shared all
 * round gives one closed polyline.
 */
function runsOf(open: Ring, shared: boolean[]): Position[][] {
  const n = open.length;
  if (n < 2) return [];
  const out: Position[][] = [];
  const start = shared.findIndex((s) => !s);
  if (start < 0) return [[...open, open[0]].map(([x, y]) => [x, y] as Position)];
  let cur: Position[] | null = null;
  for (let k = 1; k <= n; k++) {
    const i = (start + k) % n;
    if (shared[i]) {
      if (!cur) cur = [[open[i][0], open[i][1]]];
      const q = open[(i + 1) % n];
      cur.push([q[0], q[1]]);
    } else if (cur) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export interface Borders {
  /** Per polygon, per ring: the edges it shares with another polygon (their coloured outline is left off). */
  hide: Set<number>[][];
  /** Lines between polygons of different groups (different legend colours): open polylines, each once. */
  national: Position[][];
}

/**
 * Lines a region's polygons share exactly with each other. `group(p)` is polygon p's group (its legend
 * colour), or null to leave it out (contested zones are left to their own hatching). A line between
 * different groups is national; within one group it's only hidden.
 */
export function regionBorders(polys: readonly Ring[][], group: (p: number) => number | null): Borders {
  const none = (): Borders => ({ hide: polys.map((poly) => poly.map(() => new Set<number>())), national: [] });
  if (polys.length < 2) return none();
  // Quick out: without a position two polygons share there are no shared lines (most regions, and every drag of a lone part).
  const first = new Map<number, number>();
  let any = false;
  for (let p = 0; p < polys.length && !any; p++)
    for (const ring of polys[p])
      for (const [x, y] of ring) {
        const k = Math.round((((x % 360) + 360) % 360) * 1e4) * 2e6 + Math.round((y + 90) * 1e4);
        const o = first.get(k);
        if (o === undefined) first.set(k, p);
        else if (o !== p) {
          any = true;
          break;
        }
      }
  if (!any) return none();
  const opened = polys.map((poly) => poly.map((r) => openRing(r)));
  const keys = opened.map((poly, p) => (group(p) === null ? poly.map(() => [] as string[]) : poly.map(ringKeys)));
  // Which polygons each line belongs to.
  const owners = new Map<string, number[]>();
  keys.forEach((poly, p) =>
    poly.forEach((ring) =>
      ring.forEach((k) => {
        if (!k) return;
        const o = owners.get(k);
        if (!o) owners.set(k, [p]);
        else if (!o.includes(p)) o.push(p);
      }),
    ),
  );
  const hide: Set<number>[][] = opened.map((poly) => poly.map(() => new Set<number>()));
  const national: Position[][] = [];
  keys.forEach((poly, p) =>
    poly.forEach((ring, r) => {
      const others = ring.map((k) => (k ? (owners.get(k) ?? []).filter((q) => q !== p) : []));
      others.forEach((o, i) => o.length && hide[p][r].add(i));
      // Each line once: from the lowest-numbered polygon that has it.
      const mine = others.map((o) => o.length > 0 && o.every((q) => q > p));
      if (!mine.some(Boolean)) return;
      const g = group(p);
      const nat = others.map((o, i) => mine[i] && o.some((q) => group(q) !== g));
      if (nat.some(Boolean)) national.push(...runsOf(opened[p][r], nat));
    }),
  );
  return { hide, national };
}

/** Adds an open polyline (once per offset) to the current path, unwrapped so it can cross the antimeridian. */
export function traceLine(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  line: Position[],
  x: (lon: number) => number,
  y: (lat: number) => number,
  offsets: number[] = [0],
): void {
  if (line.length < 2) return;
  const u = unwrapRing(line);
  for (const off of offsets) {
    ctx.moveTo(x(u[0][0] + off), y(u[0][1]));
    for (let i = 1; i < u.length; i++) ctx.lineTo(x(u[i][0] + off), y(u[i][1]));
  }
}
