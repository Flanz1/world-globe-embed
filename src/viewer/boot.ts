/**
 * Inline boot script. It is compiled to a tiny IIFE and inlined into every
 * slot page, so it runs before first paint without any extra request.
 *
 * Its jobs: apply query-param overrides, size the LQIP poster so it lines up
 * with the 3D globe, start fetching the 1024px texture, then (after first
 * paint) create the WebGL context and dynamically import the Three.js viewer.
 */
import { applyParams, diameterFraction, distanceForZoom, posterVars } from "../shared/params.ts";
import type { ViewerConfig } from "../shared/types.ts";
import type { BootData, StartContext } from "./contract.ts";

const data = JSON.parse(document.getElementById("wge-data")!.textContent!) as BootData;
const cfg: ViewerConfig = applyParams(data.cfg, location.search);
const root = document.documentElement;
const $ = (id: string) => document.getElementById(id)!;

// Preview page (used by the admin page): every map is inlined, pick one with ?map=<id>.
if (data.maps) {
  const ids = Object.keys(data.maps);
  const want = new URLSearchParams(location.search).get("map") ?? "";
  const m = want ? data.maps[want] : data.maps[ids[0]];
  if (!m) {
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = "This map isn't published yet. It shows up here once the deploy has finished.";
    $("stage").replaceChildren(note);
    $("ui").hidden = true;
    throw new Error("map not deployed");
  }
  {
    cfg.textures = m.textures;
    cfg.title = m.name;
    document.title = `${m.name} (preview)`;
    root.style.setProperty("--lqip", `url("${m.lqip}")`);
  }
}

root.style.setProperty("--bg", cfg.bg);
root.style.setProperty("--pole", cfg.pole);
root.style.setProperty("--k", String(diameterFraction(distanceForZoom(cfg.zoom))));
// Centre the poster on the slot's longitude (it shows half the map) and fit it inside the padded band.
for (const [k, v] of Object.entries(posterVars(cfg))) root.style.setProperty(k, v);
$("ui").hidden = !cfg.controls;

if (!cfg.textures.length) throw new Error("no map");

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
  let gl: WebGL2RenderingContext | null;
  try {
    gl = canvas.getContext("webgl2", { antialias: true, alpha: true, premultipliedAlpha: true });
  } catch {
    gl = null;
  }
  if (!gl) return fallback();
  const ctx: StartContext = { cfg, canvas, gl, firstTexture };
  import(/* @vite-ignore */ data.globe)
    .then((m: { start: (c: StartContext) => Promise<void> }) => m.start(ctx))
    .catch(fallback);
}

// Wait for first paint, then load the heavy part.
requestAnimationFrame(() => setTimeout(go, 0));
