/**
 * "Recently deleted": regions and map pins deleted in the last few days, with a Restore button. Nothing extra
 * is stored: the list is read from the repository's save log (src/shared/trash.ts) and a restore is a normal
 * save that puts the file back as it was before the delete, created by the same person as before. After
 * TRASH_DAYS days an item just drops off the list.
 */
import { stringifyCompact } from "../shared/json.ts";
import { TRASH_DAYS, timeLeft, trashItems, trashSince, type TrashItem } from "../shared/trash.ts";
import type { HistoryEntry } from "../shared/history.ts";
import { h } from "./dom.ts";
import type { GitHub } from "./github.ts";
import { modal } from "./region-dialogs.ts";
import { account, currentUser, refusal } from "./session.ts";

export interface TrashOptions {
  gh: GitHub;
  /** Runs a save with the page's usual status line, reload and error handling. */
  act: (label: string, fn: () => Promise<string>) => Promise<void>;
}

const PAGE = 20;
/** At most this many pages of saves (the last few days are far fewer saves than this). */
const MAX_PAGES = 15;
const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const when = (s: string) => new Date(s).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

type Json = { properties?: Record<string, unknown> } & Record<string, unknown>;

/** The file to save when restoring: as it was, still created by the same person, saved now by the person restoring. */
export function restoredFile(text: string): string | null {
  let f: Json;
  try {
    f = JSON.parse(text) as Json;
  } catch {
    return null;
  }
  if (!f || typeof f !== "object" || !f.properties) return null;
  // A region from before regions had owners belongs to the repository owner; only they can put it back.
  if (!f.properties.createdBy && currentUser()?.owner) f.properties.createdBy = account();
  f.properties.updatedBy = account();
  f.properties.updated = stamp();
  return stringifyCompact(f) + "\n";
}

async function loadEntries(gh: GitHub, since: string): Promise<HistoryEntry[]> {
  const all: HistoryEntry[] = [];
  let page: number | null = 1;
  for (let i = 0; page !== null && i < MAX_PAGES; i++) {
    const r = await gh.history({ path: "content", limit: PAGE, page, files: true, since });
    all.push(...r.entries);
    page = r.next;
  }
  return all;
}

export function openTrash(o: TrashOptions): void {
  const m = modal("Recently deleted", "history");
  const status = h("p", { className: "muted small", textContent: "Loading…" });
  const list = h("ul", { className: "hist-list", ariaLabel: "Recently deleted" });
  m.body.append(h("p", { className: "muted small", textContent: `Deleted regions and map pins can be restored for ${TRASH_DAYS} days. After that they are gone for good from this page.` }), status, list);

  const restore = async (it: TrashItem, btn: HTMLButtonElement, note: HTMLElement) => {
    btn.disabled = true;
    note.textContent = "";
    try {
      if ((await o.gh.fileSha(it.path)) !== null) throw new Error(`There is already a ${it.kind} called "${it.id}": restoring would overwrite it.`);
      const old = await o.gh.readFileAt(it.path, it.parent);
      const text = old === null ? null : restoredFile(old);
      if (text === null) throw new Error("The deleted version can't be read any more.");
      const why = refusal({ path: it.path, before: null, after: text });
      if (why) throw new Error(/createdBy/.test(why) ? `Only ${it.kind === "pin" ? "whoever placed" : "whoever created"} it, or someone who may edit and delete other people's regions, can restore "${it.id}".` : why);
      m.close();
      await o.act(`Restoring ${it.kind} ${it.id}…`, () => o.gh.commit(`Restore ${it.kind} ${it.id}`, async () => [{ path: it.path, content: text }]));
    } catch (e) {
      note.className = "error small";
      note.textContent = (e as Error).message;
      btn.disabled = false;
    }
  };

  void (async () => {
    try {
      const now = Date.now();
      const items = trashItems(await loadEntries(o.gh, trashSince(now)), now);
      status.textContent = items.length ? `${items.length} deleted in the last ${TRASH_DAYS} days, newest first.` : `Nothing was deleted in the last ${TRASH_DAYS} days.`;
      for (const it of items) {
        const btn = h("button", { type: "button", textContent: "Restore" });
        const note = h("span", { className: "muted small" });
        btn.addEventListener("click", () => void restore(it, btn, note));
        list.append(
          h(
            "li",
            {},
            h("div", { className: "hist-item" }, h("strong", { textContent: `${it.kind === "pin" ? "Pin" : "Region"} ${it.id}` }), h("span", { className: "muted small", textContent: `deleted by ${it.deletedBy} · ${when(it.deletedAt)} · ${timeLeft(it.expires, now)} left` }), h("div", { className: "actions" }, btn, note)),
          ),
        );
      }
    } catch (e) {
      status.className = "error small";
      status.textContent = `Couldn't load the deleted items: ${(e as Error).message}`;
    }
  })();
}
