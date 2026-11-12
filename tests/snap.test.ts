import { describe, expect, it } from "vitest";
import type { Position } from "../src/shared/geo.ts";
import { carryLines, lineCarry, lineOwners, linePins, findSnap, followBorders, insertOnEdges, partRings, posKey, sharedEdges, snapRing, traceBetween, tracePath, vertexIndex, withGlued } from "../src/admin/editor/snap.ts";
import type { Parts } from "../src/admin/editor/model.ts";

// 1 degree = 10 px, square pixels.
const sc = { k: 10, ky: 1 };
const square = (x: number, y: number, s = 10): Position[] => [
  [x, y],
  [x + s, y],
  [x + s, y + s],
  [x, y + s],
];

describe("findSnap", () => {
  const rings = [snapRing(square(0, 0), { kind: "part", p: 0, r: 0 })];
  it("snaps to a vertex within the radius", () => {
    const s = findSnap(rings, [10.5, 0.3], sc, 10);
    expect(s).toMatchObject({ kind: "vertex", ring: 0, at: 1, pos: [10, 0] });
  });
  it("prefers a vertex over a nearer line", () => {
    const s = findSnap(rings, [9.5, 0.05], sc, 10);
    expect(s?.kind).toBe("vertex");
  });
  it("snaps onto a line when no vertex is near", () => {
    const s = findSnap(rings, [5, 0.4], sc, 10);
    expect(s?.kind).toBe("edge");
    expect(s!.pos[0]).toBeCloseTo(5);
    expect(s!.pos[1]).toBeCloseTo(0);
    expect(s!.at).toBeCloseTo(0.5);
  });
  it("gives null out of reach", () => {
    expect(findSnap(rings, [5, 3], sc, 10)).toBeNull();
  });
  it("works in another copy of the map", () => {
    const s = findSnap(rings, [370.2, 0.2], sc, 10);
    expect(s?.pos).toEqual([370, 0]);
  });
  it("leaves out skipped rings and vertices", () => {
    expect(findSnap(rings, [10.2, 0.2], sc, 10, (i) => i === 0)).toBeNull();
    const s = findSnap(rings, [10.2, 0.2], sc, 10, undefined, (_, v) => v === 1);
    // Vertex 1 and both lines touching it are out, so nothing is in reach.
    expect(s).toBeNull();
  });
  it("scales latitude by ky", () => {
    // ky = 2: one degree of latitude is 20 px, so 0.6° off the bottom line is out of a 10 px reach.
    expect(findSnap(rings, [5, 0.6], { k: 10, ky: 2 }, 10)).toBeNull();
    expect(findSnap(rings, [5, 0.4], { k: 10, ky: 2 }, 10)).not.toBeNull();
  });
});

describe("tracing", () => {
  // An octagon-ish ring with 8 vertices round a circle.
  const ring: Position[] = Array.from({ length: 8 }, (_, i) => [Math.round(Math.cos((i * Math.PI) / 4) * 1000) / 100, Math.round(Math.sin((i * Math.PI) / 4) * 1000) / 100]);
  it("tracePath lists the vertices strictly between, either way", () => {
    expect(tracePath(ring, { pos: ring[1], at: 1 }, { at: 4 }, 1).map((t) => t.at)).toEqual([2, 3]);
    expect(tracePath(ring, { pos: ring[1], at: 1 }, { at: 4 }, -1).map((t) => t.at)).toEqual([0, 7, 6, 5]);
  });
  it("tracePath handles points on lines", () => {
    expect(tracePath(ring, { pos: ring[1], at: 1.5 }, { at: 3.2 }, 1).map((t) => t.at)).toEqual([2, 3]);
    expect(tracePath(ring, { pos: ring[1], at: 6.5 }, { at: 0.5 }, 1).map((t) => t.at)).toEqual([7, 0]);
  });
  it("traceBetween takes the shorter way, or the other when flipped", () => {
    const a = { pos: ring[1], ring: 0, at: 1, kind: "vertex" as const };
    const b = { pos: ring[3], ring: 0, at: 3, kind: "vertex" as const };
    expect(traceBetween(ring, a, b, 1).map((t) => t.at)).toEqual([2]);
    expect(traceBetween(ring, a, b, 1, true).map((t) => t.at)).toEqual([0, 7, 6, 5, 4]);
  });
  it("traced longitudes follow on across the antimeridian", () => {
    const r: Position[] = [
      [170, 0],
      [175, 5],
      [185, 5],
      [190, 0],
    ];
    const t = tracePath(r, { pos: [-190, 0], at: 0 }, { at: 3 }, 1);
    expect(t.map((q) => q.pos[0])).toEqual([-185, -175]);
  });
});

