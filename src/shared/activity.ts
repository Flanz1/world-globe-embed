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

