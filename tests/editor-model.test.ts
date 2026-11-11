import { describe, expect, it } from "vitest";
import {
  History,
  addHole,
  countVertices,
  deleteVertices,
  insertVertex,
  moveLegendEntry,
  partAnchor,
  partsAt,
  contestedProblem,
  remapContested,
  setContested,
  zonesOf,
  moveVertices,
  nextLegendColour,
  partAt,
  partsFromGeometry,
  planMove,
  removeLegendEntry,
  setLocked,
  ringProblem,
  simplifyParts,
  smoothParts,
  toGeometry,
  toStyledGeometry,
  translate,
  type EditorState,
  type Parts,
} from "../src/admin/editor/model.ts";
import { checkGeometry, pointInRing, type Position } from "../src/shared/geo.ts";

const square = (x: number, y: number, s = 10): Position[] => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
const props = { color: "#c0392b", fillOpacity: 0.35, label: true, description: "", legendTitle: "", legend: [] };
const st = (parts: Parts): EditorState => ({ parts, styles: parts.map(() => -1), labels: parts.map(() => ""), contested: parts.map(() => -1), locked: parts.map(() => false), props: { ...props, legend: [] } });

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
    // Typing the description: merges into one step.
    h.apply("Description", { ...h.state, props: { ...h.state.props, description: "Ka" } }, "description", 1000);
    h.apply("Description", { ...h.state, props: { ...h.state.props, description: "Kal" } }, "description", 1500);
    expect(h.depth).toBe(1);
    // A drag: many previews, one step.
    h.begin();
    for (let i = 1; i <= 30; i++) h.preview({ ...h.state, parts: moveVertices(h.state.parts, [{ p: 0, r: 0, i: 0 }], 0.1, 0) });
    h.commit("Move vertex");
    expect(h.depth).toBe(2);
    h.apply("Colour", { ...h.state, props: { ...h.state.props, color: "#123456" } });
    expect(h.depth).toBe(3);
    expect(h.undo() && h.undo() && h.undo()).toBe(true);
    expect(h.state.props.description).toBe("");
    expect(h.state.parts[0][0][0]).toEqual([0, 0]);
    expect(h.undo()).toBe(false);
    expect(h.redo() && h.redo() && h.redo()).toBe(true);
    expect(h.state.props).toMatchObject({ description: "Kal", color: "#123456" });
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

describe("editor model: part colours and legend", () => {
  const legendState = (): EditorState => ({
    parts: [[square(0, 0)], [square(20, 0)], [square(40, 0)]],
    styles: [0, 1, -1],
    labels: ["North", "", "South"],
    contested: [-1, -1, -1],
    locked: [false, false, false],
    props: { ...props, legend: [{ label: "A", color: "#111111" }, { label: "B", color: "#222222" }] },
  });

  it("deleteVertices reports which parts it kept, so their colours follow them", () => {
    const res = deleteVertices(legendState().parts, [{ p: 1, r: 0, i: 0 }, { p: 1, r: 0, i: 1 }]);
    expect(res.removedParts).toBe(1);
    expect(res.kept).toEqual([0, 2]);
  });

  it("toStyledGeometry keeps partLegend in step with the stored polygons", () => {
    const s = legendState();
    const out = toStyledGeometry(s.parts, s.styles, s.labels);
    expect(out.geometry.type).toBe("MultiPolygon");
    expect(out.partLegend).toEqual([0, 1, -1]);
    expect(out.partLabels).toEqual(["North", "", "South"]);
    // A degenerate part (all one point) is dropped from both.
    const degenerate = [s.parts[0], [[[5, 5], [5, 5], [5, 5]]] as Parts[number], s.parts[2]];
    const d = toStyledGeometry(degenerate, [0, 1, -1], ["a", "b", "c"]);
    expect(d.partLegend).toEqual([0, -1]);
    expect(d.partLabels).toEqual(["a", "c"]);
    expect(d.geometry.type === "MultiPolygon" && d.geometry.coordinates.length).toBe(2);
    // One part: a Polygon with a one-entry partLegend.
    expect(toStyledGeometry([s.parts[0]], [1])).toMatchObject({ geometry: { type: "Polygon" }, partLegend: [1] });
  });

  it("removing a legend entry sends its parts back to the region colour and shifts later ones", () => {
    const next = removeLegendEntry(legendState(), 0);
    expect(next.props.legend.map((e) => e.label)).toEqual(["B"]);
    expect(next.styles).toEqual([-1, 0, -1]);
  });

  it("reordering the legend keeps each part's colour", () => {
    const s = legendState();
    const next = moveLegendEntry(s, 0, 1);
    expect(next.props.legend.map((e) => e.label)).toEqual(["B", "A"]);
    expect(next.styles).toEqual([1, 0, -1]);
    expect(moveLegendEntry(s, 0, -1)).toBe(s);
  });

  it("undo restores the legend and part colours", () => {
    const h = new History(legendState());
    h.apply("Remove legend colour", removeLegendEntry(h.state, 1));
    expect(h.state.styles).toEqual([0, -1, -1]);
    h.undo();
    expect(h.state.styles).toEqual([0, 1, -1]);
    expect(h.state.props.legend).toHaveLength(2);
  });

  it("new legend colours avoid ones in use", () => {
    expect(nextLegendColour(["#2E86C1"])).toBe("#28b463");
  });
});

