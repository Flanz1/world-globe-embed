/**
 * Combining parts and extending a part with a drawn shape: polygon unions that also close small gaps
 * between the shapes. No DOM here, so it is unit-tested directly.
 *
 * Gap filling is a morphological closing (grow by d, shrink by d) done only where two shapes come
 * within 2·d of each other, and only the new land that touches both sides is kept. So the parts'
 * own outlines and vertices stay as they were everywhere else; only the gap between them is filled.
 *
 * Distances are in "map units": degrees of longitude, with latitude scaled by ky (2 / aspect) like
 * the map's pixels, so a gap reads the same across and up the map.
 */
import * as clip from "polygon-clipping";
import { checkGeometry, openRing, signedArea, toStoredGeometry, type Position, type Ring } from "../../shared/geo.ts";
import { OWN_COLOUR } from "../../shared/region.ts";
import { cloneState, type EditorState, type Parts } from "./model.ts";

type Seg = [Position, Position];

/** Part p's centre longitude (of its outer ring's extent). */
function midLon(rings: Ring[]): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const [x] of rings[0] ?? []) {
    lo = Math.min(lo, x);
    hi = Math.max(hi, x);
  }
  return (lo + hi) / 2;
}

/** Rounds to a fine grid: polygon-clipping copes far better with fewer near-coincident points. */
const GRID = 1e7;
const snap = (v: number) => Math.round(v * GRID) / GRID;

/** Closed ring for polygon-clipping, shifted by k degrees of longitude and with latitude scaled by ky. */
const toClip = (r: Ring, k: number, ky: number): clip.Ring => {
  const out = r.map(([x, y]) => [snap(x + k), snap(y * ky)] as clip.Pair);
  if (out.length) out.push([out[0][0], out[0][1]]);
  return out;
};
const fromClip = (r: clip.Ring, ky: number): Ring => openRing(r.map(([x, y]) => [x, y / ky] as Position));

function segsOf(polys: clip.Polygon[]): Seg[] {
  const out: Seg[] = [];
  for (const poly of polys)
    for (const ring of poly)
      for (let i = 1; i < ring.length; i++) {
        const a = ring[i - 1];
        const b = ring[i];
        if (a[0] !== b[0] || a[1] !== b[1]) out.push([a as Position, b as Position]);
      }
  return out;
}

function pointSeg(p: Position, a: Position, b: Position): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
const cross = (o: Position, a: Position, b: Position) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
function segSeg(s: Seg, t: Seg): number {
  const d1 = cross(s[0], s[1], t[0]);
  const d2 = cross(s[0], s[1], t[1]);
  const d3 = cross(t[0], t[1], s[0]);
  const d4 = cross(t[0], t[1], s[1]);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(pointSeg(s[0], t[0], t[1]), pointSeg(s[1], t[0], t[1]), pointSeg(t[0], s[0], s[1]), pointSeg(t[1], s[0], s[1]));
}
interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const segBox = ([a, b]: Seg, pad = 0): Box => ({ x0: Math.min(a[0], b[0]) - pad, y0: Math.min(a[1], b[1]) - pad, x1: Math.max(a[0], b[0]) + pad, y1: Math.max(a[1], b[1]) + pad });
const overlap = (a: Box, b: Box) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;

/** Convex hull (monotone chain), closed, or null when it has no area. */
function hull(pts: Position[]): clip.Ring | null {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const half = (list: Position[]) => {
    const out: Position[] = [];
    for (const q of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], q) <= 0) out.pop();
      out.push(q);
    }
    out.pop();
    return out;
  };
  const h = [...half(p), ...half([...p].reverse())];
  if (h.length < 3 || Math.abs(signedArea(h)) < 1e-12) return null;
  return [...h, h[0]].map(([x, y]) => [snap(x), snap(y)] as clip.Pair);
}

/** Nearest point to p on any of the segments, with its distance. */
function nearestOn(p: Position, segs: Seg[]): { d: number; at: Position } {
  let d = Infinity;
  let at: Position = p;
  for (const [a, b] of segs) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
    const q: Position = [a[0] + t * dx, a[1] + t * dy];
    const e = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (e < d) {
      d = e;
      at = q;
    }
  }
  return { d, at };
}

