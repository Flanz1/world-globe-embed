/**
 * Warping regions and pins from one drawing of a world onto another (the admin's "Warp regions" tool).
 *
 * The admin matches spots on the old map and the new map ("pairs", at least MIN_PAIRS). From them we fit a
 * function from old map-image [lon, lat] to new map-image [lon, lat]:
 * - "straight": a least-squares affine map (move, rotate, scale, shear). Exact with three pairs.
 * - otherwise a thin-plate spline: the smoothest bend that takes every pair exactly where it was put
 *   (smoothness 0), or close to it (smoothness > 0, which relaxes towards the straight fit so one badly
 *   placed pair can't kink a coast). With three pairs it is the affine map.
 * For whole-world maps (`wraps`, the default) every pair is also copied one turn east and west, so the bend
 * carries on smoothly across the ±180° seam instead of tearing there.
 *
 * Everything is planar in the image frame (degrees), like the pixels the admin clicked. The function is
 * deterministic, so a vertex two regions share lands on the same spot in both, and edges get extra
 * vertices only where the bend would otherwise cut a corner, split the same way from either side.
 * No dependencies beyond geo.ts; used by the admin page and the unit tests.
 */
import { DECIMALS, MAX_VERTICES, checkGeometry, closeRing, findSelfIntersection, lonDelta, normalizeWinding, openRing, polygonsOf, round, toVec, unwrapRing, wrapLon, type Position, type RegionGeometry, type Ring } from "./geo.ts";

export const MIN_PAIRS = 3;
/** Most pairs one warp may use (a dense system of 3 × this size is solved per fit). */
export const MAX_PAIRS = 200;
/** How far (degrees in the image frame) a warped edge may stray from the warped curve before it is split. About 1 px at 16384 px wide. */
export const SPLIT_TOLERANCE = 0.02;
/** Deepest an edge is halved: one edge becomes at most 2^this pieces. */
const MAX_SPLIT_DEPTH = 7;
/** Most positions in a region's province borders (region.ts PROVINCE_BORDER_MAX; repeated to keep this file standalone). */
const PROVINCE_MAX = 5000;

export interface WarpPair {
  /** Spot on the old map, [lon, lat] in its image frame. */
  from: Position;
  /** The same spot on the new map. */
  to: Position;
}

export interface WarpOptions {
  /** Affine only, no bending. */
  straight?: boolean;
  /** 0 (each pair exact) to 100 (almost straight). Ignored when straight. */
  smoothness?: number;
  /** Both maps cover the whole world east to west, so the warp continues across the seam. Default true. */
  wraps?: boolean;
}

export interface WarpFit {
  /** Where a spot of the old map lands on the new one. Longitude may leave ±180 (wrap it yourself). */
  at(p: Position): Position;
  /** Per pair: how far (degrees on the sphere) the fit puts `from` away from `to` (0 for an exact fit). */
  residual: number[];
  /**
   * Per pair: how far (degrees on the sphere) the other pairs alone would put it from `to`. A misplaced pair
   * stands out here even though an exact fit passes through it. null with too few other pairs.
   */
  check: (number | null)[];
}

export type FitResult = { ok: true; fit: WarpFit } | { ok: false; why: string };

/* ── Linear algebra ── */

/** Solves A x = b for several right-hand sides (columns of B) by Gaussian elimination with partial pivoting. null if singular. */
function solve(A: number[][], B: number[][]): number[][] | null {
  const n = A.length;
  const m = B[0].length;
  const M = A.map((row, i) => [...row, ...B[i]]);
  let scale = 0;
  for (const row of A) for (const v of row) scale = Math.max(scale, Math.abs(v));
  const eps = 1e-12 * (scale || 1);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < eps) return null;
    if (p !== c) [M[p], M[c]] = [M[c], M[p]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (f) for (let k = c; k < n + m; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row.slice(n).map((v) => v / M[i][i]));
}

/** Thin-plate kernel U(r) = r² log r, from the squared distance. */
const kernel = (d2: number): number => (d2 > 0 ? 0.5 * d2 * Math.log(d2) : 0);

/** The new-map spot of a pair taken the short way round from its old-map spot, so the fit sees a small move, not a lap. */
const unwrapTo = (p: WarpPair): Position => [p.from[0] + lonDelta(p.from[0], p.to[0]), p.to[1]];

