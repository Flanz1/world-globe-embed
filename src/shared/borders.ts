/**
 * Shared borders: lines a region's part shares exactly with another part (a province border) or with
 * another region on the same slot (a national border). Two lines are shared when they join the same
 * two positions (either way round); the editor's snapping and border tracing make them so.
 *
 * Rings may be open or closed (a closing position is ignored). Edge i of a ring runs from its open
 * ring's vertex i to vertex i + 1 (wrapping), so the indices match tracing the closed ring.
 */
import { openRing, round, unwrapRing, wrapLon, type Position, type Ring } from "./geo.ts";

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

export interface InternalBorders {
  /** Per polygon, per ring: the edges shared with another polygon (their coloured outline is left off). */
  hide: Set<number>[][];
  /** The shared lines, each once, as open polylines. */
  lines: Position[][];
}

/**
 * Lines shared between this region's own polygons. `use(p)` false leaves polygon p out (contested
 * zones keep their own dashed border).
 */
export function internalBorders(polys: readonly Ring[][], use: (p: number) => boolean = () => true): InternalBorders {
  const opened = polys.map((poly) => poly.map((r) => openRing(r)));
  const keys = opened.map((poly, p) => (use(p) ? poly.map(ringKeys) : poly.map(() => [] as string[])));
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
  const lines: Position[][] = [];
  keys.forEach((poly, p) =>
    poly.forEach((ring, r) => {
      const shared = ring.map((k) => !!k && (owners.get(k)?.length ?? 0) > 1);
      shared.forEach((s, i) => s && hide[p][r].add(i));
      // Each line once: from the lowest-numbered polygon that has it.
      const mine = ring.map((k, i) => shared[i] && Math.min(...owners.get(k)!) === p);
      if (mine.some(Boolean)) lines.push(...runsOf(opened[p][r], mine));
    }),
  );
  return { hide, lines };
}

/**
 * Lines of this region's polygons (those with `use(p)`) that other regions' polygons share exactly.
 * Open polylines, in this region's positions.
 */
export function nationalBorders(polys: readonly Ring[][], others: readonly Ring[][], use: (p: number) => boolean = () => true): Position[][] {
  const theirs = new Set<string>();
  for (const poly of others) for (const r of poly) for (const k of ringKeys(openRing(r))) if (k) theirs.add(k);
  if (!theirs.size) return [];
  const lines: Position[][] = [];
  polys.forEach((poly, p) => {
    if (!use(p)) return;
    for (const r of poly) {
      const open = openRing(r);
      const shared = ringKeys(open).map((k) => !!k && theirs.has(k));
      if (shared.some(Boolean)) lines.push(...runsOf(open, shared));
    }
  });
  return lines;
}

/** Positions in a set of polylines. */
export const lineCount = (lines: readonly Position[][]): number => lines.reduce((n, l) => n + l.length, 0);

/** Polylines as the `shared` field stores them: wrapped, rounded. Dropped from the end past `max` positions. */
export function storedLines(lines: readonly Position[][], max: number): Position[][] {
  const out: Position[][] = [];
  let n = 0;
  for (const l of lines) {
    if (l.length < 2 || n + l.length > max) continue;
    n += l.length;
    out.push(l.map(([x, y]) => [round(wrapLon(x)), round(y)] as Position));
  }
  return out;
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
