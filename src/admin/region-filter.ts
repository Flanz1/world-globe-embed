/**
 * Search, creator filter and sorting for lists of regions. Shared by the Regions tab and the editor's
 * "Other regions" panel so both behave the same way.
 */

export interface Filterable {
  id: string;
  /** Part labels (or the region's name): searched along with the id. */
  labels: string;
  creator: string;
  creatorId: number;
  /** ISO dates; empty when unknown. */
  updated: string;
  created: string;
}

export type SortKey = "id" | "updated" | "created" | "creator";

/** Case-insensitive search over id, labels and creator; `q` must already be trimmed and lower-cased. */
export const matchesQuery = (q: string, it: Filterable): boolean =>
  !q || it.id.includes(q) || it.labels.toLowerCase().includes(q) || it.creator.toLowerCase().includes(q);

/** Creator filter value: "" for anyone, "me", or an account id. */
export function creatorId(who: string, meId: number | undefined): number | null {
  return who === "me" ? (meId ?? null) : who ? Number(who) : null;
}

export function compareBy(sort: string, a: Filterable, b: Filterable): number {
  if (sort === "updated") return b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id);
  if (sort === "created") return b.created.localeCompare(a.created) || a.id.localeCompare(b.id);
  if (sort === "creator") return a.creator.localeCompare(b.creator, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id);
  return a.id.localeCompare(b.id);
}

/** Creator choices for a filter menu: everyone who made one of the regions, except `meId`, by name. */
export function creatorChoices(items: readonly Filterable[], meId: number | undefined): [number, string][] {
  const people = new Map<number, string>();
  for (const it of items) people.set(it.creatorId, it.creator);
  return [...people].filter(([id]) => id !== meId).sort((a, b) => a[1].localeCompare(b[1]));
}
