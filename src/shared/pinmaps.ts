/**
 * Pin maps: named, embeddable sets of pins ("Holy sites", "Battles"), kept in folders that nest like the Regions
 * tab's (content/pinmaps.json). A pin map belongs to one slot; a pin is in at most one pin map
 * (properties.pinMap on the pin). An embed shows one with ?pins=<id>, and a region can include some
 * (RegionProperties.pinMaps) so their pins show on its embed. Folders and pin maps have no owner: anyone who may
 * create regions can add, rename, move and delete them. The folder tree is the Regions tab's (categories.ts),
 * with pin maps in the place of regions.
 */
import {
  addCategory,
  assignRegions,
  checkCategories,
  cleanName,
  moveCategory,
  newCategoryId,
  removeCategory,
  renameCategory,
  shiftCategory,
  CATEGORY_NAME_MAX,
  type CategoriesFile,
  type Category,
} from "./categories.ts";

export const PINMAPS_PATH = "content/pinmaps.json";
export const PINMAP_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const PINMAP_NAME_MAX = 60;
/** Most pin maps in the repository (keeps the file small enough to save in one commit). */
export const MAX_PINMAPS = 300;
/** Most pin maps one region can include. */
export const REGION_PINMAPS_MAX = 8;

export interface PinMap {
  id: string;
  name: string;
  /** The slot whose map the pins are on. */
  slot: string;
}

export interface PinMapsFile {
  $schema?: string;
  /** Folders; each lists (as `regions`, the shared tree's word for its members) the ids of the pin maps in it. */
  folders: Category[];
  maps: PinMap[];
}

export const emptyPinMaps = (): PinMapsFile => ({ folders: [], maps: [] });

/** The folder tree as the Regions tab's code sees it. */
export const treeOf = (f: PinMapsFile | null | undefined): CategoriesFile => ({ categories: f?.folders ?? [] });
const withTree = (f: PinMapsFile, t: CategoriesFile): PinMapsFile => ({ ...f, folders: t.categories });
const copy = (f: PinMapsFile): PinMapsFile => ({ ...f, folders: f.folders.map((k) => ({ ...k, regions: [...k.regions] })), maps: f.maps.map((m) => ({ ...m })) });

