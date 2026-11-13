/**
 * The Regions tab: every saved region as a card with a thumbnail, and the actions on it (edit, rename,
 * duplicate, delete, preview, copy embed code), and combining several regions into a new one. Each
 * action that writes is one commit.
 */
import { stringifyCompact } from "../shared/json.ts";
import { baseKey, combineRegions, combinedId, regionBases, type RegionBase } from "../shared/combine.ts";
import { checkGeometry, geometryBounds, polygonsOf, vertexCount } from "../shared/geo.ts";
import { paintSpec } from "../shared/raster.ts";
import { REGION_COLOR, REGION_ID, copyId, flatFit, migrateZoneColours, normalizePartLegend, regionData, type RegionFeature } from "../shared/region.ts";
import { childrenOf, moveTargets, pathName, placements, withDescendants, type Category } from "../shared/categories.ts";
import { paintSpecOf, regionClashes } from "../shared/region-paint.ts";
import type { MapMeta, SlotsFile } from "../shared/types.ts";
import { categories, canAddCategory, canEditCategory, creatorOf, initCategories, loadCategories, moveFolder, moveFolderTo, moveRegions, newCategory, remove as removeCategory, rename as renameCategory, shift as shiftCategory } from "./categories.ts";
import { $, h } from "./dom.ts";
import { hasPendingSaves, optimistic } from "./optimistic.ts";
import { openEditor, type EditorOptions } from "./editor/editor.ts";
import type { OverlayMeta } from "./editor/overlay-filter.ts";
import type { FileCommit, GitHub } from "./github.ts";
import { loadMapImage } from "./images.ts";
import { compareBy, creatorChoices, creatorId, matchesQuery, type Filterable } from "./region-filter.ts";
import { modal, openDelete, openEmbedDialog, openRegionPreview } from "./region-dialogs.ts";
import { OWNER_ID, account, can, canDelete, canEdit, canTransfer, currentUser, ownerOf, refusal } from "./session.ts";
import type { AccessFile, Account } from "../shared/access.ts";

export interface RegionEntry {
  id: string;
  path: string;
  /** Blob SHA when loaded, to notice concurrent edits. */
  sha: string;
  feature: RegionFeature | null;
  /** Why the file can't be used, if it can't. */
  problem?: string;
  commit?: FileCommit | null;
}

export interface RegionsDeps {
  gh: () => GitHub;
  maps: () => MapMeta[];
  slots: () => SlotsFile;
  act: (label: string, fn: () => Promise<string>) => Promise<void>;
  /** After a commit made outside act() (the editor): status, run polling and a reload. */
  afterCommit: (sha: string) => Promise<void>;
}

export const regionPath = (id: string) => `content/regions/${id}.json`;
export const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
export const serialize = (f: RegionFeature) => stringifyCompact(f) + "\n";

let deps: RegionsDeps;
let entries: RegionEntry[] = [];

export function regionEntries(): RegionEntry[] {
  return entries;
}

/** Parsed region files by blob SHA: a blob never changes, so a reload after a save only reads the file that changed. */
const parsed = new Map<string, { feature: RegionFeature | null; problem?: string }>();
const READ_PARALLEL = 8;
/** Regions with no `updated` stamp (saved before it existed) get their last commit looked up, up to this many per load. */
const MAX_COMMIT_LOOKUPS = 24;

/** Runs `work` on every item, at most `limit` at a time. */
async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await work(items[next++]);
    }),
  );
}

