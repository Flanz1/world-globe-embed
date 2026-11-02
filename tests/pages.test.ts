import { describe, expect, it } from "vitest";
import { generateSlotPages } from "../scripts/lib/pages.ts";
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
  slots: { slots: { aerthos: { map: "terra", title: "Aerthos </script><b>", grid: true, lon: 90 }, plain: { map: "terra" } } },
};

function dataOf(html: string) {
  const m = /<script type="application\/json" id="wge-data">(.*?)<\/script>/s.exec(html);
  return JSON.parse(m![1]);
}

describe("slot page generator", () => {
  const pages = generateSlotPages(content, "/*boot*/", "assets/globe-abc.js", ["assets/chunk-1.js"]);

  it("writes one page per slot", () => {
    expect(pages.map((p) => p.path)).toEqual(["v/aerthos/index.html", "v/plain/index.html"]);
  });

  it("inlines config, LQIP, boot script and a preload for the 1024 texture, with relative URLs only", () => {
    const html = pages[0].html;
    expect(html).toContain('--lqip:url("data:image/webp;base64,AAAA")');
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

describe("query params", () => {
  it("override slot defaults and ignore junk", () => {
    const out = applyParams(DEFAULT_VIEW, "?grid=1&rotate=0&bg=%23112233&lat=120&lon=-30&zoom=abc&controls=0");
    expect(out).toMatchObject({ grid: true, rotate: false, bg: "#112233", lat: 90, lon: -30, zoom: 1, controls: false });
  });
  it("only allows transparent or hex backgrounds", () => {
    expect(parseBg("transparent")).toBe("transparent");
    expect(parseBg("1e1e1e")).toBe("#1e1e1e");
    expect(parseBg("red;background:url(x)")).toBeUndefined();
  });
});
