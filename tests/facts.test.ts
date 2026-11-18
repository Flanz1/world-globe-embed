import { describe, expect, it } from "vitest";
import { bordering, computeFacts, parseFacts, type FactsRegion } from "../src/shared/facts.ts";
import { hitPart } from "../src/viewer/region-card.ts";
import { categoryRoots } from "../scripts/lib/facts.ts";
import { sphericalArea, type Ring } from "../src/shared/geo.ts";
import type { RegionData } from "../src/shared/region.ts";

const box = (w: number, s: number, e: number, n: number): Ring => [[w, s], [e, s], [e, n], [w, n], [w, s]];
const region = (id: string, rings: Ring[], group = ""): FactsRegion => ({ id, name: id.toUpperCase(), geometry: rings.length === 1 ? { type: "Polygon", coordinates: [rings[0]] } : { type: "MultiPolygon", coordinates: rings.map((r) => [r]) }, group });
const FRAME = { north: 0, south: 0, shift: 0 };

describe("bordering", () => {
  it("finds regions that share an edge, in both directions", () => {
    const r = [region("a", [box(0, 0, 10, 10)]), region("b", [box(10, 0, 20, 10)]), region("c", [box(40, 0, 50, 10)])];
    const b = bordering(r);
    expect(b[0]).toEqual([[1]]);
    expect(b[1]).toEqual([[0]]);
    expect(b[2]).toEqual([[]]);
  });
  it("finds a shared border where only one side has vertices along it", () => {
    const a = box(0, 0, 10, 10);
    const bRing: Ring = [[10, 0], [20, 0], [20, 10], [10, 10], [10, 6], [10, 3], [10, 0]];
    const b = bordering([region("a", [a]), region("b", [bRing])]);
    expect(b[0]).toEqual([[1]]);
  });
  it("ignores a lone touching corner, a gap, and regions in another group", () => {
    const corner = bordering([region("a", [box(0, 0, 10, 10)]), region("b", [box(10, 10, 20, 20)])]);
    expect(corner[0]).toEqual([[]]);
    const gap = bordering([region("a", [box(0, 0, 10, 10)]), region("b", [box(10.5, 0, 20, 10)])]);
    expect(gap[0]).toEqual([[]]);
    const groups = bordering([region("a", [box(0, 0, 10, 10)], "country"), region("b", [box(10, 0, 20, 10)], "religion")]);
    expect(groups[0]).toEqual([[]]);
  });
  it("matches across the antimeridian and orders by shared length", () => {
    const west = box(170, 0, 180, 10);
    const east: Ring = [[-180, 0], [-170, 0], [-170, 10], [-180, 10], [-180, 0]];
    const long = region("c", [box(160, 0, 170, 10)]);
    const r = bordering([region("a", [west]), region("b", [east]), long]);
    expect(r[0][0].sort()).toEqual([1, 2]);
    expect(r[2][0]).toEqual([0]);
  });
  it("keeps each part's neighbours separate", () => {
    const r = bordering([region("a", [box(0, 0, 10, 10), box(100, 0, 110, 10)]), region("b", [box(10, 0, 20, 10)])]);
    expect(r[0]).toEqual([[1], []]);
  });
});

describe("computeFacts", () => {
  it("gives each part's share of the sphere, the neighbours and the pins inside", () => {
    const regions = [region("a", [box(0, 0, 10, 10), box(100, 0, 110, 10)]), region("b", [box(10, 0, 20, 10)])];
    const pins = [
      { name: "Port", kind: "port" as const, at: [5, 5] as [number, number] },
      { name: "Far", kind: "city" as const, at: [-90, 5] as [number, number], pinMap: "x" },
      { name: "Fort", kind: "fortress" as const, at: [105, 2] as [number, number], pinMap: "forts" },
    ];
    const f = computeFacts(regions, pins, FRAME).get("a")!;
    const want = sphericalArea({ type: "Polygon", coordinates: [box(0, 0, 10, 10)] }) / (4 * Math.PI);
    expect(f.p[0].a).toBeCloseTo(want, 6);
    expect(f.t).toBeCloseTo(f.p[0].a + f.p[1].a, 6);
    expect(f.p[0].n?.map((k) => f.r[k].id)).toEqual(["b"]);
    expect(f.p[1].n).toBeUndefined();
    expect(f.p[0].i?.map((k) => f.i[k].name)).toEqual(["Port"]);
    expect(f.p[1].i?.map((k) => f.i[k])).toEqual([{ name: "Fort", kind: "fortress", map: "forts" }]);
  });
  it("measures on the globe, after pole padding", () => {
    const r = [region("a", [box(0, 0, 10, 10)])];
    const plain = computeFacts(r, [], FRAME).get("a")!.t;
    const padded = computeFacts(r, [], { north: 20, south: 20, shift: 0 }).get("a")!.t;
    expect(padded).toBeLessThan(plain);
  });
});

