import { describe, expect, it } from "vitest";
import { TileCache, levelFor, tileGrid, tileRect, tilesAt } from "../src/shared/tiles.ts";

describe("tile grid", () => {
  it("cuts 16384 × 9462 into 8 × 5 tiles of 2048, the last row shorter", () => {
    const g = tileGrid(16384, 1.7316);
    expect(g).toEqual({ w: 16384, h: 9462, size: 2048, cols: 8, rows: 5 });
    const [u0, v0, u1, v1] = tileRect(g, 7, 4);
    expect([u0, u1]).toEqual([7 / 8, 1]);
    expect(v0).toBeCloseTo((4 * 2048) / 9462);
    expect(v1).toBe(1);
  });
  it("finds the tiles under the view, wrapping round in longitude", () => {
    const g = tileGrid(16384, 2);
    expect(tilesAt(g, [[0.5, 0.5]])).toEqual([[4, 2]]);
    expect(tilesAt(g, [[-0.01, 0.1], [1.01, 0.1]]).sort()).toEqual([[0, 0], [7, 0]]);
    expect(tilesAt(g, [[0.5, 0.5]], true).length).toBe(5);
    expect(tilesAt(g, [[0.5, 1.2]])).toEqual([[4, 3]]);
  });
});

describe("levelFor", () => {
  const levels = [{ w: 16384 }, { w: 32768 }];
  it("shows 16384 from want 12000 and 32768 from want 24000", () => {
    expect(levelFor(levels, 9000)).toBeUndefined();
    expect(levelFor(levels, 12000)?.w).toBe(16384);
    expect(levelFor(levels, 23000)?.w).toBe(16384);
    expect(levelFor(levels, 24000)?.w).toBe(32768);
    expect(levelFor([], 99999)).toBeUndefined();
    expect(levelFor(undefined, 99999)).toBeUndefined();
  });
});

describe("TileCache", () => {
  it("drops the least recently used tiles past the budget, but never ones the view needs", () => {
    const gone: string[] = [];
    const c = new TileCache<string>(2, (v) => gone.push(v));
    c.set("a", "a");
    c.set("b", "b");
    c.get("a");
    c.set("c", "c");
    expect(gone).toEqual(["b"]);
    c.set("d", "d", new Set(["a", "c"]));
    expect(gone).toEqual(["b"]); // over budget rather than drop what's on screen
    expect(c.size).toBe(3);
    c.set("e", "e");
    expect(gone.length).toBe(3);
    c.clear();
    expect(c.size).toBe(0);
  });
});
