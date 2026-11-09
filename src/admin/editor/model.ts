/**
 * The region editor's data model: pure functions on an immutable-ish state, plus an undo/redo
 * command stack. No DOM here, so it is unit-tested directly.
 *
 * Shape coordinates are [lon, lat] in the map image's frame. In the editor every ring is *open*
 * (no repeated closing position) and *unwrapped* (longitudes continuous along the ring, so a ring
 * across the antimeridian may run from 170 to 190). toStoredGeometry() wraps and closes them on save.
 */
import {
  MAX_VERTICES,
  chaikin,
  findSelfIntersection,
  lonSpan,
  openRing,
  pointInRing,
  polygonsOf,
  simplifyRing,
  toStoredGeometry,
  unwrapRing,
  type Position,
  type RegionGeometry,
  type Ring,
} from "../../shared/geo.ts";

/** parts[p][0] is part p's outer ring, parts[p][1..] its holes. */
export type Parts = Ring[][];

export interface RegionProps {
  name: string;
  color: string;
  fillOpacity: number;
  label: boolean;
  description: string;
}

export interface EditorState {
  parts: Parts;
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
export const cloneState = (s: EditorState): EditorState => ({ parts: cloneParts(s.parts), props: { ...s.props } });

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
export function deleteVertices(parts: Parts, refs: VRef[]): { parts: Parts; removedParts: number; removedHoles: number } {
  const byRing = new Map<string, Set<number>>();
  for (const v of refs) {
    const k = `${v.p}:${v.r}`;
    (byRing.get(k) ?? byRing.set(k, new Set()).get(k)!).add(v.i);
  }
  let removedParts = 0;
  let removedHoles = 0;
  const out: Parts = [];
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
    else out.push(kept);
  });
  return { parts: out, removedParts, removedHoles };
}

/** Moves the whole shape, or one part (with its holes). Latitude is limited so nothing leaves ±90. */
export function translate(parts: Parts, part: number | null, dLon: number, dLat: number): Parts {
  let lo = Infinity;
  let hi = -Infinity;
  parts.forEach((rings, p) => {
    if (part !== null && p !== part) return;
    for (const r of rings)
      for (const [, y] of r) {
        lo = Math.min(lo, y);
        hi = Math.max(hi, y);
      }
  });
  const dy = Math.max(-90 - lo, Math.min(90 - hi, dLat));
  return parts.map((rings, p) => (part !== null && p !== part ? rings.map((r) => r.map(([x, y]) => [x, y] as Position)) : rings.map((r) => r.map(([x, y]) => [x + dLon, y + dy] as Position))));
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

/** Index of the part under a point (inside its outer ring and not in a hole), or -1. */
export function partAt(parts: Parts, pos: Position): number {
  for (let p = parts.length - 1; p >= 0; p--) {
    const rings = parts[p];
    if (!rings[0] || !pointInRing(pos, rings[0])) continue;
    if (rings.slice(1).some((h) => pointInRing(pos, h))) continue;
    return p;
  }
  return -1;
}

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
