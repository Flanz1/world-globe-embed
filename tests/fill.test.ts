import { describe, expect, it } from "vitest";
import type { Position } from "../src/shared/geo.ts";
import { fillArea, type Barrier } from "../src/admin/editor/fill.ts";

const box = (x: number, y: number, w: number, h: number): Barrier => ({
  closed: true,
  pts: [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ],
});
const bounds = (ring: Position[]) => ({
  w: Math.min(...ring.map((p) => p[0])),
  e: Math.max(...ring.map((p) => p[0])),
  s: Math.min(...ring.map((p) => p[1])),
  n: Math.max(...ring.map((p) => p[1])),
});

describe("fillArea", () => {
  it("fills the inside of a closed line, up to the line", () => {
    const res = fillArea([5, 5], [box(0, 0, 10, 10)], 1, 0.05);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const b = bounds(res.ring);
    for (const [got, want] of [[b.w, 0], [b.e, 10], [b.s, 0], [b.n, 10]]) expect(Math.abs(got - want)).toBeLessThan(0.15);
  });
  it("grows the window to reach a far wall", () => {
    const res = fillArea([50, 20], [box(0, 0, 100, 40)], 1, 0.05);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const b = bounds(res.ring);
    expect(b.e - b.w).toBeGreaterThan(99);
    expect(b.e - b.w).toBeLessThan(101);
  });
  it("stops at another area's border", () => {
    // A land mass 0..20 with a part on its right half: filling the left half gives 0..10.
    const res = fillArea([5, 5], [box(0, 0, 20, 10), box(10, -1, 20, 12)], 1, 0.05);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const b = bounds(res.ring);
    expect(b.e).toBeLessThan(10.01);
    expect(b.e).toBeGreaterThan(9.8);
  });
  it("follows an open coast line that meets the other borders", () => {
    const coast: Barrier = { closed: false, pts: [[0, 0], [10, 0]] };
    const res = fillArea([5, 3], [coast, { closed: false, pts: [[0, 0], [0, 6]] }, { closed: false, pts: [[10, 0], [10, 6]] }, { closed: false, pts: [[0, 6], [10, 6]] }], 1, 0.05);
    expect(res.ok).toBe(true);
  });
  it("reports an area that isn't closed in", () => {
    const gap: Barrier = { closed: false, pts: [[0, 0], [10, 0], [10, 10], [0, 10], [0, 1]] };
    expect(fillArea([5, 5], [gap], 1, 0.05)).toEqual({ ok: false, reason: "open" });
  });
  it("has nothing to fill without lines", () => {
    expect(fillArea([5, 5], [], 1, 0.05)).toEqual({ ok: false, reason: "none" });
  });
  it("fills across the antimeridian", () => {
    const res = fillArea([179, 5], [box(170, 0, 20, 10)], 1, 0.05);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(bounds(res.ring).e).toBeGreaterThan(189.8);
    // The same land seen from the other copy of the map.
    const res2 = fillArea([-179, 5], [box(170, 0, 20, 10)], 1, 0.05);
    expect(res2.ok).toBe(true);
    if (res2.ok) expect(bounds(res2.ring).w).toBeLessThan(-169.8);
  });
  it("copes with a click on the line itself", () => {
    const res = fillArea([0, 5], [box(0, 0, 10, 10)], 1, 0.05);
    expect(res.ok).toBe(true);
  });
  it("won't leak across a diagonal line", () => {
    const diag: Barrier = { closed: false, pts: [[-20, -20], [20, 20]] };
    const half: Barrier = { closed: true, pts: [[-20, -20], [20, 20], [20, -20]] };
    const res = fillArea([10, -5], [diag, half], 1, 0.05);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The lower-right triangle only: nothing past the diagonal.
    expect(res.ring.every(([x, y]) => y <= x + 0.2)).toBe(true);
  });
});
