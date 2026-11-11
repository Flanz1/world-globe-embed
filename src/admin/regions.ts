/**
 * The Regions tab: every saved region as a card with a thumbnail, and the actions on it (edit, rename,
 * duplicate, delete, preview, copy embed code). Each action that writes is one commit.
 */
import { checkGeometry, geometryBounds, polygonsOf, vertexCount } from "../shared/geo.ts";
import { paintSpec } from "../shared/raster.ts";
import { REGION_COLOR, copyId, flatFit, normalizePartContested, normalizePartLegend, regionData, type RegionFeature } from "../shared/region.ts";
import { paintSpecOf, regionClashes } from "../shared/region-paint.ts";
import type { MapMeta, SlotsFile } from "../shared/types.ts";
import { $, h } from "./dom.ts";
import { openEditor } from "./editor/editor.ts";
import type { FileCommit, GitHub } from "./github.ts";
import { loadMapImage } from "./images.ts";
import { openDelete, openEmbedDialog, openRegionPreview } from "./region-dialogs.ts";

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
export const serialize = (f: RegionFeature) => JSON.stringify(f, null, 2) + "\n";

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
  const date = e.commit?.date || e.feature?.properties.updated;
  const by = e.commit?.author;
  return date ? `Updated ${fmtDate(date)}${by ? ` by ${by}` : ""}` : "";
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
      h("div", { className: "actions" }, h("button", { type: "button", className: "ghost", textContent: "Delete", onclick: () => del(e) })),
    );
  }
  const f = e.feature;
  const p = f.properties;
  const slot = slots[p.slot];
  const map = maps.find((m) => m.id === (slot?.map ?? p.map));
  const differs = !!slot && slot.map !== p.map;
  const swatch = h("span", { className: "swatch", ariaHidden: "true" });
  swatch.style.backgroundColor = safeColor(p.color);
  const btn = (text: string, onclick: () => void, cls = "ghost") => h("button", { type: "button", className: cls, textContent: text, onclick, dataset: { action: text.toLowerCase().replace(/\W+/g, "-") } });
  return h(
    "div",
    { className: "rcard", dataset: { region: e.id } },
    thumbnail(f, map),
    h(
      "div",
      { className: "rinfo" },
      h("div", {}, swatch, h("strong", { className: "rname", textContent: e.id })),
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
        btn("Edit", () => edit(e), ""),
        btn("Duplicate", () => duplicate(e)),
        btn("Preview", () => slot && openRegionPreview(regionData(f), slot, slot.title ?? map?.name ?? p.slot)),
        btn("Copy embed code", () => openEmbedDialog({ region: { id: e.id, name: e.id, label: p.label, hasLegend: !!p.legend?.length }, slot: p.slot, slotTitle: slot?.title ?? map?.name ?? p.slot })),
        btn("Delete", () => del(e), "ghost danger"),
      ),
    ),
  );
}

const ui = {
  search: () => $<HTMLInputElement>("#r-search"),
  slot: () => $<HTMLSelectElement>("#r-slot"),
  sort: () => $<HTMLSelectElement>("#r-sort"),
};

export function renderRegions(): void {
  const slotSel = ui.slot();
  const newSel = $<HTMLSelectElement>("#r-new-slot");
  const slugs = Object.keys(deps.slots().slots);
  const keep = slotSel.value;
  slotSel.replaceChildren(h("option", { value: "", textContent: "All slots" }), ...slugs.map((s) => h("option", { value: s, textContent: s, selected: s === keep })));
  const keepNew = newSel.value;
  newSel.replaceChildren(...slugs.map((s) => h("option", { value: s, textContent: s, selected: s === keepNew })));

  const q = ui.search().value.trim().toLowerCase();
  const slot = slotSel.value;
  const sort = ui.sort().value;
  const shown = entries
    .filter((e) => !slot || e.feature?.properties.slot === slot)
    .filter((e) => !q || e.id.includes(q) || labelsText(e.feature?.properties).toLowerCase().includes(q))
    .sort((a, b) => {
      if (sort === "updated") {
        const da = a.commit?.date || a.feature?.properties.updated || "";
        const db = b.commit?.date || b.feature?.properties.updated || "";
        return db.localeCompare(da);
      }
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
  if (!e.feature) return;
  openEditor({ gh: deps.gh(), maps: deps.maps(), slots: deps.slots(), feature: e.feature, sha: e.sha, isNew: false, neighbours: others(e), takenIds: new Set(entries.map((x) => x.id)), afterCommit: deps.afterCommit });
}

export function newRegion(slot: string): void {
  if (!deps.slots().slots[slot]) return;
  openEditor({ gh: deps.gh(), maps: deps.maps(), slots: deps.slots(), slot, sha: null, isNew: true, neighbours: others(), takenIds: new Set(entries.map((x) => x.id)), afterCommit: deps.afterCommit });
}

function duplicate(e: RegionEntry): void {
  if (!e.feature) return;
  const taken = new Set(entries.map((x) => x.id));
  const id = copyId(e.id, taken);
  const feature: RegionFeature = { ...e.feature, id };
  openEditor({ gh: deps.gh(), maps: deps.maps(), slots: deps.slots(), feature, sha: null, isNew: true, neighbours: others(), takenIds: taken, afterCommit: deps.afterCommit });
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
  for (const b of document.querySelectorAll<HTMLButtonElement>(".r-new")) b.addEventListener("click", () => newRegion($<HTMLSelectElement>("#r-new-slot").value));
}
