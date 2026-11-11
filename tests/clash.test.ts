import { describe, expect, it } from "vitest";
import { clash, findClashes, findClashesBetween, prepare } from "../src/shared/clash.ts";
import type { Position, Ring } from "../src/shared/geo.ts";

const sq = (x: number, y: number, s = 10): Ring => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
const cw = (r: Ring): Ring => r.slice().reverse();
const P = (...rings: Ring[]) => prepare(rings);

describe("clash detection", () => {
  it("finds crossing borders", () => {
    expect(clash(P(sq(0, 0)), P(sq(5, 5)))).toBe(true);
  });

  it("finds containment both ways", () => {
    expect(clash(P(sq(0, 0, 20)), P(sq(5, 5, 3)))).toBe(true);
    expect(clash(P(sq(5, 5, 3)), P(sq(0, 0, 20)))).toBe(true);
  });

  it("finds an identical duplicate", () => {
    expect(clash(P(sq(0, 0)), P(sq(0, 0)))).toBe(true);
  });

  it("a part inside another's hole doesn't clash", () => {
    const donut = P(sq(0, 0, 20), cw(sq(5, 5, 10)));
    expect(clash(donut, P(sq(7, 7, 3)))).toBe(false);
    expect(clash(P(sq(7, 7, 3)), donut)).toBe(false);
    // Bigger than the hole: it overlaps the ring of land around it.
    expect(clash(donut, P(sq(4, 4, 12)))).toBe(true);
  });

  it("a shared snapped edge or a shared vertex doesn't clash", () => {
    expect(clash(P(sq(0, 0)), P(sq(10, 0)))).toBe(false);
    expect(clash(P(sq(0, 0)), P(sq(10, 10)))).toBe(false);
    // The shared edge has an extra vertex on one side (a T-junction).
    const b: Ring = [[10, 0], [20, 0], [20, 10], [10, 10], [10, 5]];
    expect(clash(P(sq(0, 0)), P(b))).toBe(false);
    // Partly shared edge.
    expect(clash(P(sq(0, 0)), P(sq(10, 3, 4)))).toBe(false);
  });

  it("touching at a vertex that pokes inside counts", () => {
    // A triangle whose tip sits on the square's edge and whose body comes in through a vertex.
    const tri: Ring = [[10, 5], [15, 2], [15, 8]];
    expect(clash(P(sq(0, 0)), P(tri))).toBe(false);
    const inward: Ring = [[10, 5], [5, 4], [15, 2], [15, 8], [5, 6]];
    expect(clash(P(sq(0, 0)), P(inward))).toBe(true);
  });

  it("finds a clash across the antimeridian", () => {
    // Unwrapped 175…185 vs wrapped −178…−170.
    const a: Ring = [[175, 0], [185, 0], [185, 10], [175, 10]];
    const b: Ring = [[-178, 2], [-170, 2], [-170, 8], [-178, 8]];
    expect(clash(P(a), P(b))).toBe(true);
    expect(clash(P(b), P(a))).toBe(true);
    // Stored (wrapped) form of a: 175 → -175.
    const aw: Ring = [[175, 0], [-175, 0], [-175, 10], [175, 10], [175, 0]];
    expect(clash(P(aw), P(b))).toBe(true);
    expect(findClashes([P(a), P(sq(0, 0)), P(b)])).toEqual([[0, 2]]);
    // Far apart in the other direction.
    expect(clash(P(a), P(sq(-160, 0)))).toBe(false);
  });

  it("works near the poles", () => {
    expect(clash(P(sq(0, 80, 9)), P(sq(5, 84, 5)))).toBe(true);
    expect(clash(P(sq(0, -89, 9)), P(sq(5, -85, 5)))).toBe(true);
    expect(clash(P(sq(0, 80, 5)), P(sq(5, 80, 5)))).toBe(false);
  });

  it("the broad phase skips far-apart parts and pairs across lists", () => {
    const list = [P(sq(0, 0)), P(sq(100, 0)), P(sq(5, 5)), P(sq(-100, 50))];
    expect(findClashes(list)).toEqual([[0, 2]]);
    expect(findClashes(list, new Set([1]))).toEqual([]);
    expect(findClashes(list, new Set([2]))).toEqual([[0, 2]]);
    expect(findClashesBetween([P(sq(0, 0)), P(sq(50, 50))], [P(sq(55, 55)), P(sq(-5, -5))])).toEqual(
      expect.arrayContaining([[0, 1], [1, 0]]),
    );
  });

  it("5,000 vertices in 200 parts in under 50 ms", () => {
    // 200 parts of 25 vertices on a grid, each overlapping its right neighbour.
    const parts: Prepared[] = [];
    for (let i = 0; i < 200; i++) {
      const cx = -170 + (i % 20) * 15;
      const cy = -60 + Math.floor(i / 20) * 12;
      const ring: Position[] = [];
      for (let k = 0; k < 25; k++) {
        const t = (k / 25) * Math.PI * 2;
        ring.push([cx + Math.cos(t) * 9, cy + Math.sin(t) * 5]);
      }
      parts.push(prepare([ring]));
    }
    // Best of a few runs after a warm-up, so a JIT pause or a busy CI machine doesn't decide it.
    let ms = Infinity;
    let pairs: [number, number][] = [];
    for (let run = 0; run < 4; run++) {
      const t0 = performance.now();
      const all = parts.map((p) => prepare(p.rings));
      pairs = findClashes(all);
      if (run) ms = Math.min(ms, performance.now() - t0);
    }
    expect(pairs.length).toBeGreaterThan(150);
    expect(ms, `took ${ms.toFixed(1)} ms`).toBeLessThan(50);
    console.log(`clash benchmark: 5,000 vertices in 200 parts, ${pairs.length} clashing pairs, ${ms.toFixed(1)} ms`);
  });
});

type Prepared = ReturnType<typeof prepare>;