describe("followBorders", () => {
  const rings = [snapRing(square(0, 0), { kind: "neighbour", n: 0, r: 0 })];
  const snapAt = (p: Position) => findSnap(rings, p, sc, 10);
  it("replaces a stretch drawn along a border with the border's vertices", () => {
    // From outside, down along the square's right side (x = 10) from y = 12 to y = -2, then away.
    const sketch: Position[] = [[20, 12], [15, 12], [10.3, 9.6], [10.2, 7], [9.8, 4], [10.1, 1], [10.4, 0.3], [15, -2], [20, -2]];
    const { pts, followed } = followBorders(sketch, snapAt, rings, 1, 0.2, true);
    expect(followed).toBe(1);
    // The square's corners (10, 10) and (10, 0) are both in, exactly.
    expect(pts).toContainEqual([10, 10]);
    expect(pts).toContainEqual([10, 0]);
  });
  it("follows the way the pen went round the ring", () => {
    // Along the bottom then up the right side: 0,0 → 10,0 → 10,10. Passes vertex 1 (10, 0).
    const sketch: Position[] = [[-3, -3], [0.3, 0.2], [3, 0.2], [6, -0.2], [9.7, 0.1], [10.2, 4], [9.9, 8], [10.2, 9.8], [13, 13]];
    const { pts } = followBorders(sketch, snapAt, rings, 1, 0.2, false);
    const i0 = pts.findIndex((p) => p[0] === 0 && p[1] === 0);
    const i1 = pts.findIndex((p) => p[0] === 10 && p[1] === 0);
    const i2 = pts.findIndex((p) => p[0] === 10 && p[1] === 10);
    expect(i0).toBeGreaterThanOrEqual(0);
    expect(i1).toBeGreaterThan(i0);
    expect(i2).toBeGreaterThan(i1);
    // Not the long way round through (0, 10).
    expect(pts).not.toContainEqual([0, 10]);
  });
  it("leaves a stroke that only crosses a border as drawn", () => {
    const sketch: Position[] = [[5, 5], [8, 5], [10.1, 5], [12, 5], [15, 5], [15, 15], [5, 15]];
    const { followed } = followBorders(sketch, snapAt, rings, 1, 0.01, true);
    expect(followed).toBe(0);
  });
});

describe("attached vertices", () => {
  // Two squares side by side sharing the line x = 10 (0,0)-(10,10) | (10,0)-(20,10), the right one in the next copy.
  const parts: Parts = [[square(0, 0)], [square(370, 0).map(([x, y]) => [x, y] as Position)]];
  it("posKey is the same in every copy", () => {
    expect(posKey([10, 5])).toBe(posKey([370, 5]));
    expect(posKey([-180, 0])).toBe(posKey([180, 0]));
  });
  it("withGlued adds the vertices on the same spot", () => {
    const g = withGlued(parts, [{ p: 0, r: 0, i: 1 }]);
    expect(g).toEqual([
      { p: 0, r: 0, i: 1 },
      { p: 1, r: 0, i: 0 },
    ]);
    expect(withGlued(parts, [{ p: 0, r: 0, i: 0 }])).toHaveLength(1);
  });
  it("vertexIndex groups every vertex", () => {
    const idx = vertexIndex(parts);
    expect([...idx.values()].filter((l) => l.length > 1)).toHaveLength(2);
  });
  it("sharedEdges finds the other side of a shared line, either way round", () => {
    // Left square's edge 1: (10,0) → (10,10). Right square has (10,10) → (10,0) as edge 3 (vertex 3 → 0).
    expect(sharedEdges(parts, 0, 0, 1)).toEqual([{ p: 1, r: 0, i: 3 }]);
    expect(sharedEdges(parts, 0, 0, 0)).toEqual([]);
  });
  it("insertOnEdges puts the point on both sides, in each one's copy", () => {
    const res = insertOnEdges(parts, [{ p: 0, r: 0, i: 1 }, ...sharedEdges(parts, 0, 0, 1)], [10, 5]);
    expect(res.parts[0][0][2]).toEqual([10, 5]);
    expect(res.parts[1][0][4]).toEqual([370, 5]);
    expect(res.refs).toEqual(expect.arrayContaining([{ p: 0, r: 0, i: 2 }, { p: 1, r: 0, i: 4 }]));
    // The new vertices are attached to each other.
    expect(withGlued(res.parts, [{ p: 0, r: 0, i: 2 }])).toHaveLength(2);
  });
  it("insertOnEdges keeps earlier refs right when one ring gets two points", () => {
    const res = insertOnEdges([[square(0, 0)]], [{ p: 0, r: 0, i: 0 }, { p: 0, r: 0, i: 2 }], [5, 0]);
    expect(res.parts[0][0]).toHaveLength(6);
    for (const q of res.refs) expect(res.parts[0][0][q.i][1] === 0 || res.parts[0][0][q.i][1] === 10).toBe(true);
  });
  it("partRings lists every ring with its source", () => {
    expect(partRings(parts).map((r) => r.src)).toEqual([
      { kind: "part", p: 0, r: 0 },
      { kind: "part", p: 1, r: 0 },
    ]);
  });
});