export async function loadRegions(): Promise<void> {
  const gh = deps.gh();
  // One listing request per folder level, however many regions there are (the contents API stops at 1,000).
  const files = (await gh.listTree("content/regions")).filter((f) => f.type === "file" && f.name.endsWith(".json"));
  const loaded: RegionEntry[] = [];
  await pool(files, READ_PARALLEL, async (f) => {
    const id = f.name.slice(0, -5);
    let hit = parsed.get(f.sha);
    if (!hit) {
      try {
        const text = await gh.readBlob(f.sha);
        try {
          const feature = JSON.parse(text) as RegionFeature;
          if (feature?.type !== "Feature" || !feature.geometry || !feature.properties) throw new Error("not a region");
          const errs = checkGeometry(feature.geometry);
          hit = { feature, problem: errs.length ? errs[0] : undefined };
        } catch {
          hit = { feature: null, problem: "This file isn't a valid region (broken JSON or wrong shape)." };
        }
        parsed.set(f.sha, hit);
      } catch (e) {
        loaded.push({ id, path: f.path, sha: "", feature: null, problem: (e as Error).message });
        return;
      }
    }
    // A copy, so editing an entry in memory can never change what the cache holds for that blob.
    loaded.push({ id, path: f.path, sha: f.sha, feature: hit.feature ? structuredClone(hit.feature) : null, problem: hit.problem });
  });
  // Forget files that are no longer current so the cache doesn't grow with every edit.
  const current = new Set(files.map((f) => f.sha));
  for (const k of parsed.keys()) if (!current.has(k)) parsed.delete(k);
  loaded.sort((a, b) => a.id.localeCompare(b.id));
  if (!hasPendingSaves()) entries = loaded;
  // Categories are optional: if the file can't be read, regions just show uncategorized.
  await loadCategories().catch(() => {});
  // A change is still being saved: this read may predate it. The save reloads when it's done.
  if (hasPendingSaves()) return;
  renderRegions();
  // Who saved a region last and when is in the file (the admin API requires it). Only older files without it need a commit lookup.
  const old = entries.filter((e) => !e.feature?.properties.updated).slice(0, MAX_COMMIT_LOOKUPS);
  void pool(old, 4, async (e) => {
    try {
      e.commit = await gh.lastCommit(e.path);
    } catch {
      return;
    }
    const el = document.querySelector<HTMLElement>(`[data-region-meta="${CSS.escape(e.id)}"]`);
    if (el) el.textContent = metaText(e);
  });
}

