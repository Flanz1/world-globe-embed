/**
 * The experimental atlas page (v/<slot>/atlas/index.html): every region of a slot, grouped by category.
 * Each tile starts as a light preview (the region's outline as inline SVG, no image and no iframe) and only
 * loads the real embed when the reader clicks it. Static: no Worker calls. Not linked from anywhere.
 */
import { createHash } from "node:crypto";
import { douglasPeucker } from "../../src/shared/geo.ts";
import { defaultEmbedOptions, regionEmbedCode } from "../../src/shared/embed.ts";
import { escapeHtml } from "../../src/shared/page.ts";
import { childrenOf, pathName, type CategoriesFile } from "../../src/shared/categories.ts";
import type { RegionFeature } from "../../src/shared/region.ts";
import type { Content } from "./content.ts";
import type { GeneratedPage } from "./pages.ts";

/** Stands in for the site's address in embed codes; the page swaps in the real one when it runs. */
export const SITE_TOKEN = "https://site.invalid/";

const VIEW_W = 160;
const VIEW_H = 100;
const PAD = 8;

type Ring = [number, number][];

/** Outer and hole rings of a region, as [lon, lat]. */
function polygons(r: RegionFeature): Ring[][] {
  const g = r.geometry as { type: string; coordinates: unknown };
  return (g.type === "MultiPolygon" ? g.coordinates : [g.coordinates]) as Ring[][];
}

/** The region's outline as one SVG path in a 160×100 box, fitted to its bounding box and simplified to a few points per ring. */
export function outlinePath(r: RegionFeature): string {
  const polys = polygons(r);
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of polys) for (const [x, y] of p[0]) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
  // Longitude is stretched by 1/cos(lat) shrink at the middle latitude, so shapes look right away from the equator.
  const k = Math.max(0.2, Math.cos((((y0 + y1) / 2) * Math.PI) / 180));
  const w = Math.max((x1 - x0) * k, 1e-6);
  const h = Math.max(y1 - y0, 1e-6);
  const s = Math.min((VIEW_W - 2 * PAD) / w, (VIEW_H - 2 * PAD) / h);
  const ox = (VIEW_W - w * s) / 2;
  const oy = (VIEW_H - h * s) / 2;
  const tol = 0.6 / s; // about 0.6 box units
  const num = (n: number) => (Math.round(n * 10) / 10).toString();
  const d: string[] = [];
  for (const p of polys)
    for (const ring of p) {
      const pts = douglasPeucker(ring, tol);
      if (pts.length < 4) continue;
      d.push(`M${pts.slice(0, -1).map(([x, y]) => `${num(ox + (x - x0) * k * s)} ${num(oy + (y1 - y) * s)}`).join("L")}Z`);
    }
  return d.join("");
}

/** What the admin card shows for a region: its name, else its first part label, else its id. */
export function displayName(r: RegionFeature): string {
  const p = r.properties;
  return p.name?.trim() || p.partLabels?.find((l) => l?.trim())?.trim() || r.id;
}

interface Group {
  name: string;
  ids: string[];
}

/** Regions of one slot grouped by category (depth first, "Parent / Child" names); regions in no category go last. */
export function atlasGroups(slug: string, regions: ReadonlyMap<string, RegionFeature>, cats: CategoriesFile | undefined): Group[] {
  const ids = [...regions.values()].filter((r) => r.properties.slot === slug).map((r) => r.id).sort();
  const have = new Set(ids);
  const groups: Group[] = [];
  const placed = new Set<string>();
  const walk = (parent: string | null) => {
    for (const k of childrenOf(cats, parent)) {
      const own = [...(k.pinned ?? []), ...k.regions.filter((id) => !(k.pinned ?? []).includes(id))].filter((id) => have.has(id));
      own.forEach((id) => placed.add(id));
      if (own.length) groups.push({ name: pathName(cats, k.id).split(" › ").join(" / "), ids: own });
      walk(k.id);
    }
  };
  walk(null);
  const rest = ids.filter((id) => !placed.has(id));
  if (rest.length) groups.push({ name: groups.length ? "Uncategorized" : "Regions", ids: rest });
  return groups;
}

