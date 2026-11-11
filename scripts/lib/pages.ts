import { buildViewerConfig, previewMaps, renderSlotPage } from "../../src/shared/page.ts";
import { DEFAULT_VIEW } from "../../src/shared/types.ts";
import { checkGeometry, mapGeometry, polygonsOf, round, vertexCount, type Ring } from "../../src/shared/geo.ts";
import { capClash, clashPolygon } from "../../src/shared/region-paint.ts";
import { findClashes, prepare } from "../../src/shared/clash.ts";
import {
  checkParts,
  parseRegionData,
  regionData,
  regionIndexEntry,
  type RegionData,
  type RegionFeature,
  type RegionIndexEntry,
} from "../../src/shared/region.ts";
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
 * Re-checked here (the page generator never trusts the schema alone). `clash` is the other regions'
 * polygons that overlap this one (see clashData).
 */
export function regionJson(f: RegionFeature, clash: Ring[][] = []): string {
  const problems = checkGeometry(f.geometry, `region "${f.id}"`);
  if (problems.length) throw new Error(problems.join("\n"));
  const partProblems = checkParts(f.properties, f.geometry, `region "${f.id}"`);
  if (partProblems.length) throw new Error(partProblems.join("\n"));
  const d: RegionData = { ...regionData({ ...f, geometry: mapGeometry(f.geometry, ([x, y]) => [round(x), round(y)]) }), ...(clash.length ? { clash } : {}) };
  const checked = parseRegionData(d);
  if (!checked || vertexCount(checked.geometry) !== vertexCount(f.geometry) || (checked.clash?.length ?? 0) !== clash.length)
    throw new Error(`region "${f.id}": data didn't pass the embed's own checks`);
  // Without a legend (or part labels, contested zones, clashes), those fields are left out (the embed fills in the defaults), so plain regions stay small.
  const { legend, legendTitle, parts, labels, contested, clash: cl, ...rest } = checked;
  const out: Partial<RegionData> = {
    ...rest,
    ...(legend.length ? { legendTitle, legend, parts } : {}),
    ...(labels.some((t) => t) ? { labels } : {}),
    ...(contested.some((k) => k !== -1) ? { contested } : {}),
    ...(cl?.length ? { clash: cl } : {}),
  };
  return JSON.stringify(out);
}

/**
 * For each region, the polygons of other regions on the same slot that clash with any of its parts,
 * capped at CLASH_MAX_VERTICES (simplified with Douglas–Peucker at growing tolerances when bigger).
 */
export function clashData(regions: Iterable<RegionFeature>): Map<string, Ring[][]> {
  const bySlot = new Map<string, RegionFeature[]>();
  for (const r of regions) (bySlot.get(r.properties.slot) ?? bySlot.set(r.properties.slot, []).get(r.properties.slot)!).push(r);
  const out = new Map<string, Ring[][]>();
  for (const list of bySlot.values()) {
    if (list.length < 2) continue;
    const polys = list.map((r) => polygonsOf(r.geometry));
    const preps = polys.map((ps) => ps.map((p) => prepare(p)));
    // Every polygon of the slot in one list, tagged with its region, so one sweep finds all cross-region pairs.
    const flat: { r: number; p: number }[] = [];
    polys.forEach((ps, r) => ps.forEach((_, p) => flat.push({ r, p })));
    const all = flat.map(({ r, p }) => preps[r][p]);
    const hits = list.map(() => new Set<number>());
    for (const [i, j] of findClashes(all)) {
      const a = flat[i];
      const b = flat[j];
      if (a.r === b.r) continue;
      hits[a.r].add(j);
      hits[b.r].add(i);
    }
    list.forEach((reg, r) => {
      if (!hits[r].size) return;
      const rings = [...hits[r]].sort((x, y) => x - y).map((k) => clashPolygon(polys[flat[k].r][flat[k].p]));
      out.set(reg.id, capClash(rings));
    });
  }
  return out;
}

export function generateRegionFiles(content: Content): { path: string; json: string }[] {
  const regions = [...(content.regions ?? new Map<string, RegionFeature>()).values()];
  const clashes = clashData(regions);
  return regions.map((r) => ({ path: `regions/${r.id}.json`, json: regionJson(r, clashes.get(r.id) ?? []) }));
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
