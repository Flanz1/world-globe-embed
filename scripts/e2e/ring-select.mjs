/**
 * Browser checks for selecting a whole ring by clicking its line in the region editor, in headless Chromium.
 *
 *   npm run e2e:ring-select
 *
 * A region with one part (outer ring plus a hole): clicking a line selects every vertex of that ring only;
 * Shift adds; dragging from a line still moves the part; dragging a midpoint still inserts a vertex;
 * Delete on a whole hole removes just the hole; Delete on a whole outline asks first.
 *
 * Exits non-zero if any check fails.
 */
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { SLOT, MAP, makeFixture } from "./fixture.mjs";
import { MockGitHub } from "./mock-github.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const OUT = path.resolve(".e2e/ring-select");
const BRANCH = "test/ring-select";
const SITE = "http://localhost:4173";
await mkdir(OUT, { recursive: true });

const results = [];
function check(group, name, ok, detail = "") {
  results.push({ group, name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? "✓" : "✗"} [${group}] ${name}${detail ? ` (${detail})` : ""}`);
}
async function step(group, name, fn) {
  try {
    await fn();
  } catch (e) {
    check(group, name, false, `threw: ${(e && e.message) || e}`.slice(0, 400));
  }
}

const box = (w, s, e, n) => [[w, s], [e, s], [e, n], [w, n], [w, s]];
const OUTER = [100, -56, 115, -36];
const HOLE = [104, -52, 110, -44];
const region = {
  $schema: "../../schema/region.schema.json",
  type: "Feature",
  id: "ring-test",
  properties: { slot: SLOT.slug, map: MAP.id, color: "#00e5ff", fillOpacity: 0.25, label: true, updated: "2026-11-11T12:00:00Z" },
  geometry: { type: "Polygon", coordinates: [box(...OUTER), box(...HOLE).reverse()] },
};

const dir = await makeFixture({ quiet: true });
writeFileSync(path.join(dir, "content/regions/ring-test.json"), JSON.stringify(region, null, 2) + "\n");
execFileSync("npm", ["run", "build"], { cwd: dir, env: { ...process.env, VITE_CONTENT_BRANCH: BRANCH }, stdio: "pipe" });
console.log(`Fixture: ${dir}`);

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".json": "application/json", ".txt": "text/plain" };
const DIST = path.join(dir, "dist");
const server = createServer(async (req, res) => {
  let p = path.join(DIST, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (existsSync(p) && statSync(p).isDirectory()) p = path.join(p, "index.html");
  if (!p.startsWith(DIST) || !existsSync(p)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] ?? "application/octet-stream", "Cache-Control": "no-store" });
  res.end(await readFile(p));
}).listen(4173, "localhost");

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const A = "ring-select";
const mock = new MockGitHub({ root: dir, branches: ["main", BRANCH] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await ctx.route("https://api.github.com/**", (r) => mock.handle(r));
const page = await ctx.newPage();
const errors = [];
const dialogs = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && !/^Failed to load resource/.test(m.text()) && errors.push(m.text()));
page.on("dialog", (d) => (dialogs.push(d.message()), d.dismiss()));

const ed = {
  state: () => page.evaluate(() => document.querySelector("dialog.editor").wgeEditor.state()),
  sel: () => page.evaluate(() => document.querySelector("dialog.editor").wgeEditor.selectedPart()),
  setView: (cx, cy, k) => page.evaluate(([cx, cy, k]) => document.querySelector("dialog.editor").wgeEditor.setView(cx, cy, k), [cx, cy, k]),
  xy: (lon, lat) =>
    page.evaluate(([lon, lat]) => {
      const d = document.querySelector("dialog.editor");
      const r = d.querySelector("canvas.ed-canvas").getBoundingClientRect();
      const [x, y] = d.wgeEditor.toScreen(lon, lat);
      return [r.left + x, r.top + y];
    }, [lon, lat]),
  msg: () => page.textContent("dialog.editor .ed-msg"),
  verts: () => page.evaluate(() => document.querySelector("dialog.editor").wgeEditor.selectedVertices()),
};
async function mdrag(x, y, dx, dy, mods = []) {
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x + (dx * i) / 8, y + (dy * i) / 8);
  await page.mouse.up();
  for (const m of mods) await page.keyboard.up(m);
  await page.waitForTimeout(100);
}
const K = 20;
const rings = (v) => [...new Set(v.map((q) => `${q.p}:${q.r}`))].join(",");

await step(A, "open the editor", async () => {
  await page.goto(`${SITE}/admin/#regions`);
  await page.fill("#token", "ghp_e2etoken");
  await page.click('#signin-form button[type="submit"]');
  await page.waitForSelector('#regions .rcard[data-region="ring-test"]', { timeout: 15000 });
  await page.locator('[data-region="ring-test"] [data-action="edit"]').click();
  await page.waitForSelector("dialog.editor[open]");
  await page.waitForTimeout(600);
  await ed.setView(107, -46, K);
  await page.waitForTimeout(200);
  const s = await ed.state();
  check(A, "one part with a hole", s.parts.length === 1 && s.parts[0].length === 2, JSON.stringify(s.parts.map((p) => p.length)));
});

