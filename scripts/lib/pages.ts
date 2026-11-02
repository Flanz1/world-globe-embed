import { buildViewerConfig, previewMaps, renderSlotPage } from "../../src/shared/page.ts";
import { DEFAULT_VIEW } from "../../src/shared/types.ts";
import type { Content } from "./content.ts";

export interface GeneratedPage {
  path: string;
  html: string;
}

/** One page per slot at v/<slug>/index.html. `globeFromRoot` is the viewer module's path from the site root. */
export function generateSlotPages(
  content: Content,
  bootJs: string,
  globeFromRoot: string,
  preloadsFromRoot: string[] = [],
): GeneratedPage[] {
  const toRoot = "../../";
  const rel = (p: string) => (/^(\/|https?:)/.test(p) ? p : toRoot + p);
  return Object.entries(content.slots.slots).map(([slug, slot]) => {
    const map = content.maps.get(slot.map)!;
    const cfg = buildViewerConfig(slug, slot, map, toRoot);
    return {
      path: `v/${slug}/index.html`,
      html: renderSlotPage({ cfg, lqip: map.lqip, bootJs, globeUrl: rel(globeFromRoot), modulePreloads: preloadsFromRoot.map(rel) }),
    };
  });
}

/**
 * preview/index.html: the viewer with every map inlined, chosen with ?map=<id>.
 * The admin page shows it in an iframe and adjusts padding live with postMessage.
 */
export function generatePreviewPage(
  content: Content,
  bootJs: string,
  globeFromRoot: string,
  preloadsFromRoot: string[] = [],
): GeneratedPage {
  const toRoot = "../";
  const rel = (p: string) => (/^(\/|https?:)/.test(p) ? p : toRoot + p);
  const cfg = { ...DEFAULT_VIEW, slug: "preview", title: "Map preview", textures: [] };
  return {
    path: "preview/index.html",
    html: renderSlotPage({
      cfg,
      lqip: "",
      bootJs,
      globeUrl: rel(globeFromRoot),
      modulePreloads: preloadsFromRoot.map(rel),
      maps: previewMaps(content.maps.values(), toRoot),
      noindex: true,
    }),
  };
}
