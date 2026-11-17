/**
 * Changing a region's id (its file name, and so the `?region=<id>` of every embed that shows it). These are the
 * pure parts: what refers to a region by id, and the same data with the id swapped. The admin page makes the
 * commits (regions.ts) and the admin API checks them like any other save.
 */
import type { CategoriesFile } from "./categories.ts";
import type { RegionFeature } from "./region.ts";

/** The region with `oldId` replaced by `newId` in its list of linked regions and in its underlays, or null when it refers to neither. */
export function renameInRegion(f: RegionFeature, oldId: string, newId: string): RegionFeature | null {
  const p = f.properties;
  const linked = p.linked?.includes(oldId);
  const under = p.under?.some((u) => u.id === oldId);
  if (!linked && !under) return null;
  const out = structuredClone(f);
  if (linked) out.properties.linked = [...new Set(p.linked!.map((x) => (x === oldId ? newId : x)))];
  if (under) {
    const seen = new Set<string>();
    out.properties.under = p.under!.map((u) => (u.id === oldId ? { ...u, id: newId } : u)).filter((u) => (seen.has(u.id) ? false : (seen.add(u.id), true)));
  }
  return out;
}

/** The folders file with `oldId` swapped for `newId` (in the folder's list and its pinned list), or null when no folder lists it. */
export function renameInCategories(c: CategoriesFile, oldId: string, newId: string): CategoriesFile | null {
  if (!c.categories.some((k) => k.regions.includes(oldId))) return null;
  const swap = (l: string[]) => l.map((x) => (x === oldId ? newId : x));
  return { ...c, categories: c.categories.map((k) => (k.regions.includes(oldId) ? { ...k, regions: swap(k.regions), ...(k.pinned ? { pinned: swap(k.pinned) } : {}) } : k)) };
}

/** Why `id` can't be a region's new id, or null: the same rule as the editor's id field, plus "not already taken". */
export function newIdProblem(id: string, oldId: string, taken: ReadonlySet<string>, valid: RegExp): string | null {
  if (!id) return "Enter an id.";
  if (id === oldId) return "That's the current id.";
  if (!valid.test(id)) return "Use only lowercase letters a-z, digits and hyphens, starting with a letter or digit (up to 64 characters).";
  if (taken.has(id)) return `The id "${id}" is taken. Choose another one.`;
  return null;
}
