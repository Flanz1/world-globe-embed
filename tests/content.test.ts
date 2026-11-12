import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadContent } from "../scripts/lib/content.ts";
import { contentPaths } from "../scripts/lib/paths.ts";
import type { MapMeta } from "../src/shared/types.ts";

const LQIP = "data:image/webp;base64,UklGRg==";

function project(slots: unknown, maps: Partial<MapMeta>[] = [], { writeTextures = true } = {}) {
  const paths = contentPaths(mkdtempSync(path.join(tmpdir(), "wge-c-")));
  mkdirSync(paths.mapsDir, { recursive: true });
  writeFileSync(paths.slotsFile, typeof slots === "string" ? slots : JSON.stringify(slots));
  for (const m of maps) {
    const meta: MapMeta = {
      id: m.id!,
      name: m.id!,
      uploadedBy: "t",
      date: "2026-01-01T00:00:00.000Z",
      aspect: 2,
      width: 2048,
      height: 1024,
      hash: "abcdef012345",
      sizes: { "1024": `maps/${m.id}/abcdef012345-1024.webp` },
      lqip: LQIP,
      ...m,
    };
    writeFileSync(path.join(paths.mapsDir, `${meta.id}.json`), JSON.stringify(meta));
    if (writeTextures) {
      mkdirSync(path.join(paths.publicDir, "maps", meta.id), { recursive: true });
      writeFileSync(path.join(paths.publicDir, meta.sizes["1024"]!), "x");
    }
  }
  return paths;
}

describe("content validation", () => {
  it("accepts valid content", () => {
    const r = loadContent(project({ slots: { inara: { map: "terra", grid: true, lat: 10 } } }, [{ id: "terra" }]));
    expect(r.errors).toEqual([]);
    expect(r.content?.maps.get("terra")?.id).toBe("terra");
  });

  it("rejects an LQIP with anything after the base64 data", () => {
    const r = loadContent(
      project({ slots: { inara: { map: "terra" } } }, [{ id: "terra", lqip: `${LQIP}")'><script>alert(1)</script>` }]),
    );
    expect(r.content).toBeNull();
    expect(r.errors.join("\n")).toMatch(/content\/maps\/terra\.json: lqip/);
  });

  it("catches a slot that points at a missing map, with a hint", () => {
    const r = loadContent(project({ slots: { inara: { map: "tera" } } }, [{ id: "terra" }, { id: "luna" }]));
    expect(r.content).toBeNull();
    expect(r.errors).toEqual([
      'content/slots.json: slot "inara" points at map "tera", which doesn\'t exist. Did you mean "terra"? Known maps: luna, terra.',
    ]);
  });

  it("reports schema problems readably", () => {
    const r = loadContent(project({ slots: { Bad_Name: { map: "terra" }, ok: { map: "terra", gird: true, lat: 200 } } }, [{ id: "terra" }]));
    const text = r.errors.join("\n");
    expect(text).toMatch(/slot names must be lowercase/);
    expect(text).toMatch(/slots\.ok has an unknown field "gird"/);
    expect(text).toMatch(/slots\.ok\.lat must be <= 90/);
  });

  it("accepts a flat default view and rejects anything but globe or flat", () => {
    expect(loadContent(project({ slots: { a: { map: "terra", view: "flat" } } }, [{ id: "terra" }])).errors).toEqual([]);
    const r = loadContent(project({ slots: { a: { map: "terra", view: "3d" } } }, [{ id: "terra" }]));
    expect(r.content).toBeNull();
    expect(r.errors.join("\n")).toMatch(/slots\.a\.view/);
  });

  it("reports broken JSON", () => {
    const r = loadContent(project('{ "slots": { "a": { "map": "terra" } ', [{ id: "terra" }]));
    expect(r.errors[0]).toMatch(/content\/slots\.json: is not valid JSON/);
  });

  it("catches map metadata whose textures are missing", () => {
    const r = loadContent(project({ slots: { a: { map: "terra" } } }, [{ id: "terra" }], { writeTextures: false }));
    expect(r.errors[0]).toMatch(/1024px texture "public\/maps\/terra\/abcdef012345-1024\.webp" is missing/);
  });
});