const CSS = `
:root{color-scheme:light dark;--surface:#fff8ee;--on:#1f1b14;--on-var:#4f4635;--card:#fbf2e7;--card-hi:#f0e7dc;--line:#d3c5af;--primary:#7a5900;--tonal:#f5e0bb;--on-tonal:#241a04;--chip:#f5e0bb;--on-chip:#241a04;--map:#14120f}
@media (prefers-color-scheme:dark){:root{--surface:#16130d;--on:#eae1d6;--on-var:#d3c5af;--card:#1f1b14;--card-hi:#2e2922;--line:#4f4635;--primary:#edc061;--tonal:#52452a;--on-tonal:#f5e0bb;--chip:#52452a;--on-chip:#f5e0bb}}
*{box-sizing:border-box}
body{margin:0;background:var(--surface);color:var(--on);font:15px/1.5 system-ui,sans-serif}
main{max-width:72rem;margin:0 auto;padding:16px}
h1{font-size:24px;margin:8px 0 4px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
h2{font-size:16px;font-weight:600;margin:24px 0 8px}
.pill{font-size:12px;font-weight:500;padding:2px 10px;border-radius:999px;background:var(--chip);color:var(--on-chip)}
.hint{color:var(--on-var);margin:0 0 8px;font-size:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:10px;display:flex;flex-direction:column;gap:6px;min-width:0}
.view{aspect-ratio:16/10;border-radius:8px;overflow:hidden;background:var(--map);position:relative}
.view.live{background:var(--card-hi)}
section{content-visibility:auto;contain-intrinsic-size:auto 400px}
.view svg{width:100%;height:100%;display:block}
.view iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
.name{font-weight:600;font-size:16px;overflow-wrap:anywhere}
code{font:12px ui-monospace,monospace;color:var(--on-var);overflow-wrap:anywhere}
.row{display:flex;gap:6px;flex-wrap:nowrap;overflow-x:auto}
button{flex:none;white-space:nowrap}
button{font:500 13px system-ui,sans-serif;height:32px;padding:0 14px;border-radius:999px;border:1px solid var(--line);background:transparent;color:var(--primary);cursor:pointer}
button.text{border-color:transparent}
button[hidden]{display:none}
button.tonal{background:var(--tonal);color:var(--on-tonal);border-color:transparent}
button:hover{filter:brightness(.96)}
button:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
button[disabled]{opacity:.6;cursor:default}
.empty{color:var(--on-var);background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-top:16px}
`;

/** Runs in the page: Load live view swaps the preview for the embed; Copy embed code copies the snippet. */
export const ATLAS_JS = `(()=>{
const root=new URL("../../../",location.href).href;
const open=[];
const unload=t=>{const i=open.indexOf(t);if(i>=0)open.splice(i,1);const v=t.querySelector(".view");v.classList.remove("live");v.replaceChildren(t._svg);t.querySelector("[data-live]").hidden=false;t.querySelector("[data-unload]").hidden=true;};
for(const t of document.querySelectorAll(".tile")){
const live=t.querySelector("[data-live]"),off=t.querySelector("[data-unload]"),copy=t.querySelector("[data-copy]"),view=t.querySelector(".view");
t._svg=view.firstElementChild;
live.addEventListener("click",()=>{if(open.length>=2)unload(open[0]);const f=document.createElement("iframe");f.src=new URL(t.dataset.src,location.href).href;f.title=t.dataset.title;f.allow="fullscreen";f.loading="lazy";view.classList.add("live");view.replaceChildren(f);open.push(t);live.hidden=true;off.hidden=false;off.focus()});
off.addEventListener("click",()=>{unload(t);live.focus()});
copy.addEventListener("click",async()=>{const code=copy.dataset.code.split(${JSON.stringify(SITE_TOKEN)}).join(root);const say=m=>{copy.textContent=m;setTimeout(()=>{copy.textContent="Copy embed code"},2000)};
try{await navigator.clipboard.writeText(code);say("Copied")}catch{const a=document.createElement("textarea");a.value=code;document.body.append(a);a.select();let ok=false;try{ok=document.execCommand("copy")}catch{}a.remove();say(ok?"Copied":"Copy failed")}});
}})();`;

