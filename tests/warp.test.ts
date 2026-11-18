import { describe, expect, it } from "vitest";
import { fitWarp, warpLine, warpPoint, warpShape, type WarpPair } from "../src/shared/warp.ts";
import { checkGeometry, type Position, type RegionGeometry } from "../src/shared/geo.ts";

const pair = (from: Position, to: Position): WarpPair => ({ from, to });
const near = (a: Position, b: Position, eps = 1e-6) => {
  expect(a[0]).toBeCloseTo(b[0], -Math.log10(eps));
  expect(a[1]).toBeCloseTo(b[1], -Math.log10(eps));
};
const fit = (pairs: WarpPair[], o = {}) => {
  const r = fitWarp(pairs, o);
  if (!r.ok) throw new Error(r.why);
  return r.fit;
};

/** A known affine map, to check it is reproduced. */
const shiftScale = ([x, y]: Position): Position => [x * 0.9 + 5, y * 1.1 - 3];

describe("fitWarp", () => {
  it("refuses fewer than 3 pairs, a line, and duplicate spots", () => {
    expect(fitWarp([pair([0, 0], [1, 1]), pair([10, 0], [11, 1])]).ok).toBe(false);
    const line = fitWarp([pair([0, 0], [0, 0]), pair([10, 0], [10, 0]), pair([20, 0], [20, 0])]);
    expect(line.ok).toBe(false);
    if (!line.ok) expect(line.why).toMatch(/line/);
    const dup = fitWarp([pair([0, 0], [0, 0]), pair([0, 0], [1, 1]), pair([20, 5], [20, 5]), pair([5, 20], [5, 20])]);
    expect(dup.ok).toBe(false);
  });

  it("is exact on three pairs and equals the affine map they define", () => {
    const pts: Position[] = [[-40, -10], [30, 5], [0, 40]];
    for (const o of [{ straight: true }, { wraps: false }]) {
      const f = fit(pts.map((p) => pair(p, shiftScale(p))), o);
      for (const p of pts) near(f.at(p), shiftScale(p));
      near(f.at([12, -7]), shiftScale([12, -7]));
      expect(f.check.every((c) => c === null)).toBe(true);
    }
  });

  it("reproduces an affine map from many pairs (spline without bending)", () => {
    const pts: Position[] = [[-60, -20], [50, 10], [10, 50], [-20, 30], [70, -40], [0, 0]];
    const f = fit(pts.map((p) => pair(p, shiftScale(p))), { wraps: false });
    near(f.at([22, 17]), shiftScale([22, 17]), 1e-5);
    for (const c of f.check) expect(c!).toBeLessThan(1e-6);
  });

  it("passes through every pair exactly at smoothness 0 and bends between them", () => {
    const pairs = [pair([0, 0], [0, 0]), pair([40, 0], [40, 0]), pair([0, 40], [0, 40]), pair([40, 40], [40, 40]), pair([20, 20], [24, 18])];
    const f = fit(pairs);
    for (const p of pairs) near(f.at(p.from), p.to, 1e-5);
    expect(f.residual.every((r) => r < 1e-6)).toBe(true);
    // The moved middle pair stands out in the leave-one-out check.
    const worst = f.check.indexOf(Math.max(...f.check.map((c) => c ?? 0)));
    expect(worst).toBe(4);
  });

  it("relaxes towards straight as smoothness rises", () => {
    const pairs = [pair([0, 0], [0, 0]), pair([40, 0], [40, 0]), pair([0, 40], [0, 40]), pair([40, 40], [40, 40]), pair([20, 20], [24, 18])];
    const exact = fit(pairs, { smoothness: 0 }).at([20, 20]);
    const some = fit(pairs, { smoothness: 50 }).at([20, 20]);
    const lots = fit(pairs, { smoothness: 100 }).at([20, 20]);
    const d = (p: Position) => Math.hypot(p[0] - 20, p[1] - 20);
    expect(d(exact)).toBeGreaterThan(d(some));
    expect(d(some)).toBeGreaterThan(d(lots));
  });

  it("takes pairs across the seam the short way and stays continuous there", () => {
    const pairs = [pair([170, 0], [-178, 0]), pair([-170, 10], [-158, 10]), pair([160, 30], [172, 30]), pair([0, -30], [12, -30])];
    const f = fit(pairs);
    // Everything moved 12° east: across the seam that's still a small move.
    near(warpPoint(f, [175, 5]), [-173, 5], 1e-3);
    const east = warpPoint(f, [179.999, 5]);
    const west = warpPoint(f, [-179.999, 5]);
    expect(Math.abs(((east[0] - west[0] + 540) % 360) - 180)).toBeLessThan(0.01);
  });
});

