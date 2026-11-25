// e2e-suite: roots=EDITOR weight=1
/**
 * Panning the editor map (npm run e2e:pan): while the map is dragged the last frame is slid across the canvas;
 * it must differ from the start, and once the pointer rests (and after release) the canvas must equal a fresh full repaint.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { SLOT, MAP, makeFixture } from "./fixture.mjs";
import { MockGitHub } from "./mock-github.mjs";
import { useAdminApi } from "./admin-api.mjs";
import { port } from "./ports.mjs";
import { pickRegion } from "./regions-ui.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const VERTS = 400;
const BRANCH = "test/pan";

const ring = [];
for (let i = 0; i < VERTS; i++) {
  const a = (i / VERTS) * Math.PI * 2;
  const r = 20 + 0.05 * Math.sin(a * 97);
  ring.push([Math.round((100 + r * Math.cos(a)) * 1e5) / 1e5, Math.round((-30 + r * Math.sin(a) * 0.8) * 1e5) / 1e5]);
}
ring.push([...ring[0]]);
const parts = process.env.PARTS === "2" ? [[ring], [[[10, 10], [14, 10], [14, 14], [10, 14], [10, 10]]]] : [[ring]];
const region = {
  $schema: "../../schema/region.schema.json",
  type: "Feature",
  id: "perf-test",
  properties: { slot: SLOT.slug, map: MAP.id, color: "#00e5ff", fillOpacity: 0.25, label: true, updated: "2026-11-12T12:00:00Z", description: "x", partLocked: parts.map(() => false) },
  geometry: { type: "MultiPolygon", coordinates: parts },
};
// REAL=<region id>: the repo's own content (real map, real region) instead of the synthetic one.
const REAL = process.env.REAL;
const dir = REAL ? path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..") : await makeFixture({ quiet: true });
const RID = REAL ?? "perf-test";
const GRAB = REAL ? JSON.parse(readFileSync(path.join(dir, `content/regions/${REAL}.json`), "utf8")).geometry.coordinates.flat(JSON.parse(readFileSync(path.join(dir, `content/regions/${REAL}.json`), "utf8")).geometry.type === "Polygon" ? 1 : 2)[0] : ring[0];
if (!REAL) writeFileSync(path.join(dir, "content/regions/perf-test.json"), JSON.stringify(region));
execFileSync(...(process.env.PROFILE ? ["sh", ["-c", "npx vite build --minify false && npx tsx scripts/generate-pages.ts"]] : ["npm", ["run", "build"]]), { cwd: dir, env: { ...process.env, VITE_CONTENT_BRANCH: BRANCH }, stdio: "pipe" });
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".json": "application/json", ".txt": "text/plain" };
const DIST = path.join(dir, "dist");
const server = createServer(async (req, res) => {
  let p = path.join(DIST, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (existsSync(p) && statSync(p).isDirectory()) p = path.join(p, "index.html");
  if (!p.startsWith(DIST) || !existsSync(p)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] ?? "application/octet-stream", "Cache-Control": "no-store" });
  res.end(await readFile(p));
}).listen(port(4173), "localhost");
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const mock = new MockGitHub({ root: dir, branches: ["main", BRANCH] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await ctx.route("https://api.github.com/**", (r) => mock.handle(r));
await useAdminApi(ctx, mock, { branch: BRANCH });
const page = await ctx.newPage();
page.on("crash", () => console.log("PAGE CRASHED"));
page.on("pageerror", (e) => console.log("pageerror", String(e).slice(0, 200)));
const tOpen = Date.now();
await page.goto(`http://localhost:${port(4173)}/admin/#regions`);
await page.waitForSelector(`#regions .rrow[data-region="${RID}"]`, { timeout: 20000 });
await pickRegion(page, `${RID}`);
await page.locator(`[data-region="${RID}"] [data-action="edit"]`).click({ timeout: 120000 });
await page.waitForSelector("dialog.editor[open]", { state: "attached", timeout: 240000 });
await page.waitForFunction(() => !!document.querySelector("dialog.editor")?.wgeEditor, null, { timeout: 240000 });
console.log(`editor ready after ${((Date.now() - tOpen) / 1000).toFixed(1)} s`);
await page.waitForTimeout(2500);
const call = (fn, ...args) => page.evaluate(([fn, args]) => document.querySelector("dialog.editor").wgeEditor[fn](...args), [fn, args]);

if (process.env.NOPREVIEW) await page.evaluate(() => { const f = document.querySelector('dialog.editor iframe'); f.contentWindow.postMessage = () => {}; });

let failed = 0;
const check = (name, ok, d = "") => { console.log(`${ok ? "✓" : "✗"} ${name}${d ? ` (${d})` : ""}`); if (!ok) failed++; };
const snap = () => page.evaluate(() => document.querySelector("dialog.editor canvas.ed-canvas").toDataURL());
const raf2 = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
await call("setView", GRAB[0], GRAB[1], 6);
await page.waitForTimeout(800);
const r = await page.evaluate(() => { const b = document.querySelector("dialog.editor canvas.ed-canvas").getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; });
const before = await snap();
const ev = (t, x, y, b) => page.evaluate(([t, x, y, b]) => document.querySelector("dialog.editor canvas.ed-canvas").dispatchEvent(new PointerEvent(t, { clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", bubbles: true, isPrimary: true, button: 1, buttons: b })), [t, x, y, b]);
await ev("pointerdown", r[0], r[1], 4);
for (let i = 1; i <= 8; i++) { await ev("pointermove", r[0] + i * 15, r[1] + i * 5, 4); await raf2(); }
const mid = await snap();
check("the map slides while it is dragged", mid !== before);
const midView = await page.evaluate(() => document.querySelector("dialog.editor").wgeEditor.toScreen(0, 0).join());
await page.waitForTimeout(500);
const settled = await snap();
check("the view does not change when it settles", await page.evaluate(() => document.querySelector("dialog.editor").wgeEditor.toScreen(0, 0).join()) === midView);
await ev("pointerup", r[0] + 120, r[1] + 40, 0);
await raf2();
await page.waitForTimeout(300);
const after = await snap();
// A fresh full repaint at the same view.
const v = await page.evaluate(() => document.querySelector("dialog.editor").wgeEditor.view());
await call("setView", v.cx, v.cy, v.k);
await page.waitForTimeout(300);
check("release leaves exactly a full repaint", after === (await snap()));
check("the settle repaint (pointer resting) is already the final picture", after === settled);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
