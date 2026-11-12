/**
 * Snapping, border tracing and attached (glued) vertices for the region editor. Pure functions, no
 * DOM, so they're unit-tested directly.
 *
 * Distances are in screen pixels: a longitude difference times `k` (pixels per degree), a latitude
 * difference times `k * ky` (ky = 2 / aspect, as on the flat map). Rings are open and unwrapped, as in
 * model.ts; a point is compared with the copy of a ring nearest to it, so snapping works across the
 * antimeridian and in every copy of the wrapped map.
 */
import { douglasPeuckerIndices, simplifyRing, type Position } from "../../shared/geo.ts";
import type { Parts, VRef } from "./model.ts";

/** A ring that can be snapped to: one of the region's own rings, or a neighbouring region's. */
export interface SnapRing {
  /** Open, unwrapped. */
  pts: Position[];
  /** The region's own ring (part p, ring r), a neighbour's polygon n (its ring r), province border line l (open: no closing line), or coast line c (see coast.ts). */
  src: { kind: "part"; p: number; r: number } | { kind: "neighbour"; n: number; r: number } | { kind: "line"; l: number } | { kind: "coast"; c: number };
  /** Bounds of pts: [west, south, east, north]. */
  box: [number, number, number, number];
}

/** A snapped position: on ring `ring` (index into the rings list) at `at` = i + t along edge i → i+1. */
export interface Snap {
  pos: Position;
  ring: number;
  at: number;
  kind: "vertex" | "edge";
}

export interface Scale {
  k: number;
  ky: number;
}

const nearest = (lon: number, near: number) => lon + 360 * Math.round((near - lon) / 360);

export function snapRing(pts: Position[], src: SnapRing["src"]): SnapRing {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [x, y] of pts) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return { pts, src, box: [w, s, e, n] };
}

/** The region's own rings as snap rings. */
export const partRings = (parts: Parts): SnapRing[] => parts.flatMap((rings, p) => rings.map((pts, r) => snapRing(pts, { kind: "part", p, r })));

/**
 * The nearest vertex within `radius` pixels of `pos`, else the nearest point on a line within `radius`,
 * else null. `skipRing(i)` leaves ring i out; `skipVertex(i, v)` leaves out vertex v of ring i and the
 * two lines that touch it (the vertices being dragged, so nothing snaps to itself).
 */
export function findSnap(
  rings: readonly SnapRing[],
  pos: Position,
  sc: Scale,
  radius: number,
  skipRing?: (ring: number) => boolean,
  skipVertex?: (ring: number, v: number) => boolean,
): Snap | null {
  const rx = radius / sc.k;
  const ry = radius / (sc.k * sc.ky);
  let best: Snap | null = null;
  let bestD = radius;
  const near: { ri: number; shift: number }[] = [];
  rings.forEach((ring, ri) => {
    if (ring.pts.length < 2 || skipRing?.(ri)) return;
    const [w, s, e, n] = ring.box;
    if (pos[1] < s - ry || pos[1] > n + ry) return;
    const mid = (w + e) / 2;
    const shift = nearest(mid, pos[0]) - mid;
    if (pos[0] < w + shift - rx || pos[0] > e + shift + rx) return;
    near.push({ ri, shift });
  });
  for (const { ri } of near) {
    const pts = rings[ri].pts;
    for (let i = 0; i < pts.length; i++) {
      if (skipVertex?.(ri, i)) continue;
      const lon = nearest(pts[i][0], pos[0]);
      const d = Math.hypot((lon - pos[0]) * sc.k, (pts[i][1] - pos[1]) * sc.k * sc.ky);
      if (d <= bestD) {
        bestD = d;
        best = { pos: [lon, pts[i][1]], ring: ri, at: i, kind: "vertex" };
      }
    }
  }
  if (best) return best;
  for (const { ri } of near) {
    const pts = rings[ri].pts;
    const n = pts.length;
    const last = rings[ri].src.kind === "line" ? n - 1 : n;
    for (let i = 0; i < last; i++) {
      const j = (i + 1) % n;
      if (skipVertex?.(ri, i) || skipVertex?.(ri, j)) continue;
      const a = pts[i];
      const b = pts[j];
      // The copy of this line nearest the point (the ring is unwrapped, so a and b are continuous).
      const sh = nearest((a[0] + b[0]) / 2, pos[0]) - (a[0] + b[0]) / 2;
      const ax = (a[0] + sh - pos[0]) * sc.k;
      const ay = (a[1] - pos[1]) * sc.k * sc.ky;
      const bx = (b[0] + sh - pos[0]) * sc.k;
      const by = (b[1] - pos[1]) * sc.k * sc.ky;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      if (!len2) continue;
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d <= bestD && t > 0 && t < 1) {
        bestD = d;
        best = { pos: [a[0] + sh + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])], ring: ri, at: i + t, kind: "edge" };
      }
    }
  }
  return best;
}

