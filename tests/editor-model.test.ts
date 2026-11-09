import { describe, expect, it } from "vitest";
import {
  History,
  addHole,
  countVertices,
  deleteVertices,
  insertVertex,
  moveVertices,
  partAt,
  partsFromGeometry,
  ringProblem,
  simplifyParts,
  smoothParts,
  toGeometry,
  translate,
  type EditorState,
  type Parts,
} from "../src/admin/editor/model.ts";
import { checkGeometry, type Position } from "../src/shared/geo.ts";

const square = (x: number, y: number, s = 10): Position[] => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
const props = { name: "A", color: "#c0392b", fillOpacity: 0.35, label: true, description: "" };
const st = (parts: Parts): EditorState => ({ parts, props: { ...props } });

describe("editor model", () => {
  it("round-trips stored geometry, unwrapping across the antimeridian", () => {
    const parts = partsFromGeometry({ type: "Polygon", coordinates: [[[170, 0], [-170, 0], [-170, 10], [170, 10], [170, 0]]] });
    expect(parts[0][0].map((p) => p[0])).toEqual([170, 190, 190, 170]);
    const g = toGeometry(parts);
    expect(g).toEqual({ type: "Polygon", coordinates: [[[170, 0], [-170, 0], [-170, 10], [170, 10], [170, 0]]] });
    expect(checkGeometry(g)).toEqual([]);
  });

  it("moves, inserts and deletes vertices; a ring never drops below 3", () => {
    let parts: Parts = [[square(0, 0)]];
    parts = moveVertices(parts, [{ p: 0, r: 0, i: 2 }], 5, 5);
    expect(parts[0][0][2]).toEqual([15, 15]);
    const ins = insertVertex(parts, 0, 0, 0, [5, -3]);
    expect(ins.parts[0][0]).toHaveLength(5);
    expect(ins.v).toEqual({ p: 0, r: 0, i: 1 });
    const del = deleteVertices(ins.parts, [{ p: 0, r: 0, i: 1 }]);
    expect(del.parts[0][0]).toHaveLength(4);
    const tooMany = deleteVertices(parts, [{ p: 0, r: 0, i: 0 }, { p: 0, r: 0, i: 1 }]);
    expect(tooMany.parts).toHaveLength(0);
    expect(tooMany.removedParts).toBe(1);
  });

  it("detects a drag that would cross the ring and a span over 180°", () => {
    const parts: Parts = [[square(0, 0)]];
    const crossed = moveVertices(parts, [{ p: 0, r: 0, i: 0 }], 20, 5);
    expect(ringProblem(crossed, [{ p: 0, r: 0, i: 0 }])?.edges.length).toBe(2);
    const wide = moveVertices(parts, [{ p: 0, r: 0, i: 1 }, { p: 0, r: 0, i: 2 }], 200, 0);
    expect(ringProblem(wide)?.message).toMatch(/180°/);
    expect(ringProblem(parts)).toBeNull();
  });

  it("holes go into the part that contains them; partAt skips holes", () => {
    let parts: Parts = [[square(0, 0, 20)]];
    parts = addHole(parts, square(5, 5, 5).reverse())!;
    expect(parts[0]).toHaveLength(2);
    expect(addHole(parts, square(50, 50, 1))).toBeNull();
    expect(partAt(parts, [2, 2])).toBe(0);
    expect(partAt(parts, [7, 7])).toBe(-1);
    expect(checkGeometry(toGeometry(parts))).toEqual([]);
  });

  it("translate keeps latitudes inside ±90", () => {
    const parts = translate([[square(0, 80)]], null, 5, 50);
    expect(Math.max(...parts[0][0].map((p) => p[1]))).toBe(90);
    expect(parts[0][0][0]).toEqual([5, 80]);
  });

  it("simplify reduces a dense ring, smooth doubles it and refuses past the cap", () => {
    const circle: Position[] = Array.from({ length: 400 }, (_, i) => [10 * Math.cos((i / 400) * 2 * Math.PI), 10 * Math.sin((i / 400) * 2 * Math.PI)]);
    const s = simplifyParts([[circle]], 0.3, 1);
    expect(countVertices(s.parts)).toBeLessThan(40);
    expect(countVertices(smoothParts([[square(0, 0)]])!)).toBe(8);
    const dense: Position[] = Array.from({ length: 2600 }, (_, i) => [10 * Math.cos((i / 2600) * 2 * Math.PI), 10 * Math.sin((i / 2600) * 2 * Math.PI)]);
    expect(smoothParts([[dense]])).toBeNull(); // 5200 > 5000
  });
});

describe("undo/redo", () => {
  it("covers every edit, merges typing, and makes a drag one step", () => {
    const h = new History(st([[square(0, 0)]]));
    // Typing the name: merges into one step.
    h.apply("Name", { ...h.state, props: { ...h.state.props, name: "Ka" } }, "name", 1000);
    h.apply("Name", { ...h.state, props: { ...h.state.props, name: "Kal" } }, "name", 1500);
    expect(h.depth).toBe(1);
    // A drag: many previews, one step.
    h.begin();
    for (let i = 1; i <= 30; i++) h.preview({ ...h.state, parts: moveVertices(h.state.parts, [{ p: 0, r: 0, i: 0 }], 0.1, 0) });
    h.commit("Move vertex");
    expect(h.depth).toBe(2);
    h.apply("Colour", { ...h.state, props: { ...h.state.props, color: "#123456" } });
    expect(h.depth).toBe(3);
    expect(h.undo() && h.undo() && h.undo()).toBe(true);
    expect(h.state.props.name).toBe("A");
    expect(h.state.parts[0][0][0]).toEqual([0, 0]);
    expect(h.undo()).toBe(false);
    expect(h.redo() && h.redo() && h.redo()).toBe(true);
    expect(h.state.props).toMatchObject({ name: "Kal", color: "#123456" });
    expect(h.state.parts[0][0][0][0]).toBeCloseTo(3, 10);
  });

  it("keeps at least 100 steps", () => {
    const h = new History(st([[square(0, 0)]]));
    for (let i = 0; i < 150; i++) h.apply("Nudge", { ...h.state, parts: translate(h.state.parts, null, 1, 0) });
    let n = 0;
    while (h.undo()) n++;
    expect(n).toBeGreaterThanOrEqual(100);
  });

  it("cancel snaps a refused drag back without a step", () => {
    const h = new History(st([[square(0, 0)]]));
    h.begin();
    h.preview({ ...h.state, parts: moveVertices(h.state.parts, [{ p: 0, r: 0, i: 0 }], 20, 5) });
    h.cancel();
    expect(h.state.parts[0][0][0]).toEqual([0, 0]);
    expect(h.canUndo).toBe(false);
  });
});
