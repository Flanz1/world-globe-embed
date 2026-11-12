/**
 * The Regions tab: every saved region as a card with a thumbnail, and the actions on it (edit, rename,
 * duplicate, delete, preview, copy embed code), and combining several regions into a new one. Each
 * action that writes is one commit.
 */
import { stringifyCompact } from "../shared/json.ts";
import { baseKey, combineRegions, combinedId, regionBases, type RegionBase } from "../shared/combine.ts";
import { checkGeometry, geometryBounds, polygonsOf, vertexCount } from "../shared/geo.ts";
import { paintSpec } from "../shared/raster.ts";
import { REGION_COLOR, REGION_ID, copyId, flatFit, normalizePartContested, normalizePartLegend, regionData, type RegionFeature } from "../shared/region.ts";
import { paintSpecOf, regionClashes } from "../shared/region-paint.ts";
import type { MapMeta, SlotsFile } from "../shared/types.ts";
import { $, h } from "./dom.ts";
import { openEditor } from "./editor/editor.ts";
import type { FileCommit, GitHub } from "./github.ts";
import { loadMapImage } from "./images.ts";
import { modal, openDelete, openEmbedDialog, openRegionPreview } from "./region-dialogs.ts";
import { OWNER_ID, can, canDelete, canEdit, currentUser, ownerOf } from "./session.ts";

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

export async function loadRegions(): Promise<void> {
  const gh = deps.gh();
  const files = (await gh.listDir("content/regions")).filter((f) => f.type === "file" && f.name.endsWith(".json"));
  entries = await Promise.all(
    files.map(async (f): Promise<RegionEntry> => {
      const id = f.name.slice(0, -5);
      try {
        const { text, sha } = await gh.readFile(f.path);
        let feature: RegionFeature | null = null;
        let problem: string | undefined;
        try {
          feature = JSON.parse(text) as RegionFeature;
          if (feature?.type !== "Feature" || !feature.geometry || !feature.properties) throw new Error("not a region");
          const errs = checkGeometry(feature.geometry);
          if (errs.length) problem = errs[0];
        } catch {
          feature = null;
          problem = "This file isn't a valid region (broken JSON or wrong shape).";
        }
        return { id, path: f.path, sha, feature, problem };
      } catch (e) {
        return { id, path: f.path, sha: "", feature: null, problem: (e as Error).message };
      }
    }),
  );
  renderRegions();
  // Last commit (author and date) per file, filled in as they arrive.
  for (const e of entries) {
    void gh
      .lastCommit(e.path)
      .then((c) => {
        e.commit = c;
        const el = document.querySelector<HTMLElement>(`[data-region-meta="${CSS.escape(e.id)}"]`);
        if (el) el.textContent = metaText(e);
      })
      .catch(() => {});
  }
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
        parts: normalizePartLegend(Array.isArray(p.partLegend) ? p.partLegend : undefined, n, legend.length),
        contested: normalizePartContested(Array.isArray(p.partContested) ? p.partContested : undefined, n),
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
    { className: "rcard", dataset: { region: e.id } },
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
      h(
        "div",
        { className: "actions" },
        btn("Edit", () => edit(e), "", noEdit),
        btn("Duplicate", () => duplicate(e), "ghost", noCreate),
        btn("Preview", () => slot && openRegionPreview(regionData(f), slot, slot.title ?? map?.name ?? p.slot)),
        btn("Copy embed code", () => openEmbedDialog({ region: { id: e.id, name: e.id, label: p.label, hasLegend: !!p.legend?.length }, slot: p.slot, slotTitle: slot?.title ?? map?.name ?? p.slot })),
        btn("Delete", () => del(e), "ghost danger", noDelete),
      ),
    ),
  );
}

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
  const people = new Map<number, string>();
  for (const e of entries) if (e.feature) people.set(ownerOf(e.feature), creatorName(e));
  const opts = [...people].filter(([id]) => id !== me?.id).sort((a, b) => a[1].localeCompare(b[1]));
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
  const whoId = who === "me" ? currentUser()?.id : who ? Number(who) : null;
  const shown = entries
    .filter((e) => !slot || e.feature?.properties.slot === slot)
    .filter((e) => whoId == null || (!!e.feature && ownerOf(e.feature) === whoId))
    .filter((e) => !q || e.id.includes(q) || labelsText(e.feature?.properties).toLowerCase().includes(q) || creatorName(e).toLowerCase().includes(q))
    .sort((a, b) => {
      if (sort === "updated") {
        const da = a.commit?.date || a.feature?.properties.updated || "";
        const db = b.commit?.date || b.feature?.properties.updated || "";
        return db.localeCompare(da) || a.id.localeCompare(b.id);
      }
      if (sort === "created") {
        const da = a.feature?.properties.created || "";
        const db = b.feature?.properties.created || "";
        return db.localeCompare(da) || a.id.localeCompare(b.id);
      }
      if (sort === "creator") return creatorName(a).localeCompare(creatorName(b), undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id);
      return a.id.localeCompare(b.id);
    });
  $("#regions-empty").hidden = entries.length > 0;
  $("#regions-tools").hidden = entries.length === 0;
  $("#regions").replaceChildren(
    ...(entries.length && !shown.length ? [h("p", { className: "muted", textContent: "No regions match." })] : shown.map(card)),
  );
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

