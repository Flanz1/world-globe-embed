/** Post-build step: writes dist/v/<slug>/index.html for every slot, plus the landing page. */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { buildBoot } from "./lib/build-boot.ts";
import { loadContent } from "./lib/content.ts";
import { renderLanding } from "./lib/landing.ts";
import { generateSlotPages } from "./lib/pages.ts";
import { ROOT } from "./lib/paths.ts";

interface ManifestChunk {
  file: string;
  src?: string;
  isEntry?: boolean;
  imports?: string[];
}

const dist = path.join(ROOT, "dist");
const { content, errors } = loadContent();
if (!content) {
  for (const e of errors) console.error(`✗ ${e}`);
  process.exit(1);
}

const manifestPath = path.join(dist, ".vite", "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, ManifestChunk>;
const entry = manifest["src/viewer/globe.ts"];
if (!entry) throw new Error("viewer entry missing from the Vite manifest");
const preloads: string[] = [];
const walk = (key: string) => {
  for (const imp of manifest[key]?.imports ?? []) {
    if (!preloads.includes(manifest[imp].file)) preloads.push(manifest[imp].file);
    walk(imp);
  }
};
walk("src/viewer/globe.ts");

const boot = await buildBoot();
const pages = generateSlotPages(content, boot, entry.file, preloads);
for (const p of pages) {
  const out = path.join(dist, p.path);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, p.html);
}
writeFileSync(path.join(dist, "index.html"), renderLanding(content));
writeFileSync(path.join(dist, "robots.txt"), "User-agent: *\nDisallow: /admin/\n");
rmSync(path.join(dist, ".vite"), { recursive: true, force: true });

const gz = (s: string | Buffer) => gzipSync(s, { level: 9 }).length;
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
const viewerFiles = [entry.file, ...preloads];
const viewerGz = viewerFiles.reduce((n, f) => n + gz(readFileSync(path.join(dist, f))), 0);
const bootGz = gz(boot);
const sample = pages[0];
console.log(`Generated ${pages.length} slot page(s): ${pages.map((p) => p.path).join(", ")}`);
console.log(`Inline boot JS: ${kb(boot.length)} raw, ${kb(bootGz)} gzipped`);
if (sample) console.log(`Slot page HTML (${sample.path}): ${kb(sample.html.length)} raw, ${kb(gz(sample.html))} gzipped`);
console.log(`Viewer JS (Three.js + globe): ${kb(viewerGz)} gzipped (${viewerFiles.join(", ")})`);
console.log(`Total viewer JS: ${kb(viewerGz + bootGz)} gzipped`);
