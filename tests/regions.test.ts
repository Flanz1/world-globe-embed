import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadContent } from "../scripts/lib/content.ts";
import { contentPaths } from "../scripts/lib/paths.ts";
import type { MapMeta } from "../src/shared/types.ts";
import type { RegionFeature } from "../src/shared/region.ts";
import { copyId, normalizePartLegend, parseRegionData, regionData, regionFit, regionLayers, uniqueId, zoomForCap, flatFit } from "../src/shared/region.ts";
import { ZOOM_MAX, ZOOM_MIN } from "../src/shared/params.ts";

const LQIP = "data:image/webp;base64,UklGRg==";

const good = (): RegionFeature => ({
  $schema: "../../schema/region.schema.json",
  type: "Feature",
  id: "kingdom-of-vael",
  properties: {
    name: "Kingdom of Vael",
    slot: "aerthos",
    map: "terra",
    color: "#c0392b",
    fillOpacity: 0.35,
    label: true,
    description: "Optional short text, plain text only",
    updated: "2026-11-09T12:00:00Z",
  },
  geometry: {
    type: "Polygon",
    coordinates: [[[12.5, 40.1], [17.9, 35.3], [18.2, 41.0], [12.5, 40.1]]],
  },
});

function project(regions: Record<string, unknown>, { slotMap = "terra" } = {}) {
  const paths = contentPaths(mkdtempSync(path.join(tmpdir(), "wge-r-")));
  mkdirSync(paths.mapsDir, { recursive: true });
  mkdirSync(paths.regionsDir, { recursive: true });
  writeFileSync(paths.slotsFile, JSON.stringify({ slots: { aerthos: { map: slotMap } } }));
  for (const id of ["terra", "luna"]) {
    const meta: MapMeta = {
      id,
      name: id,
      uploadedBy: "t",
      date: "2026-01-01T00:00:00.000Z",
      aspect: 2,
      width: 2048,
      height: 1024,
      hash: "abcdef012345",
      sizes: { "1024": `maps/${id}/abcdef012345-1024.webp` },
      lqip: LQIP,
    };
    writeFileSync(path.join(paths.mapsDir, `${id}.json`), JSON.stringify(meta));
    mkdirSync(path.join(paths.publicDir, "maps", id), { recursive: true });
    writeFileSync(path.join(paths.publicDir, meta.sizes["1024"]!), "x");
  }
  for (const [file, data] of Object.entries(regions))
    writeFileSync(path.join(paths.regionsDir, file), typeof data === "string" ? data : JSON.stringify(data));
  return paths;
}

/** Validates one region file and returns the joined error text. */
function errorsFor(mutate: (r: RegionFeature) => void, file = "kingdom-of-vael.json"): string {
  const r = good();
  mutate(r);
  const res = loadContent(project({ [file]: r }));
  expect(res.content).toBeNull();
  return res.errors.join("\n");
}

