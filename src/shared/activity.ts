/** Pure helpers for the admin Activity tab (kept apart from the DOM code so they can be unit tested). */
export interface Change {
  sha: string;
  login: string;
  date: string;
  verb: string;
  regions: string[];
  /** The rest of the sentence after the region names. */
  tail: string;
  raw: string;
}

/** "2 h ago", "3 days ago", or the date once it's older than a month. */
export function ago(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 30 * 86400) {
    const d = Math.floor(s / 86400);
    return `${d} day${d === 1 ? "" : "s"} ago`;
  }
  return new Date(t).toLocaleDateString();
}

/** "Today", "Yesterday" or "Earlier", for the popup's day headings. */
export function dayGroup(iso: string, now = new Date()): "Today" | "Yesterday" | "Earlier" {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "Earlier";
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (t.getTime() >= start) return "Today";
  if (t.getTime() >= start - 86_400_000) return "Yesterday";
  return "Earlier";
}

/** Reads a commit message the admin page wrote. Anything else is shown as it is. */
export function parseMessage(msg: string): Pick<Change, "verb" | "regions" | "tail" | "raw"> {
  const line = msg.split("\n")[0].trim();
  let m = /^Saves? regions? (.+?)(?: and (\d+) more)?$/.exec(line);
  if (m) {
    const ids = m[1].split(", ").filter(Boolean);
    return { verb: "saved", regions: ids, tail: m[2] ? ` and ${m[2]} more` : "", raw: line };
  }
  if ((m = /^Move region (\S+) (to category .+|out of its .+)$/.exec(line))) return { verb: "moved", regions: [m[1]], tail: ` ${m[2]}`, raw: line };
  if ((m = /^Transfer region (\S+) to (.+)$/.exec(line))) return { verb: "handed over", regions: [m[1]], tail: ` to ${m[2]}`, raw: line };
  if ((m = /^Delete region (\S+)$/.exec(line))) return { verb: "deleted", regions: [m[1]], tail: "", raw: line };
  return { verb: "", regions: [], tail: "", raw: line };
}


/** How far back the full view looks. `days: null` is everything. */
export const RANGES = [
  { id: "1", label: "Last 24 hours", days: 1 },
  { id: "7", label: "Last 7 days", days: 7 },
  { id: "30", label: "Last 30 days", days: 30 },
  { id: "90", label: "Last 90 days", days: 90 },
  { id: "365", label: "Last year", days: 365 },
  { id: "all", label: "All activity", days: null },
] as const;
export const DEFAULT_RANGE = "7";

/** Page sizes for the full view (the biggest is the most that is worth rendering at once). */
export const PAGE_SIZES = [10, 25, 50, 100, 250, 500] as const;
export const DEFAULT_PAGE_SIZE = 50;

/** The earliest time to show for a range id (ms since epoch), or 0 for "all". */
export const cutoffFor = (rangeId: string, now = Date.now()): number => {
  const days = RANGES.find((r) => r.id === rangeId)?.days;
  return days ? now - days * 86400_000 : 0;
};

/** Changes by one person (empty `login` = everyone) that happened at or after `since`. */
export function filterChanges(all: readonly Change[], o: { login?: string; since?: number }): Change[] {
  const who = (o.login ?? "").toLowerCase();
  return all.filter((c) => (!who || c.login.toLowerCase() === who) && (!o.since || Date.parse(c.date) >= o.since));
}

export const pageCount = (total: number, size: number): number => Math.max(1, Math.ceil(total / Math.max(1, size)));

/** 1-based page of a list, clamped to the pages that exist. */
export function pageOf<T>(items: readonly T[], page: number, size: number): { items: T[]; page: number; pages: number } {
  const pages = pageCount(items.length, size);
  const p = Math.min(pages, Math.max(1, Math.floor(page) || 1));
  return { items: items.slice((p - 1) * size, p * size), page: p, pages };
}

/** The people in a list, most active first. */
export function people(all: readonly Change[]): string[] {
  const n = new Map<string, number>();
  for (const c of all) n.set(c.login, (n.get(c.login) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([l]) => l);
}