/** Twice the area of the largest triangle of the points, a cheap "not all in a line" test. */
function spread(pts: Position[]): number {
  // The two points farthest apart, then the point farthest from their line.
  let best = 0;
  let a = 0;
  let b = 0;
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) {
      const d = (pts[i][0] - pts[j][0]) ** 2 + (pts[i][1] - pts[j][1]) ** 2;
      if (d > best) [best, a, b] = [d, i, j];
    }
  let area = 0;
  for (const p of pts) area = Math.max(area, Math.abs((pts[b][0] - pts[a][0]) * (p[1] - pts[a][1]) - (pts[b][1] - pts[a][1]) * (p[0] - pts[a][0])));
  return area;
}

type Fn = (p: Position) => Position;

function affine(src: Position[], dst: Position[]): Fn | null {
  // Least squares: [x y 1] · A = [x' y'].
  const PtP = [0, 1, 2].map(() => [0, 0, 0]);
  const PtV = [0, 1, 2].map(() => [0, 0]);
  src.forEach((s, i) => {
    const row = [s[0], s[1], 1];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) PtP[r][c] += row[r] * row[c];
      PtV[r][0] += row[r] * dst[i][0];
      PtV[r][1] += row[r] * dst[i][1];
    }
  });
  const A = solve(PtP, PtV);
  if (!A) return null;
  return ([x, y]) => [A[0][0] * x + A[1][0] * y + A[2][0], A[0][1] * x + A[1][1] * y + A[2][1]];
}

function spline(src: Position[], dst: Position[], lambda: number): Fn | null {
  // Work in centred, unit-sized coordinates: in degrees the kernel reaches millions while the affine part stays
  // near 1, which would make the solve's pivots useless as a singularity test.
  const n = src.length;
  const cx = src.reduce((t, p) => t + p[0], 0) / n;
  const cy = src.reduce((t, p) => t + p[1], 0) / n;
  const sc = Math.sqrt(src.reduce((t, p) => t + (p[0] - cx) ** 2 + (p[1] - cy) ** 2, 0) / n) || 1;
  const u = src.map(([x, y]) => [(x - cx) / sc, (y - cy) / sc] as Position);
  const lam = lambda / (sc * sc);
  const L: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = new Array<number>(n + 3).fill(0);
    for (let j = 0; j < n; j++) row[j] = i === j ? lam : kernel((u[i][0] - u[j][0]) ** 2 + (u[i][1] - u[j][1]) ** 2);
    row[n] = 1;
    row[n + 1] = u[i][0];
    row[n + 2] = u[i][1];
    L.push(row);
  }
  for (let k = 0; k < 3; k++) {
    const row = new Array<number>(n + 3).fill(0);
    for (let j = 0; j < n; j++) row[j] = k === 0 ? 1 : u[j][k - 1];
    L.push(row);
  }
  const V = [...dst.map((d) => [d[0], d[1]]), [0, 0], [0, 0], [0, 0]];
  const W = solve(L, V);
  if (!W) return null;
  return ([px, py]) => {
    const x = (px - cx) / sc;
    const y = (py - cy) / sc;
    let ox = W[n][0] + W[n + 1][0] * x + W[n + 2][0] * y;
    let oy = W[n][1] + W[n + 1][1] * x + W[n + 2][1] * y;
    for (let j = 0; j < n; j++) {
      const k = kernel((x - u[j][0]) ** 2 + (y - u[j][1]) ** 2);
      ox += W[j][0] * k;
      oy += W[j][1] * k;
    }
    return [ox, oy];
  };
}

/**
 * Smoothness 0..100 → the spline's regularisation, in degrees² so spline() can rescale it. Scaled to how far apart the
 * pairs are, so the slider means the same on any map: 100 is close to the straight fit, 1 barely relaxes it.
 */
function lambdaFor(smoothness: number, src: Position[]): number {
  if (!(smoothness > 0)) return 0;
  const n = src.length;
  const cx = src.reduce((t, p) => t + p[0], 0) / n;
  const cy = src.reduce((t, p) => t + p[1], 0) / n;
  const s2 = src.reduce((t, p) => t + (p[0] - cx) ** 2 + (p[1] - cy) ** 2, 0) / n || 1;
  return s2 * 10 ** ((Math.min(100, smoothness) - 100) / 25 + 1);
}

/** Fits the function for these pairs, with the pairs at `skip` left out (for the check). */
function fitFn(pairs: readonly WarpPair[], o: WarpOptions, skip = -1): Fn | null {
  const use = pairs.filter((_, i) => i !== skip);
  if (use.length < MIN_PAIRS) return null;
  const src = use.map((p) => p.from);
  const dst = use.map(unwrapTo);
  if (o.straight) return affine(src, dst);
  let s = src;
  let d = dst;
  if (o.wraps !== false) {
    s = [...src, ...src.map(([x, y]) => [x - 360, y] as Position), ...src.map(([x, y]) => [x + 360, y] as Position)];
    d = [...dst, ...dst.map(([x, y]) => [x - 360, y] as Position), ...dst.map(([x, y]) => [x + 360, y] as Position)];
  }
  return spline(s, d, lambdaFor(o.smoothness ?? 0, src));
}

