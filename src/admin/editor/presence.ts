/**
 * "Someone is editing this": an editor tab tells the admin API which regions it has open every 30 seconds
 * (the API forgets a tab after 90 s of silence), and the answer says who else has regions open. It's a hint to
 * avoid two people working on the same region; the real protection stays the check when saving.
 */
import type { Editing, GitHub } from "../github.ts";

export const BEAT_MS = 30_000;

/** Names of the other people (not this account) who have any of `ids` open, per `list`. */
export function othersOn(list: readonly Editing[], ids: readonly string[], meId: number | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const want = new Set(ids);
  for (const e of list) {
    if (e.id === meId) continue;
    for (const r of e.regions) {
      if (!want.has(r)) continue;
      const names = out.get(r) ?? [];
      if (!names.includes(e.login)) names.push(e.login);
      out.set(r, names);
    }
  }
  return out;
}

/** "Ann", "Ann and Bo", "Ann, Bo and Cy". */
export const joinNames = (n: readonly string[]): string => (n.length < 2 ? (n[0] ?? "") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`);

/** The warning shown above the editor / on a card; "" when nobody else has the region(s) open. */
export function editingNote(others: Map<string, string[]>, ids: readonly string[]): string {
  const names = [...new Set(ids.flatMap((i) => others.get(i) ?? []))];
  if (!names.length) return "";
  return `${joinNames(names)} ${names.length === 1 ? "has" : "have"} ${ids.length === 1 ? "this region" : "one of these regions"} open in the editor. Whoever saves second has to reload and redo their changes.`;
}

/**
 * Starts announcing `ids` (an editor tab). `onOthers` is called with who else has them open, after every beat.
 * Failures are ignored: the notice is a convenience.
 */
export function startPresence(gh: GitHub, ids: () => string[], meId: number | undefined, onOthers: (others: Map<string, string[]>) => void): { stop: () => void } {
  const tab = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => (b % 36).toString(36)).join("");
  let stopped = false;
  const beat = async () => {
    try {
      const list = await gh.editingBeat(tab, ids());
      if (!stopped) onOthers(othersOn(list, ids(), meId));
    } catch {
      /* ignore */
    }
  };
  void beat();
  const t = setInterval(() => void beat(), BEAT_MS);
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(t);
      void gh.editingDone(tab).catch(() => {});
    },
  };
}
