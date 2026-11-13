/**
 * The region editor's data model: pure functions on an immutable-ish state, plus an undo/redo
 * command stack. No DOM here, so it is unit-tested directly.
 *
 * Shape coordinates are [lon, lat] in the map image's frame. In the editor every ring is *open*
 * (no repeated closing position) and *unwrapped* (longitudes continuous along the ring, so a ring
 * across the antimeridian may run from 170 to 190). toStoredGeometry() wraps and closes them on save.
 */
import * as clip from "polygon-clipping";
import {
  MAX_VERTICES,
  chaikin,
  checkGeometry,
  findSelfIntersection,
  lonSpan,
  openRing,
  pointInRing,
  polygonsOf,
  segmentsIntersect,
  signedArea,
  simplifyRing,
  toStoredGeometry,
  unwrapRing,
  type Position,
  type RegionGeometry,
  type Ring,
} from "../../shared/geo.ts";
import {
  DEFAULT_FILL_OPACITY,
  LEGEND_LABEL_MAX,
  LEGEND_MAX,
  LEGEND_TITLE_MAX,
  OWN_COLOUR,
  REGION_COLOR,
  migrateZoneColours,
  normalizePartLabelHidden,
  normalizePartLabels,
  normalizePartLegend,
  normalizePartLocked,
  type LegendEntry,
  type RegionFeature,
} from "../../shared/region.ts";
export { partAnchor } from "../../shared/geo.ts";

/** parts[p][0] is part p's outer ring, parts[p][1..] its holes. */
export type Parts = Ring[][];

/**
 * A colour folder in the editor. When several regions are edited together (live.ts), each entry
 * remembers where it came from: `src` is the region's id, and either `srcIdx` (its legend index there)
 * or `own` (that region's own colour). These tags never reach a saved file.
 */
export interface EditorLegendEntry extends LegendEntry {
  src?: string;
  srcIdx?: number;
  own?: boolean;
}

export interface RegionProps {
  color: string;
  /** Legend label of the region's own colour ("" until it's given one: then it isn't in the legend). */
  colorLabel: string;
  fillOpacity: number;
  label: boolean;
  description: string;
  legendTitle: string;
  legend: EditorLegendEntry[];
  /** Draw national borders where parts share a line (off unless asked). */
  nationalBorders?: boolean;
}

export interface EditorState {
  parts: Parts;
  /** Per part: index into props.legend, or -1 (OWN_COLOUR) for the region's own colour. */
  styles: number[];
  /** Per part: the label the embed shows on it ("" for none). */
  labels: string[];
  /**
   * Per part: always -1 now. Contested zones were replaced by layers (part order); older regions'
   * zones load as plain parts. Kept so the part-reshaping helpers keep one shape.
   */
  contested: number[];
  /** Per part: true when its label is switched off in the embed (the text is kept). Missing entries: shown. */
  labelHidden: boolean[];
  /** Per part: true when it's locked (can't be moved as a whole; its vertices still edit). */
  locked: boolean[];
  /** Province borders: open lines drawn inside the region (unwrapped, like the rings). Not tied to any part. */
  lines?: Position[][];
  /**
   * Per part, only when several regions are edited together (live.ts): the id of the region the part
   * belongs to (and is saved back to). Every helper that removes or reorders parts carries it along.
   */
  owners?: string[];
  props: RegionProps;
}

/** A vertex: part, ring (0 = outer) and index in the open ring. */
export interface VRef {
  p: number;
  r: number;
  i: number;
}

export const vkey = (v: VRef): string => `${v.p}:${v.r}:${v.i}`;

export const cloneParts = (parts: Parts): Parts => parts.map((rings) => rings.map((ring) => ring.map(([x, y]) => [x, y] as Position)));
export const cloneState = (s: EditorState): EditorState => ({
  parts: cloneParts(s.parts),
  styles: [...s.styles],
  labels: [...s.labels],
  labelHidden: [...(s.labelHidden ?? [])],
  contested: [...(s.contested ?? [])],
  locked: [...(s.locked ?? [])],
  ...(s.owners ? { owners: [...s.owners] } : {}),
  lines: (s.lines ?? []).map((l) => l.map(([x, y]) => [x, y] as Position)),
  props: { ...s.props, legend: s.props.legend.map((e) => ({ ...e })) },
});

