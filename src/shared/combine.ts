/**
 * Combining several saved regions into one new region. Pure data: the admin page shows the result in
 * the editor as a new, unsaved region, so the originals are never touched.
 */
import { MAX_VERTICES, polygonsOf, vertexCount, type Position, type RegionGeometry } from "./geo.ts";
import {
  DEFAULT_FILL_OPACITY,
  LEGEND_LABEL_MAX,
  LEGEND_MAX,
  OWN_COLOUR,
  REGION_COLOR,
  migrateZoneColours,
  normalizePartOccupied,
  normalizePartLabels,
  normalizePartLegend,
  uniqueId,
  type LegendEntry,
  type RegionFeature,
} from "./region.ts";

/** Most parts a region may have (schema maxItems of partLabels / partLegend / partContested). */
export const PARTS_MAX = 1000;

/** Where a region was drawn: the slot that shows it and the map image its coordinates belong to. */
export interface RegionBase {
  slot: string;
  map: string;
}

export const baseKey = (b: RegionBase) => `${b.slot}\u0000${b.map}`;

/** The distinct (slot, map) pairs the regions were drawn on, in first-seen order, with the region ids on each. */
export function regionBases(sources: readonly RegionFeature[]): (RegionBase & { ids: string[] })[] {
  const out = new Map<string, RegionBase & { ids: string[] }>();
  for (const f of sources) {
    const b = { slot: f.properties.slot, map: f.properties.map };
    const k = baseKey(b);
    if (!out.has(k)) out.set(k, { ...b, ids: [] });
    out.get(k)!.ids.push(f.id);
  }
  return [...out.values()];
}

/** A default id for the combined region: the source ids joined, made free among `taken`. */
export function combinedId(sources: readonly RegionFeature[], taken: Set<string>): string {
  const joined = sources.length > 3 ? `${sources[0].id}-combined` : sources.map((f) => f.id).join("-");
  return uniqueId(joined.length > 64 ? `${sources[0].id}-combined` : joined, taken);
}

export interface CombineResult {
  /** The new region, or null when the regions can't be combined (see errors). */
  feature: RegionFeature | null;
  /** Why it couldn't be combined. */
  errors: string[];
  /** Things that changed on the way, to tell the user (renamed legend entries, …). */
  notes: string[];
}

const hex6 = (c: string) => (c.length === 4 ? `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}` : c).toLowerCase();
const safeColour = (c: unknown, fallback: string) => (typeof c === "string" && REGION_COLOR.test(c) ? hex6(c) : fallback);

/** `label`, or `label (2)`, `label (3)`, … — the first that isn't in `used`, kept within the length limit. */
function freeLabel(label: string, used: Set<string>): string {
  if (!used.has(label)) return label;
  for (let i = 2; ; i++) {
    const suffix = ` (${i})`;
    const l = label.slice(0, LEGEND_LABEL_MAX - suffix.length) + suffix;
    if (!used.has(l)) return l;
  }
}

/**
 * Merges `sources` (in order; the first is the base for the region-wide settings) into one region with
 * every part of every source: geometry, part labels, colours (each source's own colour becomes a
 * legend entry where it differs from the base's), and legend entries, in order (later sources' parts are drawn on top). Legend labels
 * that clash (same text, different colour) get a " (2)" suffix; identical entries are shared.
 */