/** A vertex passed by a trace: its position and index on the ring. */
export interface TracePoint {
  pos: Position;
  at: number;
}

/**
 * The ring's vertices strictly between two snapped positions on it, going forward (dir 1, increasing
 * index) or backward (-1). Longitudes follow on from `from.pos`, so the trace stays in that copy.
 */
export function tracePath(ring: readonly Position[], from: { pos: Position; at: number }, to: { at: number }, dir: 1 | -1, open = false): TracePoint[] {
  const n = ring.length;
  if (n < 2) return [];
  const eps = 1e-9;
  // An open line doesn't wrap round: a vertex the other way is out of reach.
  const dist = (x: number) => (open ? (dir === 1 ? x - from.at : from.at - x) : (((dir === 1 ? x - from.at : from.at - x) % n) + n) % n);
  const end = dist(to.at);
  if (end < eps) return [];
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const d = dist(i);
    if (d > eps && d < end - eps) idx.push(i);
  }
  idx.sort((a, b) => dist(a) - dist(b));
  const out: TracePoint[] = [];
  let prev = from.pos[0];
  for (const i of idx) {
    const lon = nearest(ring[i][0], prev);
    out.push({ pos: [lon, ring[i][1]], at: i });
    prev = lon;
  }
  return out;
}

/** Length of a path in screen-proportional units (latitude scaled by ky). */
function pathLength(pts: Position[], ky: number): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], (pts[i][1] - pts[i - 1][1]) * ky);
  return s;
}

/** The shorter way round the ring between two snaps (by length), or the other way when `flip`. Along an open line there's only one way. */
export function traceBetween(ring: readonly Position[], from: Snap, to: Snap, ky: number, flip = false, open = false): TracePoint[] {
  if (open) return tracePath(ring, from, to, to.at >= from.at ? 1 : -1, true);
  const f = tracePath(ring, from, to, 1);
  const b = tracePath(ring, from, to, -1);
  const lf = pathLength([from.pos, ...f.map((q) => q.pos), to.pos], ky);
  const lb = pathLength([from.pos, ...b.map((q) => q.pos), to.pos], ky);
  const fwd = lf <= lb;
  return fwd !== flip ? f : b;
}

/** Signed shortest step from index a to b on a ring of n vertices (fractional indices). */
const ringStep = (a: number, b: number, n: number): number => {
  let d = (((b - a) % n) + n) % n;
  if (d > n / 2) d -= n;
  return d;
};

/**
 * A freehand sketch with the stretches drawn along a border replaced by that border's own vertices, so
 * a part drawn against a neighbour shares its border exactly. A stretch counts when at least `minRun`
 * consecutive sketch points snap to the same ring; shorter ones (a stroke just crossing a border) stay
 * as drawn. Everything not on a border is simplified with Douglas–Peucker at `tol` (degrees of
 * longitude, latitude scaled by ky). `closed`: the sketch is a ring (else an open line).
 */
