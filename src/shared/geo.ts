/**
 * Small geometry toolkit for regions, shared by the validator, the page generator, the viewer and
 * the admin editor. No dependencies.
 *
 * Coordinates are GeoJSON-style [lon, lat] in degrees, in the *map image's own frame*
 * (lon = x / width * 360 - 180, lat = 90 - y / height * 180). An edge always takes the shorter way
 * round, so [179, 0] → [-179, 0] crosses the antimeridian and is 2° long.
 *
 * Naming: a "closed" ring repeats its first position at the end (GeoJSON); an "open" ring doesn't.
 * An "unwrapped" ring has continuous longitudes (they may leave ±180) so it can be treated as planar.
 */

export type Position = [number, number];
export type Ring = Position[];
export interface PolygonGeometry {
  type: "Polygon";
  coordinates: Ring[];
}
export interface MultiPolygonGeometry {
  type: "MultiPolygon";
  coordinates: Ring[][];
}
export type RegionGeometry = PolygonGeometry | MultiPolygonGeometry;

/** Most vertices a region may have, over all its rings (closing positions not counted). */
export const MAX_VERTICES = 5000;
/** Coordinates are stored with this many decimals (about 1 m on an Earth-sized globe at 1e-5; 4 is ~10 m). */
export const DECIMALS = 4;

const DEG = Math.PI / 180;
const EPS = 1e-12;

/* ── Longitude wrapping ── */

/** Wraps a longitude into [-180, 180]. Values already in range (including ±180) are returned as is. */
export function wrapLon(lon: number): number {
  if (lon >= -180 && lon <= 180) return lon;
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** Signed shortest longitude difference b - a, in (-180, 180]. */
export function lonDelta(a: number, b: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  else if (d <= -180) d += 360;
  return d;
}

/** Makes longitudes continuous along the ring: each step takes the shorter way round. Works on open or closed rings. */
export function unwrapRing(ring: Ring): Ring {
  if (!ring.length) return [];
  const out: Ring = [[ring[0][0], ring[0][1]]];
  for (let i = 1; i < ring.length; i++) {
    // The point's own longitude plus whole turns (not a running sum of deltas), so rounding doesn't
    // build up and a closing point that equals the first one stays exactly equal.
    const prev = out[i - 1][0];
    const x = ring[i][0];
    out.push([x + 360 * Math.round((prev - x) / 360), ring[i][1]]);
  }
  return out;
}

/** Wraps every longitude back into [-180, 180]. */
export const wrapRing = (ring: Ring): Ring => ring.map(([x, y]) => [wrapLon(x), y]);

export const openRing = (ring: Ring): Ring =>
  ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring.slice();

export const closeRing = (ring: Ring): Ring => (ring.length ? [...ring, [ring[0][0], ring[0][1]]] : []);

export const round = (v: number, d = DECIMALS): number => {
  const k = 10 ** d;
  const r = Math.round(v * k) / k;
  return Object.is(r, -0) ? 0 : r;
};

/** Longitude extent (degrees) of an unwrapped ring. */
export function lonSpan(unwrapped: Ring): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const [x] of unwrapped) {
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  return unwrapped.length ? hi - lo : 0;
}

/**
 * True if walking round the closed ring (each edge the shorter way) adds up to a full turn in longitude,
 * which means the ring goes round a pole.
 */
export function windsAroundPole(closed: Ring): boolean {
  let total = 0;
  for (let i = 1; i < closed.length; i++) total += lonDelta(closed[i - 1][0], closed[i][0]);
  return Math.abs(total) > 180;
}

/**
 * The smallest longitude interval that contains all the given longitudes, as [west, east] with
 * east >= west (east may exceed 180 when the interval crosses the antimeridian).
 */
export function lonBounds(lons: number[]): [number, number] {
  if (!lons.length) return [-180, 180];
  const s = [...new Set(lons.map((l) => ((wrapLon(l) + 540) % 360) - 180))].sort((a, b) => a - b);
  if (s.length === 1) return [s[0], s[0]];
  // The interval is the complement of the largest gap between neighbours (the wrap-round gap included).
  let gap = s[0] + 360 - s[s.length - 1];
  let west = s[0];
  for (let i = 1; i < s.length; i++) {
    const g = s[i] - s[i - 1];
    if (g > gap) {
      gap = g;
      west = s[i];
    }
  }
  return [west, west + 360 - gap];
}

