/**
 * Browser checks for coast snapping in the region editor, in headless Chromium.
 *
 *   npm run e2e:coast
 *
 * A test map with a wavy island (plus a river into it, a lake in it and sea lettering beside it) is
 * processed like an upload, which traces its coast. In the editor: the Coast button shows and is on;
 * a vertex dragged near the shore lands on the coastline; Ctrl+drag doesn't snap; the polygon tool
 * follows the coast between two clicks on it; a neighbouring region's vertex still wins over the coast; the
 * river and lake aren't coast; O turns coast snapping off.
 *
 * Exits non-zero if any check fails. Screenshots go to .e2e/coast/.
 */
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { makeFixture } from "./fixture.mjs";
import { MockGitHub } from "./mock-github.mjs";
import { useAdminApi } from "./admin-api.mjs";

import { port } from "./ports.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const sharp = require("sharp");

const OUT = path.resolve(".e2e/coast");
const BRANCH = "test/coast";
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

/* ── The test map: 3600 × 1800, 10 px per degree ── */
const MAPW = 3600;
const MAPH = 1800;
const SEA = "#1e3236";
const px = (lon, lat) => [((lon + 180) / 360) * MAPW, ((90 - lat) / 180) * MAPH];
/** The island's shore: radius in degrees round (0, 0) at angle t. */
const shore = (t) => 20 + 2 * Math.sin(6 * t);
/** How far a map position is from the shore, in degrees. */
const offShore = ([lon, lat]) => Math.abs(Math.hypot(lon, lat) - shore(Math.atan2(lat, lon)));
const island = Array.from({ length: 720 }, (_, i) => {
  const t = (i / 720) * 2 * Math.PI;
  return px(shore(t) * Math.cos(t), shore(t) * Math.sin(t)).map((v) => v.toFixed(1)).join(",");
}).join(" ");
const [lakeX, lakeY] = px(-8, 4);
const [rx0, ry0] = px(23, 0);
const [rx1, ry1] = px(10, 0);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${MAPW}" height="${MAPH}">
<rect width="100%" height="100%" fill="${SEA}"/>
<polygon points="${island}" fill="#6a8f45"/>
<path d="M${rx0} ${ry0} L${rx1} ${ry1}" stroke="${SEA}" stroke-width="2"/>
<circle cx="${lakeX}" cy="${lakeY}" r="25" fill="${SEA}"/>
<path d="M${px(30, 3)[0]} ${px(30, 3)[1]} q 20 -50 40 0 t 40 0 t 40 0 M${px(45, 5)[0]} ${px(45, 5)[1]} l 0 50" stroke="#ffffff" stroke-width="5" fill="none"/>
</svg>`;

const dir = await makeFixture({ quiet: true });
await sharp(Buffer.from(svg)).png().toFile(path.join(dir, "content/incoming", "coastal.png"));
execFileSync("npx", ["tsx", "scripts/process-maps.ts"], { cwd: dir, env: { ...process.env, GITHUB_ACTOR: "e2e" }, stdio: "pipe" });
const meta = JSON.parse(readFileSync(path.join(dir, "content/maps/coastal.json"), "utf8"));
const slotsFile = path.join(dir, "content/slots.json");
const slots = JSON.parse(readFileSync(slotsFile, "utf8"));
slots.slots.coastal = { map: "coastal", title: "Coast test" };
writeFileSync(slotsFile, JSON.stringify(slots, null, 2) + "\n");
const box = (w, s, e, n) => [[w, s], [e, s], [e, n], [w, n], [w, s]];
const region = {
  $schema: "../../schema/region.schema.json",
  type: "Feature",
  id: "coast-test",
  properties: { slot: "coastal", map: "coastal", color: "#00e5ff", fillOpacity: 0.25, label: true, updated: "2026-11-12T12:00:00Z" },
  geometry: { type: "Polygon", coordinates: [box(-5, -5, 5, 5)] },
};
writeFileSync(path.join(dir, "content/regions/coast-test.json"), JSON.stringify(region, null, 2) + "\n");
// A neighbour out at sea with a corner just off the shore at 45°.
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const N = [r4(Math.cos(Math.PI / 4) * (shore(Math.PI / 4) + 0.4)), r4(Math.sin(Math.PI / 4) * (shore(Math.PI / 4) + 0.4))];
const neighbour = {
  ...region,
  id: "coast-neighbour",
  properties: { ...region.properties, name: "Sea Isle", color: "#ffffff" },
  geometry: { type: "Polygon", coordinates: [[N, [N[0] + 3, N[1]], [N[0] + 3, N[1] + 3], N]] },
};
writeFileSync(path.join(dir, "content/regions/coast-neighbour.json"), JSON.stringify(neighbour, null, 2) + "\n");
execFileSync("npm", ["run", "build"], { cwd: dir, env: { ...process.env, VITE_CONTENT_BRANCH: BRANCH }, stdio: "pipe" });
console.log(`Fixture: ${dir}`);

const P = "process";
check(P, "processing the upload writes a coast file", !!meta.coast && existsSync(path.join(dir, "public", meta.coast)), meta.coast);

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".json": "application/json", ".bin": "application/octet-stream" };
const DIST = path.join(dir, "dist");
const server = createServer(async (req, res) => {
  let p = path.join(DIST, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (existsSync(p) && statSync(p).isDirectory()) p = path.join(p, "index.html");
  if (!p.startsWith(DIST) || !existsSync(p)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] ?? "application/octet-stream", "Cache-Control": "no-store" });
  res.end(await readFile(p));
}).listen(port(4173), "localhost");

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const A = "editor";
const mock = new MockGitHub({ root: dir, branches: ["main", BRANCH] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
// Other regions are hidden in the editor until switched on; this suite snaps to this neighbour.
await ctx.addInitScript(() => localStorage.setItem("wge.editor.overlays", JSON.stringify(["coast-neighbour"])));
await ctx.route("https://api.github.com/**", (r) => mock.handle(r));
await useAdminApi(ctx, mock, { branch: BRANCH });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && !/^Failed to load resource/.test(m.text()) && errors.push(m.text()));

const call = (fn, ...args) => page.evaluate(([fn, args]) => document.querySelector("dialog.editor").wgeEditor[fn](...args), [fn, args]);
const xy = (lon, lat) =>
  page.evaluate(([lon, lat]) => {
    const d = document.querySelector("dialog.editor");
    const r = d.querySelector("canvas.ed-canvas").getBoundingClientRect();
    const [x, y] = d.wgeEditor.toScreen(lon, lat);
    return [r.left + x, r.top + y];
  }, [lon, lat]);
async function click(lon, lat) {
  const [x, y] = await xy(lon, lat);
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
  await page.waitForTimeout(60);
}
async function dragPath(pts, mods = []) {
  const [x0, y0] = await xy(...pts[0]);
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (const p of pts.slice(1)) {
    const [x, y] = await xy(...p);
    await page.mouse.move(x, y, { steps: 3 });
  }
  await page.mouse.up();
  for (const m of mods) await page.keyboard.up(m);
  await page.waitForTimeout(120);
}
const undo = async () => (await page.keyboard.press("Control+z"), await page.waitForTimeout(80));
const K = 12; // px per degree: SNAP_PX (8) reaches about 0.67°
/** Centres the view between two map positions, so both are on screen. */
const look = async (a, b) => (await call("setView", (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, K), await page.waitForTimeout(120));
// A point on the shore at angle t, and one `d` degrees off it (outwards).
const onShore = (t, d = 0) => [(shore(t) + d) * Math.cos(t), (shore(t) + d) * Math.sin(t)];

await step(A, "open the editor", async () => {
  await page.goto(`${SITE}/admin/#regions`);
  await page.waitForSelector('#regions .rcard[data-region="coast-test"]', { timeout: 15000 });
  await page.locator('[data-region="coast-test"] [data-action="edit"]').click();
  await page.waitForSelector("dialog.editor[open]");
  await page.waitForFunction(() => document.querySelector("dialog.editor").wgeEditor.coastLines() > 0, null, { timeout: 10000 });
  const btn = page.locator('dialog.editor button[data-act="coast"]');
  check(A, "the Coast button shows once the coast is loaded, pressed", (await btn.isVisible()) && (await btn.getAttribute("aria-pressed")) === "true");
  // Only the island's shore: the river, the lake and the lettering in the sea aren't coast.
  check(A, "one coast line: the island's (not the river, lake or sea lettering)", (await call("coastLines")) === 1, `${await call("coastLines")} lines`);
});

