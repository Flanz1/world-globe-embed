import { describe, expect, it } from "vitest";
import { largestPart, partPlacements, placePart } from "../src/shared/label-place.ts";
import type { RegionGeometry, Ring } from "../src/shared/geo.ts";

const rect = (x0: number, y0: number, x1: number, y1: number): Ring => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]].slice(0, 4) as Ring;
/** A band of the given half-width along the line from a to b. */
const band = (a: [number, number], b: [number, number], hw: number): Ring => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy);
  const nx = (-dy / l) * hw;
  const ny = (dx / l) * hw;
  return [[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]];
};

describe("label placement", () => {
  it("a square part: label in the middle, level, sized by the part", () => {
    const p = placePart([rect(0, 0, 10, 10)])!;
    expect(p.at[0]).toBeCloseTo(5, 1);
    expect(p.at[1]).toBeCloseTo(5, 1);
    expect(p.tilted).toBe(false);
    expect(p.angle).toBe(0);
    expect(p.length).toBeCloseTo(10, 0);
    expect(p.width).toBeCloseTo(10, 0);
  });

  it("a long level strip stays level but gets its true length and width", () => {
    const p = placePart([rect(0, 0, 40, 4)])!;
    expect(p.tilted).toBe(false);
    expect(p.length).toBeCloseTo(40, 0);
    expect(p.width).toBeCloseTo(4, 0);
    expect(p.at[0]).toBeCloseTo(20, 0);
  });

  it("a narrow diagonal strip tilts along its axis and sits in the middle", () => {
    const p = placePart([band([0, 0], [40, 40], 2)])!;
    expect(p.tilted).toBe(true);
    expect(p.angle).toBeCloseTo(Math.PI / 4, 2);
    expect(p.at[0]).toBeCloseTo(20, 0);
    expect(p.at[1]).toBeCloseTo(20, 0);
    expect(p.length / p.width).toBeGreaterThan(5);
  });

  it("text is never upside down: a descending strip tilts by a negative angle", () => {
    const p = placePart([band([0, 40], [40, 0], 2)])!;
    expect(p.angle).toBeCloseTo(-Math.PI / 4, 2);
  });

  it("an L shape's label lands inside it, not in the empty corner", () => {
    const l: Ring = [[0, 0], [20, 0], [20, 4], [4, 4], [4, 20], [0, 20]];
    const p = placePart([l])!;
    const inL = (x: number, y: number) => (x >= 0 && x <= 20 && y >= 0 && y <= 4) || (x >= 0 && x <= 4 && y >= 0 && y <= 20);
    expect(inL(p.at[0], p.at[1])).toBe(true);
  });

  it("a part with a hole keeps its label out of the hole", () => {
    const p = placePart([rect(0, 0, 30, 30), rect(10, 10, 20, 20)])!;
    const inHole = p.at[0] > 10 && p.at[0] < 20 && p.at[1] > 10 && p.at[1] < 20;
    expect(inHole).toBe(false);
  });

  it("no area gives no placement", () => {
    expect(placePart([[[0, 0], [5, 5], [10, 10]]])).toBeNull();
  });

  it("works across the date line and picks the largest part", () => {
    const g: RegionGeometry = {
      type: "MultiPolygon",
      coordinates: [
        [[[170, 0], [175, 0], [175, 3], [170, 3], [170, 0]]],
        [[[170, 10], [-170, 10], [-170, 30], [170, 30], [170, 10]]],
      ],
    };
    expect(largestPart(g)).toBe(1);
    const at = partPlacements(g)[1]!.at;
    expect(Math.abs(Math.abs(at[0]) - 180)).toBeLessThan(1);
    expect(at[1]).toBeCloseTo(20, 0);
  });
});