const expandHex = (c: string) => (/^#[0-9a-f]{3}$/i.test(c) ? `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}` : c).toLowerCase();

/** Editor state for a saved region (or the empty state for a new one). */
export function stateOf(f: RegionFeature | undefined, fallbackColour = "#c0392b"): EditorState {
  const fp = f?.properties;
  const legend = (fp?.legend ?? [])
    .slice(0, LEGEND_MAX)
    .map((e) => ({ label: String(e.label ?? "").slice(0, LEGEND_LABEL_MAX), color: REGION_COLOR.test(e.color) ? expandHex(e.color) : "#7f8c8d" }));
  const parts = f ? partsFromGeometry(f.geometry) : [];
  // Older regions have one name instead of part labels: it becomes the first part's label.
  const legacy = !fp?.partLabels && fp?.name && (fp.label ?? true) ? [fp.name] : undefined;
  return {
    parts,
    // Contested zones (older regions) are plain parts now: a zone without its own colour keeps its parent's.
    styles: migrateZoneColours(normalizePartLegend(fp?.partLegend, parts.length, legend.length), fp?.partContested),
    labels: normalizePartLabels(fp?.partLabels ?? legacy, parts.length),
    labelHidden: normalizePartLabelHidden(fp?.partLabelHidden, parts.length),
    contested: new Array<number>(parts.length).fill(-1),
    locked: normalizePartLocked(fp?.partLocked, parts.length),
    lines: (fp?.provinceBorders ?? []).filter((l) => l.length >= 2).map((l) => unwrapRing(l.map(([x, y]) => [x, y] as Position))),
    props: {
      color: fp && REGION_COLOR.test(fp.color) ? expandHex(fp.color) : fallbackColour,
      colorLabel: String(fp?.colorLabel ?? "").slice(0, LEGEND_LABEL_MAX),
      fillOpacity: fp?.fillOpacity ?? DEFAULT_FILL_OPACITY,
      label: fp?.label ?? true,
      description: fp?.description ?? "",
      legendTitle: (fp?.legendTitle ?? "").slice(0, LEGEND_TITLE_MAX),
      legend,
      nationalBorders: fp?.nationalBorders === true,
    },
  };
}

export function countVertices(parts: Parts): number {
  let n = 0;
  for (const rings of parts) for (const r of rings) n += r.length;
  return n;
}

/** Shifts a ring by whole turns so its first longitude is nearest `lon`. */
function nearCopy(ring: Ring, lon: number): Ring {
  const k = Math.round((lon - ring[0][0]) / 360) * 360;
  return k ? ring.map(([x, y]) => [x + k, y]) : ring;
}

/** Stored geometry → editor parts (open, unwrapped; holes placed in the same copy as their outer ring). */
export function partsFromGeometry(g: RegionGeometry): Parts {
  return polygonsOf(g).map((poly) => {
    const rings = poly.map((r) => openRing(unwrapRing(r)));
    return rings.map((r, i) => (i === 0 || !rings[0].length ? r : nearCopy(r, rings[0][0][0])));
  });
}

export const toGeometry = (parts: Parts): RegionGeometry => toStoredGeometry(parts);

/* ── Validity ── */

export interface RingProblem {
  p: number;
  r: number;
  /** Edges (start index) that cross, for drawing in red. */
  edges: number[];
  message: string;
}

/**
 * Checks the rings that contain `only` vertices (or every ring): no self-intersection, at most 180° of
 * longitude. With `only`, the intersection test is limited to the edges touching those vertices, so
 * it stays fast while dragging.
 */
export function ringProblem(parts: Parts, only?: VRef[]): RingProblem | null {
  const targets = new Map<string, { p: number; r: number; edges: Set<number> }>();
  if (only) {
    for (const v of only) {
      const ring = parts[v.p]?.[v.r];
      if (!ring) continue;
      const key = `${v.p}:${v.r}`;
      const t = targets.get(key) ?? { p: v.p, r: v.r, edges: new Set<number>() };
      const n = ring.length;
      t.edges.add(v.i);
      t.edges.add((v.i - 1 + n) % n);
      targets.set(key, t);
    }
  } else {
    parts.forEach((rings, p) => rings.forEach((_, r) => targets.set(`${p}:${r}`, { p, r, edges: new Set() })));
  }
  for (const t of targets.values()) {
    const ring = parts[t.p][t.r];
    if (ring.length < 3) continue;
    if (lonSpan(ring) > 180) return { p: t.p, r: t.r, edges: [], message: "A ring may span at most 180° of longitude. Split it into two parts." };
    const hit = findSelfIntersection(ring, only ? t.edges : undefined);
    if (hit) return { p: t.p, r: t.r, edges: hit, message: "That would make the outline cross itself." };
  }
  return null;
}

/* ── Edits (each returns new parts) ── */

export function moveVertices(parts: Parts, refs: VRef[], dLon: number, dLat: number): Parts {
  const out = cloneParts(parts);
  for (const v of refs) {
    const pt = out[v.p]?.[v.r]?.[v.i];
    if (!pt) continue;
    pt[0] += dLon;
    pt[1] = Math.max(-90, Math.min(90, pt[1] + dLat));
  }
  return out;
}

export function setVertex(parts: Parts, v: VRef, pos: Position): Parts {
  const out = cloneParts(parts);
  out[v.p][v.r][v.i] = [pos[0], Math.max(-90, Math.min(90, pos[1]))];
  return out;
}

/** Inserts a vertex after index `i` (i.e. on the edge i → i+1). Returns the new parts and the new vertex. */
export function insertVertex(parts: Parts, p: number, r: number, i: number, pos: Position): { parts: Parts; v: VRef } {
  const out = cloneParts(parts);
  out[p][r].splice(i + 1, 0, [pos[0], pos[1]]);
  return { parts: out, v: { p, r, i: i + 1 } };
}

/**
 * Deletes whole parts (outer ring and holes) by index. `kept[i]` is the old index of new part i, so
 * colours, labels and contested zones can follow (see remapContested).
 */
export function deleteParts(parts: Parts, ps: readonly number[]): { parts: Parts; kept: number[] } {
  const drop = new Set(ps);
  const kept = parts.map((_, p) => p).filter((p) => !drop.has(p));
  return { parts: kept.map((p) => parts[p].map((ring) => ring.map(([x, y]) => [x, y] as Position))), kept };
}

/**
 * Deletes vertices. A ring may not drop below 3 vertices: a hole that would is removed, and an outer
 * ring that would takes its whole part with it.
 */
export function deleteVertices(parts: Parts, refs: VRef[]): { parts: Parts; removedParts: number; removedHoles: number; kept: number[] } {
  const byRing = new Map<string, Set<number>>();
  for (const v of refs) {
    const k = `${v.p}:${v.r}`;
    (byRing.get(k) ?? byRing.set(k, new Set()).get(k)!).add(v.i);
  }
  let removedParts = 0;
  let removedHoles = 0;
  const out: Parts = [];
  const keptParts: number[] = [];
  parts.forEach((rings, p) => {
    const kept: Ring[] = [];
    let dropPart = false;
    rings.forEach((ring, r) => {
      const del = byRing.get(`${p}:${r}`);
      const next = del ? ring.filter((_, i) => !del.has(i)) : ring.map(([x, y]) => [x, y] as Position);
      if (next.length >= 3) kept.push(next);
      else if (r === 0) dropPart = true;
      else removedHoles++;
    });
    if (dropPart) removedParts++;
    else {
      out.push(kept);
      keptParts.push(p);
    }
  });
  return { parts: out, removedParts, removedHoles, kept: keptParts };
}

/** Every vertex of one ring (outer ring r = 0, or a hole), as vertex refs. */
export function ringRefs(parts: Parts, p: number, r: number): VRef[] {
  return (parts[p]?.[r] ?? []).map((_, i) => ({ p, r, i }));
}

/** The rings (`{p, r}`) that every one of whose vertices is in `refs`. */
export function fullyChosenRings(parts: Parts, refs: readonly VRef[]): { p: number; r: number }[] {
  const count = new Map<string, number>();
  const seen = new Set<string>();
  for (const v of refs) {
    const key = `${v.p}:${v.r}:${v.i}`;
    if (seen.has(key)) continue;
    seen.add(key);
    count.set(`${v.p}:${v.r}`, (count.get(`${v.p}:${v.r}`) ?? 0) + 1);
  }
  const out: { p: number; r: number }[] = [];
  parts.forEach((rings, p) => rings.forEach((ring, r) => ring.length && count.get(`${p}:${r}`) === ring.length && out.push({ p, r })));
  return out;
}

/** Distance from point (px, py) to the segment (ax, ay)-(bx, by), in the units of the arguments. */
export function pointSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Moves the whole shape (null), one part, or several parts (with their holes). Latitude is limited so
 * nothing that moves leaves ±90.
 */
export function translate(parts: Parts, part: number | readonly number[] | null, dLon: number, dLat: number): Parts {
  const moves = part === null ? null : new Set(typeof part === "number" ? [part] : part);
  const skip = (p: number) => moves !== null && !moves.has(p);
  let lo = Infinity;
  let hi = -Infinity;
  parts.forEach((rings, p) => {
    if (skip(p)) return;
    for (const r of rings)
      for (const [, y] of r) {
        lo = Math.min(lo, y);
        hi = Math.max(hi, y);
      }
  });
  const dy = Math.max(-90 - lo, Math.min(90 - hi, dLat));
  if (!Number.isFinite(lo)) return cloneParts(parts);
  return parts.map((rings, p) => (skip(p) ? rings.map((r) => r.map(([x, y]) => [x, y] as Position)) : rings.map((r) => r.map(([x, y]) => [x + dLon, y + dy] as Position))));
}

export function addPart(parts: Parts, ring: Ring): Parts {
  return [...cloneParts(parts), [ring.map(([x, y]) => [x, y] as Position)]];
}

/** Adds a hole to the part whose outer ring contains the hole's first point. */
export function addHole(parts: Parts, ring: Ring): Parts | null {
  const p = parts.findIndex((rings) => rings[0] && pointInRing(ring[0], rings[0]));
  if (p < 0) return null;
  const out = cloneParts(parts);
  const k = Math.round((out[p][0][0][0] - ring[0][0]) / 360) * 360;
  out[p].push(ring.map(([x, y]) => [x + k, y] as Position));
  return out;
}

/* ── Cutting and splitting ── */

/** Gap a split line leaves between the pieces, in degrees: invisible, but survives 4-decimal rounding. */
export const SPLIT_GAP = 0.001;

export interface CutResult {
  state: EditorState;
  /** Old part index → new index, or -1 for a part the cut removed completely. */
  index: number[];
  /** Parts that changed (old indices). */
  cut: number[];
  /** New parts made by splitting. */
  added: number;
  /** Parts cut away completely. */
  removed: number;
  /** Contested zones that became normal parts because their part was cut away. */
  orphaned: number;
  /** Why the changed parts wouldn't save (e.g. a hole left touching the edge), or null. */
  problem: string | null;
}

const closed = (r: Ring): clip.Ring => {
  const out = r.map(([x, y]) => [x, y] as clip.Pair);
  if (out.length) out.push([out[0][0], out[0][1]]);
  return out;
};
const opened = (r: clip.Ring): Ring => openRing(r.map(([x, y]) => [x, y] as Position));
const shiftRing = (r: Ring, k: number): Ring => (k ? r.map(([x, y]) => [x + k, y] as Position) : r);
function lonRange(rings: Ring[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of rings)
    for (const [x] of r) {
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
  return [lo, hi];
}
/** Area of a polygon (outer minus holes) in plain degree units, for ordering pieces. */
const polyArea = (poly: Ring[]): number => poly.reduce((a, r, i) => a + (i ? -1 : 1) * Math.abs(signedArea(r)), 0);

/**
 * Cuts the shapes `cutters` (open rings, in any copy of the map) out of the parts. A cutter wholly
 * inside a part makes a hole; one across a part's edge bites it; one that goes right across splits it
 * into separate parts. The largest piece keeps the part's place, label and contested zones; the other
 * pieces are added at the end with the same colour and lock (and the same parent, for a contested
 * zone). Cutting reshapes rather than moves, so locked parts are cut like vertex edits reshape them.
 *
 * `onlySplit`: change only the parts that end up in more than one piece (the split-line tool, which
 * mustn't leave hairline slits in parts it only grazes). `only`: limit to these parts.
 */
export function cutParts(s: EditorState, cutters: Ring[], opts: { onlySplit?: boolean; only?: readonly number[] } = {}): CutResult {
  const pieces: (Ring[][] | null)[] = s.parts.map((rings, p) => {
    if (!rings[0] || rings[0].length < 3 || (opts.only && !opts.only.includes(p))) return null;
    const [lo, hi] = lonRange([rings[0]]);
    const mid = (lo + hi) / 2;
    // Every cutter moves by the same whole turns, into the copy of the map nearest the part.
    const use = cutters.filter((c) => c.length >= 3);
    if (!use.length) return null;
    const [clo, chi] = lonRange(use);
    const k = Math.round((mid - (clo + chi) / 2) / 360) * 360;
    const cut: clip.Polygon[] = use.map((c) => [closed(shiftRing(c, k))]);
    const subject: clip.Polygon = rings.filter((r) => r.length >= 3).map(closed);
    if (!clip.intersection(subject, cut).length) return null;
    const out = clip
      .difference(subject, cut)
      .map((poly) => poly.map(opened).filter((r) => r.length >= 3))
      .filter((poly) => poly.length && Math.abs(signedArea(poly[0])) > 1e-9);
    if (opts.onlySplit && out.length < 2) return null;
    return out.sort((a, b) => polyArea(b) - polyArea(a));
  });

  const parts: Parts = [];
  const styles: number[] = [];
  const labels: string[] = [];
  const labelHidden: boolean[] = [];
  const locked: boolean[] = [];
  const owners: string[] = [];
  const parentOld: number[] = [];
  const index = s.parts.map(() => -1);
  const extra: { rings: Ring[]; style: number; parent: number; lock: boolean; hide: boolean; owner: string }[] = [];
  const cut: number[] = [];
  let removed = 0;
  s.parts.forEach((rings, p) => {
    const pc = pieces[p];
    const style = s.styles[p] ?? OWN_COLOUR;
    const parent = s.contested[p] ?? -1;
    const lock = s.locked?.[p] !== false;
    const hide = s.labelHidden?.[p] === true;
    const owner = s.owners?.[p] ?? "";
    if (pc) cut.push(p);
    if (pc && !pc.length) return void removed++;
    index[p] = parts.length;
    parts.push(pc ? pc[0] : rings.map((r) => r.map(([x, y]) => [x, y] as Position)));
    styles.push(style);
    labels.push(s.labels[p] ?? "");
    labelHidden.push(hide);
    locked.push(lock);
    owners.push(owner);
    parentOld.push(parent);
    for (const more of pc?.slice(1) ?? []) extra.push({ rings: more, style, parent, lock, hide, owner });
  });
  for (const e of extra) {
    parts.push(e.rings);
    styles.push(e.style);
    labels.push("");
    labelHidden.push(e.hide);
    locked.push(e.lock);
    owners.push(e.owner);
    parentOld.push(e.parent);
  }
  let orphaned = 0;
  const contested = parentOld.map((k) => {
    if (k < 0) return -1;
    if (index[k] >= 0) return index[k];
    orphaned++;
    return -1;
  });
  const next = cloneState(s);
  next.parts = parts;
  next.styles = styles;
  next.labels = labels;
  next.labelHidden = labelHidden;
  next.contested = contested;
  next.locked = locked;
  if (s.owners) next.owners = owners;
  // Check the changed parts as they'd be stored (rounded): a cut can leave a hole touching the edge.
  const changedNew = [...cut.map((p) => index[p]).filter((i) => i >= 0), ...extra.map((_, i) => parts.length - extra.length + i)];
  const bad = changedNew.length ? checkGeometry(toStoredGeometry(changedNew.map((i) => parts[i]))) : [];
  const problem = bad.length ? "it would leave a hole touching the part's edge. Draw the cut a little further in, or further across." : null;
  return { state: next, index, cut, added: extra.length, removed, orphaned, problem };
}

/**
 * A thin strip along an open line (`gap` wide, in degrees of longitude; latitude scaled by ky like
 * the map's pixels): one capped rectangle per segment, so cutting with them splits what the line
 * crosses. Consecutive points are unwrapped first.
 */
export function lineStrips(line: Position[], gap = SPLIT_GAP, ky = 1): Ring[] {
  const pts = unwrapRing(line.map(([x, y]) => [x, y] as Position));
  const half = gap / 2;
  const out: Ring[] = [];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = [pts[i - 1][0], pts[i - 1][1] * ky];
    const [bx, by] = [pts[i][0], pts[i][1] * ky];
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 1e-9) continue;
    const ux = ((bx - ax) / len) * half;
    const uy = ((by - ay) / len) * half;
    // Caps of half the width at both ends, so neighbouring strips overlap at the joints.
    const corners: Position[] = [
      [ax - ux + uy, ay - uy - ux],
      [bx + ux + uy, by + uy - ux],
      [bx + ux - uy, by + uy + ux],
      [ax - ux - uy, ay - uy + ux],
    ];
    out.push(corners.map(([x, y]) => [x, y / ky] as Position));
  }
  return out;
}

