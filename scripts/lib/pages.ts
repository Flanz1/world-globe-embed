import { buildViewerConfig, previewMaps, renderSlotPage } from "../../src/shared/page.ts";
import { DEFAULT_VIEW } from "../../src/shared/types.ts";
import { checkGeometry, mapGeometry, round, vertexCount } from "../../src/shared/geo.ts";
import { parseRegionData, regionData, regionIndexEntry, type RegionData, type RegionFeature, type RegionIndexEntry } from "../../src/shared/region.ts";
import type { Content } from "./content.ts";

export interface GeneratedPage {
  path: string;
  html: string;
}

/** Module URLs (from the site root) for the two viewers. */
export interface ViewerModules {
  globe: string;
  globePreloads?: string[];
  flat?: string;
  flatPreloads?: string[];
}

const modules = (m: string | ViewerModules, preloads: string[] = []): ViewerModules =>
  typeof m === "string" ? { globe: m, globePreloads: preloads } : m;

/** Each slot's regions as the inline index (where to face, how far to zoom, flat bounds). */
export function regionIndex(content: Content, slug: string): Record<string, RegionIndexEntry> {
  const slot = content.slots.slots[slug];
  const out: Record<string, RegionIndexEntry> = {};
  if (!slot) return out;
  const frame = { north: slot.north ?? DEFAULT_VIEW.north, south: slot.south ?? DEFAULT_VIEW.south, shift: slot.shift ?? DEFAULT_VIEW.shift };
  for (const [id, r] of content.regions ?? []) if (r.properties.slot === slug) out[id] = regionIndexEntry(r.geometry, frame);
  return out;
}

/** One page per slot at v/<slug>/index.html. Module paths are from the site root. */
export function generateSlotPages(
  content: Content,
  bootJs: string,
  globeFromRoot: string | ViewerModules,
  preloadsFromRoot: string[] = [],
): GeneratedPage[] {
  const mods = modules(globeFromRoot, preloadsFromRoot);
  const toRoot = "../../";
  const rel = (p: string) => (/^(\/|https?:)/.test(p) ? p : toRoot + p);
  return Object.entries(content.slots.slots).map(([slug, slot]) => {
    const map = content.maps.get(slot.map)!;
    const cfg = buildViewerConfig(slug, slot, map, toRoot);
    return {
      path: `v/${slug}/index.html`,
      html: renderSlotPage({
        cfg,
        lqip: map.lqip,
        bootJs,
        globeUrl: rel(mods.globe),
        modulePreloads: (mods.globePreloads ?? []).map(rel),
        flatUrl: mods.flat ? rel(mods.flat) : undefined,
        flatPreloads: (mods.flatPreloads ?? []).map(rel),
        toRoot,
        regions: regionIndex(content, slug),
      }),
    };
  });
}

/**
 * The data an embed loads for ?region=<id>: regions/<id>.json, minified, coordinates rounded to 4 decimals.
 * Re-checked here (the page generator never trusts the schema alone).
 */
export function regionJson(f: RegionFeature): string {
  const problems = checkGeometry(f.geometry, `region "${f.id}"`);
  if (problems.length) throw new Error(problems.join("\n"));
  const d = regionData({ ...f, geometry: mapGeometry(f.geometry, ([x, y]) => [round(x), round(y)]) });
  const checked = parseRegionData(d);
  if (!checked || checked.name.length < 1 || vertexCount(checked.geometry) !== vertexCount(f.geometry))
    throw new Error(`region "${f.id}": data didn't pass the embed's own checks`);
  const out: RegionData = checked;
  return JSON.stringify(out);
}

export function generateRegionFiles(content: Content): { path: string; json: string }[] {
  return [...(content.regions ?? new Map<string, RegionFeature>()).values()].map((r) => ({ path: `regions/${r.id}.json`, json: regionJson(r) }));
}

/**
 * preview/index.html: the viewer with every map inlined, chosen with ?map=<id>.
 * The admin page shows it in an iframe and adjusts padding (and the region being edited) live with postMessage.
 */
export function generatePreviewPage(
  content: Content,
  bootJs: string,
  globeFromRoot: string | ViewerModules,
  preloadsFromRoot: string[] = [],
): GeneratedPage {
  const mods = modules(globeFromRoot, preloadsFromRoot);
  const toRoot = "../";
  const rel = (p: string) => (/^(\/|https?:)/.test(p) ? p : toRoot + p);
  const cfg = { ...DEFAULT_VIEW, slug: "preview", title: "Map preview", textures: [] };
  return {
    path: "preview/index.html",
    html: renderSlotPage({
      cfg,
      lqip: "",
      bootJs,
      globeUrl: rel(mods.globe),
      modulePreloads: (mods.globePreloads ?? []).map(rel),
      flatUrl: mods.flat ? rel(mods.flat) : undefined,
      flatPreloads: (mods.flatPreloads ?? []).map(rel),
      toRoot,
      maps: previewMaps(content.maps.values(), toRoot),
      noindex: true,
    }),
  };
}
