/**
 * Editor speed check: milliseconds per frame while dragging a vertex of a dense outline, and per keystroke
 * in the description field. Prints the numbers; fails if a budget is exceeded.
 *
 *   npm run perf:editor            (VERTS=30000 by default; BUDGET_DRAG / BUDGET_TYPE in ms)
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

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const VERTS = Number(process.env.VERTS ?? 30000);
const BUDGET_DRAG = Number(process.env.BUDGET_DRAG ?? 0);
const BUDGET_TYPE = Number(process.env.BUDGET_TYPE ?? 0);
const PACE = process.env.PACE ?? "timer";
const BRANCH = "test/perf";

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
await page.waitForSelector(`#regions .rcard[data-region="${RID}"]`, { timeout: 20000 });
await page.locator(`[data-region="${RID}"] [data-action="edit"]`).click({ timeout: 120000 });
await page.waitForSelector("dialog.editor[open]", { state: "attached", timeout: 240000 });
await page.waitForFunction(() => !!document.querySelector("dialog.editor")?.wgeEditor, null, { timeout: 240000 });
console.log(`editor ready after ${((Date.now() - tOpen) / 1000).toFixed(1)} s`);
await page.waitForTimeout(2500);
const call = (fn, ...args) => page.evaluate(([fn, args]) => document.querySelector("dialog.editor").wgeEditor[fn](...args), [fn, args]);

if (process.env.NOPREVIEW) await page.evaluate(() => { const f = document.querySelector('dialog.editor iframe'); f.contentWindow.postMessage = () => {}; });
const cdp0 = await ctx.newCDPSession(page);
await cdp0.send("Profiler.enable");
const busy = async (fn) => {
  await cdp0.send("Profiler.start");
  const r = await fn();
  const { profile } = await cdp0.send("Profiler.stop");
  let b = 0;
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  profile.samples.forEach((id, i) => { if (byId.get(id).callFrame.functionName !== "(idle)") b += profile.timeDeltas[i] ?? 0; });
  if (process.env.PROFILE) {
    const self = new Map();
    profile.samples.forEach((id, i) => { const n = byId.get(id); const k = `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber}:${n.callFrame.columnNumber}`; self.set(k, (self.get(k) ?? 0) + (profile.timeDeltas[i] ?? 0)); });
    console.log([...self.entries()].filter(([k]) => !k.startsWith("(idle)")).sort((a, b) => b[1] - a[1]).slice(0, 16).map(([k, v]) => `  ${(v / 1000).toFixed(0)} ms  ${k}`).join("\n"));
  }
  return [r, b / 1000];
};
// Typing: dispatch input events like keystrokes and time each one until the next frame has painted.
const typeInto = (selector) =>
  busy(() =>
    page.evaluate(async (sel) => {
      const ta = document.querySelector(sel);
      if (!ta) return null;
      ta.focus();
      const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
      const times = [];
      let v = ta.value;
      for (let i = 0; i < 40; i++) {
        v += String.fromCharCode(97 + (i % 26));
        const t0 = performance.now();
        ta.value = v;
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        await raf();
        await raf();
        times.push(performance.now() - t0);
      }
      return times;
    }, selector),
  );
const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
let typing = [0];
for (const [name, sel] of [
  ["description", 'dialog.editor textarea[name="description"]'],
  ["legend title", 'dialog.editor input[name="legend-title"]'],
  ["part label", 'dialog.editor input[data-part-label="0"]'],
]) {
  const [times, b] = await typeInto(sel);
  if (!times) continue;
  console.log(`typing ${name}: ${(b / 40).toFixed(1)} ms/keystroke of main-thread work (incl. the paint that follows)`);
  if (name === "description") {
    typing = times;
  }
}
// Dragging: grab a vertex, then move in small steps, one frame each.
await call("setView", GRAB[0], GRAB[1], 20);
await page.waitForTimeout(400);
const [gx, gy] = await page.evaluate(([lon, lat]) => {
  const d = document.querySelector("dialog.editor");
  const r = d.querySelector("canvas.ed-canvas").getBoundingClientRect();
  const [x, y] = d.wgeEditor.toScreen(lon, lat);
  return [r.left + x, r.top + y];
}, GRAB);
await page.mouse.move(gx, gy);
await page.mouse.down();
await page.mouse.move(gx + 6, gy + 6, { steps: 2 });
const cdp = null;
const [drag, dragBusy] = await busy(() => page.evaluate(
  async ([gx, gy, PACE]) => {
    const cv = document.querySelector("dialog.editor canvas.ed-canvas");
    const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
    const times = [];
    for (let i = 0; i < 80; i++) {
      const t0 = performance.now();
      const x = gx + 8 + i * 2;
      const y = gy + 8 + i;
      cv.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", bubbles: true, isPrimary: true, buttons: 1 }));
      if (PACE === "raf") { await raf(); await raf(); } else await new Promise((r) => setTimeout(r, 16));
      times.push(performance.now() - t0);
    }
    return times;
  },
  [gx, gy, PACE],
));
console.log(`drag busy: ${(dragBusy / 80).toFixed(1)} ms/move of main-thread work`);
if (cdp) {
  const { profile } = await cdp.send("Profiler.stop");
  const dt = profile.timeDeltas; const self = new Map(); const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  profile.samples.forEach((id, i) => { const n = byId.get(id); const k = `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber}`; self.set(k, (self.get(k) ?? 0) + (dt[i] ?? 0)); });
  console.log([...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${(v / 1000).toFixed(0)} ms  ${k}`).join("\n"));
}
await page.mouse.up();
console.log(`drag (${VERTS} vertices${parts.length > 1 ? ", 2 parts" : ""}): ${avg(drag).toFixed(1)} ms/move (to second frame), max ${Math.max(...drag).toFixed(1)}`);
await browser.close();
server.close();
let fail = false;
if (BUDGET_TYPE && avg(typing) > BUDGET_TYPE) {
  console.log(`✗ typing over budget ${BUDGET_TYPE} ms`);
  fail = true;
}
if (BUDGET_DRAG && avg(drag) > BUDGET_DRAG) {
  console.log(`✗ drag over budget ${BUDGET_DRAG} ms`);
  fail = true;
}
process.exit(fail ? 1 : 0);