const fmtDate = (s: string | undefined) => (s ? new Date(s).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");

function metaText(e: RegionEntry): string {
  const p = e.feature?.properties;
  const date = e.commit?.date || p?.updated;
  const by = p?.updatedBy?.login ?? e.commit?.author;
  const made = `Created by ${creatorName(e)}${p?.created ? ` on ${fmtDate(p.created)}` : ""}`;
  return [made, date ? `updated ${fmtDate(date)}${by ? ` by ${by}` : ""}` : ""].filter(Boolean).join(" · ");
}

/** The creator's login; regions from before owners existed belong to the repository owner. */
function creatorName(e: RegionEntry): string {
  const c = e.feature?.properties.createdBy;
  if (c?.login) return c.login;
  const me = currentUser();
  return me?.id === OWNER_ID ? me.login : "the owner";
}

const safeColor = (c: unknown) => (typeof c === "string" && REGION_COLOR.test(c) ? c : "#888888");

/** Region outline over its slot's 1024 map, cropped to the region with a margin. */
function thumbnail(f: RegionFeature, map: MapMeta | undefined): HTMLCanvasElement {
  const W = 168;
  const H = 96;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const c = h("canvas", { className: "rthumb", width: W * dpr, height: H * dpr, ariaHidden: "true" });
  let spec: ReturnType<typeof paintSpecOf> | undefined;
  const draw = (img: HTMLImageElement | null) => {
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const aspect = map?.aspect ?? 2;
    const ky = 2 / aspect;
    const v = flatFit(geometryBounds(f.geometry), aspect, W, H);
    const x = (lon: number) => (lon - v.cx) * v.k + W / 2;
    const y = (lat: number) => (v.cy - lat) * v.k * ky + H / 2;
    const offs = [-360, 0, 360];
    if (img) for (const o of offs) g.drawImage(img, x(-180 + o), y(90), 360 * v.k, 180 * v.k * ky);
    const p = f.properties;
    const legend = Array.isArray(p.legend) ? p.legend.map((e) => ({ label: "", color: safeColor(e?.color) })) : [];
    const n = polygonsOf(f.geometry).length;
    spec ??= paintSpecOf(
      {
        color: safeColor(p.color),
        legend,
        parts: migrateZoneColours(normalizePartLegend(Array.isArray(p.partLegend) ? p.partLegend : undefined, n, legend.length), Array.isArray(p.partContested) ? p.partContested : undefined),
        geometry: f.geometry,
      },
      regionClashes(polygonsOf(f.geometry)),
    );
    paintSpec(g, spec, x, y, offs, { fillOpacity: 0.3, lineWidth: 1.5 }, { w: W, h: H });
  };
  draw(null);
  if (map) void loadMapImage(map, 1024).then(draw, () => {});
  return c;
}

function card(e: RegionEntry): HTMLElement {
  const slots = deps.slots().slots;
  const maps = deps.maps();
  if (!e.feature) {
    return h(
      "div",
      { className: "rcard broken", dataset: { region: e.id } },
      h("div", {}, h("strong", { textContent: e.id }), " ", h("span", { className: "badge error", textContent: "Can't be read" })),
      h("p", { className: "error small", textContent: e.problem ?? "" }),
      h("div", { className: "actions" }, h("button", { type: "button", className: "ghost", textContent: "Delete", disabled: !canDelete(null), onclick: () => del(e) })),
    );
  }
  const f = e.feature;
  const p = f.properties;
  const slot = slots[p.slot];
  const map = maps.find((m) => m.id === (slot?.map ?? p.map));
  const differs = !!slot && slot.map !== p.map;
  const swatch = h("span", { className: "swatch", ariaHidden: "true" });
  swatch.style.backgroundColor = safeColor(p.color);
  const btn = (text: string, onclick: () => void, cls = "ghost", why = "") =>
    h("button", { type: "button", className: cls, textContent: text, onclick, disabled: !!why, title: why, dataset: { action: text.toLowerCase().replace(/\W+/g, "-") } });
  const someoneElse = ownerOf(f) !== currentUser()?.id;
  const noEdit = canEdit(f) ? "" : someoneElse ? `${creatorName(e)} created this region, and you can't edit other people's regions.` : "You don't have permission to edit regions.";
  const noDelete = canDelete(f) ? "" : someoneElse ? `${creatorName(e)} created this region, and you can't delete other people's regions.` : "You don't have permission to delete regions.";
  const noCreate = can("regions") ? "" : "You don't have permission to create regions.";
  return h(
    "div",
    { className: "rcard", dataset: { region: e.id }, draggable: canEdit(f) && !!categories().categories.length, title: "" },
    thumbnail(f, map),
    h(
      "div",
      { className: "rinfo" },
      h("div", {}, swatch, h("strong", { className: "rname", textContent: e.id }), " ", h("span", { className: "badge rcreator", textContent: creatorName(e), title: "Created by" })),
      labelsText(p) ? h("div", { className: "muted small rlabels", textContent: labelsText(p) }) : null,
      h(
        "div",
        { className: "muted small" },
        `Slot ${p.slot} · ${vertexCount(f.geometry)} vertices${p.legend?.length ? ` · ${p.legend.length + 1} colours` : ""}`,
        !slot ? h("span", { className: "badge error", textContent: "slot missing" }) : null,
        differs ? h("span", { className: "badge warn", textContent: "drawn on a different map", title: `Drawn on "${p.map}"; the slot now shows "${slot!.map}".` }) : null,
        e.problem ? h("span", { className: "badge error", textContent: "invalid shape", title: e.problem }) : null,
      ),
      h("div", { className: "muted small", dataset: { regionMeta: e.id }, textContent: metaText(e) }),
      categorySelect(e, f),
      h(
        "div",
        { className: "actions" },
        btn("Edit", () => edit(e), "", noEdit),
        btn("Duplicate", () => duplicate(e), "ghost", noCreate),
        btn("Preview", () => slot && openRegionPreview(regionData(f), slot, slot.title ?? map?.name ?? p.slot)),
        btn("Copy embed code", () => openEmbedDialog({ region: { id: e.id, name: e.id, label: p.label, hasLegend: !!p.legend?.length }, slot: p.slot, slotTitle: slot?.title ?? map?.name ?? p.slot })),
        btn("Delete", () => del(e), "ghost danger", noDelete),
        canTransfer() ? btn("Transfer", () => transfer(e, f), "ghost", "") : null,
      ),
    ),
  );
}

/** "Folder" dropdown on a card: only shown once folders exist. Moving needs the right to edit the region. */
function categorySelect(e: RegionEntry, f: RegionFeature): HTMLElement | null {
  const cats = categories().categories;
  if (!cats.length) return null;
  const now = placements(categories()).get(e.id) ?? "";
  const ok = canEdit(f);
  const sel = h(
    "select",
    { ariaLabel: `Folder of ${e.id}`, disabled: !ok, title: ok ? "" : "You can't edit this region, so you can't move it to another folder.", dataset: { action: "category" } },
    h("option", { value: "", textContent: "Uncategorized", selected: !now || !cats.some((k) => k.id === now) }),
    ...cats.map((k) => h("option", { value: k.id, textContent: pathName(categories(), k.id), selected: k.id === now })),
  );
  sel.addEventListener("change", () => void moveRegions([e.id], sel.value || null));
  return h("label", { className: "small rcat" }, "Folder ", sel);
}

const COLLAPSED_KEY = "globe-admin-collapsed-folders";
const collapsed = new Set<string>(
  (() => {
    try {
      const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as unknown;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  })(),
);
const UNCATEGORIZED = "~uncategorized";

function toggleFolder(id: string, el: HTMLElement): void {
  const open = collapsed.has(id);
  if (open) collapsed.delete(id);
  else collapsed.add(id);
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {
    /* remembering is a convenience */
  }
  setFolderOpen(el, open);
}

function setFolderOpen(el: HTMLElement, open: boolean): void {
  el.classList.toggle("closed", !open);
  el.querySelector(".rfolder-toggle")?.setAttribute("aria-expanded", String(open));
  el.querySelector<HTMLElement>(".rfolder-body")!.hidden = !open;
}

/** What is being dragged: a region card or a folder header. (dataTransfer can't be read while dragging over, so it's kept here.) */
let dragging: { kind: "region" | "folder"; id: string } | null = null;

/** Whether the thing being dragged may be dropped on folder `target` (null = out to the top level / Uncategorized). */
function canDrop(target: string | null): boolean {
  if (!dragging) return false;
  const cats = categories();
  if (dragging.kind === "region") return (placements(cats).get(dragging.id) ?? null) !== target;
  const k = cats.categories.find((x) => x.id === dragging!.id);
  if (!k || !canEditCategory(k)) return false;
  if (target === null) return (k.parent ?? null) !== null;
  return withDescendants(cats, k.id).has(target) ? false : (k.parent ?? null) !== target && moveTargetIds(k.id).has(target);
}
const moveTargetIds = (id: string): Set<string> => new Set(moveTargets(categories(), id).map((k) => k.id));

function dropOn(target: string | null): void {
  const d = dragging;
  const ok = canDrop(target);
  dragging = null;
  if (!d || !ok) return;
  if (d.kind === "region") void moveRegions([d.id], target);
  else {
    const k = categories().categories.find((x) => x.id === d.id);
    if (k) void moveFolderTo(k, target);
  }
}

/** Makes `el` a drop target for regions and folders. */
function dropTarget(el: HTMLElement, target: string | null): void {
  el.addEventListener("dragover", (ev) => {
    if (!canDrop(target)) return;
    ev.preventDefault();
    el.classList.add("drop");
  });
  el.addEventListener("dragleave", (ev) => {
    if (!el.contains(ev.relatedTarget as Node | null)) el.classList.remove("drop");
  });
  el.addEventListener("drop", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    el.classList.remove("drop");
    dropOn(target);
  });
}

/** A subtree of folders: a header (open/close, name, count, and the buttons for whoever may change it) over its region cards and the folders inside it. */
function folder(id: string, title: string, members: RegionEntry[], k: Category | null, pos: { first: boolean; last: boolean }, forceOpen: boolean, inner: HTMLElement[] = [], total = members.length): HTMLElement {
  const el = h("section", { className: "rfolder", dataset: { category: id } });
  const edit = !!k && canEditCategory(k);
  const small = (text: string, action: string, onclick: () => void, why = "", cls = "ghost") =>
    h("button", { type: "button", className: cls, textContent: text, onclick, disabled: !!why, title: why, dataset: { action } });
  const noEdit = k && !edit ? `${creatorOf(k)} created this folder, and you can't edit other people's.` : "";
  const head = h(
    "div",
    { className: "rfolder-head", draggable: edit },
    h(
      "button",
      { type: "button", className: "rfolder-toggle ghost", onclick: () => toggleFolder(id, el), ariaExpanded: "true", title: "Open or close this folder" },
      h("span", { className: "rfolder-arrow", ariaHidden: "true", textContent: "▾" }),
      h("strong", { className: "rfolder-name", textContent: title }),
      h("span", { className: "badge", textContent: String(total), title: `${total} region${total === 1 ? "" : "s"}` }),
      k?.createdBy ? h("span", { className: "muted small", textContent: ` by ${creatorOf(k)}` }) : null,
    ),
    k
      ? h(
          "div",
          { className: "actions" },
          small("+ Subfolder", "subfolder", () => newCategory(k.id), canAddCategory() ? "" : "You don't have permission to create folders.", "ghost"),
          small("↑", "up", () => void shiftCategory(k, -1), pos.first ? "Already first" : can_reorder() ? "" : "You don't have permission to reorder folders."),
          small("↓", "down", () => void shiftCategory(k, 1), pos.last ? "Already last" : can_reorder() ? "" : "You don't have permission to reorder folders."),
          small("Move", "move", () => moveFolder(k), noEdit),
          small("Rename", "rename", () => renameCategory(k), noEdit),
          small("Delete", "delete", () => void removeCategory(k), noEdit, "ghost danger"),
        )
      : null,
  );
  if (k) {
    head.addEventListener("dragstart", (ev) => {
      ev.stopPropagation();
      dragging = { kind: "folder", id: k.id };
      ev.dataTransfer?.setData("text/plain", `folder:${k.id}`);
    });
    head.addEventListener("dragend", () => void (dragging = null));
  }
  dropTarget(head, k ? id : null);
  const empty = !members.length && !inner.length;
  el.append(head, h("div", { className: "rfolder-body" }, ...members.map(card), ...inner, ...(empty ? [h("p", { className: "muted small", textContent: k ? "This folder is empty. Drag a region here, or use a region's Folder menu." : "" })] : [])));
  setFolderOpen(el, forceOpen || !collapsed.has(id));
  return el;
}
const can_reorder = () => canAddCategory();

const ui = {
  search: () => $<HTMLInputElement>("#r-search"),
  slot: () => $<HTMLSelectElement>("#r-slot"),
  sort: () => $<HTMLSelectElement>("#r-sort"),
  creator: () => $<HTMLSelectElement>("#r-creator"),
};

/** Creator filter: anyone, me, or one person (by account id). */
function creatorOptions(): void {
  const sel = ui.creator();
  const keep = sel.value;
  const me = currentUser();
  const opts = creatorChoices(entries.filter((e) => e.feature).map(filterable), me?.id);
  sel.replaceChildren(
    h("option", { value: "", textContent: "Anyone" }),
    h("option", { value: "me", textContent: "Me" }),
    ...opts.map(([id, name]) => h("option", { value: String(id), textContent: name })),
  );
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : "";
}

export function renderRegions(): void {
  const slotSel = ui.slot();
  const newSel = $<HTMLSelectElement>("#r-new-slot");
  const slugs = Object.keys(deps.slots().slots);
  const keep = slotSel.value;
  slotSel.replaceChildren(h("option", { value: "", textContent: "All slots" }), ...slugs.map((s) => h("option", { value: s, textContent: s, selected: s === keep })));
  const keepNew = newSel.value;
  newSel.replaceChildren(...slugs.map((s) => h("option", { value: s, textContent: s, selected: s === keepNew })));

  creatorOptions();
  for (const b of document.querySelectorAll<HTMLButtonElement>(".r-new")) {
    b.disabled = !can("regions");
    b.title = can("regions") ? "" : "You don't have permission to create regions.";
  }
  $<HTMLButtonElement>("#r-combine").disabled = !can("regions");

  const q = ui.search().value.trim().toLowerCase();
  const slot = slotSel.value;
  const sort = ui.sort().value;
  const who = ui.creator().value;
  const whoId = creatorId(who, currentUser()?.id);
  const shown = entries
    .filter((e) => !slot || e.feature?.properties.slot === slot)
    .filter((e) => whoId == null || (!!e.feature && ownerOf(e.feature) === whoId))
    .filter((e) => matchesQuery(q, filterable(e)))
    .sort((a, b) => compareBy(sort, filterable(a), filterable(b)));
  $("#regions-empty").hidden = entries.length > 0;
  $("#regions-tools").hidden = entries.length === 0;
  const cats = categories().categories;
  $<HTMLButtonElement>("#r-new-category").hidden = !entries.length;
  $<HTMLButtonElement>("#r-new-category").disabled = !canAddCategory();
  $<HTMLButtonElement>("#r-new-category").title = canAddCategory() ? "Add a folder to sort regions into" : "You don't have permission to create folders.";
  const filtering = !!(q || slot || whoId != null);
  let out: HTMLElement[];
  if (entries.length && !shown.length) out = [h("p", { className: "muted", textContent: "No regions match." })];
  else if (!cats.length) out = shown.map(card);
  else {
    // Folders in their saved order (each with the folders inside it), then whatever isn't in one. Regions whose folder is gone count as uncategorized.
    const home = placements(categories());
    const known = new Set(cats.map((k) => k.id));
    const tree = (parent: string | null): { el: HTMLElement; total: number }[] => {
      const sibs = childrenOf(categories(), parent);
      return sibs
        .map((k, i) => {
          const members = shown.filter((e) => home.get(e.id) === k.id);
          const kids = tree(k.id);
          const total = members.length + kids.reduce((n, x) => n + x.total, 0);
          return { k, i, members, kids, total };
        })
        // While searching or filtering, folders with nothing to show stay out of the way.
        .filter(({ total }) => !filtering || total)
        .map(({ k, i, members, kids, total }) => ({ el: folder(k.id, k.name, members, k, { first: i === 0, last: i === sibs.length - 1 }, filtering, kids.map((x) => x.el), total), total }));
    };
    out = tree(null).map((x) => x.el);
    const rest = shown.filter((e) => !known.has(home.get(e.id) ?? ""));
    if (rest.length) out.push(folder(UNCATEGORIZED, "Uncategorized", rest, null, { first: true, last: true }, filtering));
  }
  $("#regions").replaceChildren(...out);
}

/** What the search, creator filter and sorting see of a region (shared with the editor's overlay panel). */
export function filterable(e: RegionEntry): Filterable {
  const p = e.feature?.properties;
  return {
    id: e.id,
    labels: labelsText(p),
    creator: creatorName(e),
    creatorId: e.feature ? ownerOf(e.feature) : OWNER_ID,
    updated: e.commit?.date || p?.updated || "",
    created: p?.created || "",
  };
}

/** The part labels (or, for an older region, its name), for the card and the search. */
function labelsText(p: RegionFeature["properties"] | undefined): string {
  if (!p) return "";
  const labels = Array.isArray(p.partLabels) ? p.partLabels.filter((t) => typeof t === "string" && t.trim()) : [];
  return labels.length ? labels.join(" · ") : (p.name ?? "");
}

/* ── Actions ── */

function others(e?: RegionEntry) {
  return entries.filter((x) => x !== e && x.feature).map((x) => x.feature!);
}

/** What the editor's "Other regions" panel needs to know about the other regions: who made them, which folder they're in. */
function overlayMeta(): EditorOptions["neighbourMeta"] {
  const home = placements(categories());
  const meta = new Map<string, OverlayMeta>();
  for (const e of entries) if (e.feature) meta.set(e.id, { ...filterable(e), categoryId: home.get(e.id) ?? null });
  return { meta, categories: categories().categories.map((k) => ({ id: k.id, name: pathName(categories(), k.id), within: [...withDescendants(categories(), k.id)] })), meId: currentUser()?.id };
}

function edit(e: RegionEntry): void {
  if (!e.feature || !canEdit(e.feature)) return;
  openEditor({ gh: deps.gh(), maps: deps.maps(), slots: deps.slots(), feature: e.feature, sha: e.sha, isNew: false, neighbours: others(e), neighbourMeta: overlayMeta(), takenIds: new Set(entries.map((x) => x.id)), afterCommit: deps.afterCommit });
}

export function newRegion(slot: string): void {
  if (!deps.slots().slots[slot] || !can("regions")) return;
  openEditor({ gh: deps.gh(), maps: deps.maps(), slots: deps.slots(), slot, sha: null, isNew: true, neighbours: others(), neighbourMeta: overlayMeta(), takenIds: new Set(entries.map((x) => x.id)), afterCommit: deps.afterCommit });
}

function duplicate(e: RegionEntry): void {
  if (!e.feature || !can("regions")) return;
  const taken = new Set(entries.map((x) => x.id));
  const id = copyId(e.id, taken);
  const feature: RegionFeature = { ...e.feature, id };
  openEditor({ gh: deps.gh(), maps: deps.maps(), slots: deps.slots(), feature, sha: null, isNew: true, neighbours: others(), neighbourMeta: overlayMeta(), takenIds: taken, afterCommit: deps.afterCommit });
}

/**
 * "Combine regions": pick two or more regions; their areas, labels, colours and legends are
 * copied into one new region, opened in the editor unsaved. The originals stay as they are.
 */
export function openCombine(): void {
  const usable = entries.filter((e) => e.feature && !e.problem).sort((a, b) => a.id.localeCompare(b.id));
  const m = modal("Combine regions", "combine-dlg");
  if (usable.length < 2) {
    m.body.append(h("p", { textContent: "You need at least two regions to combine." }));
    m.foot.append(h("button", { type: "button", textContent: "OK", onclick: m.close }));
    return;
  }
  /** Ticked regions in the order they were ticked: the first one's colour and settings lead. */
  const picked: RegionEntry[] = [];
  const taken = new Set(entries.map((x) => x.id));
  let idTouched = false;
  let base: RegionBase | null = null;
  const idIn = h("input", { type: "text", maxLength: 64, autocomplete: "off", spellcheck: false, ariaLabel: "Id of the new region" });
  idIn.addEventListener("input", () => ((idTouched = true), update()));
  const baseBox = h("fieldset", { className: "combine-base", hidden: true });
  const out = h("div", { className: "combine-out", role: "status", ariaLive: "polite" });
  const go = h("button", { type: "button", textContent: "Combine", disabled: true, dataset: { action: "combine" } });
  const list = h(
    "div",
    { className: "combine-list" },
    ...usable.map((e) => {
      const p = e.feature!.properties;
      const sw = h("span", { className: "swatch", ariaHidden: "true" });
      sw.style.backgroundColor = safeColor(p.color);
      const box = h("input", { type: "checkbox", value: e.id });
      box.addEventListener("change", () => {
        const i = picked.indexOf(e);
        if (box.checked && i < 0) picked.push(e);
        if (!box.checked && i >= 0) picked.splice(i, 1);
        update();
      });
      return h("label", { className: "check" }, box, sw, h("span", { textContent: e.id }), h("span", { className: "muted small", textContent: ` slot ${p.slot} · map ${p.map}` }));
    }),
  );

  function update(): void {
    const sources = picked.map((e) => e.feature!);
    const bases = regionBases(sources);
    if (!base || !bases.some((b) => baseKey(b) === baseKey(base!))) base = bases[0] ?? null;
    // Several bases: say so and let the user pick which one the new region goes on.
    baseBox.hidden = bases.length < 2;
    const maps = new Set(bases.map((b) => b.map));
    baseBox.replaceChildren(
      h("legend", { textContent: "Base map" }),
      h("p", {
        className: maps.size > 1 ? "warn small" : "muted small",
        textContent:
          maps.size > 1
            ? "These regions were drawn on different maps. Pick the map the new region goes on: areas from the other maps are copied as they are and only line up if the maps share the same layout."
            : "These regions are on different slots. Pick the slot the new region goes on.",
      }),
      ...bases.map((b) =>
        h(
          "label",
          { className: "check" },
          h("input", { type: "radio", name: "combine-base", checked: !!base && baseKey(b) === baseKey(base), onchange: () => ((base = b), update()) }),
          `Slot ${b.slot}, map ${b.map}`,
          h("span", { className: "muted small", textContent: ` (${b.ids.join(", ")})` }),
        ),
      ),
    );
    if (!idTouched) idIn.value = sources.length ? combinedId(sources, taken) : "";
    const id = idIn.value.trim();
    const problems: string[] = [];
    if (sources.length < 2) problems.push("Tick at least two regions.");
    else if (!REGION_ID.test(id)) problems.push("The id may only use lowercase letters, digits and dashes (up to 64), starting with a letter or digit.");
    else if (taken.has(id)) problems.push(`The id "${id}" is taken. Choose another one.`);
    if (base && sources.length >= 2 && !deps.slots().slots[base.slot]) problems.push(`The slot "${base.slot}" doesn't exist any more.`);
    const r = sources.length >= 2 && base ? combineRegions(sources, { id: REGION_ID.test(id) ? id : "combined", base }) : null;
    if (r) problems.push(...r.errors);
    go.disabled = problems.length > 0 || !r?.feature;
    out.replaceChildren(
      ...problems.map((t) => h("p", { className: sources.length < 2 ? "muted small" : "error small", textContent: t })),
      ...(r?.notes ?? []).map((t) => h("p", { className: "warn small", textContent: t })),
      ...(r?.feature ? [h("p", { className: "muted small", textContent: `${polygonsOf(r.feature.geometry).length} parts · ${vertexCount(r.feature.geometry)} vertices · ${(r.feature.properties.legend?.length ?? 0) + 1} colour${r.feature.properties.legend?.length ? "s" : ""}. The originals are not changed.` })] : []),
    );
  }

  go.addEventListener("click", () => {
    const sources = picked.map((e) => e.feature!);
    const id = idIn.value.trim();
    if (!base || go.disabled) return;
    const r = combineRegions(sources, { id, base });
    if (!r.feature) return;
    r.feature.properties.map = deps.slots().slots[base.slot]?.map ?? base.map;
    m.close();
    openEditor({ gh: deps.gh(), maps: deps.maps(), slots: deps.slots(), feature: r.feature, sha: null, isNew: true, neighbours: others(), neighbourMeta: overlayMeta(), takenIds: taken, afterCommit: deps.afterCommit });
  });

  m.body.append(
    h("p", { className: "small", textContent: "Tick the regions to combine. Their areas, labels, colours and legends are copied into one new region, which opens in the editor for you to check and save. The first region you tick sets the main colour." }),
    list,
    h("label", {}, "New region id ", idIn),
    baseBox,
    out,
  );
  m.foot.append(h("button", { type: "button", className: "ghost", textContent: "Cancel", onclick: m.close }), go);
  update();
}

/**
 * "Transfer": changes who is recorded as a region's creator (and so who may edit and delete it as their own).
 * Shown to the owner and admins only; the admin API refuses anyone else. Only createdBy changes.
 */
async function transfer(e: RegionEntry, f: RegionFeature): Promise<void> {
  const people = new Map<number, Account>([[OWNER_ID, { id: OWNER_ID, login: currentUser()?.id === OWNER_ID ? currentUser()!.login : "the owner" }]]);
  try {
    const a = JSON.parse((await deps.gh().readFile("content/access.json")).text) as AccessFile;
    for (const u of a.users) people.set(u.id, { id: u.id, login: u.login });
  } catch {
    /* no access.json yet: only the owner and the region's creators can be chosen */
  }
  for (const x of entries) {
    const c = x.feature?.properties.createdBy;
    if (c) people.set(c.id, { id: c.id, login: c.login });
  }
  const now = ownerOf(f);
  const m = modal(`Transfer "${e.id}"`);
  const select = h("select", { ariaLabel: "New creator" });
  for (const u of [...people.values()].sort((a, b) => a.login.localeCompare(b.login)))
    select.append(h("option", { value: String(u.id), textContent: u.id === now ? `${u.login} (current)` : u.login }));
  select.value = String(now);
  const go = h("button", { type: "button", textContent: "Transfer", disabled: true });
  select.addEventListener("change", () => (go.disabled = Number(select.value) === now));
  m.body.append(
    h("p", {}, "Choose who created ", h("code", { textContent: e.id }), ". They become its owner: they can edit and delete it as their own. Nothing else about the region changes."),
    h("label", {}, "Creator", select),
  );
  go.addEventListener("click", () => {
    const to = people.get(Number(select.value));
    if (!to) return;
    m.close();
    void deps.act(`Transferring ${e.id} to ${to.login}…`, () =>
      deps.gh().commit(`Transfer region ${e.id} to ${to.login}`, async () => {
        const cur = await deps.gh().readFile(e.path);
        const r = JSON.parse(cur.text) as RegionFeature;
        r.properties.createdBy = to;
        r.properties.updatedBy = account();
        r.properties.updated = stamp();
        return [{ path: e.path, content: stringifyCompact(r) + "\n" }];
      }),
    );
  });
  m.foot.append(h("button", { type: "button", className: "ghost", textContent: "Cancel", onclick: m.close }), go);
}

function del(e: RegionEntry): void {
  openDelete(e.id, () => {
    void optimistic({
      label: `Delete region ${e.id}`,
      check: () => refusal({ path: e.path, before: e.feature ? serialize(e.feature) : "", after: null }),
      apply: () => {
        const before = entries;
        entries = entries.filter((x) => x !== e);
        return before;
      },
      undo: (before) => void (entries = before),
      render: renderRegions,
      commit: () => deps.gh().commit(`Delete region ${e.id}`, async () => [{ path: e.path, content: "", delete: true }]),
    });
  });
}

export function initRegions(d: RegionsDeps): void {
  deps = d;
  ui.search().addEventListener("input", renderRegions);
  ui.slot().addEventListener("change", renderRegions);
  ui.sort().addEventListener("change", renderRegions);
  ui.creator().addEventListener("change", renderRegions);
  $("#r-combine").addEventListener("click", openCombine);
  $("#r-new-category").addEventListener("click", () => newCategory());
  // Region cards can be dragged onto a folder (one listener for all cards: the list is rebuilt on every change).
  const list = $("#regions");
  list.addEventListener("dragstart", (ev) => {
    const card = (ev.target as HTMLElement).closest<HTMLElement>(".rcard[draggable='true']");
    if (!card || !card.dataset.region) return;
    dragging = { kind: "region", id: card.dataset.region };
    ev.dataTransfer?.setData("text/plain", `region:${card.dataset.region}`);
  });
  list.addEventListener("dragend", () => void (dragging = null));
  initCategories({ gh: d.gh, render: renderRegions, regionOwner: (id) => { const e = entries.find((x) => x.id === id); return e ? (e.feature ? ownerOf(e.feature) : OWNER_ID) : null; }, regionIds: () => new Set(entries.map((e) => e.id)) });
  for (const b of document.querySelectorAll<HTMLButtonElement>(".r-new")) b.addEventListener("click", () => newRegion($<HTMLSelectElement>("#r-new-slot").value));
}
