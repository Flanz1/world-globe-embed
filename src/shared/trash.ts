/**
 * The trash for deleted regions and map pins. Nothing extra is stored: a delete is a commit that removes the
 * file, so the repository's save log already knows what was deleted, when and by whom, and the file as it was
 * is in the commit before. A deleted item stays in the "Recently deleted" list for TRASH_DAYS days and can be
 * restored (a normal save that puts the file back); after that it just drops off the list.
 */
import type { HistoryEntry } from "./history.ts";

export const TRASH_DAYS = 3;
const DAY = 86_400_000;

export interface TrashItem {
  kind: "region" | "pin";
  id: string;
  path: string;
  /** The save that deleted it, and the save before that, which still has the file. */
  sha: string;
  parent: string;
  deletedBy: string;
  deletedAt: string;
  /** ISO time after which it leaves the list. */
  expires: string;
}

/** The oldest delete that is still in the trash at `now`, as an ISO time for the save log's `since`. */
export const trashSince = (now: number): string => new Date(now - TRASH_DAYS * DAY).toISOString().replace(/\.\d+Z$/, "Z");

const FILE = /^content\/(regions|pins)\/([a-z0-9][a-z0-9-]{0,63})\.json$/;

/**
 * What is in the trash: the files deleted within the last TRASH_DAYS days that are still gone.
 * `entries` is the save log with `files`, newest first. A file that was saved again after its delete (a new
 * region with the same id) isn't in the trash, and neither is one a rename moved (the same save adds another file).
 */
export function trashItems(entries: readonly HistoryEntry[], now: number, exists: (path: string) => boolean = () => false): TrashItem[] {
  const seen = new Set<string>();
  const out: TrashItem[] = [];
  for (const e of entries) {
    const at = Date.parse(e.date);
    const files = e.files ?? [];
    for (const f of files) {
      const m = FILE.exec(f.path);
      if (!m || seen.has(f.path)) continue;
      seen.add(f.path);
      if (f.status !== "removed" || !e.parent || !(at >= now - TRASH_DAYS * DAY) || exists(f.path)) continue;
      if (files.some((g) => g.status !== "removed" && FILE.exec(g.path)?.[1] === m[1])) continue;
      out.push({ kind: m[1] === "pins" ? "pin" : "region", id: m[2], path: f.path, sha: e.sha, parent: e.parent, deletedBy: e.author.login, deletedAt: e.date, expires: new Date(at + TRASH_DAYS * DAY).toISOString() });
    }
  }
  return out;
}

/** "2 days 4 hours", "5 hours" or "under an hour": how long until `expires`. */
export function timeLeft(expires: string, now: number): string {
  const ms = Date.parse(expires) - now;
  if (!(ms > 0)) return "expired";
  const h = Math.floor(ms / 3_600_000);
  const d = Math.floor(h / 24);
  if (d) return `${d} day${d === 1 ? "" : "s"}${h % 24 ? ` ${h % 24} hour${h % 24 === 1 ? "" : "s"}` : ""}`;
  return h ? `${h} hour${h === 1 ? "" : "s"}` : "under an hour";
}
