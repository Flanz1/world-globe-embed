/**
 * Where and how a region label sits: at the visual middle of a part (the point farthest from its edges,
 * slid to the middle of the long stretch for narrow parts), with the size of the part and, for narrow
 * ones, the direction of its long axis. Works in the map image's own frame (flat lon/lat); the viewers
 * project the axis, so the same numbers serve the flat map and the globe.
 */
import { openRing, polygonsOf, unwrapRing, type Position, type RegionGeometry, type Ring } from "./geo.ts";

export interface LabelPlacement {
  /** Label point, inside the part. Longitude may leave ±180 by up to one turn (an unwrapped part). */
  at: Position;
  /** Direction of the text in the map frame, radians counter-clockwise from east, in (-π/2, π/2]. 0 unless `tilted`. */
  angle: number;
  /** Room along the text direction and across it, in degrees of the map image. */
  length: number;
  width: number;
  /** True when the part is narrow enough for the text to follow its long axis. */
  tilted: boolean;
}

/** A part is "narrow" (label follows its axis) when its length is at least this many times its width. */
export const NARROW_RATIO = 2.2;
/** Axes within this many degrees of horizontal stay level: a slightly tilted label just looks crooked. */
const SNAP_DEG = 12;
/** Vertices kept per ring for placement (a stride sample): enough for the gist, cheap to measure. */
const MAX_PLACE_VERTICES = 500;

const thin = (r: Ring): Ring => {
  if (r.length <= MAX_PLACE_VERTICES) return r;
  const k = Math.ceil(r.length / MAX_PLACE_VERTICES);
  return r.filter((_, i) => i % k === 0);
};

/** Signed distance from p to the rings' outline: positive inside (outer ring, outside holes), negative outside. */
function signedDist(rings: Ring[], x: number, y: number): number {
  let inside = false;
  let best = Infinity;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, ay] = ring[i];
      const [bx, by] = ring[j];
      if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
      let px = ax;
      let py = ay;
      let dx = bx - px;
      let dy = by - py;
      if (dx || dy) {
        const t = ((x - px) * dx + (y - py) * dy) / (dx * dx + dy * dy);
        if (t > 1) {
          px = bx;
          py = by;
        } else if (t > 0) {
          px += dx * t;
          py += dy * t;
        }
      }
      dx = x - px;
      dy = y - py;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
  }
  return (inside ? 1 : -1) * Math.sqrt(best);
}

/** Area, centroid and covariance of a polygon with holes (planar). Null for no area. */
function moments(rings: Ring[]): { area: number; mx: number; my: number; sxx: number; syy: number; sxy: number } | null {
  const ox = rings[0][0][0];
  const oy = rings[0][0][1];
  let A = 0;
  let Sx = 0;
  let Sy = 0;
  let Sxx = 0;
  let Syy = 0;
  let Sxy = 0;
  rings.forEach((ring, k) => {
    let a = 0;
    let cx = 0;
    let cy = 0;
    let ixx = 0;
    let iyy = 0;
    let ixy = 0;
    for (let i = 0, n = ring.length; i < n; i++) {
      const x0 = ring[i][0] - ox;
      const y0 = ring[i][1] - oy;
      const x1 = ring[(i + 1) % n][0] - ox;
      const y1 = ring[(i + 1) % n][1] - oy;
      const c = x0 * y1 - x1 * y0;
      a += c;
      cx += (x0 + x1) * c;
      cy += (y0 + y1) * c;
      ixx += (x0 * x0 + x0 * x1 + x1 * x1) * c;
      iyy += (y0 * y0 + y0 * y1 + y1 * y1) * c;
      ixy += (x0 * y1 + 2 * x0 * y0 + 2 * x1 * y1 + x1 * y0) * c;
    }
    // Integrals over the ring's own area; flip to positive, then outer adds and holes subtract.
    const s = (a < 0 ? -1 : 1) * (k === 0 ? 1 : -1);
    A += (s * a) / 2;
    Sx += (s * cx) / 6;
    Sy += (s * cy) / 6;
    Sxx += (s * ixx) / 12;
    Syy += (s * iyy) / 12;
    Sxy += (s * ixy) / 24;
  });
  if (!(A > 1e-12)) return null;
  const mx = Sx / A;
  const my = Sy / A;
  return { area: A, mx: mx + ox, my: my + oy, sxx: Sxx / A - mx * mx, syy: Syy / A - my * my, sxy: Sxy / A - mx * my };
}

