/**
 * Inline boot script. It is compiled to a tiny IIFE and inlined into every
 * slot page, so it runs before first paint without any extra request.
 *
 * Its jobs: apply query-param overrides, size the LQIP poster so it lines up
 * with the 3D globe (or the flat map), start fetching the 1024px texture (and
 * the region, with ?region=), then (after first paint) create the WebGL context
 * and dynamically import the Three.js viewer, or import the small 2D viewer for
 * view=flat.
 */
import { applyParams, diameterFraction, distanceForZoom, posterVars } from "../shared/params.ts";
import { REGION_ID, flatFit, mergeRegions, parseRegionData, parseRegionIds, underFill, type RegionData } from "../shared/region.ts";
import { cleanTravel } from "../shared/measure.ts";
import type { ViewerConfig } from "../shared/types.ts";
import type { BootData, FlatStartContext, RegionContext, StartContext, ViewMode } from "./contract.ts";

const data = JSON.parse(document.getElementById("wge-data")!.textContent!) as BootData;
const cfg: ViewerConfig = applyParams(data.cfg, location.search);
const q = new URLSearchParams(location.search);
const root = document.documentElement;
const $ = (id: string) => document.getElementById(id)!;
// The slot's default view (cfg.view), or ?view= when given. Pages built without the flat viewer always show the globe.
const view: ViewMode = cfg.view === "flat" && data.flat ? "flat" : "globe";

/** A small, unobtrusive note in the corner (never a broken page). */
function note(text: string): void {
  const p = document.createElement("p");
  p.className = "rnote";
  p.textContent = text;
  document.body.append(p);
}

// Preview page (used by the admin page): every map is inlined, pick one with ?map=<id>.
if (data.maps) {
  const ids = Object.keys(data.maps);
  const want = q.get("map") ?? "";
  const m = want ? data.maps[want] : data.maps[ids[0]];
  if (!m) {
    const p = document.createElement("p");
    p.className = "note";
    p.textContent = "This map isn't published yet. It shows up here once the deploy has finished.";
    $("stage").replaceChildren(p);
    $("ui").hidden = true;
    throw new Error("map not deployed");
  }
  {
    cfg.textures = m.textures;
    cfg.title = m.name;
    cfg.aspect = m.aspect;
    document.title = `${m.name} (preview)`;
    // Only the admin page's own preview takes the radius from the URL; embeds get it from the slot.
    const r = Number(q.get("radius"));
    if (q.has("radius") && Number.isFinite(r)) cfg.radius = r;
    if (q.has("travel")) {
      try {
        cfg.travel = cleanTravel(JSON.parse(q.get("travel")!));
      } catch {
        cfg.travel = [];
      }
    }
    root.style.setProperty("--lqip", `url("${m.lqip}")`);
  }
}

