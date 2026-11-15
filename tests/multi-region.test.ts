import { describe, expect, it } from "vitest";
import type { Position } from "../src/shared/geo.ts";
import { hasContestedLayers, regionPaintLayers } from "../src/shared/region-paint.ts";
import { legendRows, mergeRegions, parseRegionIds, regionLabelPoints, REGIONS_MAX, type RegionData } from "../src/shared/region.ts";

const square = (x: number, y: number, s = 10): Position[][] => [[[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]];
function region(id: string, color: string, polys: Position[][][], extra: Partial<RegionData> = {}): RegionData {
  return {
    id,
    slot: "s",
    name: "",
    color,
    colorLabel: id,
    fillOpacity: 0.5,
    label: true,
    legendTitle: "",
    legend: [],
    parts: polys.map(() => -1),
    labels: polys.map(() => ""),
    geometry: { type: "MultiPolygon", coordinates: polys },
    ...extra,
  };
}

describe("parseRegionIds", () => {
  it("keeps valid ids once, in order, up to the limit", () => {
    expect(parseRegionIds("a, b,a,Bad Id,c-1")).toEqual(["a", "b", "c-1"]);
    expect(parseRegionIds(null)).toEqual([]);
    expect(parseRegionIds(Array.from({ length: 30 }, (_, i) => `r${i}`).join(","))).toHaveLength(REGIONS_MAX);
  });
});

describe("mergeRegions", () => {
  const a = region("a", "#ff0000", [square(0, 0)]);
  const b = region("b", "#0000ff", [square(5, 5)]);
  it("returns one region as it is", () => expect(mergeRegions([a])).toBe(a));
  it("stacks regions without marking them contested against each other", () => {
    const m = mergeRegions([a, b]);
    expect(m.members).toEqual([a, b]);
    const layers = regionPaintLayers(m);
    expect(layers).toHaveLength(2);
    expect(hasContestedLayers(layers)).toBe(false);
  });
  it("lists every region's legend rows, a repeated one once", () => {
    const c = region("c", "#ff0000", [square(20, 20)], { colorLabel: "a" });
    expect(legendRows(mergeRegions([a, b, c])).map((e) => e.label)).toEqual(["a", "b"]);
  });
  it("cuts the underlays to the top region only with clip", () => {
    expect(regionPaintLayers(mergeRegions([a, b], true)).map((l) => !!l.clip)).toEqual([true, false]);
    expect(regionPaintLayers(mergeRegions([a, b])).map((l) => !!l.clip)).toEqual([false, false]);
  });
  it("labels each region on its own, honouring its label setting unless forced", () => {
    const x = region("x", "#111", [square(0, 0)], { name: "X" });
    const y = region("y", "#222", [square(30, 0)], { name: "Y", label: false });
    const m = mergeRegions([x, y]);
    expect(regionLabelPoints(m).map((p) => p.text)).toEqual(["X"]);
    expect(regionLabelPoints(m, true).map((p) => p.text)).toEqual(["X", "Y"]);
  });
});
