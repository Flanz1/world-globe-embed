/**
 * Region categories: the folders the admin page's Regions tab sorts regions into (content/categories.json).
 * Admin only (the public embed doesn't use them). A category (shown as a folder) lists the ids of its regions and
 * a region is in at most one; regions in none show under "Uncategorized". Folders nest: `parent` is the id of the
 * folder it sits in (absent = top level), up to MAX_DEPTH levels. The list order is the order among siblings. The admin API uses `diffCategories`
 * to tell a change to the folders themselves (needs "Manage categories") from a region being moved between
 * them (needs the right to edit that region).
 */

export const CATEGORIES_PATH = "content/categories.json";
export const CATEGORY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const CATEGORY_NAME_MAX = 60;
/** How many levels of folders may sit inside each other. */
export const MAX_DEPTH = 5;
/** Regions one commit may move between folders: the admin API looks up each one's owner (a subrequest each), so the admin page moves a bigger batch in several commits. */
export const MAX_MOVED_PER_COMMIT = 24;
/**
 * Region files one commit may change. The admin API checks a commit by reading every changed region (and, for
 * anyone but the owner, what it was before): each read is a subrequest, and a request gets about 50 in all
 * (~14 are the fixed part). So the owner's commit fits 32 files, everyone else's 16; the admin page saves
 * bigger batches (editing several regions together) as several commits.
 */
export const regionsPerCommit = (owner: boolean): number => (owner ? 32 : 16);

/** A GitHub account (same shape as access.ts's Account). */
interface Creator {
  id: number;
  login: string;
}

export interface Category {
  id: string;
  name: string;
  regions: string[];
  /** The folder this one sits in; absent at the top level. */
  parent?: string;
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
  const list = (c as CategoriesFile).categories;
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
    else {
      const key = `${typeof k.parent === "string" ? k.parent : ""}/${name.toLowerCase()}`;
      if (names.has(key)) errs.push(`${where}: there are two folders called "${name}" in the same place.`);
      else names.add(key);
    }
    if (k.parent !== undefined) {
      if (typeof k.parent !== "string" || !list.some((x) => x && x.id === k.parent)) errs.push(`${where}.parent must be the id of another folder.`);
      else if (k.parent === k.id) errs.push(`${where}: a folder can't be inside itself.`);
    }
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
  if (!errs.length) {
    for (const k of list) {
      const d = depthOf({ categories: list }, k.id);
      if (d < 0) {
        errs.push(`The folder "${k.id}" is inside itself.`);
        break;
      }
      if (d >= MAX_DEPTH) {
        errs.push(`Folders can be at most ${MAX_DEPTH} levels deep ("${k.id}" is deeper).`);
        break;
      }
    }
  }
  return errs;
}

/* ── The tree ── */

const byId = (c: CategoriesFile | null | undefined) => new Map((c?.categories ?? []).map((k) => [k.id, k]));

/** The folder `id` sits in, or null at the top level (or when its parent no longer exists). */
export function parentOf(c: CategoriesFile | null | undefined, id: string): string | null {
  const m = byId(c);
  const p = m.get(id)?.parent;
  return p && m.has(p) ? p : null;
}

/** The folders directly inside `parent` (null = top level), in order. */
export const childrenOf = (c: CategoriesFile | null | undefined, parent: string | null): Category[] =>
  (c?.categories ?? []).filter((k) => parentOf(c, k.id) === parent);

/** How deep a folder is: 0 at the top level. -1 when its parents loop. */
export function depthOf(c: CategoriesFile | null | undefined, id: string): number {
  let d = 0;
  const seen = new Set([id]);
  for (let p = parentOf(c, id); p; p = parentOf(c, p)) {
    if (seen.has(p)) return -1;
    seen.add(p);
    d++;
  }
  return d;
}

/** The folder itself and everything inside it, at any depth. */
export function withDescendants(c: CategoriesFile | null | undefined, id: string): Set<string> {
  const out = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const k of c?.categories ?? []) {
      if (out.has(k.id) || !k.parent || !out.has(k.parent)) continue;
      out.add(k.id);
      grew = true;
    }
  }
  return out;
}

/** "Kingdoms › Free Cities": the folder's name with the ones it sits in. */
export function pathName(c: CategoriesFile | null | undefined, id: string): string {
  const m = byId(c);
  const parts: string[] = [];
  const seen = new Set<string>();
  for (let p: string | null = id; p && m.has(p) && !seen.has(p); p = parentOf(c, p)) {
    seen.add(p);
    parts.unshift(m.get(p)!.name);
  }
  return parts.join(" › ");
}

