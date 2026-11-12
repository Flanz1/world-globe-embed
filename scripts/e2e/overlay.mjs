/**
 * Browser checks for the editor's "Other regions" tool (top right of the map), in headless Chromium.
 *
 *   npm run e2e:overlay
 *
 * Other regions are hidden until switched on; the panel lists them with search, category and creator
 * filters and sorting; Show listed / Hide listed / Hide all; the choice is remembered in the browser;
 * hidden regions are neither drawn nor snap targets.
 *
 * Exits non-zero if any check fails. Screenshots go to .e2e/overlay/.
 */
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { SLOT, MAP, makeFixture } from "./fixture.mjs";
import { MockGitHub } from "./mock-github.mjs";
import { useAdminApi } from "./admin-api.mjs";

import { port } from "./ports.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const OUT = path.resolve(".e2e/overlay");
const BRANCH = "test/overlay";
const SITE = `http://localhost:${port(4173)}`;
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
const feature = (id, geometry, props) => ({
  $schema: "../../schema/region.schema.json",
  type: "Feature",
  id,
  properties: { slot: SLOT.slug, map: MAP.id, color: "#00e5ff", fillOpacity: 0.25, label: true, updated: "2026-11-12T12:00:00Z", ...props },
  geometry,
});
const regions = [
  feature("ov-edit", { type: "Polygon", coordinates: [box(100, -56, 110, -46)] }, { partLocked: [false] }),
  feature("ov-alpha", { type: "Polygon", coordinates: [box(111, -56, 121, -46)] }, { color: "#ffffff", name: "Alpha", partLocked: [false], createdBy: { id: 11, login: "zed" }, updated: "2026-11-10T00:00:00Z" }),
  feature("ov-beta", { type: "Polygon", coordinates: [box(122, -56, 132, -46)] }, { color: "#ffffff", name: "Beta", partLocked: [false], createdBy: { id: 12, login: "amy" }, updated: "2026-11-12T00:00:00Z" }),
  feature("ov-gamma", { type: "Polygon", coordinates: [box(133, -56, 143, -46)] }, { color: "#ffffff", name: "Gamma", partLocked: [false], createdBy: { id: 12, login: "amy" }, updated: "2026-11-11T00:00:00Z" }),
];
const dir = await makeFixture({ quiet: true });
// Only this test's regions: the fixture's own ones would clutter the list.
for (const f of readdirSync(path.join(dir, "content/regions"))) rmSync(path.join(dir, "content/regions", f));
for (const r of regions) writeFileSync(path.join(dir, "content/regions", `${r.id}.json`), JSON.stringify(r, null, 2) + "\n");
writeFileSync(path.join(dir, "content/categories.json"), JSON.stringify({ categories: [{ id: "north", name: "Northern realms", regions: ["ov-alpha", "ov-beta"], createdBy: { id: 12, login: "amy" } }] }, null, 2) + "\n");
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
}).listen(port(4173), "localhost");

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });

/* ═════════════ Editor ═════════════ */
const A = "editor";
const mock = new MockGitHub({ root: dir, branches: ["main", BRANCH] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await ctx.route("https://api.github.com/**", (r) => mock.handle(r));
await useAdminApi(ctx, mock, { branch: BRANCH });
const page = await ctx.newPage();
const errors = [];
const dialogs = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && !/^Failed to load resource/.test(m.text()) && errors.push(m.text()));
page.on("dialog", (d) => (dialogs.push(d.message()), d.dismiss()));

const call = (fn, ...args) => page.evaluate(([fn, args]) => document.querySelector("dialog.editor").wgeEditor[fn](...args), [fn, args]);
const ed = {
  state: () => call("state"),
  xy: (lon, lat) =>
    page.evaluate(([lon, lat]) => {
      const d = document.querySelector("dialog.editor");
      const r = d.querySelector("canvas.ed-canvas").getBoundingClientRect();
      const [x, y] = d.wgeEditor.toScreen(lon, lat);
      return [r.left + x, r.top + y];
    }, [lon, lat]),
};
async function dragPath(pts, mods = []) {
  const [x0, y0] = await ed.xy(...pts[0]);
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (const p of pts.slice(1)) {
    const [x, y] = await ed.xy(...p);
    await page.mouse.move(x, y, { steps: 3 });
  }
  await page.mouse.up();
  for (const m of mods) await page.keyboard.up(m);
  await page.waitForTimeout(120);
}


const LS = () => page.evaluate(() => localStorage.getItem("wge.editor.overlays"));
const rows = () => page.$$eval(".ed-ov-row", (l) => l.map((r) => r.dataset.region));
const panelOpen = () => page.$eval(".ed-ov-panel", (p) => !p.hidden);
const btnText = () => page.$eval(".ed-ov-btn", (b) => b.textContent);
/** Count of light-grey outline pixels on the canvas along the bottom edge of a neighbour. */
async function outlinePixels(lon) {
  await page.waitForTimeout(150);
  const [x, y] = await ed.xy(lon, -56);
  return page.evaluate(([x, y]) => {
    const c = document.querySelector("dialog.editor canvas.ed-canvas");
    const r = c.getBoundingClientRect();
    const dpr = c.width / r.width;
    const d = c.getContext("2d").getImageData(Math.round((x - r.left - 6) * dpr), Math.round((y - r.top - 2) * dpr), Math.round(12 * dpr), Math.round(5 * dpr)).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 70 && d[i + 1] > 70 && d[i + 2] > 70) n++;
    return n;
  }, [x, y]);
}
const open = async () => {
  await page.goto("about:blank");
  await page.goto(`${SITE}/admin/#regions`);
  await page.waitForSelector('#regions .rcard[data-region="ov-edit"]', { timeout: 15000 });
  await page.locator('[data-region="ov-edit"] [data-action="edit"]').click();
  await page.waitForSelector("dialog.editor[open]");
  await page.waitForTimeout(600);
  await call("setView", 120, -51, 6);
  await page.waitForTimeout(200);
};

await step(A, "everything is hidden by default", async () => {
  await open();
  check(A, "the Other regions button is there, panel closed", (await btnText()) === "Other regions" && !(await panelOpen()));
  check(A, "no outline is drawn for another region", (await outlinePixels(116)) === 0, await outlinePixels(116));
  await page.screenshot({ path: path.join(OUT, "editor-hidden.png") });
});

await step(A, "the panel lists, filters and sorts", async () => {
  await page.click(".ed-ov-btn");
  check(A, "the button opens the panel (top right)", await panelOpen());
  const box = await page.$eval(".ed-ov-btn", (b) => b.getBoundingClientRect().toJSON());
  const wrap = await page.$eval(".ed-canvas-wrap", (b) => b.getBoundingClientRect().toJSON());
  check(A, "…in the top right corner of the map", wrap.right - box.right < 30 && box.top - wrap.top < 30, JSON.stringify([box.right, wrap.right, box.top, wrap.top]));
  check(A, "it lists the other regions by ID", JSON.stringify(await rows()) === JSON.stringify(["ov-alpha", "ov-beta", "ov-gamma"]), JSON.stringify(await rows()));
  check(A, "every one is off", (await page.$$eval(".ed-ov-row input:checked", (l) => l.length)) === 0);
  await page.fill('.ed-ov-panel input[type="search"]', "gam");
  check(A, "search matches the ID", JSON.stringify(await rows()) === '["ov-gamma"]', JSON.stringify(await rows()));
  await page.fill('.ed-ov-panel input[type="search"]', "zed");
  check(A, "search matches the creator", JSON.stringify(await rows()) === '["ov-alpha"]', JSON.stringify(await rows()));
  await page.fill('.ed-ov-panel input[type="search"]', "");
  await page.selectOption('select[name="ov-category"]', "north");
  check(A, "category filter", JSON.stringify(await rows()) === '["ov-alpha","ov-beta"]', JSON.stringify(await rows()));
  await page.selectOption('select[name="ov-category"]', "__none");
  check(A, "Uncategorized filter", JSON.stringify(await rows()) === '["ov-gamma"]', JSON.stringify(await rows()));
  await page.selectOption('select[name="ov-category"]', "");
  await page.selectOption('select[name="ov-creator"]', "12");
  check(A, "creator filter", JSON.stringify(await rows()) === '["ov-beta","ov-gamma"]', JSON.stringify(await rows()));
  await page.selectOption('select[name="ov-sort"]', "updated");
  check(A, "sort by recently updated", JSON.stringify(await rows()) === '["ov-beta","ov-gamma"]', JSON.stringify(await rows()));
  await page.selectOption('select[name="ov-creator"]', "");
  await page.selectOption('select[name="ov-sort"]', "creator");
  check(A, "sort by creator", JSON.stringify(await rows()) === '["ov-beta","ov-gamma","ov-alpha"]', JSON.stringify(await rows()));
  await page.selectOption('select[name="ov-sort"]', "id");
});