/** Angular distance in degrees, precise for tiny distances too (acos isn't). */
function sphereDist(a: Position, b: Position): number {
  const u = toVec([wrapLon(a[0]), clampLat(a[1])]);
  const v = toVec([wrapLon(b[0]), clampLat(b[1])]);
  const c = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
  return (Math.atan2(c, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) * 180) / Math.PI;
}
const clampLat = (y: number) => Math.max(-90, Math.min(90, y));

/** Fits a warp, or says (in words for the admin) why it can't. */
export function fitWarp(pairs: readonly WarpPair[], o: WarpOptions = {}): FitResult {
  if (pairs.length < MIN_PAIRS) return { ok: false, why: `Add at least ${MIN_PAIRS} point pairs.` };
  if (pairs.length > MAX_PAIRS) return { ok: false, why: `Use at most ${MAX_PAIRS} point pairs.` };
  for (const p of pairs) if (![...p.from, ...p.to].every(Number.isFinite)) return { ok: false, why: "A point isn't on the map." };
  // Pairs on (nearly) one spot or in one line can't fix a rotation or a stretch.
  if (spread(pairs.map((p) => p.from)) < 1e-6 || spread(pairs.map(unwrapTo)) < 1e-6) return { ok: false, why: "The points are all in a line: spread them out so they make a triangle or more." };
  for (let i = 0; i < pairs.length; i++)
    for (let j = i + 1; j < pairs.length; j++)
      if (Math.abs(lonDelta(pairs[i].from[0], pairs[j].from[0])) < 1e-9 && Math.abs(pairs[i].from[1] - pairs[j].from[1]) < 1e-9)
        return { ok: false, why: `Points ${i + 1} and ${j + 1} are on the same spot of the old map.` };
  const f = fitFn(pairs, o);
  if (!f) return { ok: false, why: "These points can't be fitted: spread them out more." };
  const residual = pairs.map((p) => sphereDist(f(p.from), p.to));
  const check = pairs.map((p, i) => {
    const g = pairs.length - 1 >= MIN_PAIRS ? fitFn(pairs, o, i) : null;
    return g ? sphereDist(g(p.from), p.to) : null;
  });
  return { ok: true, fit: { at: f, residual, check } };
}

/* ── Warping lines and shapes ── */

/** The warped spot, wrapped to ±180 and inside ±90. */
export function warpPoint(fit: Pick<WarpFit, "at">, p: Position): Position {
  const [x, y] = fit.at([wrapLon(p[0]), p[1]]);
  return [wrapLon(x), clampLat(y)];
}

const same = (a: Position, b: Position) => a[0] === b[0] && a[1] === b[1];
const before = (a: Position, b: Position) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

/**
 * The points strictly between `a` and `b` to add so the warped edge follows the warped curve, in order from `a`
 * (old-map positions, wrapped). Always split from the "smaller" end, so a shared edge splits the same way in
 * both regions.
 */
function splitEdge(fit: Pick<WarpFit, "at">, a: Position, b: Position, tol: number): Position[] {
  if (!Number.isFinite(tol) || same(a, b)) return [];
  const flip = before(b, a);
  const [s, e] = flip ? [b, a] : [a, b];
  const e2: Position = [s[0] + lonDelta(s[0], e[0]), e[1]];
  const out: Position[] = [];
  const ws = fit.at(s);
  const we = fit.at(e2);
  const rec = (p: Position, wp: Position, q: Position, wq: Position, depth: number) => {
    const m: Position = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    const wm = fit.at(m);
    const dev = Math.hypot(wm[0] - (wp[0] + wq[0]) / 2, wm[1] - (wp[1] + wq[1]) / 2);
    if (dev <= tol || depth >= MAX_SPLIT_DEPTH) return;
    rec(p, wp, m, wm, depth + 1);
    out.push([wrapLon(m[0]), m[1]]);
    rec(m, wm, q, wq, depth + 1);
  };
  rec(s, ws, e2, we, 0);
  return flip ? out.reverse() : out;
}

