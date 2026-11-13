import { describe, expect, it } from "vitest";
import { regionBorders } from "../src/shared/borders.ts";
import type { Ring } from "../src/shared/geo.ts";
import { hasContestedMarks, regionPaintSpec } from "../src/shared/region-paint.ts";

/** A closed counter-clockwise box, as stored. */
const box = (w: number, s: number, e: number, n: number): Ring => [
  [w, s],
  [e, s],
  [e, n],
  [w, n],
  [w, s],
];

describe("regionBorders", () => {
  // Three provinces in a row: A | B share x = 10, B | C share x = 20.
  const A = [box(0, 0, 10, 10)];
  const B = [box(10, 0, 20, 10)];
  const C = [box(20, 0, 30, 10)];
  it("same-group shared lines aren't national, only hidden", () => {
    const b = regionBorders([A, B, C], () => 0);
    expect(b.national).toEqual([]);
  });
  it("hides the shared edges from both parts' outlines", () => {
    const b = regionBorders([A, B, C], () => 0);
    expect([...b.hide[0][0]]).toEqual([1]);
    expect([...b.hide[1][0]].sort()).toEqual([1, 3]);
    expect([...b.hide[2][0]]).toEqual([3]);
  });
  it("calls a line between different groups national", () => {
    const b = regionBorders([A, B, C], (p) => (p === 2 ? 1 : 0));
    expect(b.national.map((l) => l[0][0])).toEqual([20]);
  });
  it("leaves out polygons with a null group", () => {
    const b = regionBorders([A, B, C], (p) => (p === 1 ? null : 0));
    expect(b.national).toEqual([]);
    expect(b.hide.every((poly) => poly.every((h) => h.size === 0))).toBe(true);
  });
  it("joins consecutive shared lines into one polyline", () => {
    const A2: Ring[] = [[[0, 0], [10, 0], [10, 5], [10, 10], [0, 10], [0, 0]]];
    const B2: Ring[] = [[[10, 5], [10, 0], [20, 0], [20, 10], [10, 10], [10, 5]]];
    const b = regionBorders([A2, B2], (p) => p);
    expect(b.national).toHaveLength(1);
    expect(b.national[0]).toEqual([[10, 0], [10, 5], [10, 10]]);
  });
  it("matches lines across the antimeridian copy", () => {
    const W = [box(170, 0, 180, 10)];
    const E = [box(-180, 0, -170, 10)];
    expect(regionBorders([W, E], (p) => p).national).toHaveLength(1);
  });
  it("finds nothing where parts only touch at a corner or overlap", () => {
    expect(regionBorders([A, [box(10, 10, 20, 20)]], (p) => p).national).toEqual([]);
    expect(regionBorders([A, [box(5, 0, 15, 10)]], (p) => p).national).toEqual([]);
  });
});