describe("editor model: part badges", () => {
  it("partAnchor is inside the part, even for a C shape and around a hole", () => {
    expect(partAnchor([square(0, 0)])).toEqual([5, 5]);
    // C shape: the centroid falls in the gap.
    const c: Position[] = [[0, 0], [10, 0], [10, 2], [2, 2], [2, 8], [10, 8], [10, 10], [0, 10]];
    const a = partAnchor([c])!;
    expect(pointInRing(a, c)).toBe(true);
    // Square with a hole in the middle: the badge goes beside the hole.
    const hole = square(3, 3, 4);
    const b = partAnchor([square(0, 0), hole])!;
    expect(pointInRing(b, square(0, 0)) && !pointInRing(b, hole)).toBe(true);
    // Across the antimeridian (unwrapped): stays in the part's own coordinates.
    expect(partAnchor([square(175, 0)])).toEqual([180, 5]);
    expect(partAnchor([[[0, 0], [1, 1]]])).toBeNull();
  });
});

describe("editor model: contested zones", () => {
  // Part 0 (normal), 1 (zone of 0), 2 (normal), 3 (zone of 2).
  const zoneState = (): EditorState => ({
    parts: [[square(0, 0)], [square(8, 0, 6)], [square(40, 0)], [square(48, 0, 6)]],
    styles: [-1, -1, -1, -1],
    labels: ["A", "", "B", ""],
    contested: [-1, 0, -1, 2],
    locked: [false, false, false, false],
    props: { ...props, legend: [] },
  });

  it("survives deleting a vertex that removes a part", () => {
    const s = zoneState();
    // Part 2 loses two of its four vertices: it's removed, its zone (3) becomes normal.
    const res = deleteVertices(s.parts, [{ p: 2, r: 0, i: 0 }, { p: 2, r: 0, i: 1 }]);
    expect(res.kept).toEqual([0, 1, 3]);
    expect(remapContested(s.contested, res.kept)).toEqual({ contested: [-1, 0, -1], orphaned: 1 });
    // Removing a zone leaves the others pointing at the right parts.
    const res2 = deleteVertices(s.parts, [{ p: 1, r: 0, i: 0 }, { p: 1, r: 0, i: 1 }]);
    expect(remapContested(s.contested, res2.kept)).toEqual({ contested: [-1, -1, 1], orphaned: 0 });
  });

  it("deleting a parent makes its zones normal parts", () => {
    const s = zoneState();
    const res = deleteVertices(s.parts, [0, 1, 2].map((i) => ({ p: 0, r: 0, i })));
    expect(res.kept).toEqual([1, 2, 3]);
    expect(remapContested(s.contested, res.kept)).toEqual({ contested: [-1, -1, 1], orphaned: 1 });
  });

  it("toStyledGeometry remaps partContested when it drops a degenerate part", () => {
    const s = zoneState();
    // Part 0 collapses to fewer than 3 distinct stored vertices.
    const parts: Parts = [[[[0, 0], [0, 0.000001], [0.000001, 0]]], ...s.parts.slice(1)];
    const out = toStyledGeometry(parts, s.styles, s.labels, s.contested);
    expect(out.partLabels).toEqual(["", "B", ""]);
    expect(out.partContested).toEqual([-1, -1, 1]);
    expect(toStyledGeometry(s.parts, s.styles, s.labels, s.contested).partContested).toEqual([-1, 0, -1, 2]);
  });

  it("checks what can become a zone of what", () => {
    const s = zoneState();
    expect(contestedProblem(s.contested, 1, 1)).toMatch(/itself/);
    expect(contestedProblem(s.contested, 2, 1)).toMatch(/itself a contested zone/);
    expect(contestedProblem(s.contested, 0, 2)).toMatch(/has contested zones/);
    expect(contestedProblem(s.contested, 1, 2)).toBeNull();
    expect(contestedProblem(s.contested, 1, -1)).toBeNull();
    expect(setContested(s, 0, 2)).toBeTypeOf("string");
    expect((setContested(s, 1, 2) as EditorState).contested).toEqual([-1, 2, -1, 2]);
    expect(zonesOf([-1, 0, -1, 0], 0)).toEqual([1, 3]);
  });

  it("partsAt puts contested zones on top, then later parts", () => {
    const s = zoneState();
    expect(partsAt(s.parts, [9, 2], s.contested)).toEqual([1, 0]);
    expect(partAt(s.parts, [9, 2], s.contested)).toBe(1);
    expect(partsAt(s.parts, [2, 2], s.contested)).toEqual([0]);
  });

  it("translate moves one part, a part and its zones, or everything", () => {
    const s = zoneState();
    const one = translate(s.parts, 0, 5, 0);
    expect(one[0][0][0]).toEqual([5, 0]);
    expect(one[1][0][0]).toEqual([8, 0]);
    const withZones = translate(s.parts, [0, ...zonesOf(s.contested, 0)], 5, 0);
    expect(withZones[1][0][0]).toEqual([13, 0]);
    expect(withZones[2][0][0]).toEqual([40, 0]);
    // Latitude clamp only looks at the parts that move.
    const up = translate([[square(0, 85)], [square(20, 0)]], [1], 0, 50);
    expect(up[1][0][0]).toEqual([20, 50]);
  });

  it("undo and redo restore partContested with the geometry", () => {
    const h = new History(zoneState());
    h.apply("Make normal part", setContested(h.state, 1, -1) as EditorState);
    const res = deleteVertices(h.state.parts, [0, 1, 2].map((i) => ({ p: 2, r: 0, i })));
    h.apply("Delete", { ...h.state, parts: res.parts, styles: res.kept.map(() => -1), labels: res.kept.map((p) => h.state.labels[p]), contested: remapContested(h.state.contested, res.kept).contested });
    expect(h.state.contested).toEqual([-1, -1, -1]);
    h.undo();
    expect(h.state.contested).toEqual([-1, -1, -1, 2]);
    h.undo();
    expect(h.state.contested).toEqual([-1, 0, -1, 2]);
    h.redo();
    h.redo();
    expect(h.state.contested).toEqual([-1, -1, -1]);
    expect(h.state.parts).toHaveLength(3);
  });
});

