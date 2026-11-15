/**
 * The Activity tab: who saved, moved or deleted what, newest first, read from the branch's commit log
 * (the admin API's /commits route, limited to the content folder). Region names open in the editor.
 */
import { $, h } from "./dom.ts";
import { parseMessage, ago, type Change } from "../shared/activity.ts";
import type { GitHub } from "./github.ts";

export interface ActivityDeps {
  gh: () => GitHub;
  /** Opens a region (editor if the person may edit it, otherwise the Regions tab). Returns false when the region is gone. */
  openRegion: (id: string) => boolean;
  /** The region's display name, if it still exists. */
  regionName: (id: string) => string | null;
}

let deps: ActivityDeps;
const LIMIT = 100;

interface Raw {
  sha: string;
  commit: { message: string; author?: { name?: string; date?: string } };
  author?: { login?: string } | null;
}

export async function fetchChanges(gh: GitHub): Promise<Change[]> {
  const list = await gh.request<Raw[]>(`/repos/${gh.repo}/commits?path=content&sha=${encodeURIComponent(gh.branch)}&per_page=${LIMIT}`);
  return list.map((c) => ({ sha: c.sha, login: c.author?.login ?? c.commit.author?.name ?? "someone", date: c.commit.author?.date ?? "", ...parseMessage(c.commit.message) }));
}

function item(c: Change): HTMLElement {
  const text = h("span", { className: "act-text" });
  if (!c.verb) text.append(h("strong", { textContent: c.login }), ` — ${c.raw}`);
  else {
    text.append(h("strong", { textContent: c.login }), ` ${c.verb} `);
    c.regions.forEach((id, i) => {
      if (i) text.append(", ");
      const name = deps.regionName(id);
      if (name === null) text.append(h("span", { className: "act-gone", textContent: id, title: "This region no longer exists" }));
      else text.append(h("button", { type: "button", className: "link", textContent: id, title: `Open ${name}`, dataset: { open: id }, onclick: () => deps.openRegion(id) }));
    });
    text.append(c.tail);
  }
  return h("li", { className: "act-row", dataset: { sha: c.sha } }, text, h("time", { className: "muted small", dateTime: c.date, title: c.date ? new Date(c.date).toLocaleString() : "", textContent: ago(c.date) }));
}

export async function loadActivity(): Promise<void> {
  const list = $("#activity-list");
  const note = $("#activity-note");
  note.textContent = "Loading…";
  try {
    const changes = await fetchChanges(deps.gh());
    list.replaceChildren(...changes.map(item));
    note.textContent = changes.length ? `The last ${changes.length} changes to maps, slots and regions.` : "Nothing has been saved yet.";
  } catch (e) {
    note.textContent = `Couldn't load the activity: ${(e as Error).message}`;
  }
}

export function initActivity(d: ActivityDeps): void {
  deps = d;
  $("#activity-refresh").addEventListener("click", () => void loadActivity());
}
