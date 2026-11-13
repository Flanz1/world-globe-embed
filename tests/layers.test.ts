import { describe, expect, it } from "vitest";
import { legacyLayerOrder, reorderFeature } from "../src/shared/layers.ts";
import type { RegionFeature } from "../src/shared/region.ts";

const sq = (x: number, y: number, s: number): [number, number][] => [[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]];

describe("legacy layer order", () => {
  // Part 0: small, inside part 2 (big); part 1: apart; part 3: overlaps part 2.
  const f: RegionFeature = {
    type: "Feature",
    id: "r",
    properties: { slot: "s", map: "m", color: "#c33", legend: [{ label: "A", color: "#33c" }], partLegend: [0, -1, -1, -1], partLabels: ["small", "apart", "big", "edge"], partContested: [-1, -1, -1, 2] },
    geometry: { type: "MultiPolygon", coordinates: [[sq(2, 2, 2)], [sq(40, 0, 5)], [sq(0, 0, 10)], [sq(8, 0, 4)]] },
  };
  it("puts overlapping parts largest first, so small ones stay on top; others keep their place", () => {
    expect(legacyLayerOrder(f.geometry)).toEqual([2, 1, 3, 0]);
    expect(legacyLayerOrder({ type: "MultiPolygon", coordinates: [[sq(0, 0, 10)], [sq(2, 2, 2)]] })).toBeNull();
  });
  it("reorders the per-part lists with the geometry and drops partContested", () => {
    const g = reorderFeature(f, [2, 1, 3, 0]);
    expect(g.properties.partLabels).toEqual(["big", "apart", "edge", "small"]);
    // "edge" was a zone of "big" drawn in big's colour (-1).
    expect(g.properties.partLegend).toEqual([-1, -1, -1, 0]);
    expect(g.properties.partContested).toBeUndefined();
    expect(f.properties.partContested).toEqual([-1, -1, -1, 2]);
  });
});