/** Problems with the file beyond its JSON schema: the folder rules, duplicate ids or names, a folder listing a pin map that isn't there. */
export function checkPinMaps(f: unknown): string[] {
  if (!f || typeof f !== "object" || !Array.isArray((f as PinMapsFile).folders) || !Array.isArray((f as PinMapsFile).maps)) return ["it must be an object with a folders list and a maps list."];
  const file = f as PinMapsFile;
  const errs = checkCategories(treeOf(file)).map((e) => e.replace(/categories\[/g, "folders[").replace(/\.regions\b/g, ".maps").replace(/region "/g, 'pin map "').replace(/categories/g, "folders"));
  const ids = new Set<string>();
  const names = new Set<string>();
  if (file.maps.length > MAX_PINMAPS) errs.push(`There can be at most ${MAX_PINMAPS} pin maps.`);
  for (const [i, m] of file.maps.entries()) {
    const where = `maps[${i}]`;
    if (!m || typeof m !== "object") {
      errs.push(`${where} isn't an object.`);
      continue;
    }
    if (typeof m.id !== "string" || !PINMAP_ID.test(m.id)) errs.push(`${where}.id must be lowercase letters, digits and dashes.`);
    else if (ids.has(m.id)) errs.push(`${where}: the id "${m.id}" is used twice.`);
    else ids.add(m.id);
    const name = typeof m.name === "string" ? cleanName(m.name) : "";
    if (!name || name.length > PINMAP_NAME_MAX) errs.push(`${where}.name must be 1 to ${PINMAP_NAME_MAX} characters.`);
    else {
      const key = `${m.slot}/${name.toLowerCase()}`;
      if (names.has(key)) errs.push(`${where}: there are two pin maps called "${name}" on the slot "${m.slot}".`);
      else names.add(key);
    }
    if (typeof m.slot !== "string" || !PINMAP_ID.test(m.slot)) errs.push(`${where}.slot must be a slot id.`);
  }
  for (const k of file.folders) for (const id of k.regions ?? []) if (typeof id === "string" && !ids.has(id)) errs.push(`The folder "${k.id}" lists the pin map "${id}", which doesn't exist.`);
  return errs;
}

export const mapById = (f: PinMapsFile | null | undefined, id: string): PinMap | undefined => f?.maps.find((m) => m.id === id);
/** The folder a pin map is in, or null for "Not in a folder". */
export const folderOf = (f: PinMapsFile | null | undefined, id: string): string | null => f?.folders.find((k) => k.regions.includes(id))?.id ?? null;
/** The pin maps on one slot. */
export const mapsOfSlot = (f: PinMapsFile | null | undefined, slot: string): PinMap[] => (f?.maps ?? []).filter((m) => m.slot === slot);

/** Why a pin map can't be called `name` on `slot` (`except` = the one being renamed), or null. */
export function mapNameProblem(f: PinMapsFile, name: string, slot: string, except?: string): string | null {
  const n = cleanName(name);
  if (!n) return "Give the pin map a name.";
  if (n.length > PINMAP_NAME_MAX) return `Keep the name to ${PINMAP_NAME_MAX} characters or fewer.`;
  if (f.maps.some((m) => m.id !== except && m.slot === slot && m.name.toLowerCase() === n.toLowerCase())) return `There's already a pin map called "${n}" on this slot.`;
  return null;
}

/** Why a folder can't be called `name` inside `parent`, or null (the Regions tab's rule). */
export function folderNameProblem(f: PinMapsFile, name: string, except: string | undefined, parent: string | null): string | null {
  const n = cleanName(name);
  if (!n) return "Give the folder a name.";
  if (n.length > CATEGORY_NAME_MAX) return `Keep the name to ${CATEGORY_NAME_MAX} characters or fewer.`;
  if (f.folders.some((k) => k.id !== except && (k.parent ?? null) === parent && k.name.toLowerCase() === n.toLowerCase())) return `There's already a folder called "${n}" here.`;
  return null;
}

/* ── Edits. Each takes the file as it is now and returns the new one. ── */

export function addPinMap(f: PinMapsFile, name: string, slot: string, folder: string | null = null): { file: PinMapsFile; id: string } {
  const file = copy(f);
  const id = newCategoryId(cleanName(name), new Set(file.maps.map((m) => m.id)));
  file.maps.push({ id, name: cleanName(name), slot });
  return { file: folder ? movePinMap(file, id, folder) : file, id };
}

export function renamePinMap(f: PinMapsFile, id: string, name: string): PinMapsFile {
  const file = copy(f);
  const m = file.maps.find((x) => x.id === id);
  if (m) m.name = cleanName(name);
  return file;
}

/** Deleting a pin map takes it out of its folder; pins that named it just stop being in one. */
export function removePinMap(f: PinMapsFile, id: string): PinMapsFile {
  const file = copy(f);
  file.maps = file.maps.filter((m) => m.id !== id);
  for (const k of file.folders) k.regions = k.regions.filter((x) => x !== id);
  return file;
}

/** Puts a pin map in a folder (null = out of any folder). */
export const movePinMap = (f: PinMapsFile, id: string, folder: string | null): PinMapsFile => withTree(copy(f), assignRegions(treeOf(copy(f)), [id], folder));

export const addFolder = (f: PinMapsFile, name: string, parent: string | null = null): { file: PinMapsFile; id: string } => {
  const r = addCategory(treeOf(copy(f)), name, parent);
  return { file: withTree(copy(f), r.file), id: r.id };
};
export const renameFolder = (f: PinMapsFile, id: string, name: string): PinMapsFile => withTree(copy(f), renameCategory(treeOf(copy(f)), id, name));
export const shiftFolder = (f: PinMapsFile, id: string, by: -1 | 1): PinMapsFile => withTree(copy(f), shiftCategory(treeOf(copy(f)), id, by));
export const moveFolder = (f: PinMapsFile, id: string, parent: string | null): PinMapsFile => withTree(copy(f), moveCategory(treeOf(copy(f)), id, parent));
/** Deleting a folder keeps its pin maps (they become "not in a folder") and moves the folders inside it up a level. */
export const removeFolder = (f: PinMapsFile, id: string): PinMapsFile => withTree(copy(f), removeCategory(treeOf(copy(f)), id));

export const serializePinMaps = (f: PinMapsFile): string => JSON.stringify({ $schema: "../schema/pinmaps.schema.json", folders: f.folders, maps: f.maps }, null, 2) + "\n";

/** What changed between two versions, for the permission check: nothing about who owns what, so only whether it's a real file. */
export function pinMapIds(f: PinMapsFile | null | undefined): Set<string> {
  return new Set((f?.maps ?? []).map((m) => m.id));
}