/** Uniform grid over segment boxes: which boxes overlap a query box, without testing them all. */
function boxIndex(boxes: Box[], cell: number): (q: Box) => number[] {
  let x0 = Infinity;
  let y0 = Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x0);
    y0 = Math.min(y0, b.y0);
  }
  const cx = (x: number) => Math.floor((x - x0) / cell);
  const cy = (y: number) => Math.floor((y - y0) / cell);
  const key = (i: number, j: number) => i * 1048576 + j;
  const cells = new Map<number, number[]>();
  boxes.forEach((b, n) => {
    for (let i = cx(b.x0); i <= cx(b.x1); i++)
      for (let j = cy(b.y0); j <= cy(b.y1); j++) {
        const list = cells.get(key(i, j));
        if (list) list.push(n);
        else cells.set(key(i, j), [n]);
      }
  });
  const seen = new Uint32Array(boxes.length);
  let stamp = 0;
  return (q) => {
    stamp++;
    const out: number[] = [];
    for (let i = Math.max(0, cx(q.x0)); i <= cx(q.x1); i++)
      for (let j = Math.max(0, cy(q.y0)); j <= cy(q.y1); j++)
        for (const n of cells.get(key(i, j)) ?? []) {
          if (seen[n] === stamp) continue;
          seen[n] = stamp;
          if (overlap(q, boxes[n])) out.push(n);
        }
    return out;
  };
}

/**
 * Bridges across every narrow gap: for each segment of one group that comes within `gap` of another
 * group, the hull of the stretch of it that is that close and the nearest points across the gap.
 * Both sides make bridges, so a gap whose two sides have different vertices is still covered.
 */
function bridges(groups: Seg[][], gap: number): clip.Polygon[] {
  const boxes = groups.map((g) => g.map((s) => segBox(s)));
  // Cells a few gaps wide, but not so small that a big map would need millions of them.
  let extent = 1;
  for (const g of boxes) for (const b of g) extent = Math.max(extent, b.x1, b.y1, -b.x0, -b.y0);
  const cell = Math.max(gap * 4, extent / 1000);
  const indexes = boxes.map((b) => boxIndex(b, cell));
  const out: clip.Polygon[] = [];
  const pt = (s: Seg, u: number): Position => [s[0][0] + (s[1][0] - s[0][0]) * u, s[0][1] + (s[1][1] - s[0][1]) * u];
  for (let i = 0; i < groups.length; i++)
    for (let j = 0; j < groups.length; j++) {
      if (i === j) continue;
      for (const s of groups[i]) {
        const bs = segBox(s, gap);
        const near = indexes[j](bs).map((ti) => groups[j][ti]).filter((t) => segSeg(s, t) <= gap);
        if (!near.length) continue;
        // Sample along s (at least every gap/4) for the stretch within `gap`, then refine its ends.
        const len = Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]);
        const n = Math.min(64, Math.max(1, Math.ceil(len / (gap / 4))));
        const ok = (u: number) => nearestOn(pt(s, u), near).d <= gap;
        let first = -1;
        let last = -1;
        for (let k = 0; k <= n; k++)
          if (ok(k / n)) {
            if (first < 0) first = k;
            last = k;
          }
        if (first < 0) continue;
        const refine = (inU: number, outU: number) => {
          for (let r = 0; r < 20; r++) {
            const m = (inU + outU) / 2;
            if (ok(m)) inU = m;
            else outU = m;
          }
          return inU;
        };
        const u0 = first > 0 ? refine(first / n, (first - 1) / n) : 0;
        const u1 = last < n ? refine(last / n, (last + 1) / n) : 1;
        const a = pt(s, u0);
        const b = pt(s, u1);
        const ring = hull([a, b, nearestOn(a, near).at, nearestOn(b, near).at, nearestOn(pt(s, (u0 + u1) / 2), near).at]);
        if (ring) out.push([ring]);
      }
    }
  return out;
}