/** Splits the parts a line crosses from edge to edge. Parts the line only enters aren't changed. */
export function splitParts(s: EditorState, line: Position[], gap = SPLIT_GAP, ky = 1): CutResult {
  return cutParts(s, lineStrips(line, gap, ky), { onlySplit: true });
}

/** Index of the part under a point (inside its outer ring and not in a hole), or -1. The topmost wins (see partsAt). */
export function partAt(parts: Parts, pos: Position, contested: readonly number[] = []): number {
  return partsAt(parts, pos, contested)[0] ?? -1;
}

/**
 * Every part under a point, topmost first: the order they're drawn in reversed, so contested zones
 * (drawn on top) come before normal parts, and later parts before earlier ones.
 */
export function partsAt(parts: Parts, pos: Position, contested: readonly number[] = []): number[] {
  const out: number[] = [];
  for (let p = parts.length - 1; p >= 0; p--) {
    const rings = parts[p];
    if (!rings[0] || !pointInRing(pos, rings[0])) continue;
    if (rings.slice(1).some((h) => pointInRing(pos, h))) continue;
    out.push(p);
  }
  const zone = (p: number) => ((contested[p] ?? -1) >= 0 ? 0 : 1);
  return out.sort((a, b) => zone(a) - zone(b) || b - a);
}

