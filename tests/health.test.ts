import { describe, expect, it } from "vitest";
import { MAX_VERTICES } from "../src/shared/geo.ts";
import { checkHealth, groupIssues, healthMarkdown, type HealthInput } from "../src/shared/health.ts";
import type { PinFeature } from "../src/shared/pins.ts";
import type { RegionFeature } from "../src/shared/region.ts";

const square = (x: number, y: number, s = 10) => [[[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]];
const region = (id: string, extra: Partial<RegionFeature["properties"]> = {}, x = 0): { id: string; feature: RegionFeature } => ({
  id,
  feature: { type: "Feature", id, properties: { slot: "inara", map: "m2", color: "#fff", ...extra }, geometry: { type: "Polygon", coordinates: square(x, 0) } } as RegionFeature,
});
const pin = (id: string, at: [number, number], extra: Partial<PinFeature["properties"]> = {}): { id: string; feature: PinFeature } => ({
  id,
  feature: { type: "Feature", id, properties: { slot: "inara", map: "m2", name: id, kind: "city", ...extra }, geometry: { type: "Point", coordinates: at } },
});
type Base = Omit<HealthInput, "regions" | "pins"> & { regions: { id: string; feature: RegionFeature }[]; pins: { id: string; feature: PinFeature }[]; categories: { categories: { id: string; name: string; regions: string[] }[] } };
const base = (): Base => ({
  regions: [region("a"), region("b", {}, 20)],
  pins: [],
  categories: { categories: [{ id: "k", name: "K", regions: ["a", "b"] }] },
  pinMaps: { folders: [], maps: [] },
  slots: { slots: { inara: { map: "m2" } } },
});
const codes = (i: Base) => checkHealth(i).map((x) => `${x.code}:${x.subject.id}`);

describe("content health", () => {
  it("reports nothing for healthy content", () => {
    expect(checkHealth(base())).toEqual([]);
    expect(healthMarkdown([])).toContain("No problems");
  });
  it("flags regions and pins drawn on a different map than the slot shows", () => {
    const i = base();
    i.regions.push(region("old", { map: "m1" }, 40));
    i.categories.categories[0].regions.push("old");
    i.pins.push(pin("p", [1, 1], { map: "m1" }));
    expect(codes(i)).toEqual(["older-map:old", "older-map:p"]);
  });
  it("flags pins outside every region that shows their pin map", () => {
    const i = base();
    i.pinMaps = { folders: [], maps: [{ id: "holy", name: "Holy", slot: "inara" }] };
    i.regions[0].feature.properties.pinMaps = ["holy"];
    i.pins = [pin("in", [5, 5], { pinMap: "holy" }), pin("out", [50, 50], { pinMap: "holy" }), pin("free", [50, 50])];
    expect(codes(i)).toEqual(["pin-outside:out"]);
    // Shown by a second region that contains it: no longer outside.
    i.regions[1].feature.properties.pinMaps = ["holy"];
    i.pins[1] = pin("out", [25, 5], { pinMap: "holy" });
    expect(codes(i)).toEqual([]);
  });
  it("flags missing and unused pin maps", () => {
    const i = base();
    i.pinMaps = { folders: [], maps: [{ id: "empty", name: "Empty", slot: "inara" }] };
    i.regions[0].feature.properties.pinMaps = ["gone"];
    i.pins = [pin("p", [1, 1], { pinMap: "nope" })];
    expect(codes(i)).toEqual(["missing-pin-map:a", "missing-pin-map:p", "unused-pin-map:empty"]);
  });
  it("flags regions in no folder, only when folders exist", () => {
    const i = base();
    i.regions.push(region("loose", {}, 40));
    expect(codes(i)).toEqual(["no-category:loose"]);
    i.categories = { categories: [] };
    expect(codes(i)).toEqual([]);
  });
  it("flags empty colour folders", () => {
    const i = base();
    const p = i.regions[0].feature.properties;
    p.legend = [{ label: "Used", color: "#111" }, { label: "Empty", color: "#222" }];
    p.partLegend = [0];
    expect(checkHealth(i).map((x) => x.message)).toEqual(['The colour folder "Empty" has no parts.']);
    p.colorLabel = "Home";
    expect(checkHealth(i).some((x) => x.message.includes('"Home"'))).toBe(true);
    delete p.partLegend; // all parts in the default colour: both listed colours are unused
    expect(checkHealth(i)).toHaveLength(2);
  });
  it("flags regions near or over the vertex limit", () => {
    const i = base();
    const ring = (n: number) => Array.from({ length: n }, (_, k) => [k / 1e4, k % 7] as [number, number]);
    i.regions[0].feature.geometry = { type: "Polygon", coordinates: [ring(Math.round(MAX_VERTICES * 0.85))] };
    expect(checkHealth(i)[0]).toMatchObject({ code: "near-cap", severity: "notice" });
    i.regions[0].feature.geometry = { type: "Polygon", coordinates: [ring(MAX_VERTICES + 5)] };
    expect(checkHealth(i)[0]).toMatchObject({ code: "near-cap", severity: "problem" });
  });
  it("reports unreadable files and groups issues in the tab's order", () => {
    const i = base();
    (i.regions as HealthInput["regions"]).push({ id: "bad", feature: null, problem: "broken" });
    i.regions.push(region("old", { map: "m1" }, 40));
    const g = groupIssues(checkHealth(i));
    expect(g.map((x) => x.check.code)).toEqual(["unreadable", "older-map", "no-category"]);
    expect(healthMarkdown(checkHealth(i))).toContain("### Drawn on a different map (1)");
  });
});