/* ── Planar helpers (on unwrapped rings, x = lon, y = lat) ── */

/** Shoelace area of an open or closed ring; positive when counter-clockwise (east = +x, north = +y). */
export function signedArea(ring: Ring): number {
  const r = openRing(ring);
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const [x1, y1] = r[i];
    const [x2, y2] = r[(i + 1) % r.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

const orient = (a: Position, b: Position, c: Position): number => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const onSegment = (a: Position, b: Position, p: Position): boolean =>
  Math.min(a[0], b[0]) - EPS <= p[0] && p[0] <= Math.max(a[0], b[0]) + EPS && Math.min(a[1], b[1]) - EPS <= p[1] && p[1] <= Math.max(a[1], b[1]) + EPS;

/** True if segments ab and cd touch or cross (shared endpoints count). */
export function segmentsIntersect(a: Position, b: Position, c: Position, d: Position): boolean {
  if (Math.max(a[0], b[0]) < Math.min(c[0], d[0]) - EPS || Math.max(c[0], d[0]) < Math.min(a[0], b[0]) - EPS) return false;
  if (Math.max(a[1], b[1]) < Math.min(c[1], d[1]) - EPS || Math.max(c[1], d[1]) < Math.min(a[1], b[1]) - EPS) return false;
  const d1 = orient(c, d, a);
  const d2 = orient(c, d, b);
  const d3 = orient(a, b, c);
  const d4 = orient(a, b, d);
  if (((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))) return true;
  if (Math.abs(d1) <= EPS && onSegment(c, d, a)) return true;
  if (Math.abs(d2) <= EPS && onSegment(c, d, b)) return true;
  if (Math.abs(d3) <= EPS && onSegment(a, b, c)) return true;
  if (Math.abs(d4) <= EPS && onSegment(a, b, d)) return true;
  return false;
}

/** Adjacent edges a→b→c fold back on themselves (a spike of zero width). */
function foldsBack(a: Position, b: Position, c: Position): boolean {
  if (Math.abs(orient(a, b, c)) > EPS) return false;
  return (a[0] - b[0]) * (c[0] - b[0]) + (a[1] - b[1]) * (c[1] - b[1]) > 0;
}

/**
 * Indices of the first pair of edges that intersect in an open, unwrapped ring (edge i runs from
 * vertex i to i+1), or null. Only the edges in `only` are tested against the rest when given, which
 * keeps checks during a drag linear.
 */
export function findSelfIntersection(open: Ring, only?: Iterable<number>): [number, number] | null {
  const n = open.length;
  if (n < 3) return null;
  const edge = (i: number): [Position, Position] => [open[i], open[(i + 1) % n]];
  const check = (i: number, j: number): boolean => {
    if (i === j) return false;
    const adjacent = (i + 1) % n === j || (j + 1) % n === i;
    const [a, b] = edge(i);
    const [c, d] = edge(j);
    if (adjacent) {
      if (n === 3) return false;
      // Shared vertex: only a fold-back (overlap) counts.
      return (j + 1) % n === i ? foldsBack(c, a, b) : foldsBack(a, b, d);
    }
    return segmentsIntersect(a, b, c, d);
  };
  if (only) {
    for (const i of new Set(only)) for (let j = 0; j < n; j++) if (check(((i % n) + n) % n, j)) return [i, j];
    return null;
  }
  // Sweep by min-x so only edges whose x ranges overlap are compared.
  const order = [...Array(n).keys()].map((i) => {
    const [a, b] = edge(i);
    return { i, lo: Math.min(a[0], b[0]), hi: Math.max(a[0], b[0]) };
  });
  order.sort((p, q) => p.lo - q.lo);
  for (let s = 0; s < n; s++) {
    for (let t = s + 1; t < n && order[t].lo <= order[s].hi + EPS; t++) {
      if (check(order[s].i, order[t].i)) return [order[s].i, order[t].i];
    }
  }
  return null;
}

/** Ray-casting point-in-ring on an unwrapped ring; tries the point's ±360° copies so the antimeridian is handled. */
export function pointInRing(p: Position, ring: Ring): boolean {
  const r = openRing(unwrapRing(ring));
  if (r.length < 3) return false;
  let lo = Infinity;
  let hi = -Infinity;
  for (const [x] of r) {
    lo = Math.min(lo, x);
    hi = Math.max(hi, x);
  }
  for (const k of [0, -360, 360, -720, 720]) {
    const x = p[0] + k;
    if (x < lo || x > hi) continue;
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i];
      const [xj, yj] = r[j];
      if (yi > p[1] !== yj > p[1] && x < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  return false;
}

/** Point in a polygon (outer ring followed by holes). */
export function pointInPolygon(p: Position, polygon: Ring[]): boolean {
  if (!polygon.length || !pointInRing(p, polygon[0])) return false;
  for (let i = 1; i < polygon.length; i++) if (pointInRing(p, polygon[i])) return false;
  return true;
}

export const polygonsOf = (g: RegionGeometry): Ring[][] => (g.type === "Polygon" ? [g.coordinates] : g.coordinates);

export function pointInGeometry(p: Position, g: RegionGeometry): boolean {
  return polygonsOf(g).some((poly) => pointInPolygon(p, poly));
}

/* ── Simplification and smoothing (planar, on whatever 2D units the caller passes) ── */

function perpDist(p: Position, a: Position, b: Position): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Douglas–Peucker on an open polyline. Returns the indices to keep (first and last always kept). */
export function douglasPeuckerIndices(pts: Position[], tol: number): number[] {
  const n = pts.length;
  if (n <= 2) return [...Array(n).keys()];
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let best = -1;
    let bestD = tol;
    for (let i = s + 1; i < e; i++) {
      const d = perpDist(pts[i], pts[s], pts[e]);
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

export const douglasPeucker = (pts: Position[], tol: number): Position[] => douglasPeuckerIndices(pts, tol).map((i) => pts[i]);

/**
 * Douglas–Peucker for an open ring (closed shape, no repeated end). Splits at the vertex farthest
 * from the first one so both halves are simplified evenly. Never returns fewer than 3 vertices.
 */
export function simplifyRing(open: Position[], tol: number): Position[] {
  const n = open.length;
  if (n <= 3) return open.slice();
  let far = 1;
  let farD = -1;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(open[i][0] - open[0][0], open[i][1] - open[0][1]);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const a = douglasPeucker(open.slice(0, far + 1), tol);
  const b = douglasPeucker([...open.slice(far), open[0]], tol);
  const out = [...a, ...b.slice(1, -1)];
  if (out.length >= 3) return out;
  // Too aggressive: keep the three most spread-out vertices.
  const third = open.reduce((best, p, i) => (perpDist(p, open[0], open[far]) > perpDist(open[best], open[0], open[far]) ? i : best), 1);
  return [0, far, third].sort((x, y) => x - y).map((i) => open[i]);
}

/** One pass of Chaikin corner cutting on an open ring (closed shape). Doubles the vertex count. */
export function chaikin(open: Position[]): Position[] {
  const n = open.length;
  if (n < 3) return open.slice();
  const out: Position[] = [];
  for (let i = 0; i < n; i++) {
    const [x0, y0] = open[i];
    const [x1, y1] = open[(i + 1) % n];
    out.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1], [0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1]);
  }
  return out;
}

/* ── Winding ── */

/** Outer rings counter-clockwise, holes clockwise (RFC 7946). Rings are unwrapped for the test, the input is not changed. */
export function normalizeWinding(polygon: Ring[]): Ring[] {
  return polygon.map((ring, i) => {
    const ccw = signedArea(unwrapRing(ring)) > 0;
    return ccw === (i === 0) ? ring.slice() : ring.slice().reverse();
  });
}

/* ── Spherical helpers ── */

export type Vec3 = [number, number, number];

export function toVec([lon, lat]: Position): Vec3 {
  const c = Math.cos(lat * DEG);
  return [c * Math.cos(lon * DEG), c * Math.sin(lon * DEG), Math.sin(lat * DEG)];
}

export function toLonLat([x, y, z]: Vec3): Position {
  const r = Math.hypot(x, y, z) || 1;
  return [Math.atan2(y, x) / DEG, Math.asin(Math.max(-1, Math.min(1, z / r))) / DEG];
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Angular distance in degrees. */
export const angleBetween = (a: Position, b: Position): number => Math.acos(Math.max(-1, Math.min(1, dot(toVec(a), toVec(b))))) / DEG;

/**
 * Signed area of a ring on the unit sphere (steradians), edges as great-circle arcs. Positive when
 * counter-clockwise. Triangle fan from the first vertex, each triangle by the Van Oosterom–Strackee formula.
 */
export function sphericalRingArea(ring: Ring): number {
  const r = openRing(ring).map(toVec);
  let sum = 0;
  for (let i = 1; i + 1 < r.length; i++) {
    const [a, b, c] = [r[0], r[i], r[i + 1]];
    const num = dot(a, cross(b, c));
    const den = 1 + dot(a, b) + dot(b, c) + dot(c, a);
    sum += 2 * Math.atan2(num, den);
  }
  return sum;
}

/** Area of a geometry on the unit sphere in steradians (outer rings minus holes). */
export function sphericalArea(g: RegionGeometry): number {
  let total = 0;
  for (const poly of polygonsOf(g)) {
    poly.forEach((ring, i) => {
      const a = Math.abs(sphericalRingArea(ring));
      total += i === 0 ? a : -a;
    });
  }
  return Math.max(0, total);
}

/** Area as a percentage of the whole sphere. */
export const areaPercent = (g: RegionGeometry): number => (sphericalArea(g) / (4 * Math.PI)) * 100;

/**
 * Spherical centroid: the direction of ∫ x dA over the region, which by Stokes' theorem is
 * ½ Σ θ_e n_e over the boundary edges (θ = arc length, n = unit normal of the arc's great circle).
 * Rings are normalised (outer CCW, holes CW) first so holes subtract.
 */
export function sphericalCentroid(g: RegionGeometry): Position {
  const m: Vec3 = [0, 0, 0];
  let n = 0;
  const mean: Vec3 = [0, 0, 0];
  for (const poly of polygonsOf(g)) {
    for (const ring of normalizeWinding(poly)) {
      const r = openRing(ring).map(toVec);
      for (let i = 0; i < r.length; i++) {
        const a = r[i];
        const b = r[(i + 1) % r.length];
        const c = cross(a, b);
        const s = Math.hypot(...c);
        mean[0] += a[0];
        mean[1] += a[1];
        mean[2] += a[2];
        n++;
        if (s < 1e-15) continue;
        const theta = Math.atan2(s, dot(a, b));
        for (let k = 0; k < 3; k++) m[k] += (theta / 2) * (c[k] / s);
      }
    }
  }
  // Degenerate (no area): fall back to the mean of the vertices.
  const v = Math.hypot(...m) > 1e-12 ? m : mean;
  return n ? toLonLat(v) : [0, 0];
}

/** Smallest angular radius (degrees) around `centre` that contains every vertex. */
export function boundingCapRadius(g: RegionGeometry, centre: Position): number {
  let r = 0;
  for (const poly of polygonsOf(g)) for (const ring of poly) for (const p of ring) r = Math.max(r, angleBetween(centre, p));
  return r;
}

export function boundingCap(g: RegionGeometry): { centre: Position; radius: number } {
  const centre = sphericalCentroid(g);
  return { centre, radius: boundingCapRadius(g, centre) };
}

/* ── Counting and transforming ── */

export function vertexCount(g: RegionGeometry): number {
  let n = 0;
  for (const poly of polygonsOf(g)) for (const ring of poly) n += openRing(ring).length;
  return n;
}

export function mapGeometry(g: RegionGeometry, f: (p: Position) => Position): RegionGeometry {
  return g.type === "Polygon"
    ? { type: "Polygon", coordinates: g.coordinates.map((r) => r.map(f)) }
    : { type: "MultiPolygon", coordinates: g.coordinates.map((poly) => poly.map((r) => r.map(f))) };
}

/** Bounds in the map-image frame: [west, south, east, north], east >= west (east may exceed 180). */
export function geometryBounds(g: RegionGeometry): [number, number, number, number] {
  const lons: number[] = [];
  let s = Infinity;
  let n = -Infinity;
  for (const poly of polygonsOf(g))
    for (const ring of poly)
      for (const [x, y] of ring) {
        lons.push(x);
        s = Math.min(s, y);
        n = Math.max(n, y);
      }
  const [w, e] = lonBounds(lons);
  return [w, s, e, n];
}

/* ── Image frame ↔ globe frame ── */

/** The slot settings that move a map on the globe: pole padding (percent) and prime meridian shift (degrees). */
export interface GlobeFrame {
  north: number;
  south: number;
  shift: number;
}

const pad = (v: number) => Math.min(49, Math.max(0, Number.isFinite(v) ? v : 0));

/**
 * Where a point of the map image ends up on the globe. The texture is stretched over the band between the
 * padded caps and moved east by `shift`, so this is the transform regions must follow to stay on the land.
 */
export function imageToGlobe([lon, lat]: Position, f: GlobeFrame): Position {
  const n = pad(f.north) / 100;
  const s = pad(f.south) / 100;
  const v = (90 - lat) / 180;
  const t = n + v * (1 - n - s);
  return [wrapLon(lon + (Number.isFinite(f.shift) ? f.shift : 0)), 90 - t * 180];
}

/** Inverse of imageToGlobe. Latitudes inside the padded caps map outside ±90 (they're not on the map). */
export function globeToImage([lon, lat]: Position, f: GlobeFrame): Position {
  const n = pad(f.north) / 100;
  const s = pad(f.south) / 100;
  const t = (90 - lat) / 180;
  const v = (t - n) / (1 - n - s);
  return [wrapLon(lon - (Number.isFinite(f.shift) ? f.shift : 0)), 90 - v * 180];
}

/* ── Validation ── */

/**
 * Geometry rules beyond the JSON schema. Returns readable problems (empty when fine).
 * `where` prefixes each message, e.g. `content/regions/x.json: geometry`.
 */
export function checkGeometry(g: RegionGeometry, where = "geometry"): string[] {
  const errs: string[] = [];
  const polys = polygonsOf(g);
  const multi = g.type === "MultiPolygon";
  let total = 0;
  polys.forEach((poly, pi) => {
    poly.forEach((ring, ri) => {
      const name = `${multi ? `part ${pi + 1}, ` : ""}${ri === 0 ? "outer ring" : `hole ${ri}`}`;
      const at = `${where}: ${name}`;
      if (!ring.every((p) => p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))) {
        errs.push(`${at} has a position that isn't two finite numbers`);
        return;
      }
      if (ring.length < 4) {
        errs.push(`${at} has ${ring.length} positions; a ring needs at least 4 (3 corners plus the first one repeated at the end)`);
        return;
      }
      const first = ring[0];
      const last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) {
        errs.push(`${at} isn't closed: the last position must repeat the first (${JSON.stringify(first)})`);
        return;
      }
      total += ring.length - 1;
      for (let i = 1; i < ring.length; i++) {
        if (Math.abs(lonDelta(ring[i - 1][0], ring[i][0])) === 180) {
          errs.push(`${at}: the edge from ${JSON.stringify(ring[i - 1])} to ${JSON.stringify(ring[i])} is exactly 180° of longitude, so it's ambiguous which way round it goes`);
          return;
        }
      }
      if (windsAroundPole(ring)) {
        errs.push(`${at} goes all the way round a pole. Rings may not contain a pole: stop short of it, e.g. at ±89°`);
        return;
      }
      const un = unwrapRing(ring);
      const span = lonSpan(un);
      if (span > 180) {
        errs.push(`${at} spans ${round(span, 1)}° of longitude; a single ring may span at most 180°. Split it into two parts`);
        return;
      }
      const hit = findSelfIntersection(openRing(un));
      if (hit) {
        const o = openRing(ring);
        const e = (i: number) => `${JSON.stringify(o[i])}→${JSON.stringify(o[(i + 1) % o.length])}`;
        errs.push(`${at} crosses itself: edge ${e(hit[0])} meets edge ${e(hit[1])}`);
        return;
      }
      const ccw = signedArea(un) > 0;
      if (ri === 0 && !ccw) errs.push(`${at} must be counter-clockwise (the admin page fixes this on save; or reverse the positions)`);
      if (ri > 0 && ccw) errs.push(`${at} must be clockwise, because it's a hole (or reverse the positions)`);
      if (ri > 0 && poly[0].length >= 4 && !pointInRing(ring[0], poly[0])) errs.push(`${at} lies outside its outer ring`);
    });
  });
  if (total > MAX_VERTICES) errs.push(`${where} has ${total} vertices; the limit is ${MAX_VERTICES}. Simplify it in the admin page`);
  return errs;
}

/**
 * Turns editor rings (open, unwrapped, any winding) into a stored geometry: wrapped to ±180, rounded,
 * consecutive duplicates removed, closed, wound per RFC 7946. One part → Polygon, more → MultiPolygon.
 */
export function toStoredGeometry(parts: Position[][][]): RegionGeometry {
  const polys = parts
    .map((rings) =>
      normalizeWinding(
        rings
          .map((r) => {
            const out: Ring = [];
            for (const [x, y] of r) {
              const p: Position = [round(wrapLon(x)), round(Math.max(-90, Math.min(90, y)))];
              const prev = out[out.length - 1];
              if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) out.push(p);
            }
            while (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
            return out;
          })
          .filter((r, _i, all) => r.length >= 3 && all[0].length >= 3),
      ).map(closeRing),
    )
    .filter((rings) => rings.length > 0);
  return polys.length === 1 ? { type: "Polygon", coordinates: polys[0] } : { type: "MultiPolygon", coordinates: polys };
}

/**
 * A point inside a part (inside its outer ring, outside its holes), in the part's own unwrapped
 * coordinates, for a part's badge or label: the outer ring's centroid when that lands inside,
 * otherwise the middle of the widest inside stretch along the centroid's latitude.
 */
export function partAnchor(rings: Ring[]): Position | null {
  const outer = rings[0];
  if (!outer || outer.length < 3) return null;
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, n = outer.length; i < n; i++) {
    const [x0, y0] = outer[i];
    const [x1, y1] = outer[(i + 1) % n];
    const c = x0 * y1 - x1 * y0;
    a += c;
    cx += (x0 + x1) * c;
    cy += (y0 + y1) * c;
  }
  let c: Position;
  if (Math.abs(a) < 1e-12) {
    const n = outer.length;
    c = [outer.reduce((t, p) => t + p[0], 0) / n, outer.reduce((t, p) => t + p[1], 0) / n];
  } else c = [cx / (3 * a), cy / (3 * a)];
  const inside = (p: Position) => pointInRing(p, outer) && !rings.slice(1).some((h) => pointInRing(p, h));
  if (inside(c)) return c;
  // Scan along the centroid's latitude (nudged off any vertex) for the widest stretch inside the part.
  const y = c[1] + 1e-7;
  const xs: number[] = [];
  for (const ring of rings)
    for (let i = 0, n = ring.length; i < n; i++) {
      const [x0, y0] = ring[i];
      const [x1, y1] = ring[(i + 1) % n];
      if (y0 > y !== y1 > y) xs.push(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
    }
  xs.sort((p, q) => p - q);
  let best: Position | null = null;
  let width = 0;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    const w = xs[i + 1] - xs[i];
    const m: Position = [(xs[i] + xs[i + 1]) / 2, y];
    if (w > width && inside(m)) {
      width = w;
      best = m;
    }
  }
  return best ?? outer[0];
}

/**
 * A label point for each polygon of `g` (see partAnchor), in map-image lon/lat. Rings are unwrapped
 * first, with holes moved next to their outer ring, so parts across ±180° work; the longitude may
 * leave ±180 by up to one turn.
 */
export function partAnchors(g: RegionGeometry): (Position | null)[] {
  return polygonsOf(g).map((poly) => {
    const rings = poly.map((r) => openRing(unwrapRing(r)));
    const lon0 = rings[0]?.[0]?.[0] ?? 0;
    return partAnchor(rings.map((r, i) => {
      if (i === 0 || !r.length) return r;
      const k = Math.round((lon0 - r[0][0]) / 360) * 360;
      return k ? r.map(([x, y]) => [x + k, y] as Position) : r;
    }));
  });
}
