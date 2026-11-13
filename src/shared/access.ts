/**
 * Who may do what on the admin page: the permission names, the presets the Users tab offers, and the
 * rules the admin API (worker/) applies to every change before it reaches the repository. The admin page
 * uses the same functions to hide what a user can't do, but that is only a convenience: the API is
 * where the rules are enforced.
 *
 * The list of users lives in content/access.json. The repository owner (the API's OWNER_ID) always has
 * every permission, whatever that file says, so nobody can lock them out.
 */

import { CATEGORIES_PATH, checkCategories, diffCategories, placements, type CategoriesFile } from "./categories.ts";

export const PERMISSIONS = ["maps", "regions", "editOthers", "deleteOthers", "users"] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_LABELS: Record<Permission, { label: string; help: string }> = {
  maps: { label: "Maps & slots", help: "Open the Maps & slots tab: upload or replace map images, add slots and change slot settings." },
  regions: { label: "Create regions", help: "Draw new regions, and edit or delete the regions they created. Also create region folders and manage your own." },
  editOthers: { label: "Edit others' regions", help: "Change regions other people created, and rename, move, delete or fill other people's region folders." },
  deleteOthers: { label: "Delete others' regions", help: "Delete regions other people created." },
  users: { label: "Manage users", help: "Open the Users tab: add people and change what they can do (only up to their own permissions)." },
};

export const PRESETS: { name: string; permissions: Permission[] }[] = [
  { name: "Contributor", permissions: ["regions"] },
  { name: "Editor", permissions: ["regions", "editOthers"] },
  { name: "Admin", permissions: ["maps", "regions", "editOthers", "deleteOthers", "users"] },
];

/** A GitHub account, by its permanent numeric id (logins can be renamed) and the login it had when stored. */
export interface Account {
  id: number;
  login: string;
}

export interface AccessUser extends Account {
  permissions: Permission[];
  /** When they were added, and by whom (login). Informational. */
  added?: string;
  addedBy?: string;
}

/** content/access.json */
export interface AccessFile {
  $schema?: string;
  users: AccessUser[];
}

export const ACCESS_PATH = "content/access.json";
export const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

const isPermission = (p: unknown): p is Permission => typeof p === "string" && (PERMISSIONS as readonly string[]).includes(p);

/** The preset whose permissions are exactly these, or null ("Custom"). */
export function presetOf(perms: readonly Permission[]): string | null {
  const set = new Set(perms);
  const hit = PRESETS.find((p) => p.permissions.length === set.size && p.permissions.every((x) => set.has(x)));
  return hit?.name ?? null;
}

/** Problems with an access file's shape (beyond the JSON schema): duplicate ids, unknown permissions. */
export function checkAccess(a: unknown): string[] {
  const errs: string[] = [];
  if (!a || typeof a !== "object" || !Array.isArray((a as AccessFile).users)) return ["access.json must be an object with a users list."];
  const seen = new Set<number>();
  for (const [i, u] of (a as AccessFile).users.entries()) {
    const where = `users[${i}]`;
    if (!u || typeof u !== "object") {
      errs.push(`${where} isn't an object.`);
      continue;
    }
    if (!Number.isSafeInteger(u.id) || u.id <= 0) errs.push(`${where}.id must be a GitHub account id (a positive whole number).`);
    if (typeof u.login !== "string" || !LOGIN.test(u.login)) errs.push(`${where}.login isn't a valid GitHub username.`);
    if (!Array.isArray(u.permissions) || !u.permissions.every(isPermission)) errs.push(`${where}.permissions has an unknown permission.`);
    else if (new Set(u.permissions).size !== u.permissions.length) errs.push(`${where}.permissions lists a permission twice.`);
    if (seen.has(u.id)) errs.push(`${where}: the account ${u.id} is listed twice.`);
    seen.add(u.id);
  }
  return errs;
}

