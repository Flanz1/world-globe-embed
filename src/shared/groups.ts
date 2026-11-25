/**
 * Layer groups: hand-picked sets of regions (a "Religion" group holding several religion maps) or of pin maps
 * ("Holy sites", "Battles") that the embed's legend shows as one section with one switch. They replace the older
 * flat `under` list + `underTitle` and the flat `pinMaps` list; those still load (see regionGroups / pinGroups)
 * and the editor saves the new form.
 */
import type { UnderEntry } from "./region.ts";

export const GROUPS_MAX = 8;
export const GROUP_NAME_MAX = 40;
/** Most regions in all of a region's groups together (the old `under` limit). */
export const GROUP_REGIONS_MAX = 8;
/** Most pin maps in all of a region's pin groups together. */
export const GROUP_PINMAPS_MAX = 8;

/** A group of regions shown under the main one: one switch, one fill, its members in order (bottom first). */
export interface LayerGroup {
  name: string;
  regions: UnderEntry[];
  /** Whether it starts shown. Missing: the first group does, the others don't. */
  on?: boolean;
  /** Fill opacity every member is painted with (a member's own `fill` wins). Missing: each region's own. */
  fill?: number;
}

/** A group of pin maps: one switch in the embed's pin legend. */
export interface PinGroup {
  name: string;
  pinMaps: string[];
  /** Whether it starts shown. Missing: yes. */
  on?: boolean;
}

interface GroupSource {
  layerGroups?: LayerGroup[];
  pinGroups?: PinGroup[];
  under?: UnderEntry[];
  underTitle?: string;
  pinMaps?: string[];
}

/**
 * The region's layer groups. Without `layerGroups`, the old `under` list: one underlay becomes a group of one
 * named after the old heading (else its own name); several become one group each, so every old toggle stays.
 * `nameOf` gives a region's display name (the id when missing). Members in two groups stay in the first.
 */
export function regionGroups(p: GroupSource, nameOf: (id: string) => string = (id) => id): LayerGroup[] {
  const seen = new Set<string>();
  const clean = (gs: LayerGroup[]): LayerGroup[] =>
    gs
      .map((g) => ({ ...g, regions: g.regions.filter((e) => !seen.has(e.id) && !!seen.add(e.id)) }))
      .filter((g) => g.regions.length)
      .slice(0, GROUPS_MAX);
  if (p.layerGroups) return clean(p.layerGroups);
  const under = p.under ?? [];
  if (!under.length) return [];
  const heading = p.underTitle?.trim();
  if (under.length === 1) {
    const { on, ...e } = under[0];
    return clean([{ name: heading || e.label?.trim() || nameOf(e.id), regions: [{ id: e.id }], on: on ?? true, ...(e.fill !== undefined ? { fill: e.fill } : {}) }]);
  }
  return clean(under.map((e, i) => ({ name: e.label?.trim() || nameOf(e.id), regions: [{ id: e.id }], on: e.on ?? i === 0, ...(e.fill !== undefined ? { fill: e.fill } : {}) })));
}

/** The region's pin groups. Without `pinGroups`, the old `pinMaps` list: one group per pin map, named after it. */
export function pinGroups(p: GroupSource, nameOf: (id: string) => string = (id) => id): PinGroup[] {
  const seen = new Set<string>();
  const clean = (gs: PinGroup[]): PinGroup[] =>
    gs
      .map((g) => ({ ...g, pinMaps: g.pinMaps.filter((id) => !seen.has(id) && !!seen.add(id)) }))
      .filter((g) => g.pinMaps.length)
      .slice(0, GROUPS_MAX);
  if (p.pinGroups) return clean(p.pinGroups);
  return clean((p.pinMaps ?? []).map((id) => ({ name: nameOf(id), pinMaps: [id] })));
}

/** Every region id in the groups, in order (bottom first). */
export const groupRegionIds = (gs: readonly LayerGroup[]): string[] => gs.flatMap((g) => g.regions.map((e) => e.id));
/** Every pin map id in the groups, in order. */
export const groupPinMapIds = (gs: readonly PinGroup[]): string[] => gs.flatMap((g) => g.pinMaps);

/**
 * The groups as the flat underlay list the embed's stacking works with: every member with its group's fill
 * (its own wins) and the group's start state. A group of one keeps the member's own label out of the way.
 */
export function flatUnder(gs: readonly LayerGroup[]): UnderEntry[] {
  return gs.flatMap((g, gi) => g.regions.map((e) => ({ id: e.id, ...(e.label?.trim() ? { label: e.label.trim() } : {}), on: g.on ?? gi === 0, ...((e.fill ?? g.fill) !== undefined ? { fill: (e.fill ?? g.fill)! } : {}) })));
}

/** One legend section of the embed: the group's name and the ids of its members. */
export interface LegendGroup {
  /** The group's name. */
  n: string;
  /** Member region ids (or pin map ids). */
  ids: string[];
}

/** Whether a name is a usable group name (a trimmed, non-empty string). */
export const cleanName = (v: unknown): string => (typeof v === "string" ? v.trim().slice(0, GROUP_NAME_MAX) : "");

/**
 * The properties with the older `under` + `underTitle` and `pinMaps` turned into layerGroups and pinGroups (the same
 * sections the embed already shows), the older fields dropped. Nothing changes for a region that has neither.
 */
export function migrateGroups<P extends GroupSource>(p: P, regionName?: (id: string) => string, pinMapName?: (id: string) => string): P {
  const { under, pinMaps } = p;
  const next: P = { ...p };
  delete next.under;
  delete next.underTitle;
  delete next.pinMaps;
  if (under?.length && !p.layerGroups) next.layerGroups = regionGroups(p, regionName);
  else if (p.layerGroups) next.layerGroups = p.layerGroups;
  if (pinMaps?.length && !p.pinGroups) next.pinGroups = pinGroups(p, pinMapName);
  else if (p.pinGroups) next.pinGroups = p.pinGroups;
  if (!next.layerGroups?.length) delete next.layerGroups;
  if (!next.pinGroups?.length) delete next.pinGroups;
  return next;
}