/* ── Region (?region=<id>) ── */
let region: RegionContext | null = null;
const preview = !!data.maps;
// ?regions=a,b,c stacks several regions of the slot (the last on top); not in the admin preview, which shows one region.
const stacked = !preview && q.has("regions") ? parseRegionIds(q.get("regions")) : null;
const regionId = stacked ? (stacked[0] ?? "") : q.get("region");
if (regionId !== null) {
  const inIndex = (id: string) => (data.regions && Object.prototype.hasOwnProperty.call(data.regions, id) ? data.regions[id] : undefined);
  const entry = inIndex(regionId);
  // region=<id>: the region's own underlays go below it (under=0 leaves them out).
  const under = !stacked && !preview && entry?.u && q.get("under") !== "0" ? entry.u.filter((e) => e.id !== regionId && inIndex(e.id)) : [];
  // A region that includes pin maps shows their pins unless the embed code says otherwise (?pins=0 turns them off).
  if (!stacked && !preview && entry?.pm?.length && !q.has("pins")) cfg.pins = entry.pm.join(",");
  const ids = stacked ? stacked.filter(inIndex) : [...under.map((e) => e.id), regionId];
  // Stacked regions bring their own underlays (under=0 leaves them out): each goes just below its region, cut to it. Their ids are `<id>@<region>`, as one underlay can serve several regions.
  const stackPlan: { id: string; host?: string; label?: string; on?: boolean; clip?: boolean; fill?: number }[] = stacked
    ? ids.flatMap((id) => {
        const e = inIndex(id);
        const us = q.get("under") !== "0" && e?.u ? e.u.filter((u) => u.id !== id && inIndex(u.id)) : [];
        return [...us.map((u, i) => ({ id: u.id, host: id, label: u.label, on: u.on ?? i === 0, clip: e?.uc !== false, fill: underFill(u.fill) })), { id }];
      })
    : [];
  const stackUnder = stackPlan.filter((s) => s.host);
  const underId = (s: { id: string; host?: string }) => `${s.id}@${s.host}`;
  if ((stacked ? ids.length > 0 : REGION_ID.test(regionId) && (entry || preview))) {
    const given = (k: string) => {
      const v = q.get(k);
      return v != null && v.trim() !== "" && Number.isFinite(Number(v));
    };
    const explicit = { lat: given("lat"), lon: given("lon"), zoom: given("zoom") };
    const label = q.get("label");
    const previewLayers: NonNullable<RegionContext["layers"]> = { names: {}, title: "", hidden: [] };
    let subscribe: RegionContext["subscribe"];
    let regionData: Promise<RegionData | null>;
    if (preview) {
      // The admin page sends the region it's editing; only same-origin messages from the parent count.
      const subs: ((r: RegionData, centre: boolean, focus: number) => void)[] = [];
      let first: (r: RegionData) => void = () => {};
      regionData = new Promise((res) => (first = res));
      // The edited region's underlays (RegionMessage.under), kept between messages.
      let under: { regions: RegionData[]; clip: boolean } = { regions: [], clip: true };
      window.addEventListener("message", (e: MessageEvent) => {
        if (e.origin !== location.origin || e.source !== window.parent || e.data?.type !== "wge-region") return;
        const own = parseRegionData(e.data.region);
        if (!own) return;
        const u = e.data.under;
        if (u && typeof u === "object") {
          under = { regions: (Array.isArray(u.regions) ? u.regions.slice(0, 8) : []).map((x: unknown) => parseRegionData(x)).filter((x: RegionData | null): x is RegionData => !!x), clip: u.clip !== false };
          const names: Record<string, string> = {};
          if (u.names && typeof u.names === "object") for (const [k, v] of Object.entries(u.names)) if (typeof v === "string") names[k] = v.slice(0, 60);
          previewLayers.names = names;
          previewLayers.own = u.own === true;
          previewLayers.title = typeof u.title === "string" ? u.title.slice(0, 40) : "";
          previewLayers.rev = (previewLayers.rev ?? 0) + 1;
          previewLayers.hidden = Array.isArray(u.hidden) ? u.hidden.filter((x: unknown): x is string => typeof x === "string") : [];
        }
        const r = under.regions.length ? mergeRegions([...under.regions, own], under.clip) : own;
        first(r);
        const f = e.data.focus;
        const focus = typeof f === "number" && Number.isInteger(f) && f >= 0 && f < 1000 ? f : -1;
        for (const cb of subs) cb(r, e.data.centre === true, focus);
      });
      subscribe = (cb) => void subs.push(cb);
    } else {
      // Starts now, in parallel with the first texture.
      const load = (id: string): Promise<RegionData | null> =>
        fetch(`${data.root ?? "../../"}regions/${id}.json`)
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => {
            const r = parseRegionData(j);
            if (!r || r.id !== id || r.slot !== cfg.slug) return null;
            // An underlay can have its own fill (UnderEntry.fill), so it stands out.
            const fill = underFill(under.find((e) => e.id === id)?.fill);
            return fill === undefined ? r : { ...r, fillOpacity: fill };
          })
          .catch(() => null);
      regionData =
        stacked && stackUnder.length
          ? Promise.all(stackPlan.map((s) => load(s.id).then((r) => (r && s.host ? { ...r, id: underId(s), underOf: s.host, underClipped: s.clip, ...(s.fill !== undefined ? { fillOpacity: s.fill } : {}) } : r)))).then((all) => {
              // An underlay without its region isn't shown.
              const found = all.filter((r): r is RegionData => !!r && (!r.underOf || all.some((h) => h?.id === r.underOf)));
              return found.length ? mergeRegions(found) : null;
            })
          : ids.length > 1
          ? Promise.all(ids.map(load)).then((all) => {
              const found = all.filter((r): r is RegionData => !!r);
              // The region itself must be there; without it the underlays alone aren't what was asked for.
              if (under.length && all[all.length - 1] === null) return null;
              return found.length ? mergeRegions(found, under.length > 0 && entry?.uc !== false) : null;
            })
          : load(ids[0]);
    }
    const entries = ids.map(inIndex).filter((e) => !!e);
    region = {
      id: ids.join(","),
      data: regionData,
      subscribe,
      label: label === "1" ? true : label === "0" ? false : null,
      key: q.get("key") !== "0",
      dim: q.get("dim") === "1",
      toggle: q.get("toggle") !== "0",
      lock: q.get("lock") !== "0",
      explicit,
      // Stacked regions (?regions=) are framed once they've loaded; until then the poster faces the first (or the union, flat). A region with underlays is framed by itself, from the index.
      fitted: (ids.length === 1 || under.length > 0) && !!entry,
      ...(preview ? { layers: previewLayers } : {}),
      ...(stacked && stackUnder.length
        ? {
            layers: {
              names: {
                ...Object.fromEntries(ids.flatMap((id) => (inIndex(id)?.ul ? [[id, inIndex(id)!.ul!]] : []))),
                ...Object.fromEntries(stackUnder.map((s) => [underId(s), s.label ?? ""])),
              },
              title: "",
              own: false,
              hidden: stackUnder.filter((s) => !s.on).map(underId),
            },
          }
        : ids.length > 1
        ? {
            layers: {
              names: under.length
                ? { ...Object.fromEntries(under.map((e) => [e.id, e.label ?? ""])), [regionId]: entry?.ul ?? "" }
                : {},
              title: entry?.ut ?? "",
              own: entry?.ot === true,
              hidden: under.length ? under.filter((e, i) => (e.on === undefined ? i > 0 : !e.on)).map((e) => e.id) : [],
            },
          }
        : {}),
      bounds: entries.length > 1 && !under.length ? [Math.min(...entries.map((e) => e!.b[0])), Math.min(...entries.map((e) => e!.b[1])), Math.max(...entries.map((e) => e!.b[2])), Math.max(...entries.map((e) => e!.b[3]))] : entry?.b,
    };
    // Region embeds start still, so the region stays in view.
    if (!q.has("rotate")) cfg.rotate = false;
    if (entry && view === "globe") {
      // (With several regions this is the first one's view; the viewer re-frames once they've loaded.)
      if (!explicit.lon) cfg.lon = entry.c[0];
      if (!explicit.lat) cfg.lat = entry.c[1];
      if (!explicit.zoom) cfg.zoom = entry.z;
    }
  } else {
    note("Region not found");
  }
}