/** Union of many polygons, pairwise in a balanced tree (much quicker than one at a time). */
function unionAll(base: clip.MultiPolygon, more: clip.Polygon[]): clip.MultiPolygon {
  let level: clip.Geom[] = more;
  while (level.length > 1) {
    const next: clip.Geom[] = [];
    for (let i = 0; i < level.length; i += 8) next.push(level.length - i > 1 ? clip.union(level[i], ...level.slice(i + 1, i + 8)) : level[i]);
    level = next;
  }
  return level.length ? clip.union(base, level[0]) : base;
}

const multiArea = (m: clip.MultiPolygon) => m.reduce((a, poly) => a + poly.reduce((b, r, i) => b + (i ? -1 : 1) * Math.abs(signedArea(r as Position[])), 0), 0);

/**
 * Union of the groups (each a list of polygons, in clip coordinates), filling gaps up to `gap` wide
 * between different groups. `filled` is 1 when any gap was filled.
 */
export function unionFilled(groups: clip.Polygon[][], gap: number): { polys: clip.MultiPolygon; filled: number } {
  const all = groups.flat();
  const A = all.length > 1 ? clip.union(all[0], ...all.slice(1)) : all.length ? [all[0]] : [];
  if (gap <= 0 || groups.length < 2) return { polys: A, filled: 0 };
  const extra = bridges(groups.map(segsOf), gap);
  if (!extra.length) return { polys: A, filled: 0 };
  const polys = unionAll(A, extra);
  return { polys, filled: multiArea(polys) - multiArea(A) > 1e-9 ? 1 : 0 };
}

/** Merged polygons back in editor rings (open, unwrapped), largest first. */
function toParts(polys: clip.MultiPolygon, ky: number): Parts {
  return polys
    .map((poly) => poly.map((r) => fromClip(r, ky)).filter((r) => r.length >= 3))
    .filter((poly) => poly.length && Math.abs(signedArea(poly[0])) > 1e-9)
    .sort((a, b) => Math.abs(signedArea(b[0])) - Math.abs(signedArea(a[0])));
}

export interface MergeResult {
  state: EditorState;
  /** Old part index → new index (parts merged away map to the part they went into). */
  index: number[];
  /** New index of the merged part. */
  into: number;
  /** How many gaps were filled. */
  filled: number;
  /** Why the merged part wouldn't save (e.g. a hole touching the edge), or null. */
  problem: string | null;
}

const partName = (p: number, labels: readonly string[]) => `part ${p + 1}${labels[p]?.trim() ? ` (${labels[p].trim()})` : ""}`;

/**
 * Whether parts `ps` can be combined, and what the result is: all normal parts → a normal part; all
 * zones of one part → a zone of that part; a part with (some of) its own zones → the normal part
 * (the zones are absorbed). Returns the merged part's parent (-1 for normal), or why not.
 */
export function combineKind(contested: readonly number[], ps: readonly number[]): number | string {
  const parents = ps.map((p) => contested[p] ?? -1);
  if (parents.every((k) => k < 0)) return -1;
  const zoneParents = new Set(parents.filter((k) => k >= 0));
  if (zoneParents.size === 1) {
    const k = [...zoneParents][0];
    const normals = ps.filter((p) => (contested[p] ?? -1) < 0);
    if (!normals.length) return k;
    if (normals.length === 1 && normals[0] === k) return -1;
  }
  return "Only parts of the same kind can be combined: normal parts together, contested zones of the same part together, or a part with its own contested zones.";
}

/**
 * Combines parts `ps` (2 or more) into one, filling gaps narrower than `gap` map units between them.
 * The first part in `ps` keeps its place, colour and label (or the first label among the others); the
 * result is locked if any of them was. Zones of a merged-away part move to the combined part.
 * Returns the reason when it can't (not the same kind, or still apart after filling gaps).
 */
