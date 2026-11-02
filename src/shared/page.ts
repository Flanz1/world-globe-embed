/**
 * Renders the static HTML for one slot (/v/<slug>/index.html).
 * Everything needed for first paint is inline: CSS, config, the LQIP poster and the boot script.
 */
import { diameterFraction, distanceForZoom, posterVars } from "./params.ts";
import type { MapMeta, PreviewMap, Slot, ViewerConfig } from "./types.ts";
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
  return { ...DEFAULT_VIEW, ...overrides, slug, title: title ?? map.name, textures };
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
@media (prefers-reduced-motion:reduce){#poster,#globe{transition:none}}
`.replace(/\n/g, "");

const ICON_GRID =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/><ellipse cx="8" cy="8" rx="3" ry="6.5"/><path d="M1.5 8h13M2.7 4.5h10.6M2.7 11.5h10.6"/></svg>';
const ICON_FS =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/></svg>';

export interface PageInput {
  cfg: ViewerConfig;
  /** LQIP data URI; empty on the preview page (boot fills it in). */
  lqip: string;
  /** Minified boot script (IIFE). */
  bootJs: string;
  /** URL of the viewer module relative to the page. */
  globeUrl: string;
  /** Extra <link rel="modulepreload"> URLs (viewer chunks). */
  modulePreloads?: string[];
  /** Preview page only: every map, picked with ?map=<id>. */
  maps?: Record<string, PreviewMap>;
  noindex?: boolean;
}

export function renderSlotPage({ cfg, lqip, bootJs, globeUrl, modulePreloads = [], maps, noindex }: PageInput): string {
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
  const data = scriptJson({ cfg, globe: globeUrl, ...(maps ? { maps } : {}) });
  return `<!doctype html>
<html lang="en" style="${escapeHtml(vars)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${noindex ? '<meta name="robots" content="noindex">\n' : ""}<title>${title}</title>
${first ? `<link rel="preload" href="${escapeHtml(first.url)}" as="fetch" type="image/webp" crossorigin>\n` : ""}${[globeUrl, ...modulePreloads].map((u) => `<link rel="modulepreload" href="${escapeHtml(u)}">`).join("\n")}
<style>${CRITICAL_CSS}</style>
</head>
<body>
<div id="stage"><div id="poster" role="img" aria-label="${title}"></div><canvas id="globe" aria-label="${title}, drag to rotate, scroll or pinch to zoom"></canvas></div>
<div id="ui"${cfg.controls ? "" : " hidden"}><button id="btn-grid" type="button" aria-pressed="${cfg.grid}" title="Grid" aria-label="Toggle grid">${ICON_GRID}</button><button id="btn-fs" type="button" title="Fullscreen" aria-label="Fullscreen">${ICON_FS}</button></div>
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