root.style.setProperty("--bg", cfg.bg);
root.style.setProperty("--pole", cfg.pole);
if (view === "flat") {
  // The poster is the LQIP cropped exactly like the flat renderer will crop the real map.
  root.classList.add("flatview");
  const aspect = cfg.aspect ?? 2;
  const vw = Math.max(1, innerWidth);
  const vh = Math.max(1, innerHeight);
  const v = flatFit(region?.bounds ?? [-180, -90, 180, 90], aspect, vw, vh);
  if (region && region.explicit.lon) v.cx = cfg.lon;
  if (region && region.explicit.lat) v.cy = cfg.lat;
  const k = v.k * (region?.explicit.zoom ? cfg.zoom : 1);
  const ky = (2 / aspect) * k;
  root.style.setProperty("--fw", `${360 * k}px`);
  root.style.setProperty("--fh", `${180 * ky}px`);
  root.style.setProperty("--fx", `${vw / 2 - (v.cx + 180) * k}px`);
  root.style.setProperty("--fy", `${vh / 2 - (90 - v.cy) * ky}px`);
} else {
  root.style.setProperty("--k", String(diameterFraction(distanceForZoom(cfg.zoom))));
  // Centre the poster on the view's longitude (it shows half the map) and fit it inside the padded band.
  for (const [k, v] of Object.entries(posterVars(cfg))) root.style.setProperty(k, v);
}