export function combineParts(s: EditorState, ps: readonly number[], gap: number, ky: number): MergeResult | string {
  const list = [...new Set(ps)].filter((p) => s.parts[p]?.[0]?.length >= 3);
  if (list.length < 2) return "Pick at least two parts to combine.";
  const kind = combineKind(s.contested, list);
  if (typeof kind === "string") return kind;
  const into = list[0];
  const mid = midLon(s.parts[into]);
  const groups = list.map((p) => {
    const k = Math.round((mid - midLon(s.parts[p])) / 360) * 360;
    return [s.parts[p].filter((r) => r.length >= 3).map((r) => toClip(r, k, ky))];
  });
  const { polys, filled } = unionFilled(groups, gap);
  const merged = toParts(polys, ky);
  if (merged.length !== 1)
    return merged.length > 1
      ? `Those parts don't touch (${merged.length} separate pieces after filling gaps). Move them closer, or raise "Fill gaps up to".`
      : "Nothing left to combine.";
  return assemble(s, list, merged[0], kind, filled);
}

/**
 * Extends part p with a drawn outline (open ring, any copy of the map) that touches or overlaps it, or
 * comes within `gap` map units of it (the gap is filled). Holes the shape covers are filled.
 */
export function extendPart(s: EditorState, p: number, ring: Ring, gap: number, ky: number): MergeResult | string {
  const rings = s.parts[p];
  if (!rings?.[0] || rings[0].length < 3) return "Pick a part to extend.";
  if (ring.length < 3) return "An outline needs at least 3 points.";
  const mid = midLon(rings);
  const k = Math.round((mid - midLon([ring])) / 360) * 360;
  const groups = [[rings.filter((r) => r.length >= 3).map((r) => toClip(r, 0, ky))], [[toClip(ring, k, ky)]]];
  const { polys, filled } = unionFilled(groups, gap);
  const merged = toParts(polys, ky);
  if (merged.length !== 1) return `The shape has to touch or overlap ${partName(p, s.labels)}. Draw it from inside the part, or closer to its edge.`;
  return assemble(s, [p], merged[0], s.contested[p] ?? -1, filled);
}

/** Puts the merged rings in place of list[0], drops the rest of `list`, and remaps everything per part. */
function assemble(s: EditorState, list: number[], rings: Ring[], parent: number, filled: number): MergeResult {
  const into = list[0];
  const gone = new Set(list.slice(1));
  const kept = s.parts.map((_, q) => q).filter((q) => !gone.has(q));
  const at = new Map(kept.map((old, i) => [old, i]));
  const index = s.parts.map((_, q) => at.get(gone.has(q) ? into : q) ?? -1);
  const label = [into, ...list.slice(1)].map((q) => s.labels[q]?.trim() ?? "").find(Boolean) ?? "";
  const next = cloneState(s);
  next.parts = kept.map((q) => (q === into ? rings : s.parts[q].map((r) => r.map(([x, y]) => [x, y] as Position))));
  next.styles = kept.map((q) => s.styles[q] ?? OWN_COLOUR);
  next.labels = kept.map((q) => (q === into ? label : (s.labels[q] ?? "")));
  // The merged part's label shows unless every part that fed it had its label switched off.
  next.labelHidden = kept.map((q) => (q === into ? list.every((r) => s.labelHidden?.[r] === true || !s.labels[r]?.trim()) && list.some((r) => s.labelHidden?.[r] === true) : s.labelHidden?.[q] === true));
  next.locked = kept.map((q) => (q === into ? list.some((r) => s.locked[r] !== false) : s.locked[q] !== false));
  // Editing several regions together: the combined part stays with the region of the part that keeps its place.
  if (s.owners) next.owners = kept.map((q) => s.owners![q] ?? "");
  next.contested = kept.map((q) => {
    if (q === into) return parent < 0 ? -1 : (index[parent] ?? -1);
    const k = s.contested[q] ?? -1;
    return k < 0 ? -1 : (index[k] ?? -1);
  });
  const n = index[into];
  const bad = checkGeometry(toStoredGeometry([next.parts[n]]));
  const problem = bad.length ? "the result would have a hole touching its edge. Fill or move that gap first." : null;
  return { state: next, index, into: n, filled, problem };
}