/** What `userId` may do. The owner has everything; someone not listed has nothing (null). */
export function permissionsOf(access: AccessFile | null, userId: number, ownerId: number): Set<Permission> | null {
  if (userId === ownerId) return new Set(PERMISSIONS);
  const u = access?.users.find((x) => x.id === userId);
  return u ? new Set(u.permissions.filter(isPermission)) : null;
}

/** The account a region belongs to. Regions saved before owners existed belong to the repository owner. */
export function regionOwner(f: { properties?: { createdBy?: Account } } | null | undefined, ownerId: number): number {
  const id = f?.properties?.createdBy?.id;
  return typeof id === "number" ? id : ownerId;
}

/** Who may hand a region to another creator: the repository owner, or anyone allowed to manage users (admins). */
export const canTransferRegions = (perms: ReadonlySet<Permission> | null, isOwner: boolean) => isOwner || !!perms?.has("users");

/** True when two regions differ only in who created them and the save stamps (so an ownership transfer, nothing else). */
function onlyOwnershipDiffers(a: RegionLike, b: RegionLike): boolean {
  const strip = (r: RegionLike) => {
    const props: Record<string, unknown> = { ...r.properties };
    for (const k of ["createdBy", "created", "updatedBy", "updated"]) delete props[k];
    return { ...r, properties: props };
  };
  return same(strip(a), strip(b));
}

export const canEditRegion = (perms: ReadonlySet<Permission> | null, userId: number, owner: number) =>
  !!perms && (owner === userId ? perms.has("regions") : perms.has("editOthers"));

export const canDeleteRegion = (perms: ReadonlySet<Permission> | null, userId: number, owner: number) =>
  !!perms && (owner === userId ? perms.has("regions") : perms.has("deleteOthers"));

/** What a path in the repository is, for the rules below. */
export type PathKind = "region" | "maps" | "access" | "categories" | "content" | "outside";
const REGION_FILE = /^content\/regions\/([a-z0-9][a-z0-9-]{0,63})\.json$/;

export function pathKind(path: string): PathKind {
  if (REGION_FILE.test(path)) return "region";
  if (path === ACCESS_PATH) return "access";
  if (path === CATEGORIES_PATH) return "categories";
  if (path === "content/slots.json" || path.startsWith("content/maps/") || path.startsWith("content/incoming/")) return "maps";
  if (path.startsWith("content/")) return "content";
  return "outside";
}

/** One file a commit adds, changes or removes. `before`/`after` are the file's text (null = absent); only read for regions, access.json and categories.json. */
export interface FileDiff {
  path: string;
  before: string | null;
  after: string | null;
  /**
   * For categories.json: who created each region whose category changes, as of the commit being built on
   * (region id → creator's account id, or null when no such region exists). The API looks these up.
   */
  regionOwners?: Record<string, number | null>;
}

export interface Actor extends Account {
  permissions: ReadonlySet<Permission>;
  owner: boolean;
}

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
type RegionLike = { id?: unknown; properties?: { createdBy?: Account; updatedBy?: Account; updated?: string; created?: string } };

/**
 * Whether `actor` may make this change. Returns the reason it's refused, or null when it's allowed.
 * Shape checks (JSON schema) are done separately; this is only about who may change what.
 */
export function checkChange(d: FileDiff, actor: Actor, ownerId: number): string | null {
  const kind = pathKind(d.path);
  const has = (p: Permission) => actor.owner || actor.permissions.has(p);
  switch (kind) {
    case "outside":
      return `Only files in content/ can be changed from the admin page (not ${d.path}).`;
    case "content":
      return actor.owner ? null : `Only the repository owner can change ${d.path}.`;
    case "maps":
      return has("maps") ? null : "You don't have permission to change maps or slots.";
    case "access":
      return checkAccessChange(d, actor, ownerId);
    case "region":
      return checkRegionChange(d, actor, ownerId);
    case "categories":
      return checkCategoriesChange(d, actor, ownerId);
  }
}

