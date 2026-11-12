import { describe, expect, it } from "vitest";
import { generatePreviewPage, generateRegionFiles, generateSlotPages } from "../scripts/lib/pages.ts";
import { defaultEmbedOptions, regionEmbedCode } from "../src/shared/embed.ts";
import type { RegionFeature } from "../src/shared/region.ts";
import type { Content } from "../scripts/lib/content.ts";
import type { MapMeta } from "../src/shared/types.ts";
import { applyParams, parseBg } from "../src/shared/params.ts";
import { DEFAULT_VIEW } from "../src/shared/types.ts";

const map: MapMeta = {
  id: "terra",
  name: "Terra",
  uploadedBy: "t",
  date: "2026-01-01T00:00:00.000Z",
  aspect: 2,
  width: 4096,
  height: 2048,
  hash: "abcdef012345",
  sizes: {
    "1024": "maps/terra/abcdef012345-1024.webp",
    "2048": "maps/terra/abcdef012345-2048.webp",
    "4096": "maps/terra/abcdef012345-4096.webp",
  },
  lqip: "data:image/webp;base64,AAAA",
};
const content: Content = {
  maps: new Map([["terra", map]]),
  slots: { slots: { inara: { map: "terra", title: "Inara </script><b>", grid: true, lon: 90 }, plain: { map: "terra" }, padded: { map: "terra", north: 10, south: 30, pole: "#abcdef" } } },
};

function dataOf(html: string) {
  const m = /<script type="application\/json" id="wge-data">(.*?)<\/script>/s.exec(html);
  return JSON.parse(m![1]);
}

