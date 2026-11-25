import { describe, expect, it } from "vitest";
import { ATLAS_JS, atlasGroups, displayName, tileTitle, generateAtlasPages, outlinePath, SITE_TOKEN } from "../scripts/lib/atlas.ts";
import type { Content } from "../scripts/lib/content.ts";
import type { CategoriesFile } from "../src/shared/categories.ts";
import type { RegionFeature } from "../src/shared/region.ts";
import { createHash } from "node:crypto";

const region = (id: string, slot = "inara", extra: Record<string, unknown> = {}): RegionFeature =>
  ({
    type: "Feature",
    id,
    properties: { slot, map: "m", color: "#7952e5", fillOpacity: 0.35, label: true, ...extra },
    geometry: { type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 5], [0, 5], [0, 0]]] },
  }) as unknown as RegionFeature;

const regions = new Map([region("a"), region("b", "inara", { partLabels: ["", "Bee <b>"] }), region("c"), region("z", "other")].map((r) => [r.id, r]));
const cats: CategoriesFile = {
  categories: [
    { id: "land", name: "Land", regions: ["a"] },
    { id: "north", name: "North", parent: "land", regions: ["b"] },
  ],
};
const content = { slots: { slots: { inara: { map: "m", title: "Inara" }, empty: { map: "m" } } }, maps: new Map(), regions } as unknown as Content;

describe("atlas", () => {
  it("groups by folder with Parent / Child names, uncategorized last, only this slot", () => {
    expect(atlasGroups("inara", regions, cats)).toEqual([
      { name: "Land", ids: ["a"] },
      { name: "Land / North", ids: ["b"] },
      { name: "Uncategorized", ids: ["c"] },
    ]);
  });
  it("names a region like the admin card: name, first part label, id", () => {
    expect(displayName(regions.get("a")!)).toBe("a");
    expect(displayName(regions.get("b")!)).toBe("Bee <b>");
  });
  it("titles a tile with the name, else the first part label, else the id made readable", () => {
    expect(tileTitle(regions.get("b")!)).toBe("Bee <b>");
    expect(tileTitle(region("niridya-religions"))).toBe("Niridya Religions");
    expect(tileTitle(region("a"))).toBe("A");
  });
  it("draws a small closed outline", () => {
    const d = outlinePath(regions.get("a")!);
    expect(d).toMatch(/^M[\d. L-]+Z$/);
  });
  it("renders a static, escaped page per slot with no iframe until clicked, and a CSP matching its script", () => {
    const pages = generateAtlasPages(content, cats);
    expect(pages.map((p) => p.path)).toEqual(["v/inara/atlas/index.html", "v/empty/atlas/index.html"]);
    const html = pages[0].html;
    expect(html).not.toContain("<iframe");
    expect(html).toContain("Experimental");
    expect(html).toContain("Bee &lt;b&gt;");
    expect(html).toContain(`data-src="../../../v/inara/?region=b&amp;view=flat"`.replace("../../../", "../../../"));
    expect(html).toContain(SITE_TOKEN + "v/inara/?region=a");
    expect(html).toContain(`'sha256-${createHash("sha256").update(ATLAS_JS).digest("base64")}'`);
    expect(pages[1].html).toContain("No regions on this slot yet.");
  });
});
