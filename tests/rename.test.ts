import { describe, expect, it } from "vitest";
import { renameInCategories, renameInRegion, newIdProblem } from "../src/shared/rename.ts";
import { REGION_ID, type RegionFeature } from "../src/shared/region.ts";

const feat = (props: object): RegionFeature => ({ type: "Feature", id: "x", properties: { slot: "s", map: "m", color: "#fff", ...props }, geometry: { type: "Polygon", coordinates: [] } } as unknown as RegionFeature);

describe("renameInRegion", () => {
  it("swaps linked and underlay ids and keeps the rest", () => {
    const f = feat({ linked: ["a", "old"], under: [{ id: "old", label: "L", on: true }, { id: "b" }] });
    const r = renameInRegion(f, "old", "new")!;
    expect(r.properties.linked).toEqual(["a", "new"]);
    expect(r.properties.under).toEqual([{ id: "new", label: "L", on: true }, { id: "b" }]);
    expect(f.properties.linked).toEqual(["a", "old"]);
  });
  it("returns null when nothing refers to the id", () => {
    expect(renameInRegion(feat({ linked: ["a"] }), "old", "new")).toBeNull();
    expect(renameInRegion(feat({}), "old", "new")).toBeNull();
  });
});

describe("renameInCategories", () => {
  it("swaps in lists and pinned lists", () => {
    const c = { categories: [{ id: "k", name: "K", regions: ["a", "old"], pinned: ["old"] }, { id: "j", name: "J", regions: ["b"] }] };
    const r = renameInCategories(c, "old", "new")!;
    expect(r.categories[0].regions).toEqual(["a", "new"]);
    expect(r.categories[0].pinned).toEqual(["new"]);
    expect(renameInCategories(c, "zzz", "new")).toBeNull();
  });
});

describe("newIdProblem", () => {
  const taken = new Set(["a", "old"]);
  it("flags empty, unchanged, invalid and taken ids", () => {
    expect(newIdProblem("", "old", taken, REGION_ID)).toBeTruthy();
    expect(newIdProblem("old", "old", taken, REGION_ID)).toBeTruthy();
    expect(newIdProblem("Bad Id", "old", taken, REGION_ID)).toBeTruthy();
    expect(newIdProblem("a", "old", taken, REGION_ID)).toMatch(/taken/);
    expect(newIdProblem("fresh-id", "old", taken, REGION_ID)).toBeNull();
  });
});