const csp = (hash: string) =>
  ["default-src 'none'", `script-src 'sha256-${hash}'`, "style-src 'unsafe-inline'", "frame-src 'self'", "base-uri 'none'", "form-action 'none'", "object-src 'none'"].join("; ");

/** One atlas page per slot that has regions, at v/<slot>/atlas/index.html. */
export function generateAtlasPages(content: Content, cats?: CategoriesFile): GeneratedPage[] {
  const regions = content.regions;
  if (!regions) return [];
  const hash = createHash("sha256").update(ATLAS_JS, "utf8").digest("base64");
  const pages: GeneratedPage[] = [];
  for (const [slug, slot] of Object.entries(content.slots.slots)) {
    const groups = atlasGroups(slug, regions, cats);
    const title = slot.title ?? content.maps.get(slot.map)?.name ?? slug;
    const sections = !groups.length ? `<p class="empty">No regions on this slot yet.</p>` : groups
      .map((g) => {
        const tiles = g.ids
          .map((id) => {
            const r = regions.get(id)!;
            const o = { ...defaultEmbedOptions(r.properties), view: "flat" as const };
            const code = regionEmbedCode(SITE_TOKEN, slug, title, { id, name: displayName(r), label: r.properties.label }, defaultEmbedOptions(r.properties));
            const src = regionEmbedCode(SITE_TOKEN, slug, title, { id, name: displayName(r) }, o).match(/src="([^"]+)"/)![1].replace(/&amp;/g, "&").replace(SITE_TOKEN, "../../../");
            const col = /^#[0-9a-fA-F]{3,8}$/.test(r.properties.color) ? r.properties.color : "#888";
            const op = typeof r.properties.fillOpacity === "number" ? Math.min(1, Math.max(0.15, r.properties.fillOpacity + 0.2)) : 0.55;
            return `<li class="tile" data-src="${escapeHtml(src)}" data-title="${escapeHtml(`Live view of ${displayName(r)}`)}">
<div class="view"><svg viewBox="0 0 ${VIEW_W} ${VIEW_H}" role="img" aria-label="Outline of ${escapeHtml(displayName(r))}"><path d="${outlinePath(r)}" fill="${col}" fill-opacity="${op}" stroke="${col}" stroke-width="1.2" fill-rule="evenodd" stroke-linejoin="round"/></svg></div>
<div class="name">${escapeHtml(displayName(r))}</div>${displayName(r) !== id ? `<code>${escapeHtml(id)}</code>` : ""}
<div class="row"><button type="button" class="tonal" data-live>Load live view</button><button type="button" class="text" data-unload hidden>Show preview</button><button type="button" data-copy data-code="${escapeHtml(code)}" aria-live="polite">Copy embed code</button></div></li>`;
          })
          .join("\n");
        return `<section><h2>${escapeHtml(g.name)}</h2><ul class="grid" style="list-style:none;margin:0;padding:0">${tiles}</ul></section>`;
      })
      .join("\n");
    pages.push({
      path: `v/${slug}/atlas/index.html`,
      html: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp(hash)}"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Atlas: ${escapeHtml(title)} (experimental)</title><style>${CSS}</style></head>
<body><main><h1>${escapeHtml(title)} atlas <span class="pill">Experimental</span></h1>
<p class="hint">Every region on this map. Click a tile to load its live view; Copy embed code gives the iframe for your notes.</p>
${sections}</main><script>${ATLAS_JS}</script></body></html>
`,
    });
  }
  return pages;
}
