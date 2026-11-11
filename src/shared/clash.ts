/**
 * Where parts overlap ("clash"): shared by the editor, the build and the renderers. No DOM.
 *
 * Two polygons clash when their interiors overlap: their borders cross, or one lies inside the other.
 * A polygon inside the other's hole doesn't clash with it, and touching along a shared edge or at a
 * vertex doesn't either. Longitudes are compared modulo 360, so parts across the antimeridian work.
 */
import { openRing, unwrapRing, type Position, type Ring } from "./geo.ts";

/** Distances below this (degrees) count as "on the border". Stored coordinates have 4 decimals. */
const ON_EDGE = 1e-7;
/** Orientation values below this count as collinear. */
const COLLINEAR = 1e-9;

/** A polygon ready for clash tests: unwrapped rings in one frame, bounds, and its edges bucketed by latitude. */
export interface Prepared {
  /** Open rings, outer first; holes moved to the outer ring's copy. West edge normalised into [-180, 180). */
  rings: Ring[];
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** Every edge of every ring as [xa, ya, xb, yb] runs. */
  edges: Float64Array;
  /** Latitude bands: edge indices whose latitude range touches each band. */
  bandY0: number;
  bandH: number;
  bands: Uint32Array[];
}

/** Prepares one polygon (outer ring then holes; open or closed, wrapped or unwrapped). */
export function prepare(poly: readonly Ring[]): Prepared {
  const un = poly.map((r) => openRing(unwrapRing(r)));
  const lon0 = un[0]?.[0]?.[0] ?? 0;
  let x0 = Infinity;
  let x1 = -Infinity;
  for (const [x] of un[0] ?? []) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
  }
  // Holes into the outer ring's copy, and the whole polygon shifted so its west edge is in [-180, 180).
  const k0 = Number.isFinite(x0) ? Math.floor((x0 + 180) / 360) * 360 : 0;
  const rings = un.map((r, i) => {
    const k = (i === 0 || !r.length ? 0 : Math.round((lon0 - r[0][0]) / 360) * 360) - k0;
    return k ? r.map(([x, y]) => [x + k, y] as Position) : r;
  });
  if (Number.isFinite(x0)) {
    x0 -= k0;
    x1 -= k0;
  }
  let y0 = Infinity;
  let y1 = -Infinity;
  let n = 0;
  for (const r of rings) {
    if (r.length >= 3) n += r.length;
    for (const [, y] of r) {
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  const edges = new Float64Array(n * 4);
  let e = 0;
  for (const r of rings) {
    if (r.length < 3) continue;
    for (let i = 0; i < r.length; i++) {
      const a = r[i];
      const b = r[(i + 1) % r.length];
      edges[e++] = a[0];
      edges[e++] = a[1];
      edges[e++] = b[0];
      edges[e++] = b[1];
    }
  }
  const nb = Math.max(1, Math.min(256, Math.ceil(Math.sqrt(n))));
  const bandH = n && y1 > y0 ? (y1 - y0) / nb : 1;
  const lists: number[][] = Array.from({ length: nb }, () => []);
  for (let i = 0; i < n; i++) {
    const ya = edges[i * 4 + 1];
    const yb = edges[i * 4 + 3];
    const lo = Math.max(0, Math.floor((Math.min(ya, yb) - ON_EDGE - y0) / bandH));
    const hi = Math.min(nb - 1, Math.floor((Math.max(ya, yb) + ON_EDGE - y0) / bandH));
    for (let b = lo; b <= hi; b++) lists[b].push(i);
  }
  return {
    rings,
    x0: Number.isFinite(x0) ? x0 : 0,
    x1: Number.isFinite(x1) ? x1 : -1,
    y0,
    y1,
    edges,
    bandY0: y0,
    bandH,
    bands: lists.map((l) => Uint32Array.from(l)),
  };
}

/** Distance from p to segment ab (planar degrees). */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** 1 strictly inside (holes excluded), 0 on the border, -1 outside. `px` is in p's own frame. */
export function classify(p: Prepared, px: number, py: number): -1 | 0 | 1 {
  if (py < p.y0 - ON_EDGE || py > p.y1 + ON_EDGE || px < p.x0 - ON_EDGE || px > p.x1 + ON_EDGE) return -1;
  const b = Math.max(0, Math.min(p.bands.length - 1, Math.floor((py - p.bandY0) / p.bandH)));
  const list = p.bands[b];
  const E = p.edges;
  let inside = false;
  for (let j = 0; j < list.length; j++) {
    const i = list[j] * 4;
    const ax = E[i];
    const ay = E[i + 1];
    const bx = E[i + 2];
    const by = E[i + 3];
    if (segDist(px, py, ax, ay, bx, by) < ON_EDGE) return 0;
    if (ay > py !== by > py && px < ((bx - ax) * (py - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside ? 1 : -1;
}

const orient = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

/** True if some edge of a properly crosses (not just touches) some edge of b shifted by `dx`. */
function bordersCross(a: Prepared, b: Prepared, dx: number): boolean {
  // Only edges inside the overlap of the two boxes can cross.
  const lo = Math.max(a.x0, b.x0 + dx) - ON_EDGE;
  const hi = Math.min(a.x1, b.x1 + dx) + ON_EDGE;
  const ylo = Math.max(a.y0, b.y0) - ON_EDGE;
  const yhi = Math.min(a.y1, b.y1) + ON_EDGE;
  type E = { lo: number; hi: number; s: 0 | 1; i: number };
  const list: E[] = [];
  const add = (p: Prepared, s: 0 | 1, sh: number) => {
    const E = p.edges;
    for (let i = 0; i < E.length; i += 4) {
      const x0 = Math.min(E[i], E[i + 2]) + sh;
      const x1 = Math.max(E[i], E[i + 2]) + sh;
      if (x1 < lo || x0 > hi || Math.max(E[i + 1], E[i + 3]) < ylo || Math.min(E[i + 1], E[i + 3]) > yhi) continue;
      list.push({ lo: x0, hi: x1, s, i });
    }
  };
  add(a, 0, 0);
  add(b, 1, dx);
  list.sort((p, q) => p.lo - q.lo);
  const A = a.edges;
  const B = b.edges;
  for (let s = 0; s < list.length; s++) {
    const e = list[s];
    for (let t = s + 1; t < list.length && list[t].lo <= e.hi; t++) {
      const f = list[t];
      if (f.s === e.s) continue;
      const [ea, eb] = e.s === 0 ? [e, f] : [f, e];
      const i = ea.i;
      const j = eb.i;
      const ax = A[i];
      const ay = A[i + 1];
      const bx = A[i + 2];
      const by = A[i + 3];
      const cx = B[j] + dx;
      const cy = B[j + 1];
      const ex = B[j + 2] + dx;
      const ey = B[j + 3];
      if (Math.max(ay, by) < Math.min(cy, ey) || Math.max(cy, ey) < Math.min(ay, by)) continue;
      const d1 = orient(cx, cy, ex, ey, ax, ay);
      const d2 = orient(cx, cy, ex, ey, bx, by);
      const d3 = orient(ax, ay, bx, by, cx, cy);
      const d4 = orient(ax, ay, bx, by, ex, ey);
      if (((d1 > COLLINEAR && d2 < -COLLINEAR) || (d1 < -COLLINEAR && d2 > COLLINEAR)) && ((d3 > COLLINEAR && d4 < -COLLINEAR) || (d3 < -COLLINEAR && d4 > COLLINEAR))) return true;
    }
  }
  return false;
}

/** A point well inside the polygon (inside the outer ring, outside its holes), or null. */
function interiorPoint(p: Prepared): Position | null {
  const outer = p.rings[0];
  if (!outer || outer.length < 3) return null;
  // Scan a few latitudes for the widest stretch inside.
  for (const f of [0.5, 0.37, 0.63, 0.21, 0.79]) {
    const y = p.y0 + (p.y1 - p.y0) * f + 1.3e-7;
    const xs: number[] = [];
    const E = p.edges;
    for (let i = 0; i < E.length; i += 4) {
      const ay = E[i + 1];
      const by = E[i + 3];
      if (ay > y !== by > y) xs.push(E[i] + ((y - ay) / (by - ay)) * (E[i + 2] - E[i]));
    }
    xs.sort((a, b) => a - b);
    let best: Position | null = null;
    let w = 0;
    for (let i = 0; i + 1 < xs.length; i += 2) {
      if (xs[i + 1] - xs[i] > w) {
        w = xs[i + 1] - xs[i];
        best = [(xs[i] + xs[i + 1]) / 2, y];
      }
    }
    if (best && w > ON_EDGE * 10) return best;
  }
  return null;
}

/** True if any test point of `a` (vertices, edge midpoints, an interior point) is strictly inside b shifted by dx. */
function somePointInside(a: Prepared, b: Prepared, dx: number): boolean {
  const lo = b.x0 + dx - ON_EDGE;
  const hi = b.x1 + dx + ON_EDGE;
  const test = (x: number, y: number) => x >= lo && x <= hi && y >= b.y0 - ON_EDGE && y <= b.y1 + ON_EDGE && classify(b, x - dx, y) === 1;
  const ip = interiorPoint(a);
  if (ip && test(ip[0], ip[1])) return true;
  const E = a.edges;
  for (let i = 0; i < E.length; i += 4) {
    if (test(E[i], E[i + 1])) return true;
    if (test((E[i] + E[i + 2]) / 2, (E[i + 1] + E[i + 3]) / 2)) return true;
  }
  return false;
}

/** Longitude shifts (multiples of 360) that bring b's box over a's. */
function shifts(a: Prepared, b: Prepared): number[] {
  if (a.y1 < b.y0 || b.y1 < a.y0) return [];
  const out: number[] = [];
  for (const dx of [0, -360, 360]) if (b.x0 + dx <= a.x1 && a.x0 <= b.x1 + dx) out.push(dx);
  return out;
}

/** Do a and b clash? */
export function clash(a: Prepared, b: Prepared): boolean {
  if (!a.edges.length || !b.edges.length) return false;
  for (const dx of shifts(a, b)) {
    if (bordersCross(a, b, dx)) return true;
    if (somePointInside(a, b, dx) || somePointInside(b, a, -dx)) return true;
  }
  return false;
}

/**
 * Candidate pairs whose boxes overlap (modulo 360), by a sweep over west edges, so far-apart parts
 * are never compared. Pairs are [i, j] with i < j within `list`, or [i in a, j in b] across two lists.
 */
function candidates(a: Prepared[], b: Prepared[] | null, only?: ReadonlySet<number>): [number, number][] {
  type Item = { side: 0 | 1; i: number; x0: number; x1: number };
  const items: Item[] = [];
  const push = (list: Prepared[], side: 0 | 1) =>
    list.forEach((p, i) => {
      if (!p.edges.length) return;
      // A second copy one turn east catches overlaps across the antimeridian.
      items.push({ side, i, x0: p.x0, x1: p.x1 }, { side, i, x0: p.x0 + 360, x1: p.x1 + 360 });
    });
  push(a, 0);
  if (b) push(b, 1);
  items.sort((p, q) => p.x0 - q.x0);
  const seen = new Set<string>();
  const out: [number, number][] = [];
  const active: Item[] = [];
  for (const it of items) {
    for (let k = active.length - 1; k >= 0; k--) if (active[k].x1 < it.x0) active.splice(k, 1);
    for (const o of active) {
      let pi: number;
      let pj: number;
      if (b) {
        if (o.side === it.side) continue;
        [pi, pj] = o.side === 0 ? [o.i, it.i] : [it.i, o.i];
        if (only && !only.has(pi)) continue;
      } else {
        if (o.i === it.i) continue;
        [pi, pj] = o.i < it.i ? [o.i, it.i] : [it.i, o.i];
        if (only && !only.has(pi) && !only.has(pj)) continue;
      }
      const key = `${pi}:${pj}`;
      if (seen.has(key)) continue;
      const P = a[pi];
      const Q = (b ?? a)[pj];
      if (P.y1 < Q.y0 || Q.y1 < P.y0) continue;
      seen.add(key);
      out.push([pi, pj]);
    }
    active.push(it);
  }
  return out;
}

/** Clashing pairs [i, j] (i < j) among one list of polygons. With `only`, just the pairs involving those. */
export function findClashes(list: Prepared[], only?: ReadonlySet<number>): [number, number][] {
  return candidates(list, null, only).filter(([i, j]) => clash(list[i], list[j]));
}

/** Clashing pairs [i in a, j in b] between two lists. With `only`, just a's polygons in it. */
export function findClashesBetween(a: Prepared[], b: Prepared[], only?: ReadonlySet<number>): [number, number][] {
  if (!a.length || !b.length) return [];
  return candidates(a, b, only).filter(([i, j]) => clash(a[i], b[j]));
}