describe("parseFacts", () => {
  const good = { v: 1, t: 0.2, p: [{ a: 0.1, n: [0], i: [0] }, { a: 0.1 }], r: [{ id: "b", name: "B" }], i: [{ name: "Port", kind: "port" }] };
  it("accepts a facts file for the right number of parts", () => {
    expect(parseFacts(good, 2)?.p[0]).toEqual({ a: 0.1, n: [0], i: [0] });
  });
  it("rejects the wrong shape, the wrong part count and bad numbers", () => {
    expect(parseFacts(null, 2)).toBeNull();
    expect(parseFacts({ ...good, v: 2 }, 2)).toBeNull();
    expect(parseFacts(good, 3)).toBeNull();
    expect(parseFacts({ ...good, p: [{ a: 7 }, { a: 0.1 }] }, 2)).toBeNull();
  });
  it("drops references that point nowhere and entries that aren't valid", () => {
    const f = parseFacts({ ...good, p: [{ a: 0.1, n: [0, 5], i: [3] }, { a: 0.1 }], r: [{ id: "b", name: "B" }, { id: "Bad Id", name: "x" }], i: [{ name: "x", kind: "nope" }] }, 2)!;
    expect(f.p[0]).toEqual({ a: 0.1, n: [0] });
  });
});

describe("hitPart", () => {
  const data = (id: string, rings: Ring[], extra: Partial<RegionData> = {}): RegionData => ({
    id,
    slot: "s",
    name: "",
    color: "#fff",
    colorLabel: "",
    fillOpacity: 0.3,
    label: true,
    legendTitle: "",
    legend: [],
    parts: rings.map(() => -1),
    labels: rings.map(() => ""),
    geometry: { type: "MultiPolygon", coordinates: rings.map((r) => [r]) },
    ...extra,
  });
  it("returns the topmost part under the point", () => {
    const r = data("a", [box(0, 0, 10, 10), box(5, 5, 15, 15)]);
    expect(hitPart(r, [7, 7])).toMatchObject({ part: 1 });
    expect(hitPart(r, [2, 2])).toMatchObject({ part: 0 });
    expect(hitPart(r, [50, 50])).toBeNull();
  });
  it("finds the stacked region on top, and skips underlays (their parts are cut copies)", () => {
    const a = data("a", [box(0, 0, 10, 10)]);
    const b = data("b", [box(5, 0, 15, 10)]);
    const u = data("u@b", [box(5, 0, 10, 10)], { underOf: "b" });
    const merged = { ...a, id: "a,b", members: [a, b] };
    expect(hitPart(merged, [7, 5])?.region.id).toBe("b");
    expect(hitPart(merged, [2, 5])?.region.id).toBe("a");
    const withUnder = { ...a, id: "x", members: [u, b], clip: true };
    expect(hitPart(withUnder, [7, 5])?.region.id).toBe("b");
    expect(hitPart({ ...a, id: "x", members: [a, b], clip: true }, [2, 5])).toBeNull();
  });
});

describe("categoryRoots", () => {
  it("maps each region to the top-level folder it sits under", () => {
    const m = categoryRoots({ categories: [{ id: "country", name: "Country", regions: [] }, { id: "n", name: "N", parent: "country", regions: ["x"] }, { id: "religion", name: "R", regions: ["y"] }] });
    expect(m.get("x")).toBe("country");
    expect(m.get("y")).toBe("religion");
    expect(m.get("z")).toBeUndefined();
  });
});