export function followBorders(
  sketch: readonly Position[],
  snapAt: (p: Position) => Snap | null,
  rings: readonly SnapRing[],
  ky: number,
  tol: number,
  closed: boolean,
  minRun = 3,
): { pts: Position[]; followed: number } {
  const snaps = sketch.map((p) => snapAt(p));
  const out: { pos: Position; keep: boolean }[] = [];
  let followed = 0;
  let i = 0;
  while (i < sketch.length) {
    const s = snaps[i];
    let j = i + 1;
    if (s) while (j < sketch.length && snaps[j]?.ring === s.ring) j++;
    if (!s || j - i < minRun) {
      for (let q = i; q < j; q++) out.push({ pos: sketch[q], keep: false });
      i = j;
      continue;
    }
    // A run along ring s.ring: which way round did the pen go?
    const ring = rings[s.ring].pts;
    const open = rings[s.ring].src.kind === "line";
    let sum = 0;
    for (let q = i + 1; q < j; q++) sum += open ? snaps[q]!.at - snaps[q - 1]!.at : ringStep(snaps[q - 1]!.at, snaps[q]!.at, ring.length);
    const last = snaps[j - 1]!;
    out.push({ pos: s.pos, keep: true });
    let prev = s.pos[0];
    for (const t of tracePath(ring, s, last, open ? (last.at >= s.at ? 1 : -1) : sum >= 0 ? 1 : -1, open)) {
      const pos: Position = [nearest(t.pos[0], prev), t.pos[1]];
      out.push({ pos, keep: true });
      prev = pos[0];
    }
    if (last.at !== s.at) out.push({ pos: [nearest(last.pos[0], prev), last.pos[1]], keep: true });
    followed++;
    i = j;
  }
  // Simplify only the hand-drawn stretches: between kept points (and the ends of an open line).
  const n = out.length;
  const keep = new Uint8Array(n);
  out.forEach((q, k) => (keep[k] = q.keep ? 1 : 0));
  const scaled = out.map((q) => [q.pos[0], q.pos[1] * ky] as Position);
  const anchors = [...keep.keys()].filter((k) => keep[k]);
  if (!anchors.length) {
    // Nothing followed: plain simplification, as the freehand tool always did.
    if (!closed) return { pts: douglasPeuckerIndices(scaled, tol).map((k) => out[k].pos), followed };
    return { pts: simplifyRing(scaled, tol).map(([x, y]) => [x, y / ky] as Position), followed };
  }
  if (!closed) {
    keep[0] = keep[n - 1] = 1;
    if (anchors[0] !== 0) anchors.unshift(0);
    if (anchors[anchors.length - 1] !== n - 1) anchors.push(n - 1);
  }
  const stretches: [number, number][] = [];
  for (let a = 1; a < anchors.length; a++) stretches.push([anchors[a - 1], anchors[a]]);
  if (closed) stretches.push([anchors[anchors.length - 1], anchors[0] + n]); // round past the end
  for (const [s, e] of stretches) {
    if (e - s < 2) continue;
    const seg = Array.from({ length: e - s + 1 }, (_, q) => scaled[(s + q) % n]);
    for (const q of douglasPeuckerIndices(seg, tol)) keep[(s + q) % n] = 1;
  }
  const pts: Position[] = [];
  for (let k = 0; k < n; k++) {
    if (!keep[k]) continue;
    const p = out[k].pos;
    const prev = pts[pts.length - 1];
    if (prev && Math.abs(prev[0] - p[0]) < 1e-12 && Math.abs(prev[1] - p[1]) < 1e-12) continue;
    pts.push(p);
  }
  if (closed && pts.length > 1) {
    const a = pts[0];
    const z = pts[pts.length - 1];
    if (Math.abs(a[0] - z[0]) < 1e-12 && Math.abs(a[1] - z[1]) < 1e-12) pts.pop();
  }
  return { pts, followed };
}

/* ── Attached (glued) vertices: vertices of the region's own rings that sit on the same spot ── */

/** A key for a position, the same in every copy of the map (longitude taken modulo 360). */
export const posKey = ([x, y]: Position): string => `${Math.round((((x % 360) + 360) % 360) * 1e6) % 360000000}:${Math.round(y * 1e6)}`;

/** Every vertex, grouped by position. */
export function vertexIndex(parts: Parts): Map<string, VRef[]> {
  const m = new Map<string, VRef[]>();
  parts.forEach((rings, p) =>
    rings.forEach((ring, r) =>
      ring.forEach((pt, i) => {
        const k = posKey(pt);
        const list = m.get(k);
        if (list) list.push({ p, r, i });
        else m.set(k, [{ p, r, i }]);
      }),
    ),
  );
  return m;
}