/* ── Controls: the lock button shows on every region embed, even with controls=0 ── */
$("ui").hidden = !cfg.controls && !region;
for (const id of ["btn-grid", "btn-fs"]) $(id).hidden = !cfg.controls;
if (region) $("btn-lock").hidden = false;
// Globe/flat switch: on every embed that has both viewers. The admin preview has its own switch beside the iframe.
if (data.flat && (region || !data.maps)) {
  const vb = $("btn-view") as HTMLButtonElement;
  vb.hidden = !cfg.controls;
  vb.dataset.view = view;
  const other = view === "flat" ? "Show globe" : "Show flat map";
  vb.title = other;
  vb.setAttribute("aria-label", other);
  vb.addEventListener("click", () => {
    const u = new URL(location.href);
    u.searchParams.set("view", view === "flat" ? "globe" : "flat");
    location.replace(u.href);
  });
}

if (!cfg.textures.length) throw new Error("no map");

// Preload the chosen viewer's chunks only (the flat view must never fetch Three.js).
for (const href of [view === "flat" ? data.flat! : data.globe, ...(data.preload?.[view] ?? [])]) {
  const l = document.createElement("link");
  l.rel = "modulepreload";
  l.href = href;
  document.head.append(l);
}

// The preload <link> in <head> has already started this request; fetch() reuses it.
const firstTexture: Promise<Blob> = fetch(cfg.textures[0].url).then((r) => {
  if (!r.ok) throw new Error(`texture ${r.status}`);
  return r.blob();
});
firstTexture.catch(() => {});

function fallback(): void {
  // No WebGL (or the viewer failed to load): show the flat map instead.
  const img = document.createElement("img");
  const t = cfg.textures;
  img.src = (t.find((x) => x.w === 2048) ?? t[t.length - 1]).url;
  img.alt = cfg.title;
  img.className = "flat";
  $("stage").replaceChildren(img);
  $("ui").hidden = true;
  root.dataset.state = "fallback";
}

function go(): void {
  const canvas = $("globe") as HTMLCanvasElement;
  if (view === "flat") {
    const ctx: FlatStartContext = { cfg, canvas, firstTexture, region };
    import(/* @vite-ignore */ data.flat!)
      .then((m: { start: (c: FlatStartContext) => Promise<void> }) => m.start(ctx))
      .catch(fallback);
    return;
  }
  let gl: WebGL2RenderingContext | null;
  try {
    gl = canvas.getContext("webgl2", { antialias: true, alpha: true, premultipliedAlpha: true });
  } catch {
    gl = null;
  }
  if (!gl) return fallback();
  const ctx: StartContext = { cfg, canvas, gl, firstTexture, region };
  import(/* @vite-ignore */ data.globe)
    .then((m: { start: (c: StartContext) => Promise<void> }) => m.start(ctx))
    .catch(fallback);
}

// Wait for first paint, then load the heavy part.
requestAnimationFrame(() => setTimeout(go, 0));