/* ── Locked parts ── */

/** Sets part p's lock. Parts are locked unless an entry says otherwise. */
export function setLocked(s: EditorState, p: number, on: boolean): EditorState {
  const next = cloneState(s);
  while (next.locked.length < next.parts.length) next.locked.push(true);
  if (p >= 0 && p < next.parts.length) next.locked[p] = on;
  return next;
}

/** Part labels as the editor names them in messages: "Part 3" or "Part 3 (Label)". */
const partName = (p: number, labels: readonly string[]) => `Part ${p + 1}${labels[p]?.trim() ? ` (${labels[p].trim()})` : ""}`;

/**
 * The parts a drag or nudge may move, given the locks. `grabbed` is the part that was grabbed (null for
 * the whole region) and `set` what would move with it (its contested zones). A locked part refuses the
 * move, and so does the whole region when any part is locked; locked zones just stay where they are.
 */
export function planMove(
  locked: readonly boolean[],
  labels: readonly string[],
  n: number,
  grabbed: number | null,
  set: readonly number[] = grabbed === null ? [] : [grabbed],
): { parts: number[] | null } | { refused: string } {
  if (grabbed === null) {
    const first = Array.from({ length: n }, (_, p) => p).find((p) => locked[p] !== false);
    return first === undefined ? { parts: null } : { refused: `${partName(first, labels)} is locked, so the whole region can't move. Unlock it in the Parts list first.` };
  }
  if (locked[grabbed] !== false) return { refused: `${partName(grabbed, labels)} is locked: drag its vertices or midpoints to reshape it, or unlock it to move it.` };
  return { parts: set.filter((p) => p === grabbed || locked[p] === false) };
}

