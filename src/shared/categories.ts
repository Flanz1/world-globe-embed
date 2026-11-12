/**
 * Region categories: the folders the admin page's Regions tab sorts regions into (content/categories.json).
 * Single level, admin only (the public embed doesn't use them). A category lists the ids of its regions and
 * a region is in at most one; regions in none show under "Uncategorized". The admin API uses `diffCategories`
 * to tell a change to the folders themselves (needs "Manage categories") from a region being moved between
 * them (needs the right to edit that region).
 */

export const CATEGORIES_PATH = "content/categories.json";
export const CATEGORY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const CATEGORY_NAME_MAX = 60;

/** A GitHub account (same shape as access.ts's Account). */
interface Creator {
  id: number;
  login: string;
}

export interface Category {
  id: string;
  name: string;
  regions: string[];
  /** Who created it (stamped by the admin page, verified by the API). Older or hand-made categories belong to the repository owner. */
  createdBy?: Creator;
  created?: string;
}

export interface CategoriesFile {
  $schema?: string;
  categories: Category[];
}

export const emptyCategories = (): CategoriesFile => ({ categories: [] });

/** Problems with a categories file's shape (beyond the JSON schema): duplicate ids or names, a region in two folders. */
export function checkCategories(c: unknown): string[] {
  if (!c || typeof c !== "object" || !Array.isArray((c as CategoriesFile).categories)) return ["it must be an object with a categories list."];
  const errs: string[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  const home = new Map<string, string>();
  for (const [i, k] of (c as CategoriesFile).categories.entries()) {
    const where = `categories[${i}]`;
    if (!k || typeof k !== "object") {
      errs.push(`${where} isn't an object.`);
      continue;
    }
    if (typeof k.id !== "string" || !CATEGORY_ID.test(k.id)) errs.push(`${where}.id must be lowercase letters, digits and dashes.`);
    else if (ids.has(k.id)) errs.push(`${where}: the id "${k.id}" is used twice.`);
    else ids.add(k.id);
    const name = typeof k.name === "string" ? k.name.trim() : "";
    if (!name || name.length > CATEGORY_NAME_MAX) errs.push(`${where}.name must be 1 to ${CATEGORY_NAME_MAX} characters.`);
    else if (names.has(name.toLowerCase())) errs.push(`${where}: there are two categories called "${name}".`);
    else names.add(name.toLowerCase());
    if (!Array.isArray(k.regions)) {
      errs.push(`${where}.regions must be a list.`);
      continue;
    }
    for (const r of k.regions) {
      if (typeof r !== "string") continue;
      const at = home.get(r);
      if (at !== undefined && at !== k.id) errs.push(`The region "${r}" is in two categories ("${at}" and "${k.id}").`);
      home.set(r, k.id);
    }
  }
  return errs;
}

/** Region id → id of the category it is in. */
export function placements(c: CategoriesFile | null | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const k of c?.categories ?? []) for (const r of k.regions) m.set(r, k.id);
  return m;
}

/** The category a region is in, or null for "Uncategorized". */
export const categoryOf = (c: CategoriesFile | null | undefined, regionId: string): string | null => placements(c).get(regionId) ?? null;

/**
 * What changed between two versions of the file: the categories `added` and `removed`, those `renamed`,
 * whether the order of the ones that stayed `reordered`, and the regions now in a different category (or
 * none) than before (`moved`). Regions in a category that was added or removed count as moved.
 */
