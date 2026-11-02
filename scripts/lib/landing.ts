import { escapeHtml } from "../../src/shared/page.ts";
import type { Content } from "./content.ts";

/** A small, unindexed index page listing the slots and their embed snippets. */
export function renderLanding({ slots, maps }: Content): string {
  const rows = Object.entries(slots.slots)
    .map(([slug, s]) => {
      const title = escapeHtml(s.title ?? maps.get(s.map)?.name ?? slug);
      return `<li><a href="v/${slug}/">${title}</a> <code>${escapeHtml(slug)}</code> → map <code>${escapeHtml(s.map)}</code>
<pre data-slug="${slug}" data-title="${title}"></pre></li>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>World globe embeds</title>
<style>:root{color-scheme:light dark}body{font:15px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 16px}
pre{white-space:pre-wrap;word-break:break-all;background:#8881;padding:.6rem;border-radius:6px;font-size:12px}li{margin-bottom:1rem}</style></head>
<body><h1>World globe embeds</h1><p>Slots on this site. Manage them in the <a href="admin/">admin page</a> or by editing <code>content/slots.json</code>.</p>
<ul>${rows}</ul>
<script>for(const p of document.querySelectorAll("pre[data-slug]")){const u=new URL("v/"+p.dataset.slug+"/",location.href).href;
p.textContent='<iframe src="'+u+'" width="100%" height="480" style="border:0;border-radius:8px;background:transparent" loading="lazy" allow="fullscreen" title="'+p.dataset.title+' globe"></iframe>'}</script>
</body></html>
`;
}
