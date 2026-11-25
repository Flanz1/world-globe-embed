import { describe, expect, it } from "vitest";
import { flatUnder, migrateGroups, pinGroups, regionGroups } from "../src/shared/groups.ts";
import { mergeRows } from "../src/viewer/region-ui.ts";

describe("regionGroups (older flat underlays)", () => {
  it("makes one underlay a group named after the old heading, keeping its start state and fill", () => {
    const g = regionGroups({ under: [{ id: "gethricism", label: "Religion", on: true, fill: 0.7 }], underTitle: "Religion" });
    expect(g).toEqual([{ name: "Religion", regions: [{ id: "gethricism" }], on: true, fill: 0.7 }]);
  });
  it("names a lone underlay after its label, else its region, when there was no heading", () => {
    expect(regionGroups({ under: [{ id: "x", label: "Faith" }] })[0].name).toBe("Faith");
    expect(regionGroups({ under: [{ id: "x" }] }, () => "The X")[0].name).toBe("The X");
  });
  it("makes several underlays one group each, so every toggle and its start state stays", () => {
    const g = regionGroups({ under: [{ id: "a" }, { id: "b", on: true }, { id: "c" }], underTitle: "Layers" });
    expect(g.map((x) => [x.name, x.on])).toEqual([["a", true], ["b", true], ["c", false]]);
  });
  it("prefers layerGroups, drops empty groups and keeps a region in the first group that has it", () => {
    const g = regionGroups({ layerGroups: [{ name: "A", regions: [{ id: "x" }] }, { name: "B", regions: [{ id: "x" }] }, { name: "C", regions: [{ id: "y" }] }], under: [{ id: "z" }] });
    expect(g.map((x) => x.name)).toEqual(["A", "C"]);
  });
  it("flattens groups for the embed: members take the group's start state and fill, their own fill wins", () => {
    const flat = flatUnder([{ name: "A", regions: [{ id: "x" }, { id: "y", fill: 0.4 }], fill: 0.7 }, { name: "B", regions: [{ id: "z" }] }]);
    expect(flat).toEqual([{ id: "x", on: true, fill: 0.7 }, { id: "y", on: true, fill: 0.4 }, { id: "z", on: false }]);
  });
});

describe("pinGroups (older flat pin maps)", () => {
  it("makes one group per pin map, named after it", () => {
    expect(pinGroups({ pinMaps: ["a", "b"] }, (id) => id.toUpperCase())).toEqual([{ name: "A", pinMaps: ["a"] }, { name: "B", pinMaps: ["b"] }]);
  });
});

describe("migrateGroups", () => {
  it("swaps the older fields for groups and leaves everything else alone", () => {
    const next = migrateGroups({ name: "v", under: [{ id: "g", on: true }], underTitle: "Religion", pinMaps: ["h"] } as Parameters<typeof migrateGroups>[0]);
    expect(next).toEqual({ name: "v", layerGroups: [{ name: "Religion", regions: [{ id: "g" }], on: true }], pinGroups: [{ name: "h", pinMaps: ["h"] }] });
  });
  it("changes nothing for a region without either", () => {
    expect(migrateGroups({ name: "v" } as Parameters<typeof migrateGroups>[0])).toEqual({ name: "v" });
  });
});

describe("legend section rows", () => {
  it("shows a name once however many of the group's regions use it", () => {
    expect(mergeRows([{ label: "Kethrism", color: "#111111" }, { label: "kethrism ", color: "#222222" }, { label: "Other", color: "#333333" }]).map((e) => e.label)).toEqual(["Kethrism", "Other"]);
  });
});