describe("paint spec", () => {
  const base = { color: "#c0392b", legend: [{ label: "Breza", color: "#c0392b" }, { label: "Selbia", color: "#2e86c1" }] };
  const geometry = { type: "MultiPolygon" as const, coordinates: [[box(0, 0, 10, 10)], [box(10, 0, 20, 10)], [box(20, 0, 30, 10)]] };
  it("a national border (different colours) makes the spec non-plain and hides the shared edges", () => {
    const spec = regionPaintSpec({ ...base, parts: [0, 0, 1], geometry, nationalBorders: true });
    expect(spec.plain).toBe(false);
    expect(spec.borders?.national).toHaveLength(1);
    expect(spec.parts[2].hide?.[0].size).toBe(1);
  });
  it("province borders are carried through", () => {
    const apart = { type: "MultiPolygon" as const, coordinates: [[box(0, 0, 10, 10)]] };
    const spec = regionPaintSpec({ ...base, parts: [0], geometry: apart, provinceBorders: [[[5, 0], [5, 10]]] });
    expect(spec.plain).toBe(false);
    expect(spec.borders?.provincial).toHaveLength(1);
  });
  it("a region without shared lines stays plain", () => {
    const apart = { type: "MultiPolygon" as const, coordinates: [[box(0, 0, 10, 10)], [box(11, 0, 20, 10)], [box(21, 0, 30, 10)]] };
    const spec = regionPaintSpec({ ...base, parts: [0, 0, 1], geometry: apart });
    expect(spec.plain).toBe(true);
    expect(spec.borders).toBeUndefined();
  });
  it("parts that share a line just touch unless national borders are asked for", () => {
    const spec = regionPaintSpec({ ...base, parts: [0, 0, 1], geometry });
    expect(spec.plain).toBe(true);
    expect(spec.borders).toBeUndefined();
    expect(spec.parts.every((p) => !p.hide)).toBe(true);
  });
  it("overlapping parts are layers: each part lists the later parts that cover it", () => {
    const over = { type: "MultiPolygon" as const, coordinates: [[box(0, 0, 10, 10)], [box(5, 0, 15, 10)], [box(8, 2, 12, 8)], [box(30, 0, 40, 10)]] };
    const spec = regionPaintSpec({ ...base, legend: [], parts: [-1, -1, -1, -1], geometry: over });
    expect(spec.plain).toBe(false);
    expect(spec.front).toEqual([[1, 2], [2], [], []]);
    // All one colour: overlapping, but nothing contested.
    expect(hasContestedMarks(spec)).toBe(false);
  });
  it("overlapping parts of different colours are contested (legend row)", () => {
    const over = { type: "MultiPolygon" as const, coordinates: [[box(0, 0, 10, 10)], [box(5, 0, 15, 10)], [box(30, 0, 40, 10)]] };
    expect(hasContestedMarks(regionPaintSpec({ ...base, parts: [0, 1, 0], geometry: over }))).toBe(true);
    const apart = { type: "MultiPolygon" as const, coordinates: [[box(0, 0, 10, 10)], [box(11, 0, 15, 10)]] };
    expect(hasContestedMarks(regionPaintSpec({ ...base, parts: [0, 1], geometry: apart }))).toBe(false);
  });
});

describe("contested cells", () => {
  const sq = (w: number, s: number, e: number, n: number): Ring[] => [box(w, s, e, n)];
  it("three overlapping colours: every pair and the triple, each with all its colours in part order", () => {
    // A, B, C overlap in one spot; D (same colour as A) only touches A.
    const over = { type: "MultiPolygon" as const, coordinates: [sq(0, 0, 10, 10), sq(5, 0, 15, 10), sq(3, 5, 12, 15), sq(-5, 0, 2, 3)] };
    const legend = [{ label: "B", color: "#00ff00" }, { label: "C", color: "#0000ff" }];
    const spec = regionPaintSpec({ color: "#ff0000", legend, parts: [-1, 0, 1, -1], geometry: over });
    const cells = spec.cells.map((c) => [c.parts.join(""), c.colors.join(" "), c.outside.join("")]);
    expect(cells).toEqual([
      ["01", "#ff0000 #00ff00", "23"],
      ["012", "#ff0000 #00ff00 #0000ff", "3"],
      ["02", "#ff0000 #0000ff", "13"],
      ["12", "#00ff00 #0000ff", "0"],
    ]);
    // A and D are one colour: they just overlap, nothing contested between them.
    expect(spec.overlaps[0]).toEqual([1, 2, 3]);
    expect(hasContestedMarks(spec)).toBe(true);
  });
  it("an occupied area is striped like any overlap (it only keeps the borders under it)", () => {
    // Orange home part, green part beside it, an orange occupied area reaching into the green.
    const over = { type: "MultiPolygon" as const, coordinates: [sq(0, 0, 10, 10), sq(10, 0, 20, 10), sq(8, 2, 16, 8)] };
    const legend = [{ label: "Green", color: "#00ff00" }];
    const spec = regionPaintSpec({ color: "#ff8800", legend, parts: [-1, 0, -1], occupied: [false, false, true], geometry: over });
    expect(spec.cells).toEqual([{ parts: [1, 2], outside: [0], colors: ["#00ff00", "#ff8800"] }]);
    expect(spec.overlaps).toEqual([[2], [2], [0, 1]]);
    expect(spec.parts[2].occupied).toBe(true);
    expect(spec.plain).toBe(false);
  });
  it("an occupied area over nothing of another colour isn't contested", () => {
    const one = { type: "MultiPolygon" as const, coordinates: [sq(0, 0, 10, 10)] };
    const spec = regionPaintSpec({ color: "#ff0000", legend: [], parts: [-1], occupied: [true], geometry: one });
    expect(spec.cells).toEqual([]);
    expect(hasContestedMarks(spec)).toBe(false);
  });
});
