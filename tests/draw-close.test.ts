import { describe, expect, it } from "vitest";
import { trimStrokeOvershoot } from "../src/admin/editor/model.ts";
import { findSelfIntersection, type Position } from "../src/shared/geo.ts";

describe("trimStrokeOvershoot", () => {
  const square: Position[] = [[0, 0], [10, 0], [10, 10], [0, 10]];

  it("leaves a clean stroke alone", () => {
    expect(trimStrokeOvershoot(square)).toEqual(square);
  });

  it("trims a stroke that overshoots its start and crosses the first edge", () => {
    const over: Position[] = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 4], [5, -2]];
    const out = trimStrokeOvershoot(over);
    expect(findSelfIntersection(out)).toBeNull();
    expect(out.length).toBeGreaterThanOrEqual(3);
    expect(out[0][1]).toBeCloseTo(0, 6);
  });

  it("keeps a long loop that crosses itself (a figure-eight is still refused)", () => {
    const eight: Position[] = [[0, 0], [10, 10], [20, 0], [10, -10], [0, 0.01], [-10, 10], [-20, 0], [-10, -10], [5, 5]];
    const out = trimStrokeOvershoot(eight);
    expect(out).toEqual(eight);
  });
});
