import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { combineRegions, combinedId, regionBases, resolveLinked } from "../src/shared/combine.ts";
import { MAX_VERTICES, checkGeometry, polygonsOf } from "../src/shared/geo.ts";
import { LEGEND_MAX, checkLegend, checkParts, regionData, type RegionFeature } from "../src/shared/region.ts";

const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
const validate = ajv.compile(JSON.parse(readFileSync(new URL("../schema/region.schema.json", import.meta.url), "utf8")) as object);

/** A small counter-clockwise square at (x, y). */
const square = (x: number, y: number, s = 2): [number, number][][] => [
  [
    [x, y],
    [x + s, y],
    [x + s, y + s],
    [x, y + s],
    [x, y],
  ],
];

function region(id: string, props: Partial<RegionFeature["properties"]>, polys: [number, number][][][]): RegionFeature {
  return {
    $schema: "../../schema/region.schema.json",
    type: "Feature",
    id,
    properties: { slot: "inara", map: "terra", color: "#c0392b", ...props },
    geometry: polys.length === 1 ? { type: "Polygon", coordinates: polys[0] } : { type: "MultiPolygon", coordinates: polys },
  };
}

const base = { slot: "inara", map: "terra" };

function expectValid(f: RegionFeature) {
  expect(validate(f), JSON.stringify(validate.errors)).toBe(true);
  expect(checkGeometry(f.geometry)).toEqual([]);
  expect(checkLegend(f.properties, f.geometry, "x")).toEqual([]);
  expect(checkParts(f.properties, f.geometry, "x")).toEqual([]);
}

describe("combineRegions", () => {
  const vael = region(
    "vael",
    {
      color: "#c0392b",
      label: true,
      legendTitle: "Holdings",
      legend: [{ label: "Vassal", color: "#2980b9" }],
      partLegend: [-1, 0, -1],
      partLabels: ["Vael", "Ost", "Vael marches"],
      partContested: [-1, -1, 0],
      description: "Old kingdom",
    },
    [square(0, 0), square(10, 0), square(2, 0)],
  );
  const keth = region(
    "keth",
    { color: "#5881ad", label: false, partLabels: ["Keth", ""], partContested: [-1, 0] },
    [square(20, 20), square(22, 20)],
  );

  it("copies every part with its label and colour (older contested zones become plain parts), leaving the originals alone", () => {
    const before = JSON.stringify([vael, keth]);
    const r = combineRegions([vael, keth], { id: "vael-keth", base });
    expect(r.errors).toEqual([]);
    const f = r.feature!;
    expect(JSON.stringify([vael, keth])).toBe(before);
    expect(f.id).toBe("vael-keth");
    expect(f.properties.slot).toBe("inara");
    expect(f.properties.map).toBe("terra");
    expect(polygonsOf(f.geometry)).toHaveLength(5);
    expect(polygonsOf(f.geometry)[3]).toEqual(square(20, 20));
    expect(f.properties.color).toBe("#c0392b");
    expect(f.properties.partLabels).toEqual(["Vael", "Ost", "Vael marches", "Keth", ""]);
    // keth's own colour becomes a legend entry named after it.
    expect(f.properties.legend).toEqual([
      { label: "Vassal", color: "#2980b9" },
      { label: "keth", color: "#5881ad" },
    ]);
    expect(f.properties.partLegend).toEqual([-1, 0, -1, 1, 1]);
    expect(f.properties.partContested).toBeUndefined();
    expect(f.properties.legendTitle).toBe("Holdings");
    expect(f.properties.description).toBe("Old kingdom");
    expect(f.properties.label).toBe(true);
    expect(r.notes.some((n) => n.includes("labels"))).toBe(true);
    expectValid(f);
    // The embed draws the same colours per part.
    const d = regionData(f);
    expect(d.parts.map((k) => (k < 0 ? d.color : d.legend[k].color))).toEqual(["#c0392b", "#2980b9", "#c0392b", "#5881ad", "#5881ad"]);
  });

  it("shares identical legend entries and renames clashing labels with a suffix", () => {
    const a = region("a", { legend: [{ label: "Vassal", color: "#2980b9" }, { label: "Ally", color: "#27ae60" }], partLegend: [0, 1] }, [square(0, 0), square(5, 0)]);
    const b = region("b", { legend: [{ label: "Vassal", color: "#2980b9" }, { label: "Ally", color: "#8e44ad" }], partLegend: [0, 1] }, [square(10, 0), square(15, 0)]);
    const r = combineRegions([a, b], { id: "ab", base });
    const f = r.feature!;
    expect(f.properties.legend).toEqual([
      { label: "Vassal", color: "#2980b9" },
      { label: "Ally", color: "#27ae60" },
      { label: "Ally (2)", color: "#8e44ad" },
    ]);
    expect(f.properties.partLegend).toEqual([0, 1, 0, 2]);
    expect(r.notes.some((n) => n.includes('"Ally (2)"'))).toBe(true);
    expectValid(f);
  });

  it("keeps a region's own colour when it matches the base colour, and leaves out empty extras", () => {
    const a = region("a", { color: "#ABC" }, [square(0, 0)]);
    const b = region("b", { color: "#aabbcc" }, [square(5, 0)]);
    const f = combineRegions([a, b], { id: "ab", base }).feature!;
    expect(f.properties.color).toBe("#aabbcc");
    expect(f.properties.legend).toBeUndefined();
    expect(f.properties.partLegend).toBeUndefined();
    expect(f.properties.partContested).toBeUndefined();
    expect(f.geometry.type).toBe("MultiPolygon");
    expectValid(f);
  });

  it("turns a legacy name into the first part's label", () => {
    const old = region("old", { name: "Old Realm", color: "#123456" }, [square(0, 0), square(4, 0)]);
    const f = combineRegions([vael, old], { id: "x", base }).feature!;
    expect(f.properties.partLabels!.slice(3)).toEqual(["Old Realm", ""]);
    expect(f.properties.legend!.at(-1)).toEqual({ label: "Old Realm", color: "#123456" });
  });

  it("refuses too few regions, too many colours and too many vertices", () => {
    expect(combineRegions([vael], { id: "x", base }).feature).toBeNull();
    const many = Array.from({ length: LEGEND_MAX + 2 }, (_, i) => region(`r${i}`, { color: `#${(i + 1).toString(16).padStart(2, "0")}0000` }, [square(i * 3, 0)]));
    expect(combineRegions(many, { id: "x", base }).errors.join()).toMatch(/legend colours/);
    const ring: [number, number][] = Array.from({ length: MAX_VERTICES / 2 + 1 }, (_, i) => {
      const t = (i / (MAX_VERTICES / 2 + 1)) * 2 * Math.PI;
      return [Math.cos(t) * 5, Math.sin(t) * 5];
    });
    const big = region("big", {}, [[[...ring, ring[0]]]]);
    const r = combineRegions([big, { ...big, id: "big2" }], { id: "x", base });
    expect(r.feature).toBeNull();
    expect(r.errors.join()).toMatch(/vertices/);
  });

  it("notes regions drawn on a different map or slot", () => {
    const other = region("other", { map: "luna" }, [square(30, 0)]);
    const moved = region("moved", { slot: "second" }, [square(40, 0)]);
    expect(regionBases([vael, other, moved]).map((b) => [b.slot, b.map, b.ids])).toEqual([
      ["inara", "terra", ["vael"]],
      ["inara", "luna", ["other"]],
      ["second", "terra", ["moved"]],
    ]);
    const r = combineRegions([vael, other, moved], { id: "x", base: { slot: "second", map: "terra" } });
    expect(r.feature!.properties.slot).toBe("second");
    expect(r.notes.some((n) => n.includes('other was drawn on the map "luna"'))).toBe(true);
    expect(r.notes.some((n) => n.includes('vael moves from slot "inara"'))).toBe(true);
  });
});