/** Warps an open line (province border) or, with `closed`, an open ring (its closing edge is split too). */
export function warpLine(fit: Pick<WarpFit, "at">, line: readonly Position[], closed: boolean, tol = SPLIT_TOLERANCE): Position[] {
  const pts: Position[] = [];
  const n = line.length;
  for (let i = 0; i < n; i++) {
    pts.push(line[i]);
    const j = i + 1 < n ? i + 1 : closed ? 0 : -1;
    if (j >= 0 && n > 1) pts.push(...splitEdge(fit, line[i], line[j], tol));
  }
  const out: Position[] = [];
  for (const p of pts) {
    const w = warpPoint(fit, p);
    const q: Position = [round(w[0], DECIMALS), round(w[1], DECIMALS)];
    const prev = out[out.length - 1];
    if (!prev || !same(prev, q)) out.push(q);
  }
  if (closed) while (out.length > 1 && same(out[0], out[out.length - 1])) out.pop();
  return out;
}

/** How close (degrees) a vertex must already be to an edge it ends up crossing for repairRing to drop it. */
const TOUCH = 0.002;

function segDist(p: Position, a: Position, b: Position): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/**
 * Where a ring nearly touched itself (a pinched neck, a vertex drawn onto another edge), rounding the warped
 * positions can tip it into crossing. Drops the vertex that sits on the other edge, while the crossings are that
 * tiny; anything bigger is left for the admin to see. Takes and returns an open ring of wrapped positions.
 */
export function repairRing(open: Position[]): Position[] {
  let ring = open;
  for (let tries = 0; tries < 50 && ring.length > 3; tries++) {
    const un = unwrapRing(ring);
    const hit = findSelfIntersection(un);
    if (!hit) return ring;
    const n = un.length;
    const [i, j] = hit;
    const cands: { v: number; d: number }[] = [];
    for (const [v, e] of [[i, j], [(i + 1) % n, j], [j, i], [(j + 1) % n, i]] as const) cands.push({ v, d: segDist(un[v], un[e], un[(e + 1) % n]) });
    cands.sort((a, b) => a.d - b.d);
    if (cands[0].d > TOUCH) return ring;
    ring = ring.filter((_, k) => k !== cands[0].v);
  }
  return ring;
}

export interface WarpedShape {
  geometry: RegionGeometry;
  provinceBorders?: Position[][];
  /** Positions added to follow the bend (outlines and province borders together). */
  added: number;
  /** Why this result can't be saved (outline crosses itself, a ring collapsed…). Empty = fine. */
  problems: string[];
}

function warpGeometry(fit: Pick<WarpFit, "at">, g: RegionGeometry, tol: number): { geometry: RegionGeometry; count: number; collapsed: boolean } {
  let count = 0;
  let collapsed = false;
  const polys = polygonsOf(g).map((poly) =>
    normalizeWinding(
      poly.map((ring) => {
        const open = openRing(ring);
        const w = repairRing(warpLine(fit, open, true, tol));
        if (w.length < 3) collapsed = true;
        count += w.length;
        return w as Ring;
      }),
    ).map(closeRing),
  );
  const geometry: RegionGeometry = g.type === "Polygon" ? { type: "Polygon", coordinates: polys[0] } : { type: "MultiPolygon", coordinates: polys };
  return { geometry, count, collapsed };
}

/** Warps a region's outline and its province borders. Densifies only while the region stays under the vertex caps. */
export function warpShape(fit: Pick<WarpFit, "at">, geometry: RegionGeometry, provinceBorders?: readonly Position[][], tol = SPLIT_TOLERANCE): WarpedShape {
  let before = 0;
  for (const poly of polygonsOf(geometry)) for (const r of poly) before += openRing(r).length;
  let g = warpGeometry(fit, geometry, tol);
  if (g.count > MAX_VERTICES) g = warpGeometry(fit, geometry, Infinity);
  let lines: Position[][] | undefined;
  let linesBefore = 0;
  let linesAfter = 0;
  if (provinceBorders?.length) {
    linesBefore = provinceBorders.reduce((t, l) => t + l.length, 0);
    lines = provinceBorders.map((l) => warpLine(fit, l, false, tol));
    if (lines.reduce((t, l) => t + l.length, 0) > PROVINCE_MAX) lines = provinceBorders.map((l) => warpLine(fit, l, false, Infinity));
    lines = lines.filter((l) => l.length >= 2);
    linesAfter = lines.reduce((t, l) => t + l.length, 0);
  }
  const problems: string[] = [];
  if (g.collapsed) problems.push("a part would shrink to almost nothing");
  else problems.push(...checkGeometry(g.geometry).map((e) => e.replace(/^geometry\.?/, "")));
  return { geometry: g.geometry, ...(lines ? { provinceBorders: lines } : {}), added: Math.max(0, g.count - before) + Math.max(0, linesAfter - linesBefore), problems };
}