describe("region validation", () => {
  it("accepts a good region (clockwise example normalised: this one is CCW)", () => {
    const res = loadContent(project({ "kingdom-of-vael.json": good() }));
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
    expect(res.content?.regions?.get("kingdom-of-vael")?.properties.name).toBe("Kingdom of Vael");
  });

  it("unknown slot", () => {
    expect(errorsFor((r) => (r.properties.slot = "aerthoss"))).toMatch(
      /content\/regions\/kingdom-of-vael\.json: slot "aerthoss" doesn't exist in content\/slots\.json\. Did you mean "aerthos"\?/,
    );
  });

  it("id doesn't match the file name", () => {
    expect(errorsFor(() => {}, "vael.json")).toMatch(/"id" is "kingdom-of-vael" but the file is named "vael\.json"/);
  });

  it("unclosed ring", () => {
    expect(errorsFor((r) => (r.geometry.coordinates = [[[12.5, 40.1], [17.9, 35.3], [18.2, 41.0], [13, 40]]]))).toMatch(
      /outer ring isn't closed: the last position must repeat the first/,
    );
  });

  it("under 4 positions", () => {
    expect(errorsFor((r) => (r.geometry.coordinates = [[[12.5, 40.1], [17.9, 35.3], [12.5, 40.1]]]))).toMatch(
      /geometry\.coordinates\.0 has fewer than 4 positions; a ring needs at least 4/,
    );
  });

  it("self-intersection", () => {
    expect(errorsFor((r) => (r.geometry.coordinates = [[[0, 0], [2, 2], [2, 0], [0, 2], [0, 0]]]))).toMatch(/outer ring crosses itself: edge/);
  });

  it("ring spanning more than 180° of longitude", () => {
    expect(
      errorsFor((r) => (r.geometry.coordinates = [[[-100, 0], [-5, 0], [90, 0], [90, 10], [-5, 10], [-100, 10], [-100, 0]]])),
    ).toMatch(/outer ring spans 190° of longitude; a single ring may span at most 180°/);
  });

  it("ring containing a pole", () => {
    expect(errorsFor((r) => (r.geometry.coordinates = [[[0, 80], [90, 80], [180, 80], [-90, 80], [0, 80]]]))).toMatch(
      /goes all the way round a pole/,
    );
  });

  it("too many vertices", () => {
    const n = 5001;
    const ring = Array.from({ length: n }, (_, i) => {
      const t = (i / n) * 2 * Math.PI;
      return [Math.round(10 * Math.cos(t) * 1e4) / 1e4, Math.round(10 * Math.sin(t) * 1e4) / 1e4] as [number, number];
    });
    expect(errorsFor((r) => (r.geometry.coordinates = [[...ring, ring[0]]]))).toMatch(/has 5001 vertices; the limit is 5000/);
  });

  it("bad colour", () => {
    expect(errorsFor((r) => (r.properties.color = "red;background:url(x)"))).toMatch(/properties\.color must be a colour like #c0392b/);
  });

  it("extra property", () => {
    expect(errorsFor((r) => ((r.properties as unknown as Record<string, unknown>).onclick = "x"))).toMatch(
      /properties has an unknown field "onclick"/,
    );
    expect(errorsFor((r) => ((r as unknown as Record<string, unknown>).style = "x"))).toMatch(/\(top level\) has an unknown field "style"/);
  });

  it("wrong winding is reported with a hint", () => {
    expect(errorsFor((r) => (r.geometry.coordinates = [[[12.5, 40.1], [18.2, 41.0], [17.9, 35.3], [12.5, 40.1]]]))).toMatch(
      /outer ring must be counter-clockwise/,
    );
  });

  it("non-finite and out-of-range numbers fail", () => {
    expect(errorsFor((r) => (r.properties.fillOpacity = 2))).toMatch(/fillOpacity must be <= 1/);
    expect(errorsFor((r) => (r.geometry.coordinates[0][1] = [200, 0]))).toMatch(/must be <= 180/);
  });

  it("a slot that now shows a different map is a warning, not an error", () => {
    const res = loadContent(project({ "kingdom-of-vael.json": good() }, { slotMap: "luna" }));
    expect(res.errors).toEqual([]);
    expect(res.content).not.toBeNull();
    expect(res.warnings[0]).toMatch(/was drawn on map "terra", but slot "aerthos" now shows map "luna"/);
  });

  it("broken JSON is reported", () => {
    const res = loadContent(project({ "x.json": "{ nope" }));
    expect(res.errors[0]).toMatch(/content\/regions\/x\.json: is not valid JSON/);
  });
});

describe("region helpers", () => {
  it("parseRegionData accepts good data and rejects anything off", () => {
    const d = { id: "a", slot: "s", name: "A", color: "#abc", fillOpacity: 0.3, label: true, geometry: good().geometry };
    expect(parseRegionData(d)).toEqual({ ...d, legendTitle: "", legend: [], parts: [-1] });
    expect(parseRegionData({ ...d, color: "#abc;x" })).toBeNull();
    expect(parseRegionData({ ...d, id: "../x" })).toBeNull();
    expect(parseRegionData({ ...d, fillOpacity: Number.NaN })).toBeNull();
    expect(parseRegionData({ ...d, geometry: { type: "Polygon", coordinates: [[[0, Infinity]]] } })).toBeNull();
    expect(parseRegionData({ ...d, geometry: { type: "Point", coordinates: [0, 0] } })).toBeNull();
    const huge = Array.from({ length: 10_001 }, (_, i) => [i % 90, 0]);
    expect(parseRegionData({ ...d, geometry: { type: "Polygon", coordinates: [huge] } })).toBeNull();
    expect(parseRegionData({ ...d, name: "x".repeat(81) })).toBeNull();
  });

  it("ids: unique and copies", () => {
    expect(uniqueId("Kingdom of Vael!", new Set())).toBe("kingdom-of-vael");
    expect(uniqueId("Vael", new Set(["vael", "vael-2"]))).toBe("vael-3");
    expect(copyId("vael", new Set())).toBe("vael-copy");
    expect(copyId("vael", new Set(["vael-copy", "vael-copy-2"]))).toBe("vael-copy-3");
    expect(copyId("x".repeat(64), new Set())).toHaveLength(64);
  });

  it("fit: faces the region on the globe (after shift and padding) and zooms to it", () => {
    const fit = regionFit(good().geometry, { north: 0, south: 0, shift: 30 });
    expect(fit.lon).toBeGreaterThan(30 + 12);
    expect(fit.lon).toBeLessThan(30 + 18.5);
    expect(zoomForCap(1)).toBe(ZOOM_MAX);
    expect(zoomForCap(120)).toBe(ZOOM_MIN);
    expect(zoomForCap(30)).toBeGreaterThan(zoomForCap(60));
  });

  it("flat fit centres the bounds with a 15% margin", () => {
    const v = flatFit([170, 0, 190, 10], 2, 900, 480);
    expect(v.cx).toBe(180);
    expect(v.cy).toBe(5);
    expect(v.k).toBeCloseTo(Math.min(900 / 26, 480 / 13), 6);
  });
});

describe("region colours and legend", () => {
  const multi = (): RegionFeature => {
    const f = good();
    f.geometry = {
      type: "MultiPolygon",
      coordinates: [
        [[[12.5, 40.1], [17.9, 35.3], [18.2, 41.0], [12.5, 40.1]]],
        [[[20, 10], [25, 10], [25, 15], [20, 10]]],
        [[[30, 10], [35, 10], [35, 15], [30, 10]]],
      ],
    };
    f.properties.legendTitle = "Provinces";
    f.properties.legend = [
      { label: "North", color: "#2e86c1" },
      { label: "<b>South</b>", color: "#28b463" },
    ];
    f.properties.partLegend = [-1, 1, 0];
    return f;
  };

  it("a region with a legend validates", () => {
    const res = loadContent(project({ "kingdom-of-vael.json": multi() }));
    expect(res.errors).toEqual([]);
    expect(res.content?.regions?.size).toBe(1);
  });

  it("partLegend must have one entry per part and point at real legend entries", () => {
    const short = multi();
    short.properties.partLegend = [0, 1];
    expect(loadContent(project({ "kingdom-of-vael.json": short })).errors.join("\n")).toMatch(/"partLegend" has 2 entries but the geometry has 3 parts/);
    const bad = multi();
    bad.properties.partLegend = [0, 1, 5];
    expect(loadContent(project({ "kingdom-of-vael.json": bad })).errors.join("\n")).toMatch(/entry 2 is 5, but the legend has 2 entries/);
    const colour = multi();
    colour.properties.legend![0].color = "red;background:url(x)";
    expect(loadContent(project({ "kingdom-of-vael.json": colour })).errors.length).toBeGreaterThan(0);
  });

  it("regionData and regionLayers group the parts by colour, region colour first", () => {
    const d = regionData(multi());
    expect(d.parts).toEqual([-1, 1, 0]);
    const layers = regionLayers(d);
    expect(layers.map((l) => l.color)).toEqual(["#c0392b", "#2e86c1", "#28b463"]);
    expect(layers.map((l) => (l.geometry.type === "MultiPolygon" ? l.geometry.coordinates.length : 1))).toEqual([1, 1, 1]);
    expect(layers[1].geometry).toEqual({ type: "MultiPolygon", coordinates: [multi().geometry.coordinates[2]] });
  });

  it("normalizePartLegend pads, cuts and drops bad indices", () => {
    expect(normalizePartLegend(undefined, 2, 3)).toEqual([-1, -1]);
    expect(normalizePartLegend([2, 0, 1], 2, 3)).toEqual([2, 0]);
    expect(normalizePartLegend([3, -2, 0.5], 3, 3)).toEqual([-1, -1, -1]);
  });

  it("parseRegionData checks the legend and the part colours", () => {
    const d = regionData(multi());
    const wire = JSON.parse(JSON.stringify(d));
    expect(parseRegionData(wire)).toEqual(d);
    expect(parseRegionData({ ...wire, legend: [{ label: "x", color: "#zzz" }] })).toBeNull();
    expect(parseRegionData({ ...wire, legend: [{ label: "x".repeat(61), color: "#abc" }] })).toBeNull();
    expect(parseRegionData({ ...wire, legend: Array.from({ length: 17 }, () => ({ label: "x", color: "#abc" })) })).toBeNull();
    expect(parseRegionData({ ...wire, parts: [0, 1] })).toBeNull();
    expect(parseRegionData({ ...wire, parts: [0, 1, 2] })).toBeNull();
    expect(parseRegionData({ ...wire, legendTitle: 5 })).toBeNull();
    // Old data without the legend fields still loads.
    const old = { ...wire };
    delete old.legend;
    delete old.legendTitle;
    delete old.parts;
    expect(parseRegionData(old)?.parts).toEqual([-1, -1, -1]);
  });
});
