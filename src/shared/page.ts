/**
 * Renders the static HTML for one slot (/v/<slug>/index.html).
 * Everything needed for first paint is inline: CSS, config, the LQIP poster and the boot script.
 */
import { diameterFraction, distanceForZoom, posterVars } from "./params.ts";
import type { MapMeta, PreviewMap, Slot, ViewerConfig } from "./types.ts";
import type { RegionIndexEntry } from "./region.ts";
import { REGION_ID } from "./region.ts";
import { DEFAULT_VIEW, TEXTURE_WIDTHS } from "./types.ts";

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A base64 WebP data: URI and nothing else (no quotes, brackets or spaces). */
export const LQIP = /^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/;

/** JSON that is safe inside a <script> element. */
export const scriptJson = (v: unknown): string =>
  JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

/** Builds the viewer config for a slot. `toRoot` is the relative path from the slot page to the site root. */
export function buildViewerConfig(slug: string, slot: Slot, map: MapMeta, toRoot = "../../"): ViewerConfig {
  const textures = TEXTURE_WIDTHS.filter((w) => map.sizes[`${w}`]).map((w) => ({
    w,
    url: toRoot + map.sizes[`${w}`]!,
  }));
  const { map: _map, title, ...overrides } = slot;
  void _map;
  return { ...DEFAULT_VIEW, ...overrides, slug, title: title ?? map.name, textures, aspect: map.aspect };
}

export const CRITICAL_CSS = `
:root{color-scheme:light dark;--bg:transparent;--k:.8;--px:50%;--ph:100%;--py:50%;--pole:#e8dcc8}
html,body{margin:0;height:100%;overflow:hidden;background:var(--bg)}
body{font:12px/1.2 system-ui,sans-serif;-webkit-tap-highlight-color:transparent}
#stage{position:fixed;inset:0}
#poster{position:absolute;left:50%;top:50%;width:calc(var(--k) * min(100vw,100vh));aspect-ratio:1;transform:translate(-50%,-50%);border-radius:50%;
background-image:radial-gradient(circle at 34% 30%,rgba(255,244,224,.22),transparent 48%),radial-gradient(circle,transparent 58%,rgba(0,0,0,.5)),var(--lqip);
background-size:100% 100%,100% 100%,200% var(--ph);background-position:0 0,0 0,var(--px) var(--py);background-color:var(--pole);background-repeat:no-repeat,no-repeat,repeat-x;
transition:opacity .4s ease}
#globe{position:absolute;inset:0;width:100%;height:100%;display:block;opacity:0;transition:opacity .4s ease;touch-action:none;cursor:grab;outline:none}
.ready #globe{opacity:1}.ready #poster{opacity:0}
.flat{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
.note{position:absolute;inset:auto 16px;top:45%;margin:0;text-align:center;font-size:14px;color:#9d927b}
#ui{position:fixed;right:8px;bottom:8px;display:flex;gap:4px;opacity:.55;transition:opacity .2s}
#ui:hover,#ui:focus-within{opacity:1}
#ui button{all:unset;box-sizing:border-box;width:28px;height:28px;display:grid;place-items:center;border-radius:6px;cursor:pointer;color:#e8dcc8;background:rgba(20,18,14,.55)}
#ui button:focus-visible{outline:2px solid #c9a94e}
#ui button[aria-pressed=true]{color:#e8c44a;background:rgba(20,18,14,.8)}
#ui [hidden],#legend[hidden],#ui[hidden]{display:none}
#legend{position:fixed;left:8px;bottom:8px;padding:6px 8px;border-radius:6px;color:#e8dcc8;background:rgba(20,18,14,.6);display:grid;gap:4px}
#legend i{display:inline-block;width:16px;height:3px;border-radius:1px;margin-right:6px;vertical-align:middle}
.flatview #poster{left:0;top:0;width:100%;height:100%;aspect-ratio:auto;transform:none;border-radius:0;background-color:transparent;
background-image:var(--lqip);background-size:var(--fw) var(--fh);background-position:var(--fx) var(--fy);background-repeat:repeat-x}
#btn-lock[aria-pressed=true] .i-open,#btn-lock[aria-pressed=false] .i-shut,#btn-view[data-view=flat] .i-flat,#btn-view[data-view=globe] .i-globe{display:none}
.rlabel{position:absolute;left:0;top:0;padding:2px 7px;border-radius:5px;background:rgba(20,18,14,.62);color:#f3ead8;font:600 12px/1.3 system-ui,sans-serif;white-space:nowrap;pointer-events:none;max-width:60vw;overflow:hidden;text-overflow:ellipsis}
.rkey{position:absolute;left:8px;top:8px;max-width:min(60vw,240px);max-height:calc(100% - 52px);overflow:auto;border-radius:6px;background:rgba(20,18,14,.62);color:#f3ead8;font:12px/1.3 system-ui,sans-serif}
.rkey-head{all:unset;box-sizing:border-box;display:block;width:100%;padding:4px 8px;font-weight:600;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rkey-head:focus-visible{outline:2px solid #c9a94e}
.rkey-head::after{content:"▾";margin-left:6px;opacity:.7}.rkey-head[aria-expanded=false]::after{content:"▸"}
.rkey ul{list-style:none;margin:0;padding:0 8px 6px;display:grid;gap:3px}
.rkey li{display:flex;align-items:center;gap:6px;min-width:0}
.rkey li span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rkey i{flex:none;width:12px;height:12px;border-radius:3px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.35)}
.rkey[hidden],.rkey ul[hidden]{display:none}
.rnote{position:fixed;left:8px;top:8px;margin:0;padding:3px 8px;border-radius:6px;background:rgba(20,18,14,.6);color:#e8dcc8;font-size:11px;pointer-events:none}
@media (prefers-reduced-motion:reduce){#poster,#globe{transition:none}}
`.replace(/\n/g, "");

