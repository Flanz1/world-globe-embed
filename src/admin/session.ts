/**
 * Who is signed in to the admin page and what they may do. The page uses this only to hide or disable
 * what someone can't do; the admin API enforces the same rules (src/shared/access.ts) on every save.
 */
import { canDeleteRegion, canEditRegion, canTransferRegions, regionOwner, type Account, type Permission } from "../shared/access.ts";
import type { Me } from "./github.ts";
import type { RegionFeature } from "../shared/region.ts";

/** The repository owner's GitHub account id: owns regions saved before regions had owners. Set from the build (VITE_OWNER_ID). */
export const OWNER_ID = Number(import.meta.env.VITE_OWNER_ID ?? 45669787) || 45669787;

let me: Me | null = null;

export const setMe = (m: Me | null) => void (me = m);
export const currentUser = (): Me | null => me;
export const account = (): Account => ({ id: me!.id, login: me!.login });

export function can(p: Permission): boolean {
  return !!me && (me.owner || me.permissions.includes(p));
}

const perms = () => (me ? new Set<Permission>(me.owner ? ["maps", "regions", "editOthers", "deleteOthers", "users"] : me.permissions) : null);

export const ownerOf = (f: RegionFeature | null | undefined) => regionOwner(f, OWNER_ID);
export const canEdit = (f: RegionFeature | null | undefined) => !!me && canEditRegion(perms(), me.id, ownerOf(f));
export const canDelete = (f: RegionFeature | null | undefined) => !!me && canDeleteRegion(perms(), me.id, ownerOf(f));
/** Handing a region to another creator: the owner and admins (Manage users) only. */
export const canTransfer = () => !!me && canTransferRegions(perms(), me.owner);
