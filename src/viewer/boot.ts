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
import { REGION_ID, flatFit, parseRegionData, type RegionData } from "../shared/region.ts";
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
    root.style.setProperty("--lqip", `url("${m.lqip}")`);
  }
}

/* ── Region (?region=<id>) ── */
let region: RegionContext | null = null;
const regionId = q.get("region");
if (regionId !== null) {
  const preview = !!data.maps;
  const entry = data.regions && Object.prototype.hasOwnProperty.call(data.regions, regionId) ? data.regions[regionId] : undefined;
  if (REGION_ID.test(regionId) && (entry || preview)) {
    const given = (k: string) => {
      const v = q.get(k);
      return v != null && v.trim() !== "" && Number.isFinite(Number(v));
    };
    const explicit = { lat: given("lat"), lon: given("lon"), zoom: given("zoom") };
    const label = q.get("label");
    let subscribe: RegionContext["subscribe"];
    let regionData: Promise<RegionData | null>;
    if (preview) {
      // The admin page sends the region it's editing; only same-origin messages from the parent count.
      const subs: ((r: RegionData, centre: boolean) => void)[] = [];
      let first: (r: RegionData) => void = () => {};
      regionData = new Promise((res) => (first = res));
      window.addEventListener("message", (e: MessageEvent) => {
        if (e.origin !== location.origin || e.source !== window.parent || e.data?.type !== "wge-region") return;
        const r = parseRegionData(e.data.region);
        if (!r) return;
        first(r);
        for (const cb of subs) cb(r, e.data.centre === true);
      });
      subscribe = (cb) => void subs.push(cb);
    } else {
      // Starts now, in parallel with the first texture.
      regionData = fetch(`${data.root ?? "../../"}regions/${regionId}.json`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          const r = parseRegionData(j);
          return r && r.id === regionId && r.slot === cfg.slug ? r : null;
        })
        .catch(() => null);
    }
    region = {
      id: regionId,
      data: regionData,
      subscribe,
      label: label === "1" ? true : label === "0" ? false : null,
      key: q.get("key") !== "0",
      dim: q.get("dim") === "1",
      lock: q.get("lock") !== "0",
      explicit,
      fitted: !!entry,
      bounds: entry?.b,
    };
    // Region embeds start still, so the region stays in view.
    if (!q.has("rotate")) cfg.rotate = false;
    if (entry && view === "globe") {
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