/** The point farthest inside the rings (polylabel: best-first search over squares). */
function pole(rings: Ring[], bbox: [number, number, number, number], precision: number): { x: number; y: number; d: number } {
  const [x0, y0, x1, y1] = bbox;
  const w = x1 - x0;
  const h = y1 - y0;
  const size = Math.min(w, h) || Math.max(w, h) || 1;
  type Cell = { x: number; y: number; h: number; d: number; max: number };
  const cell = (x: number, y: number, hh: number): Cell => {
    const d = signedDist(rings, x, y);
    return { x, y, h: hh, d, max: d + hh * Math.SQRT2 };
  };
  const queue: Cell[] = [];
  for (let x = x0; x < x1; x += size) for (let y = y0; y < y1; y += size) queue.push(cell(x + size / 2, y + size / 2, size / 2));
  let best = cell(x0 + w / 2, y0 + h / 2, 0);
  for (let n = 0; queue.length && n < 4000; n++) {
    let bi = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i].max > queue[bi].max) bi = i;
    const c = queue[bi];
    queue[bi] = queue[queue.length - 1];
    queue.pop();
    if (c.d > best.d) best = c;
    if (c.max - best.d <= precision) continue;
    const q = c.h / 2;
    queue.push(cell(c.x - q, c.y - q, q), cell(c.x + q, c.y - q, q), cell(c.x - q, c.y + q, q), cell(c.x + q, c.y + q, q));
  }
  return { x: best.x, y: best.y, d: best.d };
}

/** Placement for one part (outer ring first, holes after), in planar unwrapped coordinates. Null for a part with no area. */
export function placePart(rings: Ring[]): LabelPlacement | null {
  const rs = rings.map(thin).filter((r) => r.length >= 3);
  if (!rs.length) return null;
  const m = moments(rs);
  if (!m) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of rs[0]) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const p = pole(rs, [x0, y0, x1, y1], Math.max(1e-9, Math.sqrt(m.area) * 0.004));
  if (!(p.d > 0)) return null;

  // Principal axis of the part's area.
  const half = (m.sxx - m.syy) / 2;
  const root = Math.hypot(half, m.sxy);
  const l1 = (m.sxx + m.syy) / 2 + root;
  const l2 = Math.max((m.sxx + m.syy) / 2 - root, 1e-12);
  const long = Math.sqrt(12 * l1);
  const short = Math.sqrt(12 * l2);
  let angle = 0.5 * Math.atan2(m.sxy, half);
  if (angle <= -Math.PI / 2) angle += Math.PI;
  const tilted = long / short >= NARROW_RATIO && Math.abs(angle) > (SNAP_DEG * Math.PI) / 180;

  let at: Position = [p.x, p.y];
  if (long / short >= NARROW_RATIO) {
    // Slide along the long axis to the middle of the stretch that is still nearly as deep as the pole.
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    const floor = p.d * 0.6;
    const step = long / 80;
    const reach = (dir: number): number => {
      let t = 0;
      while (t < long && signedDist(rs, p.x + ux * (t + step) * dir, p.y + uy * (t + step) * dir) >= floor) t += step;
      return t;
    };
    const shift = (reach(1) - reach(-1)) / 2;
    const q: Position = [p.x + ux * shift, p.y + uy * shift];
    if (signedDist(rs, q[0], q[1]) >= floor) at = q;
  }
  return tilted
    ? { at, angle, length: long, width: short, tilted }
    : { at, angle: 0, length: Math.sqrt(12 * Math.max(m.sxx, 1e-12)), width: Math.sqrt(12 * Math.max(m.syy, 1e-12)), tilted };
}

const unwrapPart = (poly: Ring[]): Ring[] => {
  const rings = poly.map((r) => openRing(unwrapRing(r)));
  const lon0 = rings[0]?.[0]?.[0] ?? 0;
  // Holes move next to their outer ring, so parts across ±180° stay one piece.
  return rings.map((r, i) => {
    if (i === 0 || !r.length) return r;
    const k = Math.round((lon0 - r[0][0]) / 360) * 360;
    return k ? r.map(([x, y]) => [x + k, y] as Position) : r;
  });
};

const cache = new WeakMap<RegionGeometry, (LabelPlacement | null)[]>();

/** Placement of every part of `g`, in order (null for a part with no area). Remembered per geometry object. */
export function partPlacements(g: RegionGeometry): (LabelPlacement | null)[] {
  let out = cache.get(g);
  if (!out) {
    out = polygonsOf(g).map((poly) => placePart(unwrapPart(poly)));
    cache.set(g, out);
  }
  return out;
}

/** Index of the part with the most area (planar, in the image frame), or -1 for no parts. */
export function largestPart(g: RegionGeometry): number {
  let best = -1;
  let bestArea = -1;
  polygonsOf(g).forEach((poly, i) => {
    const rs = unwrapPart(poly).map(thin).filter((r) => r.length >= 3);
    const m = rs.length ? moments(rs) : null;
    if (m && m.area > bestArea) {
      best = i;
      bestArea = m.area;
    }
  });
  return best;
}