/** `refs` plus every vertex attached to one of them (on the same spot, in another ring or the same one). */
export function withGlued(parts: Parts, refs: readonly VRef[], index = vertexIndex(parts)): VRef[] {
  const seen = new Set<string>();
  const out: VRef[] = [];
  const add = (v: VRef) => {
    const k = `${v.p}:${v.r}:${v.i}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(v);
  };
  for (const v of refs) {
    add(v);
    const pt = parts[v.p]?.[v.r]?.[v.i];
    if (pt) for (const g of index.get(posKey(pt)) ?? []) add(g);
  }
  return out;
}

/**
 * Lines of the region's other rings that run between the same two spots as edge i → i+1 of ring
 * (p, r): the other side of a shared border. Returned as {p, r, i} (the line's first vertex).
 */
export function sharedEdges(parts: Parts, p: number, r: number, i: number, index = vertexIndex(parts)): VRef[] {
  const ring = parts[p]?.[r];
  if (!ring || ring.length < 2) return [];
  const ka = posKey(ring[i]);
  const kb = posKey(ring[(i + 1) % ring.length]);
  const out: VRef[] = [];
  for (const v of index.get(ka) ?? []) {
    if (v.p === p && v.r === r) continue;
    const other = parts[v.p][v.r];
    const n = other.length;
    if (posKey(other[(v.i + 1) % n]) === kb) out.push({ p: v.p, r: v.r, i: v.i });
    else if (posKey(other[(v.i - 1 + n) % n]) === kb) out.push({ p: v.p, r: v.r, i: (v.i - 1 + n) % n });
  }
  return out;
}

/**
 * Inserts the point `pos` on each of the given lines ({p, r, i}: after vertex i), shifted to each
 * line's copy of the map. Returns the new parts and the new vertices.
 */
export function insertOnEdges(parts: Parts, edges: readonly VRef[], pos: Position): { parts: Parts; refs: VRef[] } {
  const out = parts.map((rings) => rings.map((ring) => ring.map(([x, y]) => [x, y] as Position)));
  // Later lines of a ring first, so earlier indices stay valid.
  const order = [...edges].sort((a, b) => a.p - b.p || a.r - b.r || b.i - a.i);
  const refs: VRef[] = [];
  for (const e of order) {
    const ring = out[e.p][e.r];
    const lon = nearest(pos[0], ring[e.i][0]);
    ring.splice(e.i + 1, 0, [lon, pos[1]]);
    // Earlier-recorded refs in this ring after the insertion point move up by one.
    for (const q of refs) if (q.p === e.p && q.r === e.r && q.i > e.i) q.i++;
    refs.push({ p: e.p, r: e.r, i: e.i + 1 });
  }
  return { parts: out, refs };
}

/* ── Province borders follow their part ── */

/**
 * Province borders are stored as plain lines, but they belong to the part they lie in and follow it:
 * moving the part moves them, and a line point sitting on an outline (snapped to a vertex or a line
 * of the part) stays on it when the outline's vertices move. Nothing about this is stored: ownership
 * and attachment are worked out from the geometry when an edit starts (see carryLines), so cutting,
 * splitting and combining parts leave the lines where they are.
 */

const lonNear = (lon: number, near: number) => lon + 360 * Math.round((near - lon) / 360);

function inPart(rings: readonly Position[][], pt: Position): boolean {
  if (!rings[0]?.length) return false;
  const p: Position = [lonNear(pt[0], rings[0][0][0]), pt[1]];
  const inside = (ring: readonly Position[]) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  return inside(rings[0]) && !rings.slice(1).some((h) => inside(h.map(([x, y]) => [lonNear(x, rings[0][0][0]), y] as Position)));
}

/** The part each line lies in (most of its points and segment midpoints inside it; contested zones don't own lines), or -1. */
export function lineOwners(parts: Parts, lines: readonly Position[][], contested: readonly number[] = []): number[] {
  return lines.map((line) => {
    const samples: Position[] = [];
    line.forEach((pt, i) => {
      samples.push(pt);
      if (i) samples.push([(pt[0] + line[i - 1][0]) / 2, (pt[1] + line[i - 1][1]) / 2]);
    });
    let best = -1;
    let bestN = 0;
    parts.forEach((rings, p) => {
      if ((contested[p] ?? -1) >= 0) return;
      const n = samples.filter((s) => inPart(rings, s)).length;
      if (n > bestN) {
        bestN = n;
        best = p;
      }
    });
    return best;
  });
}

/** A line point on a part's outline: line l, point k, on edge e (e → e + 1) of ring (p, r) at fraction t. */
export interface LinePin {
  l: number;
  k: number;
  p: number;
  r: number;
  e: number;
  t: number;
}

/** The line points that sit on an outline (within `eps` degrees), each with the edge it's on. */
export function linePins(parts: Parts, lines: readonly Position[][], eps = 1e-6, owners: readonly number[] = []): LinePin[] {
  const out: LinePin[] = [];
  lines.forEach((line, l) =>
    line.forEach((pt, k) => {
      let best: LinePin | null = null;
      let bestD = eps;
      // A point on an outline the line's own part shares with another part is pinned to its own part's edge.
      const own = owners[l] ?? -1;
      const order = parts.map((_, p) => p).sort((a, b) => Number(b === own) - Number(a === own));
      const seen = new Set<number>();
      order.forEach((p) => {
        if (seen.size && best && own >= 0 && p !== own) return;
        seen.add(p);
        const rings = parts[p];
        rings.forEach((ring, r) => {
          const n = ring.length;
          for (let e = 0; e < n; e++) {
            const a = ring[e];
            const b = ring[(e + 1) % n];
            const ax = lonNear(a[0], pt[0]);
            const bx = ax + (b[0] - a[0]);
            const dx = bx - ax;
            const dy = b[1] - a[1];
            const len2 = dx * dx + dy * dy;
            if (!len2) continue;
            const t = Math.max(0, Math.min(1, ((pt[0] - ax) * dx + (pt[1] - a[1]) * dy) / len2));
            const d = Math.hypot(pt[0] - (ax + t * dx), pt[1] - (a[1] + t * dy));
            if (d <= bestD) {
              bestD = d;
              best = { l, k, p, r, e, t };
            }
          }
        });
      });
      if (best) out.push(best);
    }),
  );
  return out;
}

export interface LineCarry {
  pins: LinePin[];
  owners: number[];
}

/** What an edit needs to know up front to carry the lines along (computed on the parts before the edit). */
export function lineCarry(parts: Parts, lines: readonly Position[][], contested: readonly number[] = []): LineCarry {
  const owners = lineOwners(parts, lines, contested);
  return { pins: linePins(parts, lines, 1e-6, owners), owners };
}

/**
 * The lines after an edit that kept every part and vertex index (a move, nudge or vertex drag):
 * `before`/`after` are the parts either side. Lines owned by a part in `moved` (null: all parts; [] :
 * none) shift by the part's displacement; every point pinned to an outline is then put back on that
 * outline's edge, wherever the edge's vertices went.
 */
export function carryLines(lines: readonly Position[][], carry: LineCarry, before: Parts, after: Parts, moved: readonly number[] | null): Position[][] {
  const out = lines.map((l) => l.map(([x, y]) => [x, y] as Position));
  const pinned = new Set(carry.pins.map((q) => `${q.l}:${q.k}`));
  // Displacement of a moved part: how far its first vertex went.
  const shift = (p: number): [number, number] => {
    const a = before[p]?.[0]?.[0];
    const b = after[p]?.[0]?.[0];
    return a && b ? [b[0] - a[0], b[1] - a[1]] : [0, 0];
  };
  const all = moved === null;
  const set = new Set(moved ?? []);
  out.forEach((line, l) => {
    const o = carry.owners[l];
    if (o < 0 || !(all || set.has(o))) return;
    const [dx, dy] = shift(o);
    if (!dx && !dy) return;
    line.forEach((pt, k) => {
      if (pinned.has(`${l}:${k}`)) return;
      pt[0] += dx;
      pt[1] = Math.max(-90, Math.min(90, pt[1] + dy));
    });
  });
  for (const q of carry.pins) {
    const ring = after[q.p]?.[q.r];
    const was = out[q.l]?.[q.k];
    if (!ring || !was) continue;
    const a = ring[q.e];
    const b = ring[(q.e + 1) % ring.length];
    if (!a || !b) continue;
    const old = before[q.p][q.r][q.e];
    // Same copy of the map as the point was in.
    const ax = a[0] + (lonNear(old[0], lines[q.l][q.k][0]) - old[0]);
    out[q.l][q.k] = [ax + q.t * (b[0] - a[0]), a[1] + q.t * (b[1] - a[1])];
  }
  return out;
}