function edit(e: RegionEntry): void {
  if (!e.feature || !canEdit(e.feature)) return;
  openEditor({ gh: deps.gh(), maps: deps.maps(), slots: deps.slots(), feature: e.feature, sha: e.sha, isNew: false, neighbours: others(e), takenIds: new Set(entries.map((x) => x.id)), afterCommit: deps.afterCommit });
}

export function newRegion(slot: string): void {
  if (!deps.slots().slots[slot] || !can("regions")) return;
  openEditor({ gh: deps.gh(), maps: deps.maps(), slots: deps.slots(), slot, sha: null, isNew: true, neighbours: others(), takenIds: new Set(entries.map((x) => x.id)), afterCommit: deps.afterCommit });
}

function duplicate(e: RegionEntry): void {
  if (!e.feature || !can("regions")) return;
  const taken = new Set(entries.map((x) => x.id));
  const id = copyId(e.id, taken);
  const feature: RegionFeature = { ...e.feature, id };
  openEditor({ gh: deps.gh(), maps: deps.maps(), slots: deps.slots(), feature, sha: null, isNew: true, neighbours: others(), takenIds: taken, afterCommit: deps.afterCommit });
}

/**
 * "Combine regions": pick two or more regions; their areas, labels, colours, legends and contested
 * zones are copied into one new region, opened in the editor unsaved. The originals stay as they are.
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
    openEditor({ gh: deps.gh(), maps: deps.maps(), slots: deps.slots(), feature: r.feature, sha: null, isNew: true, neighbours: others(), takenIds: taken, afterCommit: deps.afterCommit });
  });

  m.body.append(
    h("p", { className: "small", textContent: "Tick the regions to combine. Their areas, labels, colours, legends and contested zones are copied into one new region, which opens in the editor for you to check and save. The first region you tick sets the main colour." }),
    list,
    h("label", {}, "New region id ", idIn),
    baseBox,
    out,
  );
  m.foot.append(h("button", { type: "button", className: "ghost", textContent: "Cancel", onclick: m.close }), go);
  update();
}

function del(e: RegionEntry): void {
  openDelete(e.id, () => {
    void deps.act(`Deleting ${e.id}…`, () => deps.gh().commit(`Delete region ${e.id}`, async () => [{ path: e.path, content: "", delete: true }]));
  });
}

export function initRegions(d: RegionsDeps): void {
  deps = d;
  ui.search().addEventListener("input", renderRegions);
  ui.slot().addEventListener("change", renderRegions);
  ui.sort().addEventListener("change", renderRegions);
  ui.creator().addEventListener("change", renderRegions);
  $("#r-combine").addEventListener("click", openCombine);
  for (const b of document.querySelectorAll<HTMLButtonElement>(".r-new")) b.addEventListener("click", () => newRegion($<HTMLSelectElement>("#r-new-slot").value));
}
