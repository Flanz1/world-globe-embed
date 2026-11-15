/**
 * Pin maps and their folders on the admin page's Pins tab (content/pinmaps.json): the state, the dialogs to add,
 * rename, move, reorder and delete folders and pin maps, and the folder tree itself. It works like the Regions tab's
 * folders (the same shared tree code), but pin maps are what sit in the folders. Nothing here has an owner: anyone
 * who may create regions can organise them, and the admin API enforces the same (src/shared/access.ts). Every change
 * is one commit made on a fresh copy of the file, so two people saving at once don't overwrite each other.
 */
import { CATEGORY_NAME_MAX, childrenOf, cleanName, moveTargets, pathName } from "../shared/categories.ts";
import {
  PINMAPS_PATH,
  PINMAP_NAME_MAX,
  addFolder,
  addPinMap,
  emptyPinMaps,
  folderNameProblem,
  folderOf,
  mapNameProblem,
  moveFolder as moveFolderEdit,
  movePinMap,
  removeFolder as removeFolderEdit,
  removePinMap,
  renameFolder as renameFolderEdit,
  renamePinMap,
  serializePinMaps,
  shiftFolder,
  treeOf,
  type PinMap,
  type PinMapsFile,
} from "../shared/pinmaps.ts";
import type { Category } from "../shared/categories.ts";
import { h } from "./dom.ts";
import { GitHubError, type GitHub } from "./github.ts";
import { confirmBox, modal } from "./region-dialogs.ts";
import { can, refusal } from "./session.ts";

export interface PinMapsDeps {
  gh: () => GitHub;
  /** Commits with the admin page's busy/status handling (then the page reloads). */
  act: (label: string, fn: () => Promise<string>) => Promise<void>;
  /** Redraws the Pins tab after the local state changed. */
  render: () => void;
}

let deps: PinMapsDeps;
let current: PinMapsFile = emptyPinMaps();

export const pinMaps = (): PinMapsFile => current;
export const initPinMaps = (d: PinMapsDeps) => void (deps = d);
export const canOrganise = () => can("regions");

async function read(gh: GitHub): Promise<PinMapsFile> {
  try {
    const f = JSON.parse(await gh.readText(PINMAPS_PATH)) as PinMapsFile;
    return Array.isArray(f?.folders) && Array.isArray(f?.maps) ? f : emptyPinMaps();
  } catch (e) {
    if (e instanceof GitHubError && e.status !== 404) throw e;
    return emptyPinMaps();
  }
}

export async function loadPinMaps(): Promise<void> {
  current = await read(deps.gh());
}

/** Applies `edit` to a fresh copy of the file and commits it. Returns the id `edit` made, if it made one. */
async function save(label: string, edit: (f: PinMapsFile) => PinMapsFile): Promise<void> {
  const why = refusal({ path: PINMAPS_PATH, before: serializePinMaps(current), after: serializePinMaps(edit(current)) });
  if (why) return void (await confirmBox("Can't do that", why, "OK", "Close"));
  await deps.act(`${label}…`, () =>
    deps.gh().commit(label, async () => [{ path: PINMAPS_PATH, content: serializePinMaps(edit(await read(deps.gh()))) }]),
  );
}

/* ── Dialogs ── */

function askName(title: string, ok: string, initial: string, max: number, problem: (name: string) => string | null, then: (name: string) => void): void {
  const m = modal(title);
  const input = h("input", { type: "text", value: initial, maxLength: max, autocomplete: "off", ariaLabel: "Name", dataset: { field: "pinmap-name" } });
  const err = h("p", { className: "error small", ariaLive: "polite" });
  const go = h("button", { type: "submit", textContent: ok, dataset: { action: "confirm-pinmap" } });
  const form = h("form", { className: "dlg-body" }, h("label", {}, "Name ", input), err);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const p = problem(input.value);
    if (p) {
      err.textContent = p;
      return;
    }
    m.close();
    then(cleanName(input.value));
  });
  m.body.append(form);
  m.foot.append(h("button", { type: "button", className: "ghost", textContent: "Cancel", onclick: m.close }), go);
  go.addEventListener("click", (e) => {
    e.preventDefault();
    form.requestSubmit();
  });
  input.focus();
  input.select();
}

export function newFolder(parent: string | null = null): void {
  if (!canOrganise()) return;
  const where = parent ? ` in ${pathName(treeOf(current), parent)}` : "";
  askName(parent ? "New subfolder" : "New folder", "Add folder", "", CATEGORY_NAME_MAX, (n) => folderNameProblem(current, n, undefined, parent), (name) => void save(`Add pin folder ${name}${where}`, (f) => addFolder(f, name, parent).file));
}

export function renameFolder(k: Category): void {
  if (!canOrganise()) return;
  askName("Rename folder", "Rename", k.name, CATEGORY_NAME_MAX, (n) => folderNameProblem(current, n, k.id, k.parent ?? null), (name) => void save(`Rename pin folder ${k.name} to ${name}`, (f) => renameFolderEdit(f, k.id, name)));
}