/* ── Contested zones ── */

/**
 * partContested after parts were removed or kept (`kept[i]` = old index of new part i). A zone whose
 * parent went keeps its shape and becomes a normal part; `orphaned` counts them.
 */
export function remapContested(contested: readonly number[], kept: readonly number[]): { contested: number[]; orphaned: number } {
  const at = new Map(kept.map((old, i) => [old, i]));
  let orphaned = 0;
  const out = kept.map((old) => {
    const k = contested[old] ?? -1;
    if (k < 0) return -1;
    const n = at.get(k);
    if (n === undefined) {
      orphaned++;
      return -1;
    }
    return n;
  });
  return { contested: out, orphaned };
}

/** Why part p can't become a zone of part k (or back to normal with k = -1), or null if it can. */
export function contestedProblem(contested: readonly number[], p: number, k: number): string | null {
  if (k === -1) return null;
  if (k === p) return "A part can't be a contested zone of itself.";
  if (k < 0 || k >= contested.length) return "That part doesn't exist.";
  if ((contested[k] ?? -1) !== -1) return `Part ${k + 1} is itself a contested zone; a zone has to extend a normal part.`;
  if (contested.some((v) => v === p)) return `Part ${p + 1} has contested zones of its own, so it can't become one. Change those zones first.`;
  return null;
}

