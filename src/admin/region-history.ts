/**
 * Version history of one region: the saves that changed its file (who, when), a preview of an old outline
 * dashed over the current one, and a one-click restore. History is the repository's own: the saves come from
 * the admin API's save log and an old version is the file as it was in that commit, so nothing extra is stored.
 * Restoring is a normal save (a new commit), so it can be undone by restoring the version before it.
 */
import { geometryBounds, polygonsOf, type RegionGeometry } from "../shared/geo.ts";
import type { HistoryEntry } from "../shared/history.ts";
import { paintSpec } from "../shared/raster.ts";
import { REGION_COLOR, flatFit, migrateZoneColours, normalizePartLegend, type RegionFeature } from "../shared/region.ts";
import { paintSpecOf, regionClashes } from "../shared/region-paint.ts";
import type { MapMeta } from "../shared/types.ts";
import { stringifyCompact } from "../shared/json.ts";
import { h } from "./dom.ts";
import type { GitHub } from "./github.ts";
import { loadMapImage } from "./images.ts";
import { modal } from "./region-dialogs.ts";
import { account, refusal } from "./session.ts";

export interface HistoryOptions {
  gh: GitHub;
  /** The region as it is now. */
  id: string;
  path: string;
  feature: RegionFeature;
  map: MapMeta | undefined;
  /** Why this person can't restore (or null). Anyone on the list can look. */
  noRestore: string | null;
  /** Runs a save with the page's usual status line, reload and error handling. */
  act: (label: string, fn: () => Promise<string>) => Promise<void>;
}

const PAGE = 15;
const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const serialize = (f: RegionFeature) => stringifyCompact(f) + "\n";
const safeColor = (c: unknown) => (typeof c === "string" && REGION_COLOR.test(c) ? c : "#888888");
const when = (s: string) => (s ? new Date(s).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
/** The first line of a commit message: that's the save's name. */
const title = (m: string) => m.split("\n")[0];

/** Parses an old version of a region file; null when it isn't a usable region. */
export function parseVersion(text: string): RegionFeature | null {
  try {
    const f = JSON.parse(text) as RegionFeature;
    return f?.type === "Feature" && f.geometry && f.properties ? f : null;
  } catch {
    return null;
  }
}

/**
 * The region file to save when restoring `old` over `current`: the old shape and look, but still created by
 * whoever created the region (restoring never changes ownership) and stamped as saved now by the person restoring.
 */
export function restoredFeature(old: RegionFeature, current: RegionFeature, by: { id: number; login: string }): RegionFeature {
  const f = structuredClone(old);
  const p = f.properties;
  const c = current.properties;
  if (c.createdBy) p.createdBy = c.createdBy;
  else delete p.createdBy;
  if (c.created) p.created = c.created;
  else delete p.created;
  p.updatedBy = by;
  p.updated = stamp();
  return f;
}

/** Old outline dashed over the current one, both on the slot's map, framed on the two together. */
function comparison(now: RegionFeature, old: RegionFeature | null, map: MapMeta | undefined): HTMLCanvasElement {
  const W = 520;
  const H = 300;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const c = h("canvas", { className: "hist-canvas", width: W * dpr, height: H * dpr, ariaLabel: old ? "The old outline (dashed) over the current region" : "The current region" });
  const draw = (img: HTMLImageElement | null) => {
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const aspect = map?.aspect ?? 2;
    const ky = 2 / aspect;
    const a = geometryBounds(now.geometry);
    const b = old ? geometryBounds(old.geometry) : a;
    const v = flatFit([Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])], aspect, W, H);
    const x = (lon: number) => (lon - v.cx) * v.k + W / 2;
    const y = (lat: number) => (v.cy - lat) * v.k * ky + H / 2;
    const offs = [-360, 0, 360];
    g.fillStyle = "#2a2a2a";
    g.fillRect(0, 0, W, H);
    if (img) for (const o of offs) g.drawImage(img, x(-180 + o), y(90), 360 * v.k, 180 * v.k * ky);
    const p = now.properties;
    const legend = Array.isArray(p.legend) ? p.legend.map((e) => ({ label: "", color: safeColor(e?.color) })) : [];
    const n = polygonsOf(now.geometry).length;
    const spec = paintSpecOf(
      { color: safeColor(p.color), legend, parts: migrateZoneColours(normalizePartLegend(Array.isArray(p.partLegend) ? p.partLegend : undefined, n, legend.length), Array.isArray(p.partContested) ? p.partContested : undefined), geometry: now.geometry },
      regionClashes(polygonsOf(now.geometry)),
    );
    paintSpec(g, spec, x, y, offs, { fillOpacity: 0.3, lineWidth: 1.5 }, { w: W, h: H });
    if (old) strokeOutline(g, old.geometry, x, y, offs);
  };
  draw(null);
  if (map) void loadMapImage(map, 1024).then(draw, () => {});
  return c;
}

