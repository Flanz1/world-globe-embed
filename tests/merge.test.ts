import { describe, expect, it } from "vitest";
import { combineKind, combineParts, extendPart, type MergeResult } from "../src/admin/editor/merge.ts";
import { toGeometry, type EditorState, type Parts } from "../src/admin/editor/model.ts";
import { checkGeometry, pointInRing, signedArea, type Position, type Ring } from "../src/shared/geo.ts";

const rect = (x0: number, y0: number, x1: number, y1: number): Position[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const props = { color: "#c0392b", fillOpacity: 0.35, label: true, description: "", legendTitle: "", colorLabel: "", legend: [{ label: "A", color: "#2e86c1" }] };
const st = (parts: Parts, extra: Partial<EditorState> = {}): EditorState => ({
  parts,
  styles: parts.map(() => -1),
  labels: parts.map(() => ""),
  contested: parts.map(() => -1),
  locked: parts.map(() => false),
  labelHidden: parts.map(() => false),
  props: { ...props, legend: [...props.legend] },
  ...extra,
});
const ok = (r: MergeResult | string): MergeResult => {
  if (typeof r === "string") throw new Error(r);
  return r;
};
const area = (rings: Ring[]) => rings.reduce((a, r, i) => a + (i ? -1 : 1) * Math.abs(signedArea(r)), 0);
const inside = (rings: Ring[], pt: Position) => pointInRing(pt, rings[0]) && !rings.slice(1).some((h) => pointInRing(pt, h));
const valid = (parts: Parts) => expect(checkGeometry(toGeometry(parts))).toEqual([]);

describe("combine parts", () => {
  it("overlapping parts become one, keeping the first part's place", () => {
    const s = st([[rect(-50, -50, -40, -40)], [rect(0, 0, 10, 10)], [rect(5, 5, 15, 15)]], { labels: ["", "Breza", "East"], styles: [-1, 0, -1] });
    const r = ok(combineParts(s, [1, 2], 0, 1));
    expect(r.state.parts).toHaveLength(2);
    expect(r.into).toBe(1);
    expect(r.index).toEqual([0, 1, 1]);
    expect(r.state.labels).toEqual(["", "Breza"]);
    expect(r.state.styles).toEqual([-1, 0]);
    expect(area(r.state.parts[1])).toBeCloseTo(175, 6);
    expect(r.filled).toBe(0);
    valid(r.state.parts);
  });

  it("parts that only share an edge are joined without a seam", () => {
    const r = ok(combineParts(st([[rect(0, 0, 10, 10)], [rect(10, 0, 20, 10)]]), [0, 1], 0, 1));
    expect(r.state.parts).toHaveLength(1);
    expect(r.state.parts[0]).toHaveLength(1);
    expect(area(r.state.parts[0])).toBeCloseTo(200, 6);
  });

  it("fills a small gap between parts, and only the gap", () => {
    // 0.4 wide gap between the squares.
    const s = st([[rect(0, 0, 10, 10)], [rect(10.4, 0, 20, 10)]]);
    expect(combineParts(s, [0, 1], 0, 1)).toMatch(/don't touch/);
    expect(combineParts(s, [0, 1], 0.3, 1)).toMatch(/don't touch/);
    const r = ok(combineParts(s, [0, 1], 1, 1));
    expect(r.filled).toBe(1);
    expect(r.state.parts).toHaveLength(1);
    const rings = r.state.parts[0];
    expect(inside(rings, [10.2, 5])).toBe(true);
    // The gap is filled about edge to edge, not bulging beyond the parts.
    // Parts are 100 + 96; the gap adds 0.4 × 10 and nothing more.
    expect(area(rings)).toBeCloseTo(200, 6);
    expect(inside(rings, [10.2, 10.3])).toBe(false);
    expect(inside(rings, [10.2, -0.3])).toBe(false);
    valid(r.state.parts);
  });

  it("leaves the parts' own corners and dents alone", () => {
    // A C-shaped part (its bay 4 high), next to a square 0.3 away.
    const L: Position[] = [[0, 0], [10, 0], [10, 4], [4.5, 4], [4.5, 8], [10, 8], [10, 10], [0, 10]];
    const s = st([[L], [rect(10.3, 0, 20, 10)]]);
    const r = ok(combineParts(s, [0, 1], 1, 1));
    expect(r.state.parts).toHaveLength(1);
    // The L's inner bay stays open.
    expect(inside(r.state.parts[0], [7, 6])).toBe(false);
    // The gap where the L's arms meet the square is filled.
    expect(inside(r.state.parts[0], [10.15, 2])).toBe(true);
    expect(inside(r.state.parts[0], [10.15, 9])).toBe(true);
  });

  it("works across the antimeridian", () => {
    // Part 0 east of 180 (unwrapped as 185), part 1 written in the -180 copy.
    const s = st([[rect(170, 0, 179.9, 10)], [rect(-180, 0, -170, 10)]]);
    const r = ok(combineParts(s, [0, 1], 0.5, 1));
    expect(r.state.parts).toHaveLength(1);
    const xs = r.state.parts[0][0].map(([x]) => x);
    expect(Math.min(...xs)).toBeCloseTo(170, 6);
    expect(Math.max(...xs)).toBeCloseTo(190, 6);
    valid(r.state.parts);
  });

  it("keeps a lock, and moves zones of a merged-away part to the result", () => {
    const s = st([[rect(0, 0, 10, 10)], [rect(10, 0, 20, 10)], [rect(18, 2, 25, 8)]], { contested: [-1, -1, 1], locked: [false, true, false] });
    const r = ok(combineParts(s, [0, 1], 0, 1));
    expect(r.state.locked).toEqual([true, false]);
    expect(r.state.contested).toEqual([-1, 0]);
  });

  it("a part with its own zone absorbs it; mixed kinds are refused", () => {
    const s = st([[rect(0, 0, 10, 10)], [rect(8, 0, 14, 10)], [rect(30, 0, 40, 10)], [rect(38, 0, 44, 10)]], { contested: [-1, 0, -1, 2] });
    expect(combineKind(s.contested, [0, 1])).toBe(-1);
    expect(typeof combineKind(s.contested, [0, 3])).toBe("string");
    expect(typeof combineKind(s.contested, [1, 3])).toBe("string");
    const r = ok(combineParts(s, [0, 1], 0, 1));
    expect(r.state.contested).toEqual([-1, -1, 1]);
  });

  it("two zones of the same part stay a zone of it", () => {
    const s = st([[rect(0, 0, 10, 10)], [rect(10, 0, 14, 4)], [rect(14, 0, 18, 4)]], { contested: [-1, 0, 0] });
    const r = ok(combineParts(s, [1, 2], 0, 1));
    expect(r.state.contested).toEqual([-1, 0]);
  });

  it("keeps holes, and takes the first label found", () => {
    const s = st([[rect(0, 0, 10, 10), rect(2, 2, 4, 4)], [rect(10, 0, 20, 10)]], { labels: ["", "B"] });
    const r = ok(combineParts(s, [0, 1], 0, 1));
    expect(r.state.parts[0]).toHaveLength(2);
    expect(r.state.labels).toEqual(["B"]);
  });
});

describe("extend part", () => {
  it("adds a drawn shape that overlaps the part", () => {
    const r = ok(extendPart(st([[rect(0, 0, 10, 10)]]), 0, rect(8, 2, 16, 6), 0, 1));
    expect(r.state.parts).toHaveLength(1);
    expect(area(r.state.parts[0])).toBeCloseTo(100 + 6 * 4, 6);
    expect(inside(r.state.parts[0], [14, 4])).toBe(true);
  });

  it("closes a small gap to the part, and refuses a shape that's too far", () => {
    const s = st([[rect(0, 0, 10, 10)]]);
    const r = ok(extendPart(s, 0, rect(10.2, 2, 16, 6), 0.5, 1));
    expect(inside(r.state.parts[0], [10.1, 4])).toBe(true);
    expect(r.filled).toBe(1);
    expect(extendPart(s, 0, rect(12, 2, 16, 6), 0.5, 1)).toMatch(/touch or overlap/);
  });

  it("fills a hole the shape covers and leaves other parts alone", () => {
    const s = st([[rect(0, 0, 10, 10), rect(4, 4, 6, 6)], [rect(20, 0, 30, 10)]], { labels: ["A", "B"], locked: [true, false] });
    const r = ok(extendPart(s, 0, rect(3, 3, 7, 7), 0, 1));
    expect(r.state.parts[0]).toHaveLength(1);
    expect(r.state.parts[1]).toEqual(s.parts[1]);
    expect(r.state.labels).toEqual(["A", "B"]);
    expect(r.state.locked).toEqual([true, false]);
  });

  it("works across the antimeridian", () => {
    const r = ok(extendPart(st([[rect(170, 0, 180, 10)]]), 0, rect(-181, 2, -175, 6), 0, 1));
    const xs = r.state.parts[0][0].map(([x]) => x);
    expect(Math.max(...xs)).toBeCloseTo(185, 6);
    valid(r.state.parts);
  });

  it("a zone extended stays a zone", () => {
    const s = st([[rect(0, 0, 10, 10)], [rect(10, 0, 14, 4)]], { contested: [-1, 0] });
    const r = ok(extendPart(s, 1, rect(12, 2, 18, 6), 0, 1));
    expect(r.state.contested).toEqual([-1, 0]);
  });
});

describe("province borders survive combining and extending", () => {
  const lines = [[[2, 5], [8, 5]] as [number, number][]];
  const withLines = (parts: Parameters<typeof st>[0]) => ({ ...st(parts), lines: lines.map((l) => l.map(([x, y]) => [x, y] as [number, number])) });
  it("extend keeps them", () => {
    const r = extendPart(withLines([[rect(0, 0, 10, 10)]]), 0, rect(8, 2, 16, 6), 0, 1);
    expect(typeof r).not.toBe("string");
    expect((r as MergeResult).state.lines).toEqual(lines);
  });
  it("combine keeps them", () => {
    const r = combineParts(withLines([[rect(0, 0, 10, 10)], [rect(10, 0, 20, 10)]]), [0, 1], 0.5, 1);
    expect(typeof r).not.toBe("string");
    expect((r as MergeResult).state.lines).toEqual(lines);
  });
});

describe("combine big parts", () => {
  // Two coastlines of 20,000 vertices each, a hair apart: filling the gap used to compare every
  // segment with every other (many seconds), now only neighbours.
  const coast = (n: number, cx: number): Position[] =>
    Array.from({ length: n }, (_, i) => {
      const t = (i / n) * 2 * Math.PI;
      const r = 20 * (1 + 0.1 * Math.sin(5 * t) + 0.004 * Math.sin(97 * t));
      return [Math.round((cx + Math.cos(t) * r) * 1e4) / 1e4, Math.round(Math.sin(t) * r * 0.8 * 1e4) / 1e4] as Position;
    });

  it("fills a gap between two 20,000-vertex parts in a couple of seconds", () => {
    const t0 = performance.now();
    const r = ok(combineParts(st([[coast(20000, 0)], [coast(20000, 40.3)]]), [0, 1], 0.5, 1));
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(r.state.parts).toHaveLength(1);
    expect(r.filled).toBe(1);
    expect(r.state.parts[0][0].length).toBeGreaterThan(30000);
  });
});