function checkRegionChange(d: FileDiff, actor: Actor, ownerId: number): string | null {
  const id = REGION_FILE.exec(d.path)![1];
  const before = d.before === null ? null : (parse(d.before) as RegionLike | undefined);
  const after = d.after === null ? null : (parse(d.after) as RegionLike | undefined);
  if (after === undefined) return `${d.path} isn't valid JSON.`;
  // A broken file can still be deleted by whoever could delete it if it were whole (its owner is unknown: the repository owner).
  const owner = regionOwner(before ?? null, ownerId);
  const mine = owner === actor.id;
  if (!after) {
    if (actor.owner || canDeleteRegion(actor.permissions, actor.id, owner)) return null;
    return mine ? "You don't have permission to delete regions." : `You can't delete "${id}": someone else created it.`;
  }
  if (after.id !== id) return `The region in ${d.path} must have the id "${id}".`;
  const updatedBy = after.properties?.updatedBy;
  if (!updatedBy || updatedBy.id !== actor.id || updatedBy.login !== actor.login) return `"${id}" must be saved with updatedBy set to you (${actor.login}).`;
  if (!before) {
    if (!actor.owner && !actor.permissions.has("regions")) return "You don't have permission to create regions.";
    const c = after.properties?.createdBy;
    if (actor.owner && c) return null; // The owner may record someone else as the creator (e.g. when moving regions over).
    if (!c || c.id !== actor.id || c.login !== actor.login) return `New region "${id}" must have createdBy set to you (${actor.login}).`;
    return null;
  }
  const transfer = !same(before.properties?.createdBy, after.properties?.createdBy);
  const mayTransfer = canTransferRegions(actor.permissions, actor.owner);
  // Handing a region to someone else is allowed to the owner and admins, even for regions they couldn't otherwise edit, as long as nothing else changes.
  if (transfer && mayTransfer && !actor.owner && !canEditRegion(actor.permissions, actor.id, owner) && onlyOwnershipDiffers(before, after)) return null;
  if (!actor.owner && !canEditRegion(actor.permissions, actor.id, owner))
    return mine ? "You don't have permission to edit regions." : `You can't edit "${id}": someone else created it.`;
  if (transfer && !mayTransfer) return `Only the repository owner or an admin can change who created "${id}".`;
  return null;
}

function checkAccessChange(d: FileDiff, actor: Actor, ownerId: number): string | null {
  if (!actor.owner && !actor.permissions.has("users")) return "You don't have permission to manage users.";
  if (d.after === null) return "access.json can't be deleted.";
  const after = parse(d.after) as AccessFile | undefined;
  const errs = checkAccess(after);
  if (errs.length) return `access.json: ${errs[0]}`;
  if (actor.owner) return null;
  const before = (d.before === null ? null : (parse(d.before) as AccessFile | undefined)) ?? { users: [] };
  const old = new Map(before.users.map((u) => [u.id, u]));
  const next = new Map(after!.users.map((u) => [u.id, u]));
  // Nobody but the owner changes their own entry, or the owner's.
  for (const id of [actor.id, ownerId]) if (!same(old.get(id), next.get(id))) return id === actor.id ? "You can't change your own permissions." : "You can't change the repository owner's entry.";
  // Permissions can only be handed out by someone who has them.
  for (const u of next.values()) {
    const had = new Set(old.get(u.id)?.permissions ?? []);
    const extra = u.permissions.filter((p) => !had.has(p) && !actor.permissions.has(p));
    if (extra.length) return `You can't give ${u.login} "${PERMISSION_LABELS[extra[0]].label}": you don't have it yourself.`;
  }
  // Taking a permission away is fine only if the actor holds it too (so an editor can't strip an admin).
  for (const u of old.values()) {
    const now = new Set(next.get(u.id)?.permissions ?? []);
    const lost = u.permissions.filter((p) => !now.has(p) && !actor.permissions.has(p));
    if (lost.length) return `You can't take "${PERMISSION_LABELS[lost[0]].label}" from ${u.login}: you don't have it yourself.`;
  }
  return null;
}

