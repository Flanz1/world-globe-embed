import { describe, expect, it } from "vitest";
import { SPLIT_GAP, cutParts, lineStrips, splitParts, toGeometry, toStyledGeometry, type EditorState, type Parts } from "../src/admin/editor/model.ts";
import { checkGeometry, pointInRing, signedArea, type Position, type Ring } from "../src/shared/geo.ts";

const square = (x: number, y: number, s = 10): Position[] => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
const rect = (x0: number, y0: number, x1: number, y1: number): Position[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const props = { color: "#c0392b", fillOpacity: 0.35, label: true, description: "", legendTitle: "", legend: [{ label: "A", color: "#2e86c1" }] };
const st = (parts: Parts, extra: Partial<EditorState> = {}): EditorState => ({
  parts,
  styles: parts.map(() => -1),
  labels: parts.map(() => ""),
  contested: parts.map(() => -1),
  locked: parts.map(() => false),
  props: { ...props, legend: [...props.legend] },
  ...extra,
});
const area = (r: Ring) => Math.abs(signedArea(r));
const inside = (rings: Ring[], pt: Position) => pointInRing(pt, rings[0]) && !rings.slice(1).some((h) => pointInRing(pt, h));
const valid = (parts: Parts) => expect(checkGeometry(toGeometry(parts))).toEqual([]);

describe("cut tool", () => {
  it("a cut wholly inside a part still makes a hole", () => {
    const res = cutParts(st([[square(0, 0)]]), [square(3, 3, 2)]);
    expect(res.state.parts).toHaveLength(1);
    expect(res.state.parts[0]).toHaveLength(2);
    expect(res.added).toBe(0);
    expect(res.cut).toEqual([0]);
    expect(res.problem).toBeNull();
    expect(inside(res.state.parts[0], [4, 4])).toBe(false);
    expect(inside(res.state.parts[0], [1, 1])).toBe(true);
    valid(res.state.parts);
  });

  it("a cut across the edge bites the part without splitting it", () => {
    const res = cutParts(st([[square(0, 0)]]), [rect(8, 2, 14, 6)]);
    expect(res.state.parts).toHaveLength(1);
    expect(res.state.parts[0]).toHaveLength(1);
    expect(area(res.state.parts[0][0])).toBeCloseTo(100 - 8, 6);
    valid(res.state.parts);
  });

  it("a cut right across splits the part into separate parts, the largest keeping its place", () => {
    const s = st([[square(0, 0)], [square(50, 50, 4)]], { styles: [0, -1], labels: ["Vael", "Isle"] });
    const res = cutParts(s, [rect(2, -5, 4, 15), rect(6, -5, 7, 15)]);
    // Pieces: x 0..2 (20), 4..6 (20), 7..10 (30) → largest stays at index 0.
    expect(res.state.parts).toHaveLength(4);
    expect(res.added).toBe(2);
    expect(area(res.state.parts[0][0])).toBeCloseTo(30, 6);
    expect(res.state.parts[1][0]).toEqual(square(50, 50, 4));
    expect(res.state.styles).toEqual([0, -1, 0, 0]);
    expect(res.state.labels).toEqual(["Vael", "Isle", "", ""]);
    expect(res.state.contested).toEqual([-1, -1, -1, -1]);
    expect(res.index).toEqual([0, 1]);
    valid(res.state.parts);
    const styled = toStyledGeometry(res.state.parts, res.state.styles, res.state.labels, res.state.contested);
    expect(styled.partLegend).toEqual([0, -1, 0, 0]);
  });

  it("pieces of a locked part stay locked; a removed part's lock goes with it", () => {
    const s = st([[square(0, 0)], [square(30, 0)], [square(60, 0)]], { locked: [true, false, true] });
    const res = cutParts(s, [rect(4, -5, 5, 15), rect(29, -1, 41, 11)]);
    expect(res.state.parts).toHaveLength(3);
    expect(res.state.locked).toEqual([true, true, true]);
  });

  it("keeps holes with the piece they're in", () => {
    const res = cutParts(st([[square(0, 0, 20), square(12, 12, 4).reverse()]]), [rect(9, -5, 10, 25)]);
    expect(res.state.parts).toHaveLength(2);
    const withHole = res.state.parts.find((rings) => rings.length === 2);
    expect(withHole).toBeDefined();
    expect(inside(withHole!, [14, 14])).toBe(false);
    valid(res.state.parts);
  });

  it("flags a cut that would leave a hole touching the part's edge", () => {
    // A diamond-shaped hole whose right corner sits exactly on the cut's edge.
    const diamond: Position[] = [[14, 6], [12, 8], [14, 10], [16, 8]];
    const res = cutParts(st([[square(0, 0, 20), diamond]]), [rect(16, -5, 17, 25)]);
    expect(res.problem).toMatch(/hole touching/);
    expect(cutParts(st([[square(0, 0, 20), diamond]]), [rect(17, -5, 18, 25)]).problem).toBeNull();
  });

  it("removes a part cut away completely, and its contested zones become normal parts", () => {
    const s = st([[square(0, 0)], [square(30, 0)], [square(8, 0, 5)]], { contested: [-1, -1, 0] });
    const res = cutParts(s, [rect(-1, -1, 7, 11)], { only: [0] });
    // Only part 0 was cut (the zone overlaps it but wasn't asked for); it keeps its zone.
    expect(res.removed).toBe(0);
    expect(res.state.contested).toEqual([-1, -1, 0]);
    const gone = cutParts(s, [rect(-1, -1, 11, 11)], { only: [0] });
    expect(gone.removed).toBe(1);
    expect(gone.index).toEqual([-1, 0, 1]);
    expect(gone.orphaned).toBe(1);
    expect(gone.state.contested).toEqual([-1, -1]);
  });

  it("splitting a contested zone gives every piece the same parent, and remaps parents", () => {
    const s = st([[square(-30, 0)], [square(0, 0)], [square(5, 0)]], { contested: [-1, -1, 1], styles: [-1, -1, 0] });
    // Cut away part 0 completely and split the zone (part 2) in two.
    const res = cutParts(s, [rect(-31, -1, -19, 11), rect(9, -1, 10, 11)]);
    expect(res.removed).toBe(1);
    // Part 1 (now 0) only lost a strip at its edge; the zone (x 5..15) is in two pieces, both its zones.
    expect(res.state.parts).toHaveLength(3);
    expect(res.state.parts[0]).toHaveLength(1);
    expect(area(res.state.parts[1][0])).toBeCloseTo(50, 6);
    expect(area(res.state.parts[2][0])).toBeCloseTo(40, 6);
    expect(res.state.contested).toEqual([-1, 0, 0]);
    expect(res.state.styles).toEqual([-1, 0, 0]);
    expect(res.index).toEqual([-1, 0, 1]);
  });
});

describe("split tool", () => {
  it("a line across a part splits it in two with a tiny gap", () => {
    const res = splitParts(st([[square(0, 0)]]), [[5, -3], [5.5, 4], [5, 13]]);
    expect(res.state.parts).toHaveLength(2);
    const total = res.state.parts.reduce((a, rings) => a + area(rings[0]), 0);
    expect(total).toBeGreaterThan(100 - 10 * SPLIT_GAP * 2);
    expect(total).toBeLessThan(100);
    expect(res.state.parts.some((rings) => inside(rings, [5.25, 0.5]))).toBe(false);
    valid(res.state.parts);
    // Still two separate parts once rounded to 4 decimals and stored.
    expect(checkGeometry(toGeometry(res.state.parts))).toEqual([]);
    expect(toGeometry(res.state.parts).type).toBe("MultiPolygon");
  });

  it("a line that only goes partway in changes nothing", () => {
    const s = st([[square(0, 0)]]);
    const res = splitParts(s, [[5, -3], [5, 6]]);
    expect(res.cut).toEqual([]);
    expect(res.state.parts).toEqual(s.parts);
  });

  it("splits several parts with one line, and a part into more than two pieces", () => {
    const u: Position[] = [[0, 0], [30, 0], [30, 20], [20, 20], [20, 5], [10, 5], [10, 20], [0, 20]];
    const res = splitParts(st([[u], [square(50, 5)]]), [[-5, 12], [60, 12]]);
    // The U's two arms are cut off its base, and the square is split too.
    expect(res.state.parts).toHaveLength(5);
    expect(res.cut).toEqual([0, 1]);
    valid(res.state.parts);
  });

  it("works across the antimeridian, whichever copy the line is drawn in", () => {
    // A part from 170°E to 170°W (unwrapped to 170..190), split along the antimeridian drawn at -180.
    const s = st([[rect(170, 0, 190, 10)]]);
    const res = splitParts(s, [[-180, -5], [-180, 15]]);
    expect(res.state.parts).toHaveLength(2);
    valid(res.state.parts);
    const g = toGeometry(res.state.parts);
    const lons = (g.coordinates as unknown as number[][][][]).flat(2).map((pt) => pt[0]);
    expect(lons.every((x) => x >= -180 && x <= 180)).toBe(true);
    // One piece on each side of the antimeridian.
    expect(res.state.parts.map((rings) => Math.sign(rings[0][0][0] - 180)).sort()).toEqual([-1, 1]);
    // And the same with a cut shape drawn in the far copy.
    const cut = cutParts(s, [rect(-182 + 360 * 2, -1, -178 + 360 * 2, 11)]);
    expect(cut.state.parts).toHaveLength(2);
  });

  it("strips overlap at the joints, so a bent line leaves no bridge", () => {
    const strips = lineStrips([[0, 0], [10, 0], [10, 10]], 1);
    expect(strips).toHaveLength(2);
    // The corner point is strictly inside both strips.
    expect(strips.every((r) => pointInRing([10, 0], r))).toBe(true);
    const res = splitParts(st([[square(2, -5)]]), [[0, 0], [10, 0], [10, 10]]);
    expect(res.state.parts).toHaveLength(2);
  });
});