/** Sets part p's parent (-1 for normal). Returns the new state, or the reason it can't. */
export function setContested(s: EditorState, p: number, k: number): EditorState | string {
  const why = contestedProblem(s.contested, p, k);
  if (why) return why;
  const next = cloneState(s);
  next.contested[p] = k;
  return next;
}

/** The zones of part p (parts whose parent is p). */
export const zonesOf = (contested: readonly number[], p: number): number[] => contested.flatMap((k, i) => (k === p ? [i] : []));

/**
 * Douglas–Peucker with `tol` in degrees of longitude, measured in the map image's proportions
 * (latitude scaled by ky = 2 / aspect, like pixels). A ring that would cross itself keeps its old shape.
 */
export function simplifyParts(parts: Parts, tol: number, ky: number): { parts: Parts; kept: number } {
  let kept = 0;
  const out = parts.map((rings) =>
    rings.map((ring) => {
      if (ring.length <= 3 || tol <= 0) return ring.map(([x, y]) => [x, y] as Position);
      const s = simplifyRing(ring.map(([x, y]) => [x, y * ky]), tol).map(([x, y]) => [x, y / ky] as Position);
      if (findSelfIntersection(s)) {
        kept++;
        return ring.map(([x, y]) => [x, y] as Position);
      }
      return s;
    }),
  );
  return { parts: out, kept };
}

/** One Chaikin pass on every ring. Refused (null) past the vertex cap. */
export function smoothParts(parts: Parts): Parts | null {
  const out = parts.map((rings) => rings.map((r) => chaikin(r)));
  return countVertices(out) > MAX_VERTICES ? null : out;
}

/** Switches part p's label off (`hidden`) or on in the embed. The text is kept either way. */
export function setLabelHidden(s: EditorState, p: number, hidden: boolean): EditorState {
  const next = cloneState(s);
  while (next.labelHidden.length < next.parts.length) next.labelHidden.push(false);
  if (p >= 0 && p < next.parts.length) next.labelHidden[p] = hidden;
  return next;
}

/** Switches the labels of all the parts in `members` off or on at once. */
export function setLabelsHidden(s: EditorState, members: readonly number[], hidden: boolean): EditorState {
  const next = cloneState(s);
  while (next.labelHidden.length < next.parts.length) next.labelHidden.push(false);
  for (const p of members) if (p >= 0 && p < next.parts.length) next.labelHidden[p] = hidden;
  return next;
}

/* ── Part colours and the legend ── */