await step(A, "click a line", async () => {
  // Hole's bottom-side line near, but not at, its midpoint (107, -52): offset 1.5 degrees.
  let [x, y] = await ed.xy(105.5, -52);
  await page.mouse.click(x, y);
  let v = await ed.verts();
  check(A, "clicking a hole's line selects all 4 hole vertices and nothing else", v.length === 4 && rings(v) === "0:1", `${v.length} ${rings(v)}`);
  [x, y] = await ed.xy(95, -46); // outside the part
  await page.mouse.click(x, y);
  v = await ed.verts();
  check(A, "clicking empty space clears it", v.length === 0, String(v.length));
  [x, y] = await ed.xy(101.5, -56);
  await page.mouse.click(x, y);
  v = await ed.verts();
  check(A, "clicking the outer line selects the 4 outer vertices only", v.length === 4 && rings(v) === "0:0", `${v.length} ${rings(v)}`);
  [x, y] = await ed.xy(105.5, -52);
  await page.keyboard.down("Shift");
  await page.mouse.click(x, y);
  await page.keyboard.up("Shift");
  v = await ed.verts();
  check(A, "Shift+click another line adds that ring", v.length === 8, String(v.length));
});

await step(A, "drags still work", async () => {
  const before = await ed.state();
  let [x, y] = await ed.xy(105.5, -52.15); // 3 px outside the hole, on solid ground, still within reach of its line
  await mdrag(x, y, K, 0);
  let s = await ed.state();
  check(A, "dragging from a line moves the part, it doesn't select a ring", s.parts[0][0][0][0] === before.parts[0][0][0][0] + 1, JSON.stringify(s.parts[0][0][0]));
  await page.keyboard.press("Control+z");
  [x, y] = await ed.xy(107, -52); // midpoint of the hole's bottom line
  const n = before.parts[0][1].length;
  await mdrag(x, y, 0, K);
  s = await ed.state();
  check(A, "dragging a midpoint still inserts a vertex", s.parts[0][1].length === n + 1, `${n} → ${s.parts[0][1].length}`);
  await page.keyboard.press("Control+z");
  s = await ed.state();
  check(A, "undo restores it", s.parts[0][1].length === n);
});

await step(A, "delete", async () => {
  let [x, y] = await ed.xy(105.5, -52);
  await page.mouse.click(x, y);
  await page.keyboard.press("Delete");
  await page.waitForTimeout(150);
  let s = await ed.state();
  check(A, "Delete on a whole hole removes the hole and keeps the part", s.parts.length === 1 && s.parts[0].length === 1 && !/error/.test(await page.getAttribute("dialog.editor .ed-msg", "class") ?? ""), JSON.stringify(s.parts.map((p) => p.length)));
  await page.keyboard.press("Control+z");
  [x, y] = await ed.xy(101.5, -56);
  await page.mouse.click(x, y);
  await page.keyboard.press("Delete");
  await page.waitForSelector("dialog.small-dlg.danger[open]");
  s = await ed.state();
  check(A, "Delete on a whole outline asks first and changes nothing yet", s.parts.length === 1);
  await page.click('dialog.small-dlg.danger[open] button:has-text("Keep it")');
  await page.keyboard.press("Delete");
  await page.waitForSelector("dialog.small-dlg.danger[open]");
  await page.click('dialog.small-dlg.danger[open] button:has-text("Delete part")');
  // The confirm resolves asynchronously: wait for the part to go rather than a fixed 150 ms, which flaked on a busy machine.
  await page.waitForFunction(() => document.querySelector("dialog.editor").wgeEditor.state().parts.length === 0, null, { timeout: 5000 }).catch(() => {});
  s = await ed.state();
  check(A, "confirming deletes the whole part", s.parts.length === 0, String(s.parts.length));
});

check(A, "no errors or dialogs in the admin page", errors.length === 0 && dialogs.length === 0, [...errors, ...dialogs].join(" | ") || "none");
await ctx.close();
await browser.close();
server.close();
await writeFile(path.join(OUT, "report.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed:\n${failed.map((f) => `  [${f.group}] ${f.name} ${f.detail}`).join("\n")}` : ""}`);
process.exit(failed.length ? 1 : 0);