describe("combinedId", () => {
  it("joins the ids and avoids taken ones", () => {
    const a = region("vael", {}, [square(0, 0)]);
    const b = region("keth", {}, [square(5, 0)]);
    expect(combinedId([a, b], new Set())).toBe("vael-keth");
    expect(combinedId([a, b], new Set(["vael-keth"]))).toBe("vael-keth-2");
    expect(combinedId([a, b, a, b], new Set())).toBe("vael-combined");
  });
});

describe("resolveLinked", () => {
  const a = region("a", { partLabels: ["A"] }, [square(0, 0)]);
  const b = region("b", { color: "#2e86c1", partLabels: ["B"] }, [square(10, 0)]);
  const link = (linked: string[], polys = [square(50, 50)]) =>
    region("ab", { linked, partLabels: ["stale"], createdBy: { id: 7, login: "maker" }, created: "2026-11-13T00:00:00Z" }, polys);
  const lookup = (m: Record<string, RegionFeature>) => (id: string) => m[id];

  it("rebuilds the region from its linked regions as they are now, keeping its id, links and maker", () => {
    const r = resolveLinked(link(["a", "b"]), lookup({ a, b }));
    expect(r.missing).toEqual([]);
    expect(r.feature!.id).toBe("ab");
    expect(polygonsOf(r.feature!.geometry)).toHaveLength(2);
    expect(r.feature!.properties.partLabels).toEqual(["A", "B"]);
    expect(r.feature!.properties).toMatchObject({ linked: ["a", "b"], createdBy: { id: 7, login: "maker" } });
    expect(validate(r.feature)).toBe(true);
    // A change in a linked region shows up.
    const a2 = region("a", { partLabels: ["A changed"] }, [square(0, 0)]);
    expect(resolveLinked(link(["a", "b"]), lookup({ a: a2, b })).feature!.properties.partLabels).toEqual(["A changed", "B"]);
  });

  it("skips missing, linked and other-slot regions; with none left the snapshot stands", () => {
    const other = region("c", { slot: "elsewhere" }, [square(20, 0)]);
    const chained = { ...link(["a"]), id: "d" };
    const r = resolveLinked(link(["a", "gone", "c", "d"]), lookup({ a, c: other, d: chained }));
    expect(r.missing).toEqual(["gone", "c", "d"]);
    expect(polygonsOf(r.feature!.geometry)).toHaveLength(1);
    expect(resolveLinked(link(["gone"]), lookup({})).feature).toBeNull();
  });
});