await step(A, "turning regions on and off", async () => {
  await page.click('.ed-ov-row[data-region="ov-alpha"] input');
  check(A, "ticking one draws it", (await outlinePixels(116)) > 0 && (await outlinePixels(127)) === 0, `${await outlinePixels(116)} / ${await outlinePixels(127)}`);
  check(A, "the button counts what is on", (await btnText()) === "Other regions (1)", await btnText());
  check(A, "the choice is remembered in the browser", (await LS()) === '["ov-alpha"]', await LS());
  await page.screenshot({ path: path.join(OUT, "editor-one.png") });
  // Snapping follows what is visible: a vertex dragged next to alpha snaps to it...
  await dragPath([[110, -46], [110.6, -46.1], [111.18, -46.12]]);
  let s = await ed.state();
  check(A, "a visible region is a snap target", s.parts[0][0].some((p) => p[0] === 111 && p[1] === -46), JSON.stringify(s.parts[0][0]));
  await page.keyboard.press("Control+z");
  await page.selectOption('select[name="ov-category"]', "north");
  await page.click('[data-act="overlays-show"]');
  check(A, "Show listed turns on what the filters list", (await outlinePixels(127)) > 0 && (await outlinePixels(138)) === 0 && (await btnText()) === "Other regions (2)", await btnText());
  await page.click('[data-act="overlays-hide"]');
  check(A, "Hide listed turns them off again", (await outlinePixels(116)) === 0 && (await btnText()) === "Other regions", await btnText());
  await page.selectOption('select[name="ov-category"]', "");
  await page.click('[data-act="overlays-show"]');
  check(A, "Show listed with no filter shows all", (await btnText()) === "Other regions (3)" && (await outlinePixels(138)) > 0);
  await page.screenshot({ path: path.join(OUT, "editor-all.png") });
  await page.click('[data-act="overlays-hide-all"]');
  check(A, "Hide all hides everything", (await btnText()) === "Other regions" && (await outlinePixels(116)) === 0 && (await outlinePixels(138)) === 0);
  // ...and a hidden one isn't.
  await dragPath([[110, -46], [110.6, -46.1], [111.18, -46.12]]);
  s = await ed.state();
  check(A, "a hidden region is not a snap target", !s.parts[0][0].some((p) => p[0] === 111 && p[1] === -46), JSON.stringify(s.parts[0][0]));
  await page.keyboard.press("Control+z");
});

await step(A, "remembered next time", async () => {
  await page.click('.ed-ov-row[data-region="ov-beta"] input');
  await open();
  check(A, "reopening the editor shows the same choice", (await btnText()) === "Other regions (1)" && (await outlinePixels(127)) > 0 && (await outlinePixels(116)) === 0, await btnText());
  await page.keyboard.press("Escape");
  check(A, "no errors or dialogs in the admin page", errors.length === 0 && dialogs.length === 0, JSON.stringify([...errors, ...dialogs]));
});

await browser.close();
server.close();
await writeFile(path.join(OUT, "report.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed:\n${failed.map((f) => `  [${f.group}] ${f.name} ${f.detail}`).join("\n")}` : ""}`);
process.exit(failed.length ? 1 : 0);