/**
 * categories.json follows the region rules. "Create regions" lets someone add categories and rename or
 * delete their own; "Edit others' regions" does the same for anyone's. Moving a region into or out of a
 * folder needs the right to edit that region. Order is cosmetic: anyone who can create regions may
 * reorder. (A category with no creator recorded belongs to the repository owner.)
 */
function checkCategoriesChange(d: FileDiff, actor: Actor, ownerId: number): string | null {
  const mayCreate = actor.owner || actor.permissions.has("regions");
  const mayEditAny = actor.owner || actor.permissions.has("editOthers");
  if (!mayCreate) return "You don't have permission to change categories.";
  const parsed = d.after === null ? { categories: [] } : (parse(d.after) as CategoriesFile | undefined);
  if (d.after !== null) {
    if (parsed === undefined) return `${d.path} isn't valid JSON.`;
    const errs = checkCategories(parsed);
    if (errs.length) return `categories.json: ${errs[0]}`;
  }
  const after = parsed as CategoriesFile;
  const before = d.before === null ? null : (parse(d.before) as CategoriesFile | undefined);
  if (before === undefined) return "categories.json before this change isn't valid JSON.";
  const diff = diffCategories(before, after);
  const owned = (k: { createdBy?: Account }) => (k.createdBy?.id ?? ownerId) === actor.id;
  const mayEdit = (k: { createdBy?: Account }) => mayEditAny || owned(k);
  const was = new Map((before?.categories ?? []).map((k) => [k.id, k]));
  const now = new Map(after.categories.map((k) => [k.id, k]));
  for (const id of diff.added) {
    const c = now.get(id)!.createdBy;
    if (actor.owner && c) continue; // The owner may record someone else as the creator.
    if (!c || c.id !== actor.id || c.login !== actor.login) return `The new category "${now.get(id)!.name}" must have createdBy set to you (${actor.login}).`;
  }
  for (const id of diff.removed) if (!mayEdit(was.get(id)!)) return `You can't delete the category "${was.get(id)!.name}": ${creatorName(was.get(id)!)} created it.`;
  for (const id of diff.renamed) if (!mayEdit(was.get(id)!)) return `You can't rename the category "${was.get(id)!.name}": ${creatorName(was.get(id)!)} created it.`;
  for (const [id, k] of was) if (now.has(id) && !actor.owner && !same(k.createdBy, now.get(id)!.createdBy)) return `Only the repository owner can change who created "${k.name}".`;
  // A folder moved into another folder (or out to the top level) is changed like a rename: the folder's owner, or someone who may edit others'. Folders whose own parent is being deleted just move up a level.
  for (const id of diff.reparented) {
    const k = was.get(id)!;
    if (k.parent && diff.removed.includes(k.parent)) continue;
    if (!mayEdit(k)) return `You can't move the category "${k.name}": ${creatorName(k)} created it.`;
  }
  // Regions leaving a category that is being deleted just become uncategorized: that isn't moving them.
  const gone = new Set(diff.removed);
  const placedBefore = placements(before);
  const placedAfter = placements(after);
  for (const id of diff.moved) {
    if (actor.owner) break; // The repository owner may move any region.
    if (gone.has(placedBefore.get(id) ?? "") && !placedAfter.has(id)) continue;
    const owner = d.regionOwners?.[id];
    if (owner === undefined) return `Can't tell who created "${id}".`;
    // A leftover id of a region that was deleted: anyone may tidy it away, but nobody may reserve a new one.
    if (owner === null) {
      if (placedAfter.has(id)) return `There's no region "${id}" to put in a category.`;
      continue;
    }
    if (!canEditRegion(actor.permissions, actor.id, owner)) return `You can't move "${id}" between categories: someone else created it, and you can't edit other people's regions.`;
  }
  return null;
}

const creatorName = (k: { createdBy?: Account }) => k.createdBy?.login ?? "the owner";