describe("editor model: locked parts", () => {
  // Part 0 (normal), 1 (zone of 0), 2 (normal).
  const lockState = (locked: boolean[]): EditorState => ({
    parts: [[square(0, 0)], [square(8, 0, 6)], [square(40, 0)]],
    styles: [-1, -1, -1],
    labels: ["Heartland", "", ""],
    contested: [-1, 0, -1],
    locked,
    props: { ...props, legend: [] },
  });

  it("setLocked toggles one part and is one undo step", () => {
    const h = new History(lockState([false, false, false]));
    h.apply("Lock part", setLocked(h.state, 2, true));
    expect(h.state.locked).toEqual([false, false, true]);
    h.undo();
    expect(h.state.locked).toEqual([false, false, false]);
    h.redo();
    expect(h.state.locked).toEqual([false, false, true]);
    // Out of range does nothing; a short array is padded.
    expect(setLocked(h.state, 9, true).locked).toEqual([false, false, true]);
    expect(setLocked({ ...h.state, locked: [] }, 1, true).locked).toEqual([false, true, false]);
  });

  it("a locked part refuses to move; unlocked parts still move", () => {
    const s = lockState([true, false, false]);
    const r = planMove(s.locked, s.labels, 3, 0, [0, 1]);
    expect("refused" in r && r.refused).toMatch(/Part 1 \(Heartland\) is locked/);
    expect(planMove(s.locked, s.labels, 3, 2)).toEqual({ parts: [2] });
  });

  it("the whole region refuses to move while any part is locked", () => {
    const r = planMove([false, false, true], ["", "", ""], 3, null);
    expect("refused" in r && r.refused).toMatch(/Part 3 is locked, so the whole region can't move/);
    expect(planMove([false, false, false], [], 3, null)).toEqual({ parts: null });
    // A lock past the last part (stale) doesn't count.
    expect(planMove([false, false, false, true], [], 3, null)).toEqual({ parts: null });
  });

  it("a part moving with its zones leaves a locked zone where it is", () => {
    const s = lockState([false, true, false]);
    expect(planMove(s.locked, s.labels, 3, 0, [0, 1])).toEqual({ parts: [0] });
  });

  it("vertex and midpoint edits ignore the lock (they don't go through planMove)", () => {
    const s = lockState([true, false, false]);
    const moved = moveVertices(s.parts, [{ p: 0, r: 0, i: 0 }], 1, 1);
    expect(moved[0][0][0]).toEqual([1, 1]);
    const ins = insertVertex(s.parts, 0, 0, 0, [5, 0]);
    expect(ins.parts[0][0]).toHaveLength(5);
  });

  it("toStyledGeometry keeps partLocked in step when it drops a degenerate part", () => {
    const s = lockState([false, true, true]);
    const parts: Parts = [[[[0, 0], [0, 0.000001], [0.000001, 0]]], ...s.parts.slice(1)];
    expect(toStyledGeometry(parts, s.styles, s.labels, s.contested, s.locked).partLocked).toEqual([true, true]);
    expect(toStyledGeometry(s.parts, s.styles, s.labels, s.contested, s.locked).partLocked).toEqual([false, true, true]);
    expect(toStyledGeometry(s.parts, s.styles).partLocked).toEqual([false, false, false]);
  });
});
