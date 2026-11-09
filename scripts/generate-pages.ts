/** Post-build step: writes dist/v/<slug>/index.html for every slot, plus the landing page. */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { buildBoot } from "./lib/build-boot.ts";
import { loadContent } from "./lib/content.ts";
import { renderLanding } from "./lib/landing.ts";
import { generatePreviewPage, generateRegionFiles, generateSlotPages, type ViewerModules } from "./lib/pages.ts";
import { ROOT } from "./lib/paths.ts";

interface ManifestChunk {
  file: string;
  src?: string;
  isEntry?: boolean;
  imports?: string[];
}

const dist = path.join(ROOT, "dist");
const { content, errors, warnings } = loadContent();
if (!content) {
  for (const e of errors) console.error(`✗ ${e}`);
  process.exit(1);
}
for (const w of warnings) console.warn(`! ${w}`);

const manifestPath = path.join(dist, ".vite", "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, ManifestChunk>;
/** An entry's file plus every chunk it statically imports, from the Vite manifest. */
function chunksOf(key: string): { file: string; imports: string[] } {
  const entry = manifest[key];
  if (!entry) throw new Error(`${key} missing from the Vite manifest`);
  const imports: string[] = [];
  const walk = (k: string) => {
    for (const imp of manifest[k]?.imports ?? []) {
      if (!imports.includes(manifest[imp].file)) imports.push(manifest[imp].file);
      walk(imp);
    }
  };
  walk(key);
  return { file: entry.file, imports };
}
const globe = chunksOf("src/viewer/globe.ts");
const flat = chunksOf("src/viewer/flat.ts");
const mods: ViewerModules = { globe: globe.file, globePreloads: globe.imports, flat: flat.file, flatPreloads: flat.imports };
// The flat view must never pull in Three.js.
for (const f of [flat.file, ...flat.imports]) {
  if (/THREE\.|WebGLRenderer/.test(readFileSync(path.join(dist, f), "utf8"))) throw new Error(`flat viewer chunk ${f} contains Three.js`);
}

const boot = await buildBoot();
const pages = generateSlotPages(content, boot, mods);
for (const p of [...pages, generatePreviewPage(content, boot, mods)]) {
  const out = path.join(dist, p.path);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, p.html);
}
const regionFiles = generateRegionFiles(content);
for (const r of regionFiles) {
  const out = path.join(dist, r.path);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, r.json);
}
writeFileSync(path.join(dist, "index.html"), renderLanding(content));
writeFileSync(path.join(dist, "robots.txt"), "User-agent: *\nDisallow: /admin/\nDisallow: /preview/\n");
rmSync(path.join(dist, ".vite"), { recursive: true, force: true });

const gz = (s: string | Buffer) => gzipSync(s, { level: 9 }).length;
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
const sum = (files: string[]) => files.reduce((n, f) => n + gz(readFileSync(path.join(dist, f))), 0);
const viewerFiles = [globe.file, ...globe.imports];
const flatFiles = [flat.file, ...flat.imports];
const viewerGz = sum(viewerFiles);
const flatGz = sum(flatFiles);
const bootGz = gz(boot);
const sample = pages[0];
console.log(`Generated ${pages.length} slot page(s): ${pages.map((p) => p.path).join(", ")}`);
console.log(`Inline boot JS: ${kb(boot.length)} raw, ${kb(bootGz)} gzipped`);
if (sample) console.log(`Slot page HTML (${sample.path}): ${kb(sample.html.length)} raw, ${kb(gz(sample.html))} gzipped`);
console.log(`Viewer JS (Three.js + globe): ${kb(viewerGz)} gzipped (${viewerFiles.join(", ")})`);
console.log(`Total globe path JS: ${kb(viewerGz + bootGz)} gzipped`);
console.log(`Flat viewer JS (no Three.js): ${kb(flatGz)} gzipped (${flatFiles.join(", ")})`);
console.log(`Total flat path JS: ${kb(flatGz + bootGz)} gzipped`);
if (regionFiles.length) {
  const sizes = regionFiles.map((r) => r.json.length).sort((a, b) => a - b);
  const mid = regionFiles.find((r) => r.json.length === sizes[Math.floor(sizes.length / 2)])!;
  console.log(`Regions: ${regionFiles.length} file(s); median ${mid.path}: ${kb(mid.json.length)} raw, ${kb(gz(mid.json))} gzipped`);
}
