import { describe, expect, it } from "vitest";
import { generatePreviewPage, generateSlotPages } from "../scripts/lib/pages.ts";
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
  slots: { slots: { aerthos: { map: "terra", title: "Aerthos </script><b>", grid: true, lon: 90 }, plain: { map: "terra" }, padded: { map: "terra", north: 10, south: 30, pole: "#abcdef" } } },
};

function dataOf(html: string) {
  const m = /<script type="application\/json" id="wge-data">(.*?)<\/script>/s.exec(html);
  return JSON.parse(m![1]);
}

describe("slot page generator", () => {
  const pages = generateSlotPages(content, "/*boot*/", "assets/globe-abc.js", ["assets/chunk-1.js"]);

  it("writes one page per slot", () => {
    expect(pages.map((p) => p.path)).toEqual(["v/aerthos/index.html", "v/plain/index.html", "v/padded/index.html"]);
  });

  it("inlines config, LQIP, boot script and a preload for the 1024 texture, with relative URLs only", () => {
    const html = pages[0].html;
    expect(html).toContain('--lqip:url(&quot;data:image/webp;base64,AAAA&quot;)');
    expect(html).toContain("<script>/*boot*/</script>");
    expect(html).toContain('<link rel="preload" href="../../maps/terra/abcdef012345-1024.webp" as="fetch" type="image/webp" crossorigin>');
    expect(html).toContain('<link rel="modulepreload" href="../../assets/globe-abc.js">');
    expect(html).toContain('<link rel="modulepreload" href="../../assets/chunk-1.js">');
    expect(html).not.toMatch(/(src|href)="\//);
    const data = dataOf(html);
    expect(data.globe).toBe("../../assets/globe-abc.js");
    expect(data.cfg).toMatchObject({ slug: "aerthos", grid: true, lon: 90, rotate: true, zoom: 1 });
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
    expect(html).toContain("<title>Aerthos &lt;/script&gt;&lt;b&gt;</title>");
    expect(html.match(/<\/script>/g)!.length).toBe(2); // only the two real closing tags
    expect(dataOf(html).cfg.title).toBe("Aerthos </script><b>");
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