/**
 * Stored geometry plus the matching partLegend, partLabels, partContested and partLocked, dropping any part that
 * doesn't survive storing (too few vertices). Zones of a dropped part become normal parts.
 */
export function toStyledGeometry(
  parts: Parts,
  styles: number[],
  labels: string[] = [],
  contested: number[] = [],
  locked: boolean[] = [],
  labelHidden: boolean[] = [],
): { geometry: RegionGeometry; partLegend: number[]; partLabels: string[]; partLabelHidden: boolean[]; partContested: number[]; partLocked: boolean[] } {
  const keep: Parts = [];
  const kept: number[] = [];
  const partLegend: number[] = [];
  const partLabels: string[] = [];
  const partLocked: boolean[] = [];
  const partLabelHidden: boolean[] = [];
  parts.forEach((rings, p) => {
    if (polygonsOf(toStoredGeometry([rings])).length) {
      keep.push(rings);
      kept.push(p);
      partLegend.push(styles[p] ?? OWN_COLOUR);
      partLabels.push(labels[p] ?? "");
      partLocked.push(locked[p] !== false);
      partLabelHidden.push(labelHidden[p] === true);
    }
  });
  return { geometry: toStoredGeometry(keep), partLegend, partLabels, partLabelHidden, partContested: remapContested(contested, kept).contested, partLocked };
}

/** Removes legend entry `k`: its parts go back to the region's colour, later indices shift down. */
export function removeLegendEntry(s: EditorState, k: number): EditorState {
  const next = cloneState(s);
  next.props.legend.splice(k, 1);
  next.styles = next.styles.map((v) => (v === k ? OWN_COLOUR : v > k ? v - 1 : v));
  return next;
}

/** Moves legend entry `k` by `d` places (up −1, down +1), keeping each part's colour. */
export function moveLegendEntry(s: EditorState, k: number, d: number): EditorState {
  const j = k + d;
  if (j < 0 || j >= s.props.legend.length || j === k) return s;
  const next = cloneState(s);
  const [e] = next.props.legend.splice(k, 1);
  next.props.legend.splice(j, 0, e);
  next.styles = next.styles.map((v) => (v === k ? j : v === j ? k : v));
  return next;
}

/**
 * Moves part `p` so it ends up at index `to` (parts in between shift by one), with its colour, label
 * and lock. Part order is layer order: a later part is drawn on top where parts overlap.
 */
export function reorderPart(s: EditorState, p: number, to: number): EditorState {
  const n = s.parts.length;
  if (p < 0 || p >= n || to < 0 || to >= n || p === to) return s;
  const order = [...Array(n).keys()];
  order.splice(p, 1);
  order.splice(to, 0, p);
  const inv: number[] = [];
  order.forEach((old, i) => (inv[old] = i));
  const next = cloneState(s);
  next.parts = order.map((i) => next.parts[i]);
  next.styles = order.map((i) => s.styles[i] ?? OWN_COLOUR);
  next.labels = order.map((i) => s.labels[i] ?? "");
  next.labelHidden = order.map((i) => s.labelHidden?.[i] === true);
  next.contested = order.map((i) => ((s.contested[i] ?? -1) >= 0 ? inv[s.contested[i]] : -1));
  next.locked = order.map((i) => s.locked[i] ?? true);
  if (s.owners) next.owners = order.map((i) => s.owners![i] ?? "");
  return next;
}

/**
 * Where "Bring forward" (dir 1) or "Send backward" (dir -1) puts part p: just past the nearest part it
 * overlaps in that direction (so the move always changes what's on top), else one place along; -1 when
 * it's already the top (or bottom) layer. `overlaps` are pairs [i, j] of parts that overlap.
 */
export function layerTarget(n: number, overlaps: readonly (readonly [number, number])[], p: number, dir: 1 | -1): number {
  if (p < 0 || p >= n || (dir > 0 ? p >= n - 1 : p <= 0)) return -1;
  const other = overlaps.flatMap(([i, j]) => (i === p ? [j] : j === p ? [i] : []));
  const ahead = other.filter((q) => (dir > 0 ? q > p : q < p));
  if (!ahead.length) return p + dir;
  return dir > 0 ? Math.min(...ahead) : Math.max(...ahead);
}

/** Colours offered for a new legend entry, in order, skipping ones already in use. */
export const LEGEND_PALETTE = ["#2e86c1", "#28b463", "#f1c40f", "#8e44ad", "#e67e22", "#16a085", "#d35400", "#7f8c8d", "#c0392b", "#1abc9c", "#9b59b6", "#34495e"];
export function nextLegendColour(used: string[]): string {
  const u = new Set(used.map((c) => c.toLowerCase()));
  return LEGEND_PALETTE.find((c) => !u.has(c)) ?? LEGEND_PALETTE[used.length % LEGEND_PALETTE.length];
}

/* ── Undo / redo ── */