await step(A, "a dragged vertex snaps onto the coast", async () => {
  // Corner (-5, 5) to just off the north shore (0.15° out to sea).
  const want = onShore(1.9, 0.15);
  await look([-5, 5], want);
  await page.screenshot({ path: path.join(OUT, "editor-coast.png") });
  await dragPath([[-5, 5], [-6, 10], want]);
  let s = await call("state");
  const v = s.parts[0][0].find((p) => p[1] > 10);
  check(A, "it lands on the coastline", v && offShore(v) < 0.12 && Math.hypot(v[0] - want[0], v[1] - want[1]) > 0.03, `${JSON.stringify(v)} is ${v && offShore(v).toFixed(3)}° off the shore`);
  await page.screenshot({ path: path.join(OUT, "editor-snapped.png") });
  await undo();
  await dragPath([[-5, 5], [-6, 10], want], ["Control"]);
  s = await call("state");
  const f = s.parts[0][0].find((p) => p[1] > 10);
  check(A, "Ctrl+drag places it freely", f && Math.hypot(f[0] - want[0], f[1] - want[1]) < 0.04, JSON.stringify(f));
  await undo();
});

await step(A, "the polygon tool follows the coast between two clicks", async () => {
  const a = onShore(0.25, 0.05);
  const b = onShore(0.75, 0.05);
  await call("setView", 15, 10, 18);
  await page.waitForTimeout(150);
  await page.keyboard.press("p");
  await click(...onShore(0.25, -4));
  await click(...a);
  await click(...b);
  const d = await call("drawing");
  const traced = d ? d.slice(2) : [];
  check(A, "the shore's points between the clicks are filled in", traced.length >= 5 && traced.every((p) => offShore(p) < 0.15), `${traced.length} points; worst ${Math.max(...traced.map(offShore)).toFixed(3)}°`);
  await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(OUT, "editor-traced.png") });
  await page.keyboard.press("Escape");
  await page.keyboard.press("v");
});