describe("warping shapes", () => {
  const bend = () => fit([pair([-50, -50], [-50, -50]), pair([50, -50], [50, -50]), pair([-50, 50], [-50, 50]), pair([50, 50], [50, 50]), pair([0, 0], [6, 4])]);
  const square: Position[] = [[-30, -30], [30, -30], [30, 30], [-30, 30]];

  it("adds points only where the bend needs them", () => {
    const straight = fit([pair([0, 0], [5, 5]), pair([10, 0], [15, 5]), pair([0, 10], [5, 15])], { straight: true });
    expect(warpLine(straight, square, true)).toHaveLength(4);
    expect(warpLine(bend(), square, true).length).toBeGreaterThan(4);
  });

  it("splits a shared edge the same way from both sides", () => {
    const f = bend();
    const a = warpLine(f, [[-30, -30], [30, -30]], false);
    const b = warpLine(f, [[30, -30], [-30, -30]], false);
    expect(b).toEqual([...a].reverse());
  });

  it("keeps a vertex two regions share on one spot", () => {
    const f = bend();
    const left: RegionGeometry = { type: "Polygon", coordinates: [[[-30, -30], [0, -30], [0, 30], [-30, 30], [-30, -30]]] };
    const right: RegionGeometry = { type: "Polygon", coordinates: [[[0, -30], [30, -30], [30, 30], [0, 30], [0, -30]]] };
    const L = warpShape(f, left).geometry.coordinates[0] as Position[];
    const R = warpShape(f, right).geometry.coordinates[0] as Position[];
    const key = (p: Position) => p.join(",");
    const shared = L.filter((p) => R.some((q) => key(q) === key(p)));
    // Both corners on x = 0 and every point added along the bent shared edge.
    expect(shared.length).toBeGreaterThan(8);
    const rightOfL = L.slice(L.findIndex((p) => key(p) === key(shared[0])), L.findIndex((p) => key(p) === key(shared[shared.length - 1])) + 1);
    expect(rightOfL).toEqual(shared);
  });

  it("returns valid geometry with holes, winding and province borders", () => {
    const g: RegionGeometry = {
      type: "MultiPolygon",
      coordinates: [
        [square.concat([square[0]]) as Position[], [[-10, -10], [-10, 10], [10, 10], [10, -10], [-10, -10]]],
        [[[35, 35], [45, 35], [45, 45], [35, 45], [35, 35]]],
      ],
    };
    const w = warpShape(bend(), g, [[[-30, 0], [30, 0]]]);
    expect(w.problems).toEqual([]);
    expect(checkGeometry(w.geometry)).toEqual([]);
    expect(w.geometry.type).toBe("MultiPolygon");
    expect(w.geometry.coordinates).toHaveLength(2);
    expect(w.provinceBorders![0].length).toBeGreaterThan(2);
    expect(w.added).toBeGreaterThan(0);
  });

  it("mirrors keep valid winding", () => {
    const flip = fit([pair([0, 0], [0, 0]), pair([10, 0], [-10, 0]), pair([0, 10], [0, 10])], { straight: true });
    const w = warpShape(flip, { type: "Polygon", coordinates: [square.concat([square[0]])] });
    expect(w.problems).toEqual([]);
  });

  it("reports outlines that would cross themselves", () => {
    // Swap two corners: the square becomes a bow tie.
    const f = fit([pair([-30, -30], [30, -30]), pair([30, -30], [-30, -30]), pair([30, 30], [30, 30]), pair([-30, 30], [-30, 30])]);
    const w = warpShape(f, { type: "Polygon", coordinates: [square.concat([square[0]])] }, undefined, Infinity);
    expect(w.problems.length).toBeGreaterThan(0);
  });

  it("warps across the seam without tearing a ring", () => {
    const f = fit([pair([170, 0], [-178, 0]), pair([-170, 10], [-158, 10]), pair([160, 30], [172, 30]), pair([0, -30], [12, -30])]);
    const ring: Position[] = [[175, -5], [-175, -5], [-175, 5], [175, 5], [175, -5]];
    const w = warpShape(f, { type: "Polygon", coordinates: [ring] });
    expect(w.problems).toEqual([]);
    // Moved 12° east, so it's now just east of the seam (-173 to -163), in one piece.
    for (const [x] of w.geometry.coordinates[0] as Position[]) {
      expect(x).toBeGreaterThan(-175);
      expect(x).toBeLessThan(-160);
    }
  });
});
