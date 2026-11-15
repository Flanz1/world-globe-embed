/**
 * Activity: who saved, moved or deleted what, from the admin API's save log (GET /history).
 * The left sidebar shows the latest few; "Open full activity" opens a dialog with every save, filterable by
 * person and by how far back to look (default 7 days), in pages of a size you pick.
 */
import { $, h } from "./dom.ts";
import { modal } from "./region-dialogs.ts";
import { DEFAULT_PAGE_SIZE, DEFAULT_RANGE, PAGE_SIZES, RANGES, ago, cutoffFor, filterChanges, pageOf, parseMessage, people, type Change } from "../shared/activity.ts";
import type { HistoryEntry } from "../shared/history.ts";
import type { GitHub } from "./github.ts";

export interface ActivityDeps {
  gh: () => GitHub;
  /** Opens a region (editor if the person may edit it, otherwise the Regions tab). Returns false when the region is gone. */
  openRegion: (id: string) => boolean;
  /** The region's display name, if it still exists. */
  regionName: (id: string) => string | null;
}

let deps: ActivityDeps;
const SIDEBAR_COUNT = 30;
/** The save log's page size (the API's maximum). */
const FETCH = 50;

const toChange = (e: HistoryEntry): Change => ({ sha: e.sha, login: e.author.login, date: e.date, ...parseMessage(e.message) });

/** Saves newest first until one is older than `since` (0 = all of them). `onPage` reports progress. */
export async function fetchSince(gh: GitHub, since: number, onPage?: (n: number) => void): Promise<Change[]> {
  const out: Change[] = [];
  for (let page = 1; ; ) {
    const r = await gh.history({ limit: FETCH, page });
    out.push(...r.entries.map(toChange));
    onPage?.(out.length);
    const oldest = out[out.length - 1];
    if (r.next === null || !oldest || (since && Date.parse(oldest.date) < since)) return out;
    page = r.next;
  }
}

function sentence(c: Change, compact: boolean, afterOpen?: () => void): HTMLElement {
  const text = h("span", { className: "act-text" });
  text.append(h("strong", { textContent: c.login }));
  if (!c.verb) text.append(` — ${c.raw}`);
  else {
    text.append(` ${c.verb} `);
    c.regions.forEach((id, i) => {
      if (i) text.append(", ");
      const name = deps.regionName(id);
      if (name === null) text.append(h("span", { className: "act-gone", textContent: id, title: "This region no longer exists" }));
      else
        text.append(
          h("button", {
            type: "button",
            className: "link",
            textContent: id,
            title: `Open ${name}`,
            dataset: { open: id },
            onclick: () => {
              afterOpen?.();
              deps.openRegion(id);
            },
          }),
        );
    });
    text.append(c.tail);
  }
  const time = h("time", { className: "muted small", dateTime: c.date, title: c.date ? new Date(c.date).toLocaleString() : "", textContent: compact ? ago(c.date) : `${ago(c.date)} · ${c.date ? new Date(c.date).toLocaleString() : ""}` });
  return h("li", { className: "act-row", dataset: { sha: c.sha } }, text, time);
}

/* ── Sidebar ── */

export async function loadActivity(): Promise<void> {
  const list = $("#activity-list");
  const note = $("#activity-note");
  try {
    const r = await deps.gh().history({ limit: SIDEBAR_COUNT });
    const changes = r.entries.map(toChange);
    list.replaceChildren(...changes.map((c) => sentence(c, true)));
    note.textContent = changes.length ? "" : "Nothing has been saved yet.";
  } catch (e) {
    note.textContent = `Couldn't load the activity: ${(e as Error).message}`;
  }
}

/* ── Full view ── */

export function openFullActivity(): void {
  const m = modal("Activity", "activity-dlg");
  const select = (label: string, id: string, opts: { value: string; text: string }[], value: string) => {
    const el = h("select", { id });
    el.append(...opts.map((o) => h("option", { value: o.value, textContent: o.text, selected: o.value === value })));
    return { el, label: h("label", {}, label, " ", el) };
  };
  const who = select("Person", "act-who", [{ value: "", text: "Everyone" }], "");
  const range = select("Show", "act-range", RANGES.map((r) => ({ value: r.id, text: r.label })), DEFAULT_RANGE);
  const size = select("Per page", "act-size", PAGE_SIZES.map((n) => ({ value: String(n), text: String(n) })), String(DEFAULT_PAGE_SIZE));
  const status = h("p", { className: "muted small", ariaLive: "polite" });
  const list = h("ul", { className: "activity" });
  const first = h("button", { type: "button", className: "ghost", textContent: "« First" });
  const prev = h("button", { type: "button", className: "ghost", textContent: "‹ Newer" });
  const next = h("button", { type: "button", className: "ghost", textContent: "Older ›" });
  const last = h("button", { type: "button", className: "ghost", textContent: "Last »" });
  const where = h("span", { className: "muted small" });
  const pager = h("div", { className: "row act-pager" }, first, prev, where, next, last);
  m.body.append(h("div", { className: "row act-filters" }, who.label, range.label, size.label), status, list, pager);

  let all: Change[] = [];
  /** How far back `all` reaches: 0 = everything is loaded; otherwise the time it was loaded back to. */
  let loadedTo: number | null = null;
  let page = 1;
  let token = 0;

  const render = () => {
    const rows = filterChanges(all, { login: who.el.value, since: cutoffFor(range.el.value) });
    const p = pageOf(rows, page, Number(size.el.value));
    page = p.page;
    list.replaceChildren(...p.items.map((c) => sentence(c, false, m.close)));
    status.textContent = rows.length ? `${rows.length} change${rows.length === 1 ? "" : "s"}` : "Nothing in this range.";
    where.textContent = `Page ${p.page} of ${p.pages}`;
    first.disabled = prev.disabled = p.page <= 1;
    next.disabled = last.disabled = p.page >= p.pages;
    pager.hidden = p.pages <= 1;
  };
  const refillPeople = () => {
    const keep = who.el.value;
    const names = people(all);
    who.el.replaceChildren(h("option", { value: "", textContent: "Everyone" }), ...names.map((n) => h("option", { value: n, textContent: n, selected: n === keep })));
  };
  /** Makes sure enough history is loaded for the chosen range. */
  const load = async () => {
    const since = cutoffFor(range.el.value);
    if (loadedTo !== null && (loadedTo === 0 || (since && loadedTo <= since))) return render();
    const mine = ++token;
    status.textContent = "Loading…";
    try {
      const got = await fetchSince(deps.gh(), since, (n) => mine === token && (status.textContent = `Loading… ${n} so far`));
      if (mine !== token) return;
      all = got;
      loadedTo = since;
      refillPeople();
      render();
    } catch (e) {
      if (mine === token) status.textContent = `Couldn't load the activity: ${(e as Error).message}`;
    }
  };
  range.el.addEventListener("change", () => ((page = 1), void load()));
  who.el.addEventListener("change", () => ((page = 1), render()));
  size.el.addEventListener("change", () => ((page = 1), render()));
  first.addEventListener("click", () => ((page = 1), render()));
  prev.addEventListener("click", () => (page--, render()));
  next.addEventListener("click", () => (page++, render()));
  last.addEventListener("click", () => ((page = 1e9), render()));
  void load();
}

export function initActivity(d: ActivityDeps): void {
  deps = d;
  $("#activity-open").addEventListener("click", openFullActivity);
}