const ICON_GRID =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/><ellipse cx="8" cy="8" rx="3" ry="6.5"/><path d="M1.5 8h13M2.7 4.5h10.6M2.7 11.5h10.6"/></svg>';
const ICON_FS =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/></svg>';

const ICON_LOCK =
  '<svg class="i-shut" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/></svg>' +
  '<svg class="i-open" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5 7V5a3 3 0 0 1 5.8-1"/></svg>';
const ICON_VIEW =
  '<svg class="i-flat" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="1.5" y="3.5" width="13" height="9" rx="1"/><path d="M1.5 8h13M6 3.5v9M10 3.5v9"/></svg>' +
  '<svg class="i-globe" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/><path d="M1.6 7.2c2.6 2 10.2 2 12.8 0"/><path d="M4.6 3.6a5 5 0 0 1 3.4-1.3" stroke-linecap="round"/></svg>';

export interface PageInput {
  cfg: ViewerConfig;
  /** LQIP data URI; empty on the preview page (boot fills it in). */
  lqip: string;
  /** Minified boot script (IIFE). */
  bootJs: string;
  /** URL of the viewer module relative to the page. */
  globeUrl: string;
  /** Chunks the 3D viewer imports (the boot script preloads them only for the globe view). */
  modulePreloads?: string[];
  /** URL of the flat (2D) viewer module and its chunks, relative to the page. */
  flatUrl?: string;
  flatPreloads?: string[];
  /** Path from the page to the site root. */
  toRoot?: string;
  /** This slot's regions (id → where it is), for ?region=. */
  regions?: Record<string, RegionIndexEntry>;
  /** Preview page only: every map, picked with ?map=<id>. */
  maps?: Record<string, PreviewMap>;
  noindex?: boolean;
}

const finite = (...v: number[]) => v.every((n) => typeof n === "number" && Number.isFinite(n));

