/**
 * The save log: who changed what in content/, and when, as the admin API's GET /history serves it.
 * The Regions tab's version history and the activity feed both read it; they share these types and
 * helpers so neither has to re-parse GitHub's commit format.
 */

/** One save: a commit on the content branch. */
export interface HistoryEntry {
  sha: string;
  /** The save this one built on (its first parent); null for the very first. */
  parent?: string | null;
  /** ISO time of the commit. */
  date: string;
  /** Who made it. `id` is the GitHub account id when GitHub knows the account (a commit by a bot or an unlinked email has none). */
  author: { login: string; id: number | null };
  /** The commit message (first 300 characters). */
  message: string;
  /** Changed files, only when asked for with `files=1`. */
  files?: { path: string; status: "added" | "modified" | "removed" | "renamed" }[];
}

export interface HistoryPage {
  entries: HistoryEntry[];
  /** Pass as `page` to get older saves, or null when there are no more. */
  next: number | null;
}

export const HISTORY_MAX_LIMIT = 50;
/** `files=1` costs one GitHub request per save, so it covers fewer saves per page. */
export const HISTORY_MAX_WITH_FILES = 20;

/** The region id of a changed file (`content/regions/<id>.json`), or null for any other file. */
export function regionIdOf(path: string): string | null {
  const m = /^content\/regions\/([^/]+)\.json$/.exec(path);
  return m ? m[1] : null;
}

/** Ids of the regions a save touched (needs `files`). */
export function regionsTouched(e: HistoryEntry): string[] {
  return (e.files ?? []).map((f) => regionIdOf(f.path)).filter((x): x is string => !!x);
}