export function diffCategories(
  before: CategoriesFile | null | undefined,
  after: CategoriesFile | null | undefined,
): { added: string[]; removed: string[]; renamed: string[]; reordered: boolean; moved: string[] } {
  const b = before?.categories ?? [];
  const a = after?.categories ?? [];
  const was = new Map(b.map((k) => [k.id, k]));
  const now = new Map(a.map((k) => [k.id, k]));
  const added = a.filter((k) => !was.has(k.id)).map((k) => k.id);
  const removed = b.filter((k) => !now.has(k.id)).map((k) => k.id);
  const renamed = a.filter((k) => was.has(k.id) && was.get(k.id)!.name !== k.name).map((k) => k.id);
  const keptBefore = b.filter((k) => now.has(k.id)).map((k) => k.id);
  const keptAfter = a.filter((k) => was.has(k.id)).map((k) => k.id);
  const reordered = JSON.stringify(keptBefore) !== JSON.stringify(keptAfter);
  const pa = placements(before);
  const pb = placements(after);
  const moved = [...new Set([...pa.keys(), ...pb.keys()])].filter((r) => pa.get(r) !== pb.get(r)).sort();
  return { added, removed, renamed, reordered, moved };
}

/** A new folder id from its name ("Free Cities" → "free-cities"), made unique among `taken`. */
export function newCategoryId(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "category";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** The text a name is saved as (trimmed, inner whitespace collapsed). */
export const cleanName = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Why `name` can't be used for the category `except` (null = free), or null when it's fine. */
export function nameProblem(c: CategoriesFile, name: string, except?: string): string | null {
  const n = cleanName(name);
  if (!n) return "Give the category a name.";
  if (n.length > CATEGORY_NAME_MAX) return `Keep the name to ${CATEGORY_NAME_MAX} characters or fewer.`;
  if (c.categories.some((k) => k.id !== except && k.name.toLowerCase() === n.toLowerCase())) return `There's already a category called "${n}".`;
  return null;
}

/* ── Edits. Each takes the file as it is now and returns the new one; the admin page applies them to a fresh copy at commit time. ── */

const copy = (c: CategoriesFile): CategoriesFile => ({ ...c, categories: c.categories.map((k) => ({ ...k, regions: [...k.regions] })) });

export function addCategory(c: CategoriesFile, name: string, by: Creator, now: string): { file: CategoriesFile; id: string } {
  const file = copy(c);
  const id = newCategoryId(cleanName(name), new Set(file.categories.map((k) => k.id)));
  file.categories.push({ id, name: cleanName(name), regions: [], createdBy: { id: by.id, login: by.login }, created: now });
  return { file, id };
}

export function renameCategory(c: CategoriesFile, id: string, name: string): CategoriesFile {
  const file = copy(c);
  const k = file.categories.find((x) => x.id === id);
  if (k) k.name = cleanName(name);
  return file;
}

/** Moves a folder one place up (-1) or down (+1). */
export function shiftCategory(c: CategoriesFile, id: string, by: -1 | 1): CategoriesFile {
  const file = copy(c);
  const i = file.categories.findIndex((x) => x.id === id);
  const j = i + by;
  if (i >= 0 && j >= 0 && j < file.categories.length) [file.categories[i], file.categories[j]] = [file.categories[j], file.categories[i]];
  return file;
}

/** Deleting a category doesn't delete its regions: they go to "Uncategorized". */
export function removeCategory(c: CategoriesFile, id: string): CategoriesFile {
  const file = copy(c);
  file.categories = file.categories.filter((x) => x.id !== id);
  return file;
}

/** Puts regions in a category (null = Uncategorized), taking them out of wherever they were. */
export function assignRegions(c: CategoriesFile, regionIds: readonly string[], categoryId: string | null): CategoriesFile {
  const file = copy(c);
  const set = new Set(regionIds);
  for (const k of file.categories) k.regions = k.regions.filter((r) => !set.has(r));
  const into = file.categories.find((k) => k.id === categoryId);
  if (into) into.regions.push(...regionIds.filter((r, i) => regionIds.indexOf(r) === i).sort());
  if (into) into.regions.sort();
  return file;
}

/** Drops region ids that no longer exist. */
export function pruneRegions(c: CategoriesFile, exists: ReadonlySet<string>): CategoriesFile {
  const file = copy(c);
  for (const k of file.categories) k.regions = k.regions.filter((r) => exists.has(r));
  return file;
}

export const serializeCategories = (c: CategoriesFile): string =>
  JSON.stringify({ $schema: "../schema/categories.schema.json", categories: c.categories }, null, 2) + "\n";