/** Re-checks the region index before it goes into the page, even though the schema already checked the data. */
function checkIndex(regions: Record<string, RegionIndexEntry>): Record<string, RegionIndexEntry> {
  const out: Record<string, RegionIndexEntry> = {};
  for (const [id, e] of Object.entries(regions)) {
    if (!REGION_ID.test(id)) throw new Error(`region id "${id}" is not a valid id`);
    if (!finite(...e.c, e.z, ...e.b) || e.c.length !== 2 || e.b.length !== 4) throw new Error(`region "${id}": bad index numbers`);
    out[id] = { c: [e.c[0], e.c[1]], z: e.z, b: [e.b[0], e.b[1], e.b[2], e.b[3]] };
  }
  return out;
}

export function renderSlotPage({
  cfg,
  lqip,
  bootJs,
  globeUrl,
  modulePreloads = [],
  flatUrl,
  flatPreloads = [],
  toRoot,
  regions,
  maps,
  noindex,
}: PageInput): string {
  const k = diameterFraction(distanceForZoom(cfg.zoom)).toFixed(4);
  const title = escapeHtml(cfg.title);
  const first = cfg.textures[0];
  // The schema already limits these, but check anyway: this attribute is the one place map data meets raw HTML.
  if (lqip && !LQIP.test(lqip)) throw new Error(`map "${cfg.slug}": lqip must be a base64 WebP data: URI`);
  const pv = posterVars(cfg);
  const vars = [
    `--bg:${cfg.bg}`,
    `--k:${k}`,
    `--pole:${cfg.pole}`,
    ...Object.entries(pv).map(([key, v]) => `${key}:${v}`),
    ...(lqip ? [`--lqip:url("${lqip}")`] : []),
  ].join(";");
  const data = scriptJson({
    cfg,
    globe: globeUrl,
    ...(flatUrl ? { flat: flatUrl } : {}),
    preload: { globe: modulePreloads, flat: flatPreloads },
    ...(toRoot ? { root: toRoot } : {}),
    ...(regions && Object.keys(regions).length ? { regions: checkIndex(regions) } : {}),
    ...(maps ? { maps } : {}),
  });
  return `<!doctype html>
<html lang="en" style="${escapeHtml(vars)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${noindex ? '<meta name="robots" content="noindex">\n' : ""}<title>${title}</title>
${first ? `<link rel="preload" href="${escapeHtml(first.url)}" as="fetch" type="image/webp" crossorigin>\n` : ""}<style>${CRITICAL_CSS}</style>
</head>
<body>
<div id="stage"><div id="poster" role="img" aria-label="${title}"></div><canvas id="globe" aria-label="${title}, drag to rotate, scroll or pinch to zoom"></canvas></div>
<div id="ui"${cfg.controls ? "" : " hidden"}><button id="btn-lock" type="button" hidden aria-pressed="true" title="Unlock view" aria-label="Unlock view">${ICON_LOCK}</button><button id="btn-view" type="button" hidden>${ICON_VIEW}</button><button id="btn-grid" type="button" aria-pressed="${cfg.grid}" title="Grid" aria-label="Toggle grid">${ICON_GRID}</button><button id="btn-fs" type="button" title="Fullscreen" aria-label="Fullscreen">${ICON_FS}</button></div>
<div id="legend" hidden><span><i style="background:#e8c44a"></i>Equator</span><span><i style="background:#e85050"></i>Prime meridian</span><span><i style="background:rgba(201,169,78,.6)"></i>30°</span><span><i style="background:rgba(201,169,78,.3)"></i>15°</span></div>
<script type="application/json" id="wge-data">${data}</script>
<script>${bootJs}</script>
</body>
</html>
`;
}

/** Map data for the preview page. `toRoot` is the path from the preview page to the site root. */
export function previewMaps(maps: Iterable<MapMeta>, toRoot = "../"): Record<string, PreviewMap> {
  const out: Record<string, PreviewMap> = {};
  for (const m of maps) {
    if (!LQIP.test(m.lqip)) throw new Error(`map "${m.id}": lqip must be a base64 WebP data: URI`);
    out[m.id] = {
      name: m.name,
      aspect: m.aspect,
      lqip: m.lqip,
      textures: TEXTURE_WIDTHS.filter((w) => m.sizes[`${w}`]).map((w) => ({ w, url: toRoot + m.sizes[`${w}`]! })),
    };
  }
  return out;
}