await step(A, "a region's vertex in reach wins over the coast", async () => {
  // Dropped 0.15° off the shore and 0.25° from the neighbour's corner: both in reach, the corner wins.
  const want = onShore(Math.PI / 4, 0.15);
  await look([5, 5], want);
  await dragPath([[5, 5], [10, 10], want]);
  const s = await call("state");
  await page.screenshot({ path: path.join(OUT, "editor-vertex-wins.png") });
  check(A, "it lands on the neighbour's corner exactly", s.parts[0][0].some((p) => p[0] === N[0] && p[1] === N[1]), JSON.stringify(s.parts[0][0]));
  await undo();
});

await step(A, "rivers and lakes aren't coast", async () => {
  await look([5, -5], [15, 0]);
  await dragPath([[5, -5], [9, -2], [15, 0.12]]); // next to the river, well inland
  let s = await call("state");
  const r = s.parts[0][0].find((p) => p[0] > 9);
  check(A, "a vertex dropped by the river stays where it was dropped", r && Math.hypot(r[0] - 15, r[1] - 0.12) < 0.04, JSON.stringify(r));
  await undo();
  await look([-5, -5], [-5.4, 4]);
  await dragPath([[-5, -5], [-6, 0], [-8 + 2.5 + 0.1, 4]]); // at the lake's edge (r 2.5°)
  s = await call("state");
  const l = s.parts[0][0].find((p) => p[1] > 1 && p[0] < -5.2);
  check(A, "nor by the lake", l && Math.hypot(l[0] - (-5.4), l[1] - 4) < 0.04, JSON.stringify(l));
  await undo();
});

await step(A, "O turns coast snapping off", async () => {
  await page.locator("dialog.editor canvas.ed-canvas").focus();
  await page.keyboard.press("o");
  check(A, "off", (await call("coastOn")) === false && (await page.getAttribute('dialog.editor button[data-act="coast"]', "aria-pressed")) === "false");
  const want = onShore(1.9, 0.15);
  await look([-5, 5], want);
  await dragPath([[-5, 5], [-6, 10], want]);
  const s = await call("state");
  const v = s.parts[0][0].find((p) => p[1] > 10);
  check(A, "a vertex dropped by the shore stays put", v && Math.hypot(v[0] - want[0], v[1] - want[1]) < 0.04, JSON.stringify(v));
  await undo();
  await page.keyboard.press("o");
  check(A, "and back on", (await call("coastOn")) === true);
});

check(A, "no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
server.close();
await writeFile(path.join(OUT, "report.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed:\n${failed.map((f) => `  [${f.group}] ${f.name} ${f.detail}`).join("\n")}` : ""}`);
process.exit(failed.length ? 1 : 0);
