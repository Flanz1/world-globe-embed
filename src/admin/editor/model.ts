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
  signedArea,
  simplifyRing,
  toStoredGeometry,
  unwrapRing,
  type Position,
  type RegionGeometry,
  type Ring,
} from "../../shared/geo.ts";
import { OWN_COLOUR, type LegendEntry } from "../../shared/region.ts";
export { partAnchor } from "../../shared/geo.ts";

/** parts[p][0] is part p's outer ring, parts[p][1..] its holes. */
export type Parts = Ring[][];

export interface RegionProps {
  color: string;
  fillOpacity: number;
  label: boolean;
  description: string;
  legendTitle: string;
  legend: LegendEntry[];
}

export interface EditorState {
  parts: Parts;
  /** Per part: index into props.legend, or -1 (OWN_COLOUR) for the region's own colour. */
  styles: number[];
  /** Per part: the label the embed shows on it ("" for none). */
  labels: string[];
  /** Per part: -1 for a normal part, or the (normal) part this contested zone extends. */
  contested: number[];
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
  contested: [...(s.contested ?? [])],
  props: { ...s.props, legend: s.props.legend.map((e) => ({ ...e })) },
});

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
 * pieces are added at the end with the same colour (and the same parent, for a contested zone).
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
  const parentOld: number[] = [];
  const index = s.parts.map(() => -1);
  const extra: { rings: Ring[]; style: number; parent: number }[] = [];
  const cut: number[] = [];
  let removed = 0;
  s.parts.forEach((rings, p) => {
    const pc = pieces[p];
    const style = s.styles[p] ?? OWN_COLOUR;
    const parent = s.contested[p] ?? -1;
    if (pc) cut.push(p);
    if (pc && !pc.length) return void removed++;
    index[p] = parts.length;
    parts.push(pc ? pc[0] : rings.map((r) => r.map(([x, y]) => [x, y] as Position)));
    styles.push(style);
    labels.push(s.labels[p] ?? "");
    parentOld.push(parent);
    for (const more of pc?.slice(1) ?? []) extra.push({ rings: more, style, parent });
  });
  for (const e of extra) {
    parts.push(e.rings);
    styles.push(e.style);
    labels.push("");
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
  next.contested = contested;
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

/* ── Part colours and the legend ── */


/**
 * Stored geometry plus the matching partLegend, partLabels and partContested, dropping any part that
 * doesn't survive storing (too few vertices). Zones of a dropped part become normal parts.
 */
export function toStyledGeometry(
  parts: Parts,
  styles: number[],
  labels: string[] = [],
  contested: number[] = [],
): { geometry: RegionGeometry; partLegend: number[]; partLabels: string[]; partContested: number[] } {
  const keep: Parts = [];
  const kept: number[] = [];
  const partLegend: number[] = [];
  const partLabels: string[] = [];
  parts.forEach((rings, p) => {
    if (polygonsOf(toStoredGeometry([rings])).length) {
      keep.push(rings);
      kept.push(p);
      partLegend.push(styles[p] ?? OWN_COLOUR);
      partLabels.push(labels[p] ?? "");
    }
  });
  return { geometry: toStoredGeometry(keep), partLegend, partLabels, partContested: remapContested(contested, kept).contested };
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