export function combineRegions(sources: readonly RegionFeature[], target: { id: string; base: RegionBase }): CombineResult {
  const errors: string[] = [];
  const notes: string[] = [];
  if (sources.length < 2) return { feature: null, errors: ["Pick at least two regions to combine."], notes };

  const first = sources[0].properties;
  const colour = safeColour(first.color, "#c0392b");
  const legend: LegendEntry[] = [];
  const used = new Set<string>();
  /** Index of an existing identical entry (same label and colour), or a new entry. */
  const entryFor = (label: string, color: string, from: string): number => {
    const l = label.slice(0, LEGEND_LABEL_MAX);
    const same = legend.findIndex((e) => e.label === l && e.color === color);
    if (same >= 0) return same;
    const free = freeLabel(l, used);
    if (free !== l) notes.push(`Legend entry "${l}" from ${from} was renamed "${free}" (another region uses that label for a different colour).`);
    used.add(free);
    legend.push({ label: free, color });
    return legend.length - 1;
  };

  const polygons: Position[][][] = [];
  const labels: string[] = [];
  const hidden: boolean[] = [];
  const styles: number[] = [];
  const occupied: boolean[] = [];

  for (const [si, f] of sources.entries()) {
    const p = f.properties;
    const polys = polygonsOf(f.geometry);
    const n = polys.length;
    const srcLegend = Array.isArray(p.legend) ? p.legend.slice(0, LEGEND_MAX) : [];
    const partLegend = migrateZoneColours(normalizePartLegend(Array.isArray(p.partLegend) ? p.partLegend : undefined, n, srcLegend.length), Array.isArray(p.partContested) ? p.partContested : undefined);
    // Legend entries this source's parts use, mapped into the combined legend. Unused entries are kept too.
    const map = srcLegend.map((e) => entryFor(String(e?.label ?? ""), safeColour(e?.color, "#7f8c8d"), f.id));
    const own = safeColour(p.color, colour);
    let ownIndex = OWN_COLOUR;
    if (si > 0 && own !== colour && partLegend.some((k) => k === OWN_COLOUR)) {
      const name = (typeof p.colorLabel === "string" && p.colorLabel.trim()) || (typeof p.name === "string" && p.name.trim()) || f.id;
      ownIndex = entryFor(name, own, f.id);
    }
    // Older regions have one name instead of part labels: it becomes the first part's label (as in the editor).
    const legacy = !Array.isArray(p.partLabels) && p.name && (p.label ?? true) ? [p.name] : undefined;
    const partLabels = normalizePartLabels(Array.isArray(p.partLabels) ? p.partLabels : legacy, n);
    const occ = normalizePartOccupied(Array.isArray(p.partOccupied) ? p.partOccupied : undefined, Array.isArray(p.partContested) ? p.partContested : undefined, n);
    for (let i = 0; i < n; i++) {
      occupied.push(occ[i]);
      polygons.push(polys[i]);
      labels.push(partLabels[i]);
      hidden.push(p.partLabelHidden?.[i] === true);
      styles.push(partLegend[i] === OWN_COLOUR ? ownIndex : map[partLegend[i]]);
    }
  }

  if (legend.length > LEGEND_MAX)
    errors.push(`Together these regions use ${legend.length} legend colours; a region can have at most ${LEGEND_MAX}. Combine fewer regions, or merge some colours first.`);
  if (polygons.length > PARTS_MAX) errors.push(`Together these regions have ${polygons.length} parts; a region can have at most ${PARTS_MAX}.`);
  const geometry: RegionGeometry = polygons.length === 1 ? { type: "Polygon", coordinates: polygons[0] } : { type: "MultiPolygon", coordinates: polygons };
  const vertices = vertexCount(geometry);
  if (vertices > MAX_VERTICES) errors.push(`Together these regions have ${vertices} vertices; a region can have at most ${MAX_VERTICES.toLocaleString("en")}. Leave some of them out.`);

  const others = regionBases(sources).filter((b) => baseKey(b) !== baseKey(target.base));
  for (const b of others)
    notes.push(
      b.map !== target.base.map
        ? `${b.ids.join(", ")} ${b.ids.length > 1 ? "were" : "was"} drawn on the map "${b.map}", not "${target.base.map}": ${b.ids.length > 1 ? "their" : "its"} areas keep their coordinates, so they only line up if both maps have the same layout.`
        : `${b.ids.join(", ")} ${b.ids.length > 1 ? "move" : "moves"} from slot "${b.slot}" to "${target.base.slot}" (same map).`,
    );
  if (errors.length) return { feature: null, errors, notes };
  if (new Set(sources.map((f) => f.properties.label ?? true)).size > 1)
    notes.push("Some of these regions hide their labels and some show them; the combined region shows them (untick \"Show part labels in embed\" in the editor to hide them).");

  const desc = sources.map((f) => f.properties.description?.trim()).find((d) => d);
  const legendTitle = sources.map((f) => f.properties.legendTitle?.trim()).find((t) => t);
  const colorLabel = typeof first.colorLabel === "string" ? first.colorLabel.trim().slice(0, LEGEND_LABEL_MAX) : "";
  const feature: RegionFeature = {
    $schema: "../../schema/region.schema.json",
    type: "Feature",
    id: target.id,
    properties: {
      slot: target.base.slot,
      map: target.base.map,
      color: colour,
      ...(colorLabel ? { colorLabel } : {}),
      fillOpacity: first.fillOpacity ?? DEFAULT_FILL_OPACITY,
      label: sources.some((f) => f.properties.label ?? true),
      ...(desc ? { description: desc } : {}),
      ...(legendTitle ? { legendTitle } : {}),
      ...(sources.some((f) => f.properties.nationalBorders === true) ? { nationalBorders: true } : {}),
      ...(legend.length ? { legend, partLegend: styles } : {}),
      partLabels: labels,
      ...(occupied.some(Boolean) ? { partOccupied: occupied } : {}),
      ...(hidden.some(Boolean) ? { partLabelHidden: hidden } : {}),
    },
    geometry,
  };
  return { feature, errors, notes };
}