describe("slot page generator", () => {
  const pages = generateSlotPages(content, "/*boot*/", "assets/globe-abc.js", ["assets/chunk-1.js"]);

  it("writes one page per slot", () => {
    expect(pages.map((p) => p.path)).toEqual(["v/inara/index.html", "v/plain/index.html", "v/padded/index.html"]);
  });

  it("inlines config, LQIP, boot script and a preload for the 1024 texture, with relative URLs only", () => {
    const html = pages[0].html;
    expect(html).toContain('--lqip:url(&quot;data:image/webp;base64,AAAA&quot;)');
    expect(html).toContain("<script>/*boot*/</script>");
    expect(html).toContain('<link rel="preload" href="../../maps/terra/abcdef012345-1024.webp" as="fetch" type="image/webp" crossorigin>');
    // Module preloads are added by the boot script for the chosen view only (flat must never fetch Three.js).
    expect(html).not.toContain("modulepreload");
    expect(html).not.toMatch(/(src|href)="\//);
    const data = dataOf(html);
    expect(data.globe).toBe("../../assets/globe-abc.js");
    expect(data.preload.globe).toEqual(["../../assets/chunk-1.js"]);
    expect(data.cfg).toMatchObject({ slug: "inara", grid: true, lon: 90, rotate: true, zoom: 1 });
    expect(data.cfg.textures).toEqual([
      { w: 1024, url: "../../maps/terra/abcdef012345-1024.webp" },
      { w: 2048, url: "../../maps/terra/abcdef012345-2048.webp" },
      { w: 4096, url: "../../maps/terra/abcdef012345-4096.webp" },
    ]);
  });

  it("refuses an LQIP that could break out of the style attribute", () => {
    const evil: MapMeta = { ...map, lqip: `data:image/webp;base64,AA")'><script>alert(1)</script>` };
    const c: Content = { maps: new Map([["terra", evil]]), slots: { slots: { x: { map: "terra" } } } };
    expect(() => generateSlotPages(c, "", "g.js")).toThrow(/lqip/);
  });

  it("escapes the title in HTML and in the inline JSON", () => {
    const html = pages[0].html;
    expect(html).toContain("<title>Inara &lt;/script&gt;&lt;b&gt;</title>");
    expect(html.match(/<\/script>/g)!.length).toBe(2); // only the two real closing tags
    expect(dataOf(html).cfg.title).toBe("Inara </script><b>");
  });

  it("falls back to the map name and default view", () => {
    const cfg = dataOf(pages[1].html).cfg;
    expect(cfg.title).toBe("Terra");
    expect(cfg).toMatchObject(DEFAULT_VIEW);
  });
});

describe("pole padding", () => {
  it("passes padding to the viewer and fits the poster inside the padded band", () => {
    const html = generateSlotPages(content, "", "g.js")[2].html;
    expect(dataOf(html).cfg).toMatchObject({ north: 10, south: 30, pole: "#abcdef" });
    expect(html).toContain("--pole:#abcdef");
    expect(html).toContain("--ph:60.00%"); // 100 - 10 - 30
    expect(html).toContain("--py:25.00%"); // 10 / (10 + 30)
  });
});

describe("preview page", () => {
  it("inlines every map, is noindex and has no slot-specific preload", () => {
    const page = generatePreviewPage(content, "", "assets/globe-abc.js");
    expect(page.path).toBe("preview/index.html");
    expect(page.html).toContain('<meta name="robots" content="noindex">');
    expect(page.html).not.toContain('rel="preload"');
    const data = dataOf(page.html);
    expect(data.globe).toBe("../assets/globe-abc.js");
    expect(data.maps.terra.textures[0]).toEqual({ w: 1024, url: "../maps/terra/abcdef012345-1024.webp" });
  });
});

describe("prime meridian shift", () => {
  it("is a query param in degrees, clamped to ±180", () => {
    expect(applyParams(DEFAULT_VIEW, "?shift=-30").shift).toBe(-30);
    expect(applyParams(DEFAULT_VIEW, "?shift=500").shift).toBe(180);
  });
  it("moves the poster with the map", () => {
    const base = generateSlotPages({ ...content, slots: { slots: { a: { map: "terra" } } } }, "", "g.js")[0].html;
    const shifted = generateSlotPages({ ...content, slots: { slots: { a: { map: "terra", shift: 90 } } } }, "", "g.js")[0].html;
    expect(base).toContain("--px:50.00%");
    expect(shifted).toContain("--px:0.00%"); // 90° east = a quarter of the map
    expect(dataOf(shifted).cfg.shift).toBe(90);
  });
});

describe("default view", () => {
  it("is globe unless the slot says flat, and ?view= overrides it", () => {
    expect(DEFAULT_VIEW.view).toBe("globe");
    const flat = generateSlotPages({ ...content, slots: { slots: { a: { map: "terra", view: "flat" } } } }, "", "g.js")[0].html;
    expect(dataOf(flat).cfg.view).toBe("flat");
    expect(applyParams({ ...DEFAULT_VIEW, view: "flat" }, "?view=globe").view).toBe("globe");
    expect(applyParams(DEFAULT_VIEW, "?view=flat").view).toBe("flat");
    expect(applyParams({ ...DEFAULT_VIEW, view: "flat" }, "?view=<b>").view).toBe("flat");
  });
});

describe("query params", () => {
  it("override slot defaults and ignore junk", () => {
    const out = applyParams(DEFAULT_VIEW, "?grid=1&rotate=0&bg=%23112233&lat=120&lon=-30&zoom=abc&controls=0&north=12.5&south=80&pole=transparent");
    expect(out).toMatchObject({ grid: true, rotate: false, bg: "#112233", lat: 90, lon: -30, zoom: 1, controls: false, north: 12.5, south: 49, pole: "#e8dcc8" });
  });
  it("only allows transparent or hex backgrounds", () => {
    expect(parseBg("transparent")).toBe("transparent");
    expect(parseBg("1e1e1e")).toBe("#1e1e1e");
    expect(parseBg("red;background:url(x)")).toBeUndefined();
  });
});

describe("regions in the build", () => {
  const evil = '"><script>alert(1)</script>';
  const region = {
    $schema: "../../schema/region.schema.json",
    type: "Feature" as const,
    id: "evil",
    properties: { name: evil, slot: "inara", map: "terra", color: "#c33", description: "</script><img src=x onerror=alert(2)>", label: true },
    geometry: { type: "Polygon" as const, coordinates: [[[170, 0], [-170, 0], [-170, 10], [170, 10], [170, 0]]] as [number, number][][] },
  };
  const withRegion: Content = { ...content, regions: new Map([["evil", region]]) };

  it("inlines only a small index per region into its slot page, and nothing from the region's text", () => {
    const pages = generateSlotPages(withRegion, "", "g.js");
    const html = pages[0].html;
    expect(dataOf(html).regions).toEqual({ evil: { c: [180, 5.06], z: expect.any(Number), b: [170, 0, 190, 10] } });
    expect(html).not.toContain("alert");
    expect(html.match(/<\/script>/g)!.length).toBe(2);
    // Other slots get no index entry for it.
    expect(dataOf(pages[1].html).regions).toBeUndefined();
  });

  it("writes regions/<id>.json minified, with the name as plain JSON text", () => {
    const [file] = generateRegionFiles(withRegion);
    expect(file.path).toBe("regions/evil.json");
    const data = JSON.parse(file.json);
    expect(data).toEqual({ id: "evil", slot: "inara", name: evil, color: "#c33", fillOpacity: 0.35, label: true, geometry: region.geometry });
    expect(file.json).not.toContain("description");
    expect(file.json).not.toMatch(/\n/);
  });

  it("never adds other regions' overlaps (each region is its own map), and keeps contested zones", () => {
    const sq = (x: number, y: number, s = 10): [number, number][] => [[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]];
    const base = { $schema: "../../schema/region.schema.json", type: "Feature" as const };
    const a = { ...base, id: "a", properties: { slot: "inara", map: "terra", color: "#c33", partContested: [-1, 0] }, geometry: { type: "MultiPolygon" as const, coordinates: [[sq(0, 0)], [sq(8, 0, 4)]] } };
    // b overlaps a on the same slot: a different map, so neither gets anything from the other.
    const b = { ...base, id: "b", properties: { slot: "inara", map: "terra", color: "#33c" }, geometry: { type: "MultiPolygon" as const, coordinates: [[sq(5, 5)], [sq(60, 0)]] } };
    const files = generateRegionFiles({ ...content, regions: new Map([["a", a], ["b", b]] as [string, RegionFeature][]) });
    const get = (id: string) => JSON.parse(files.find((f) => f.path === `regions/${id}.json`)!.json);
    expect(get("a").clash).toBeUndefined();
    expect(get("b").clash).toBeUndefined();
    expect(get("a").contested).toEqual([-1, 0]);
    expect(get("b").contested).toBeUndefined();
    expect(JSON.stringify(get("a"))).not.toContain("#33c");
  });

  it("re-checks region data in the generator", () => {
    const bad = { ...region, geometry: { type: "Polygon" as const, coordinates: [[[0, 0], [2, 2], [2, 0], [0, 2], [0, 0]]] as [number, number][][] } };
    expect(() => generateRegionFiles({ ...content, regions: new Map([["evil", bad]]) })).toThrow(/crosses itself/);
    const badColor = { ...region, properties: { ...region.properties, color: "red;}" } };
    expect(() => generateRegionFiles({ ...content, regions: new Map([["evil", badColor]]) })).toThrow(/embed's own checks/);
  });

  it("the copied embed snippet escapes the name", () => {
    const code = regionEmbedCode("https://flanz1.github.io/world-globe-embed/", "inara", "Inara", { id: "evil", name: evil, label: true }, defaultEmbedOptions({ label: true }));
    expect(code).toBe(
      '<iframe src="https://flanz1.github.io/world-globe-embed/v/inara/?region=evil&amp;view=globe"\n' +
        '        width="100%" height="480" style="border:0;border-radius:8px;background:transparent"\n' +
        '        loading="lazy" allow="fullscreen" title="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt; (Inara)"></iframe>',
    );
    expect(code).not.toMatch(/<script/);
  });

  it("embed URL options: flat, label off, dim, start unlocked, custom domain", () => {
    const code = regionEmbedCode("https://maps.example.org/", "inara", "Inara", { id: "vael", name: "Vael", label: true }, { view: "flat", height: 600, label: false, dim: true, lock: false, key: false });
    expect(code).toContain('src="https://maps.example.org/v/inara/?region=vael&amp;view=flat&amp;label=0&amp;dim=1&amp;lock=0&amp;key=0"');
    expect(code).toContain('height="600"');
  });
});