interface Command {
  label: string;
  before: EditorState;
  after: EditorState;
  /** Consecutive commands with the same key (e.g. typing in the name field) merge into one step. */
  merge?: string;
  t: number;
}

export const HISTORY_LIMIT = 200;
const MERGE_MS = 1200;

/**
 * A command stack over editor states. Every edit (geometry, name, colour, …) goes through apply() or
 * a begin()/preview()/commit() drag, so a whole drag is a single step.
 */
export class History {
  private undos: Command[] = [];
  private redos: Command[] = [];
  private dragStart: EditorState | null = null;
  /** Bumped on every change, so the editor can tell whether there are unsaved edits. */
  version = 0;

  constructor(
    public state: EditorState,
    private limit = HISTORY_LIMIT,
  ) {}

  get canUndo(): boolean {
    return this.undos.length > 0;
  }
  get canRedo(): boolean {
    return this.redos.length > 0;
  }
  get depth(): number {
    return this.undos.length;
  }
  get dragging(): boolean {
    return this.dragStart !== null;
  }
  get lastLabel(): string {
    return this.undos[this.undos.length - 1]?.label ?? "";
  }

  apply(label: string, next: EditorState, merge?: string, now = Date.now()): void {
    const last = this.undos[this.undos.length - 1];
    if (merge && last && last.merge === merge && now - last.t < MERGE_MS && !this.redos.length) {
      last.after = cloneState(next);
      last.t = now;
    } else {
      this.undos.push({ label, before: cloneState(this.state), after: cloneState(next), merge, t: now });
      if (this.undos.length > this.limit) this.undos.shift();
    }
    this.redos = [];
    this.state = cloneState(next);
    this.version++;
  }

  /** Start of a drag: later preview() calls change the state without history entries. */
  begin(): void {
    this.dragStart = cloneState(this.state);
  }
  preview(next: EditorState): void {
    this.state = next;
    this.version++;
  }
  /** End of a drag: one undo step from where it began (nothing if it didn't change anything). */
  commit(label: string): void {
    const start = this.dragStart;
    this.dragStart = null;
    if (!start || JSON.stringify(start) === JSON.stringify(this.state)) return;
    const next = this.state;
    this.state = start;
    this.apply(label, next);
  }
  /** Abandon a drag and snap back. */
  cancel(): void {
    if (this.dragStart) this.state = this.dragStart;
    this.dragStart = null;
    this.version++;
  }

  undo(): boolean {
    const c = this.undos.pop();
    if (!c) return false;
    this.redos.push(c);
    this.state = cloneState(c.before);
    this.version++;
    return true;
  }
  redo(): boolean {
    const c = this.redos.pop();
    if (!c) return false;
    this.undos.push(c);
    this.state = cloneState(c.after);
    this.version++;
    return true;
  }
}

/**
 * Tidies the end of a freehand stroke that overshot its start: when the last stretch crosses one of
 * the first edges, the loop between the crossing and the end is kept and the little tails on either side
 * are dropped, with the crossing itself as the new vertex. Only trims when the tails are short (at most
 * a quarter of the stroke), so a deliberate figure-eight is still refused as self-crossing. `ky` scales
 * latitude to the screen's aspect so "short" matches what was drawn.
 */
export function trimStrokeOvershoot(open: Position[], ky = 1): Position[] {
  const n = open.length;
  if (n < 4 || n > 3000) return open;
  const len = (a: Position, b: Position) => Math.hypot(b[0] - a[0], (b[1] - a[1]) * ky);
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + len(open[i - 1], open[i]));
  const total = cum[n - 1];
  let best: { j: number; i: number; x: Position } | null = null;
  for (let j = 0; j < n - 3 && !best; j++) {
    for (let i = n - 2; i > j + 1; i--) {
      if (!segmentsIntersect(open[j], open[j + 1], open[i], open[i + 1])) continue;
      const x = crossingPoint(open[j], open[j + 1], open[i], open[i + 1]);
      if (!x) continue;
      // What would be thrown away: the start up to the crossing, and the end past it.
      const dropped = cum[j] + len(open[j], x) + (total - cum[i + 1]) + len(open[i + 1], x);
      if (dropped <= total * 0.25) best = { j, i, x };
      break;
    }
  }
  if (!best) return open;
  const out = [best.x, ...open.slice(best.j + 1, best.i + 1)];
  return out.length >= 3 ? out : open;
}

/** Where segments ab and cd cross, or null when they are parallel. */
function crossingPoint(a: Position, b: Position, c: Position, d: Position): Position | null {
  const r: Position = [b[0] - a[0], b[1] - a[1]];
  const q: Position = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * q[1] - r[1] * q[0];
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c[0] - a[0]) * q[1] - (c[1] - a[1]) * q[0]) / den;
  return [a[0] + t * r[0], a[1] + t * r[1]];
}