describe("province borders follow their part", () => {
  const A = square(0, 0);
  const B = square(10, 0);
  const parts: Parts = [[A], [B]];
  // A line inside A from its bottom edge midpoint (5, 0) up to (5, 10)'s top edge, with a free point at (5, 5).
  const lines: Position[][] = [[[5, 0], [5, 5], [5, 10]]];
  it("assigns each line to the part it lies in", () => {
    expect(lineOwners(parts, lines)).toEqual([0]);
    expect(lineOwners(parts, [[[15, 2], [15, 8]]])).toEqual([1]);
    expect(lineOwners(parts, [[[50, 2], [50, 8]]])).toEqual([-1]);
  });
  it("finds the points on outlines, with the edge and fraction", () => {
    const pins = linePins(parts, lines);
    expect(pins.map((q) => [q.k, q.p, q.e])).toEqual([[0, 0, 0], [2, 0, 2]]);
    expect(pins[0].t).toBeCloseTo(0.5);
  });
  it("moving the part carries the whole line", () => {
    const carry = lineCarry(parts, lines);
    const moved: Parts = [[A.map(([x, y]) => [x + 3, y + 2] as Position)], [B]];
    const out = carryLines(lines, carry, parts, moved, [0]);
    expect(out[0]).toEqual([[8, 2], [8, 7], [8, 12]]);
  });
  it("moving another part leaves it", () => {
    const carry = lineCarry(parts, lines);
    const moved: Parts = [[A], [B.map(([x, y]) => [x + 3, y] as Position)]];
    expect(carryLines(lines, carry, parts, moved, [1])[0]).toEqual(lines[0]);
  });
  it("dragging a vertex slides the pinned points along their edges, the free point stays", () => {
    const carry = lineCarry(parts, lines);
    // Pull A's bottom-right corner (10, 0) down to (10, -4): the bottom edge's midpoint moves to (5, -2).
    const dragged: Parts = [[[[0, 0], [10, -4], [10, 10], [0, 10]]], [B]];
    const out = carryLines(lines, carry, parts, dragged, [])[0];
    expect(out[0][0]).toBeCloseTo(5);
    expect(out[0][1]).toBeCloseTo(-2);
    expect(out[1]).toEqual([5, 5]);
    expect(out[2]).toEqual([5, 10]);
  });
  it("is the same across the antimeridian copy", () => {
    const west: Parts = [[square(170, 0)]];
    const line: Position[][] = [[[-185, 0], [-185, 10]]]; // lon 175 in another copy
    expect(lineOwners(west, line)).toEqual([0]);
    const carry = lineCarry(west, line);
    const moved: Parts = [[square(172, 0)]];
    expect(carryLines(line, carry, west, moved, [0])[0][0][0]).toBeCloseTo(-183);
  });
  it("a free-floating line (touching no vertex or outline) is kept as drawn and moves with its part, whatever the vertices do", () => {
    const floating: Position[][] = [[[2, 3], [4, 6], [3, 8]]];
    const carry = lineCarry(parts, floating);
    expect(carry.pins).toEqual([]);
    expect(carry.owners).toEqual([0]);
    // A vertex drag leaves it exactly where it was.
    const dragged: Parts = [[[[0, 0], [10, -4], [10, 10], [0, 10]]], [B]];
    expect(carryLines(floating, carry, parts, dragged, [])).toEqual(floating);
    // Moving the part carries it.
    const moved: Parts = [[A.map(([x, y]) => [x - 2, y + 1] as Position)], [B]];
    expect(carryLines(floating, carry, parts, moved, [0])[0]).toEqual([[0, 4], [2, 7], [1, 9]]);
    // Moving the whole region carries it too.
    const all: Parts = [[A.map(([x, y]) => [x + 1, y] as Position)], [B.map(([x, y]) => [x + 1, y] as Position)]];
    expect(carryLines(floating, carry, parts, all, null)[0]).toEqual([[3, 3], [5, 6], [4, 8]]);
  });
  it("only points on an outline are pinned; the rest of the same line stays free", () => {
    const mixed: Position[][] = [[[5, 0], [5, 5], [7, 4]]];
    expect(lineCarry(parts, mixed).pins.map((q) => q.k)).toEqual([0]);
  });
});