export function moveFolder(k: Category): void {
  if (!canOrganise()) return;
  const m = modal(`Move folder "${k.name}"`);
  const here = k.parent ?? "";
  const sel = h(
    "select",
    { ariaLabel: "Move into", dataset: { field: "folder-parent" } },
    h("option", { value: "", textContent: "Top level", selected: !here }),
    ...moveTargets(treeOf(current), k.id).map((t) => h("option", { value: t.id, textContent: pathName(treeOf(current), t.id), selected: t.id === here })),
  );
  const err = h("p", { className: "error small", ariaLive: "polite" });
  const go = h("button", { type: "button", textContent: "Move", dataset: { action: "confirm-move-folder" } });
  go.addEventListener("click", () => {
    const to = sel.value || null;
    if ((to ?? "") === here) return m.close();
    const clash = folderNameProblem(current, k.name, k.id, to);
    if (clash) {
      err.textContent = clash;
      return;
    }
    m.close();
    void save(`Move pin folder ${k.name} to ${to ? pathName(treeOf(current), to) : "the top level"}`, (f) => moveFolderEdit(f, k.id, to));
  });
  m.body.append(h("div", { className: "dlg-body" }, h("label", {}, "Move into ", sel), err));
  m.foot.append(h("button", { type: "button", className: "ghost", textContent: "Cancel", onclick: m.close }), go);
}