/** Where `id` may be moved to: every folder except itself and what's inside it, and nothing that would make the tree too deep. */
export function moveTargets(c: CategoriesFile, id: string): Category[] {
  const inside = withDescendants(c, id);
  const height = Math.max(...[...inside].map((x) => depthOf(c, x) - depthOf(c, id)));
  return c.categories.filter((k) => !inside.has(k.id) && depthOf(c, k.id) + 1 + height < MAX_DEPTH);
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
): { added: string[]; removed: string[]; renamed: string[]; reordered: boolean; moved: string[]; reparented: string[] } {
  const b = before?.categories ?? [];
  const a = after?.categories ?? [];
  const was = new Map(b.map((k) => [k.id, k]));
  const now = new Map(a.map((k) => [k.id, k]));
  const added = a.filter((k) => !was.has(k.id)).map((k) => k.id);
  const removed = b.filter((k) => !now.has(k.id)).map((k) => k.id);
  const renamed = a.filter((k) => was.has(k.id) && was.get(k.id)!.name !== k.name).map((k) => k.id);
  const keptBefore = b.filter((k) => now.has(k.id)).map((k) => k.id);
  const keptAfter = a.filter((k) => was.has(k.id)).map((k) => k.id);
  const reparented = a.filter((k) => was.has(k.id) && (was.get(k.id)!.parent ?? null) !== (k.parent ?? null)).map((k) => k.id);
  const reordered = JSON.stringify(keptBefore) !== JSON.stringify(keptAfter);
  const pa = placements(before);
  const pb = placements(after);
  const moved = [...new Set([...pa.keys(), ...pb.keys()])].filter((r) => pa.get(r) !== pb.get(r)).sort();
  return { added, removed, renamed, reordered, moved, reparented };
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

/** Why `name` can't be used for a folder inside `parent` (`except` = the folder being renamed), or null when it's fine. Two folders may share a name if they sit in different places. */
export function nameProblem(c: CategoriesFile, name: string, except?: string, parent: string | null = null): string | null {
  const n = cleanName(name);
  if (!n) return "Give the folder a name.";
  if (n.length > CATEGORY_NAME_MAX) return `Keep the name to ${CATEGORY_NAME_MAX} characters or fewer.`;
  if (childrenOf(c, parent).some((k) => k.id !== except && k.name.toLowerCase() === n.toLowerCase())) return `There's already a folder called "${n}" here.`;
  return null;
}

/* ── Edits. Each takes the file as it is now and returns the new one; the admin page applies them to a fresh copy at commit time. ── */

const copy = (c: CategoriesFile): CategoriesFile => ({ ...c, categories: c.categories.map((k) => ({ ...k, regions: [...k.regions] })) });

export function addCategory(c: CategoriesFile, name: string, by: Creator, now: string, parent: string | null = null): { file: CategoriesFile; id: string } {
  const file = copy(c);
  const id = newCategoryId(cleanName(name), new Set(file.categories.map((k) => k.id)));
  const inside = parent && file.categories.some((k) => k.id === parent) ? { parent } : {};
  file.categories.push({ id, name: cleanName(name), regions: [], ...inside, createdBy: { id: by.id, login: by.login }, created: now });
  return { file, id };
}

export function renameCategory(c: CategoriesFile, id: string, name: string): CategoriesFile {
  const file = copy(c);
  const k = file.categories.find((x) => x.id === id);
  if (k) k.name = cleanName(name);
  return file;
}

/** Moves a folder one place up (-1) or down (+1) among the folders next to it (those in the same folder). */
export function shiftCategory(c: CategoriesFile, id: string, by: -1 | 1): CategoriesFile {
  const file = copy(c);
  const sibs = childrenOf(file, parentOf(file, id)).map((k) => k.id);
  const at = sibs.indexOf(id);
  const other = sibs[at + by];
  if (at < 0 || other === undefined) return file;
  const i = file.categories.findIndex((x) => x.id === id);
  const j = file.categories.findIndex((x) => x.id === other);
  [file.categories[i], file.categories[j]] = [file.categories[j], file.categories[i]];
  return file;
}

/** Puts a folder (with everything in it) inside another folder, or at the top level (null), as the last one there. Refused moves (into itself, too deep) return the file unchanged. */
export function moveCategory(c: CategoriesFile, id: string, parent: string | null): CategoriesFile {
  const file = copy(c);
  const k = file.categories.find((x) => x.id === id);
  if (!k || (parent ?? null) === parentOf(file, id)) return file;
  if (parent !== null && !moveTargets(file, id).some((t) => t.id === parent)) return file;
  file.categories = file.categories.filter((x) => x !== k);
  if (parent === null) delete k.parent;
  else k.parent = parent;
  // Land after its new siblings (and what's inside them).
  const sibs = childrenOf(file, parent).map((x) => x.id);
  const last = sibs.length ? Math.max(...sibs.flatMap((s) => [...withDescendants(file, s)].map((d) => file.categories.findIndex((x) => x.id === d)))) : parent === null ? file.categories.length - 1 : file.categories.findIndex((x) => x.id === parent);
  file.categories.splice(last + 1, 0, k);
  return file;
}

/** Deleting a folder doesn't delete its regions (they go to "Uncategorized") or the folders inside it (they move up a level). */
export function removeCategory(c: CategoriesFile, id: string): CategoriesFile {
  const file = copy(c);
  const up = parentOf(file, id);
  file.categories = file.categories.filter((x) => x.id !== id);
  for (const k of file.categories) {
    if (k.parent !== id) continue;
    if (up) k.parent = up;
    else delete k.parent;
  }
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
