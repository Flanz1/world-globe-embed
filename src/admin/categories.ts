/**
 * Region categories on the admin page: the state (content/categories.json), who may change what, and the
 * dialogs to add, rename, reorder and delete categories and to move regions between them. Every change is
 * one commit made on a fresh copy of the file, so two people saving at once don't overwrite each other.
 * The admin API enforces the same rules (src/shared/access.ts): "Create regions" is enough to add categories
 * and manage your own, "Edit others' regions" covers everyone's.
 */
import {
  CATEGORIES_PATH,
  CATEGORY_NAME_MAX,
  addCategory,
  assignRegions,
  cleanName,
  emptyCategories,
  nameProblem,
  placements,
  pruneRegions,
  removeCategory,
  renameCategory,
  serializeCategories,
  shiftCategory,
  type CategoriesFile,
  type Category,
} from "../shared/categories.ts";
import { h } from "./dom.ts";
import { hasPendingSaves, optimistic } from "./optimistic.ts";
import { GitHubError, type GitHub } from "./github.ts";
import { confirmBox, modal } from "./region-dialogs.ts";
import { OWNER_ID, account, can, currentUser, refusal } from "./session.ts";

export interface CategoriesDeps {
  gh: () => GitHub;
  /** Redraws the Regions tab after the local state changed. */
  render: () => void;
  /** Who created a region (account id), or null when there's no such region. */
  regionOwner: (id: string) => number | null;
  /** Ids of the regions that exist now (to tidy away ids of deleted ones). */
  regionIds: () => Set<string>;
}

let deps: CategoriesDeps;
let current: CategoriesFile = emptyCategories();

export const categories = (): CategoriesFile => current;
export const initCategories = (d: CategoriesDeps) => void (deps = d);

/** Reads the file; a missing or unreadable one means no categories (everything shows as uncategorized). */
async function read(gh: GitHub): Promise<CategoriesFile> {
  try {
    const f = JSON.parse(await gh.readText(CATEGORIES_PATH)) as CategoriesFile;
    return Array.isArray(f?.categories) ? f : emptyCategories();
  } catch (e) {
    if (e instanceof GitHubError && e.status !== 404) throw e;
    return emptyCategories();
  }
}

export async function loadCategories(): Promise<void> {
  const fresh = await read(deps.gh());
  if (!hasPendingSaves()) current = fresh;
}

/* ── Who may do what ── */

export const canAddCategory = () => can("regions");
/** Own categories with "Create regions", anyone's with "Edit others' regions"; categories with no creator belong to the owner. */
export function canEditCategory(k: Category): boolean {
  const me = currentUser();
  if (!me) return false;
  if (me.owner || can("editOthers")) return true;
  return can("regions") && (k.createdBy?.id ?? OWNER_ID) === me.id;
}
export const creatorOf = (k: Category) => k.createdBy?.login ?? "the owner";

/* ── Saving ── */

const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

/**
 * Applies the change on screen at once and commits it in the background (see optimistic.ts). The commit
 * edits a fresh copy of the file, so changes someone else made meanwhile are kept.
 */
function save(message: string, edit: (c: CategoriesFile) => CategoriesFile): Promise<void> {
  let next = current;
  return optimistic<CategoriesFile>({
    label: message,
    check: () => {
      next = pruneRegions(edit(current), deps.regionIds());
      // The same rules the admin API applies when it receives the commit.
      const owners: Record<string, number | null> = {};
      for (const k of [...current.categories, ...next.categories]) for (const id of k.regions) owners[id] = deps.regionOwner(id);
      const why = refusal({ path: CATEGORIES_PATH, before: serializeCategories(current), after: serializeCategories(next), regionOwners: owners });
      return why && `Can't ${message[0].toLowerCase()}${message.slice(1)}: ${why}`;
    },
    apply: () => {
      const before = current;
      current = next;
      return before;
    },
    undo: (before) => void (current = before),
    render: deps.render,
    commit: () =>
      deps.gh().commit(message, async () => {
        const fresh = await read(deps.gh());
        return [{ path: CATEGORIES_PATH, content: serializeCategories(pruneRegions(edit(fresh), deps.regionIds())) }];
      }),
  });
}

/** Puts regions in a category (null = uncategorized). */
export function moveRegions(ids: string[], categoryId: string | null): Promise<void> {
  const name = current.categories.find((k) => k.id === categoryId)?.name;
  return save(`Move ${ids.length === 1 ? `region ${ids[0]}` : `${ids.length} regions`} ${name ? `to category ${name}` : "out of its category"}`, (c) => assignRegions(c, ids, categoryId));
}

export const placementOf = (regionId: string): string | null => placements(current).get(regionId) ?? null;

export function shift(k: Category, by: -1 | 1): Promise<void> {
  return save(`Move category ${k.name} ${by < 0 ? "up" : "down"}`, (c) => shiftCategory(c, k.id, by));
}

/* ── Dialogs ── */

/** Asks for a name; `except` is the category being renamed. */
function askName(title: string, ok: string, initial: string, except: string | undefined, then: (name: string) => void): void {
  const m = modal(title);
  const input = h("input", { type: "text", value: initial, maxLength: CATEGORY_NAME_MAX, autocomplete: "off", ariaLabel: "Category name", dataset: { field: "category-name" } });
  const err = h("p", { className: "error small", ariaLive: "polite" });
  const go = h("button", { type: "submit", textContent: ok, dataset: { action: "confirm-category" } });
  const form = h("form", { className: "dlg-body" }, h("label", {}, "Name ", input), err);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const problem = nameProblem(current, input.value, except);
    if (problem) {
      err.textContent = problem;
      return;
    }
    m.close();
    then(cleanName(input.value));
  });
  m.body.append(form);
  m.foot.append(h("button", { type: "button", className: "ghost", textContent: "Cancel", onclick: m.close }), go);
  go.addEventListener("click", (e) => {
    e.preventDefault();
    form.requestSubmit();
  });
  input.focus();
  input.select();
}

export function newCategory(): void {
  if (!canAddCategory()) return;
  askName("New category", "Add category", "", undefined, (name) => void save(`Add category ${name}`, (c) => addCategory(c, name, account(), stamp()).file));
}

export function rename(k: Category): void {
  if (!canEditCategory(k)) return;
  askName("Rename category", "Rename", k.name, k.id, (name) => void save(`Rename category ${k.name} to ${name}`, (c) => renameCategory(c, k.id, name)));
}

export async function remove(k: Category): Promise<void> {
  if (!canEditCategory(k)) return;
  const n = k.regions.filter((r) => deps.regionIds().has(r)).length;
  const text = n ? `"${k.name}" will be deleted. Its ${n === 1 ? "region isn't" : `${n} regions aren't`} deleted: ${n === 1 ? "it goes" : "they go"} back to Uncategorized.` : `"${k.name}" will be deleted.`;
  if (await confirmBox("Delete category?", text, "Delete category", "Cancel", true)) void save(`Delete category ${k.name}`, (c) => removeCategory(c, k.id));
}