export async function removeFolder(k: Category): Promise<void> {
  if (!canOrganise()) return;
  const n = k.regions.length;
  const sub = childrenOf(treeOf(current), k.id).length;
  const parts = [`"${k.name}" will be deleted.`];
  if (n) parts.push(`Its ${n === 1 ? "pin map isn't" : `${n} pin maps aren't`} deleted: ${n === 1 ? "it goes" : "they go"} back to "Not in a folder".`);
  if (sub) parts.push(`The ${sub === 1 ? "folder" : `${sub} folders`} inside ${sub === 1 ? "it moves" : "move"} up a level.`);
  if (await confirmBox("Delete folder?", parts.join(" "), "Delete folder", "Cancel", true)) await save(`Delete pin folder ${k.name}`, (f) => removeFolderEdit(f, k.id));
}

export const shift = (k: Category, by: -1 | 1): Promise<void> => save(`Move pin folder ${k.name} ${by < 0 ? "up" : "down"}`, (f) => shiftFolder(f, k.id, by));

/** A new pin map on `slot`, in `folder` if given; `then` gets its id once it's saved. */
export function newMap(slot: string, folder: string | null, then?: (id: string) => void): void {
  if (!canOrganise()) return;
  askName("New pin map", "Add pin map", "", PINMAP_NAME_MAX, (n) => mapNameProblem(current, n, slot), (name) => {
    let id = "";
    void save(`Add pin map ${name} on slot ${slot}`, (f) => {
      const r = addPinMap(f, name, slot, folder);
      id = r.id;
      return r.file;
    }).then(() => id && then?.(id));
  });
}

export function renameMap(m: PinMap): void {
  if (!canOrganise()) return;
  askName("Rename pin map", "Rename", m.name, PINMAP_NAME_MAX, (n) => mapNameProblem(current, n, m.slot, m.id), (name) => void save(`Rename pin map ${m.name} to ${name}`, (f) => renamePinMap(f, m.id, name)));
}

/** Asks which folder a pin map goes in. */
export function moveMapDialog(m: PinMap): void {
  if (!canOrganise()) return;
  const dlg = modal(`Move pin map "${m.name}"`);
  const here = folderOf(current, m.id) ?? "";
  const sel = h(
    "select",
    { ariaLabel: "Folder", dataset: { field: "pinmap-folder" } },
    h("option", { value: "", textContent: "Not in a folder", selected: !here }),
    ...current.folders.map((k) => h("option", { value: k.id, textContent: pathName(treeOf(current), k.id), selected: k.id === here })),
  );
  const go = h("button", { type: "button", textContent: "Move", dataset: { action: "confirm-move-pinmap" } });
  go.addEventListener("click", () => {
    dlg.close();
    const to = sel.value || null;
    if ((to ?? "") !== here) void save(`Move pin map ${m.name} ${to ? `to ${pathName(treeOf(current), to)}` : "out of its folder"}`, (f) => movePinMap(f, m.id, to));
  });
  dlg.body.append(h("div", { className: "dlg-body" }, h("label", {}, "Folder ", sel)));
  dlg.foot.append(h("button", { type: "button", className: "ghost", textContent: "Cancel", onclick: dlg.close }), go);
}

/** Deletes a pin map. `pins` = how many pins are in it: they stay, but are no longer in one. */
export async function removeMap(m: PinMap, pins: number): Promise<void> {
  if (!canOrganise()) return;
  const text = `"${m.name}" will be deleted.${pins ? ` Its ${pins === 1 ? "pin isn't" : `${pins} pins aren't`} deleted: ${pins === 1 ? "it stays" : "they stay"} on the map, but ${pins === 1 ? "is" : "are"} no longer in a pin map, and any region or embed that showed ${pins === 1 ? "it" : "them"} through this pin map stops doing so.` : " Regions and embeds that used it stop showing it."}`;
  if (await confirmBox("Delete pin map?", text, "Delete pin map", "Cancel", true)) await save(`Delete pin map ${m.name}`, (f) => removePinMap(f, m.id));
}

/* ── The tree ── */

const closed = new Set<string>();

export interface TreeOptions {
  /** The slot whose pin maps are shown. */
  slot: string;
  /** Draws one pin map's contents (its own buttons and pins); null = pins that are in no pin map. */
  mapBody: (m: PinMap | null) => HTMLElement;
  /** The count shown beside a pin map, and whether it matches the search (a pin map with nothing to show is hidden while searching). */
  filtering: boolean;
  hasMatch: (m: PinMap | null) => boolean;
}

const small = (text: string, action: string, onclick: () => void, why = "", cls = "ghost") =>
  h("button", { type: "button", className: cls, textContent: text, onclick, disabled: !!why, title: why, dataset: { action } });

function folderEl(k: Category, o: TreeOptions, pos: { first: boolean; last: boolean }, kids: HTMLElement[], maps: PinMap[]): HTMLElement {
  const el = h("section", { className: "rfolder", dataset: { pinfolder: k.id } });
  const body = h("div", { className: "rfolder-body" });
  const open = o.filtering || !closed.has(k.id);
  const toggle = h("button", { type: "button", className: "rfolder-toggle ghost", ariaExpanded: String(open), title: "Open or close this folder" }, h("span", { className: "rfolder-arrow", ariaHidden: "true", textContent: "▾" }), h("strong", { className: "rfolder-name", textContent: k.name }), h("span", { className: "badge", textContent: String(maps.length), title: `${maps.length} pin map${maps.length === 1 ? "" : "s"} on this slot` }));
  toggle.addEventListener("click", () => {
    const now = body.hidden;
    body.hidden = !now;
    el.classList.toggle("closed", !now);
    toggle.setAttribute("aria-expanded", String(now));
    if (now) closed.delete(k.id);
    else closed.add(k.id);
  });
  const why = canOrganise() ? "" : "You don't have permission to change folders.";
  const head = h(
    "div",
    { className: "rfolder-head" },
    toggle,
    h(
      "div",
      { className: "actions" },
      small("+ Pin map", "new-map", () => newMap(o.slot, k.id), why),
      small("+ Subfolder", "subfolder", () => newFolder(k.id), why),
      small("↑", "up", () => void shift(k, -1), pos.first ? "Already first" : why),
      small("↓", "down", () => void shift(k, 1), pos.last ? "Already last" : why),
      small("Move", "move", () => moveFolder(k), why),
      small("Rename", "rename", () => renameFolder(k), why),
      small("Delete", "delete", () => void removeFolder(k), why, "ghost danger"),
    ),
  );
  body.hidden = !open;
  el.classList.toggle("closed", !open);
  const empty = !maps.length && !kids.length;
  body.append(...maps.map((m) => o.mapBody(m)), ...kids, ...(empty ? [h("p", { className: "muted small", textContent: "This folder is empty. Add a pin map here, or move one with its Move button." })] : []));
  el.append(head, body);
  return el;
}

/** The folders (with the pin maps of the slot in them, then the folders inside), then pin maps in no folder, then pins in no pin map. */
export function renderTree(o: TreeOptions): HTMLElement[] {
  const tree = treeOf(current);
  const onSlot = (id: string) => current.maps.find((m) => m.id === id && m.slot === o.slot);
  const level = (parent: string | null): HTMLElement[] => {
    const sibs = childrenOf(tree, parent);
    const out: HTMLElement[] = [];
    sibs.forEach((k, i) => {
      const maps = k.regions.map(onSlot).filter((m): m is PinMap => !!m && (!o.filtering || o.hasMatch(m)));
      const kids = level(k.id);
      if (o.filtering && !maps.length && !kids.length) return;
      out.push(folderEl(k, o, { first: i === 0, last: i === sibs.length - 1 }, kids, maps));
    });
    return out;
  };
  const inFolder = new Set(current.folders.flatMap((k) => k.regions));
  const loose = current.maps.filter((m) => m.slot === o.slot && !inFolder.has(m.id) && (!o.filtering || o.hasMatch(m)));
  return [...level(null), ...loose.map((m) => o.mapBody(m)), ...(!o.filtering || o.hasMatch(null) ? [o.mapBody(null)] : [])];
}