/** The old outline: a white halo under a dashed orange line, so it reads on any map. */
function strokeOutline(g: CanvasRenderingContext2D, geom: RegionGeometry, x: (lon: number) => number, y: (lat: number) => number, offs: number[]): void {
  const trace = (o: number) => {
    g.beginPath();
    for (const poly of polygonsOf(geom))
      for (const ring of poly) {
        ring.forEach(([lon, lat], i) => (i ? g.lineTo(x(lon + o), y(lat)) : g.moveTo(x(lon + o), y(lat))));
        g.closePath();
      }
  };
  for (const o of offs) {
    trace(o);
    g.setLineDash([]);
    g.lineWidth = 4;
    g.strokeStyle = "rgba(255,255,255,.85)";
    g.stroke();
    g.setLineDash([7, 5]);
    g.lineWidth = 2;
    g.strokeStyle = "#e8590c";
    g.stroke();
  }
  g.setLineDash([]);
}

export function openHistory(o: HistoryOptions): void {
  const m = modal(`History of "${o.id}"`, "history");
  const list = h("ul", { className: "hist-list", ariaLabel: "Saves" });
  const more = h("button", { type: "button", className: "ghost", textContent: "Older saves" });
  const status = h("p", { className: "muted small", textContent: "Loading…" });
  const side = h("div", { className: "hist-side" }, h("p", { className: "muted", textContent: "Pick a save to see how the region looked then." }));
  m.body.append(status, h("div", { className: "hist-grid" }, h("div", {}, list, more), side));
  more.hidden = true;
  const now = serialize(o.feature);
  let page = 1;
  let selected: HTMLElement | null = null;
  const versions = new Map<string, string | null>();

  const show = async (e: HistoryEntry, li: HTMLElement) => {
    selected?.classList.remove("on");
    selected = li;
    li.classList.add("on");
    side.replaceChildren(h("p", { className: "muted", textContent: "Loading that version…" }));
    let text: string | null | undefined = versions.get(e.sha);
    try {
      if (text === undefined) {
        text = await o.gh.readFileAt(o.path, e.sha);
        versions.set(e.sha, text);
      }
    } catch (err) {
      if (selected === li) side.replaceChildren(h("p", { className: "error", textContent: `Couldn't read that version: ${(err as Error).message}` }));
      return;
    }
    if (selected !== li) return;
    const old = text === null ? null : parseVersion(text);
    const same = text !== null && old !== null && serialize(old) === now;
    const head = h("p", { className: "small" }, h("strong", { textContent: title(e.message) }), ` · ${e.author.login} · ${when(e.date)}`);
    if (!old) {
      side.replaceChildren(head, h("p", { className: "muted", textContent: text === null ? "The region didn't exist in this save." : "This version can't be read as a region, so it can't be restored." }));
      return;
    }
    const go = h("button", { type: "button", textContent: "Restore this version", disabled: same || !!o.noRestore, title: o.noRestore ?? (same ? "It's the same as now." : "") });
    go.addEventListener("click", () => {
      const next = restoredFeature(old, o.feature, account());
      const why = refusal({ path: o.path, before: now, after: serialize(next) });
      if (why) {
        side.append(h("p", { className: "error", textContent: why }));
        return;
      }
      m.close();
      void o.act(`Restoring ${o.id} to the version from ${when(e.date)}…`, () =>
        o.gh.commit(`Restore region ${o.id} to the version from ${when(e.date)}`, async () => {
          // Build on the file as it is right now, so a save someone made meanwhile keeps its creator and ownership.
          const cur = parseVersion((await o.gh.readFile(o.path)).text) ?? o.feature;
          return [{ path: o.path, content: serialize(restoredFeature(old, cur, account())) }];
        }),
      );
    });
    side.replaceChildren(
      head,
      same ? h("p", { className: "muted", textContent: "This is how the region looks now." }) : h("p", { className: "small hist-key" }, h("span", { className: "hist-dash" }), " the old outline, over the region as it is now"),
      comparison(o.feature, same ? null : old, o.map),
      h("div", { className: "actions" }, go),
    );
  };

  const add = (entries: HistoryEntry[]) => {
    for (const e of entries) {
      const li = h("li", {}, h("button", { type: "button", className: "hist-item" }, h("strong", { textContent: title(e.message) || "(no message)" }), h("span", { className: "muted small", textContent: `${e.author.login} · ${when(e.date)}` })));
      li.firstElementChild!.addEventListener("click", () => void show(e, li));
      list.append(li);
    }
  };
  const load = async () => {
    more.disabled = true;
    try {
      const r = await o.gh.history({ path: o.path, limit: PAGE, page });
      add(r.entries);
      page = r.next ?? page;
      more.hidden = r.next === null;
      status.textContent = list.children.length ? `${list.children.length} saves, newest first. The first one is the current version.` : "No saves found for this region yet.";
    } catch (err) {
      status.className = "error small";
      status.textContent = `Couldn't load the history: ${(err as Error).message}`;
    } finally {
      more.disabled = false;
    }
  };
  more.addEventListener("click", () => void load());
  void load();
}
