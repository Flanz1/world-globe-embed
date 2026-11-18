import { DEFAULT_VIEW } from "../../src/shared/types.ts";
import { computeFacts, FACTS_NAME_MAX, nameFromId, type FactsFile, type FactsPin, type FactsRegion } from "../../src/shared/facts.ts";
import type { CategoriesFile } from "../../src/shared/categories.ts";
import type { Content } from "./content.ts";

/** The top-level folder a region sits in (or "" for none): regions only border regions of their own kind (countries with countries, not with religions). */
export function categoryRoots(c: CategoriesFile | undefined): Map<string, string> {
  const byId = new Map((c?.categories ?? []).map((k) => [k.id, k]));
  const out = new Map<string, string>();
  for (const k of byId.values()) {
    let root = k;
    for (let depth = 0; root.parent && byId.has(root.parent) && depth < 10; depth++) root = byId.get(root.parent)!;
    for (const r of k.regions) out.set(r, root.id);
  }
  return out;
}

/** facts/<region>.json for every region: area share, bordering regions and the pins inside each part. */
export function generateFactsFiles(content: Content): { path: string; json: string }[] {
  const roots = categoryRoots(content.categories);
  const out: { path: string; json: string }[] = [];
  for (const [slug, slot] of Object.entries(content.slots.slots)) {
    const frame = { north: slot.north ?? DEFAULT_VIEW.north, south: slot.south ?? DEFAULT_VIEW.south, shift: slot.shift ?? DEFAULT_VIEW.shift };
    const regions: FactsRegion[] = [...(content.regions?.values() ?? [])]
      .filter((r) => r.properties.slot === slug)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((r) => ({
        id: r.id,
        name: (r.properties.name?.trim() || nameFromId(r.id)).slice(0, FACTS_NAME_MAX),
        geometry: r.geometry,
        // A combined region repeats its members' borders: it is its own group, so it neither shows up as a neighbour nor sees one.
        group: r.properties.linked?.length ? `linked:${r.id}` : (roots.get(r.id) ?? ""),
      }));
    const pins: FactsPin[] = [...(content.pins?.values() ?? [])]
      .filter((p) => p.properties.slot === slug)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((p) => ({ name: p.properties.name, kind: p.properties.kind, ...(p.properties.pinMap ? { pinMap: p.properties.pinMap } : {}), at: p.geometry.coordinates }));
    const facts: Map<string, FactsFile> = computeFacts(regions, pins, frame);
    for (const [id, f] of facts) out.push({ path: `facts/${id}.json`, json: JSON.stringify(f) });
  }
  return out;
}
