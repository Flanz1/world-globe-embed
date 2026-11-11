/**
 * Browser checks for the tile levels past 8192, in headless Chromium (system Playwright).
 *
 *   npm run e2e:tiles                       synthetic 32768 px map
 *   env TILES_MAP=path/to/map.jpg npm run e2e:tiles     your own map (at least 16384 px wide)
 *
 * Builds a throwaway copy of the repo with a map at least 16384 wide, then checks that:
 * - process-maps writes the 16384 (and 32768) tile levels;
 * - a region embed at max zoom loads 1024 → 4096 → 8192, then only the tiles under the view,
 *   16384 before 32768, and shows them (globe and flat);
 * - the default zoom loads no tiles, and a phone loads none;
 * - panning at max zoom loads the new tiles under the view and keeps within the tile budget;
 * - the admin region editor zoomed far in shows the same tiles (against the in-memory GitHub API).
 *
 * Screenshots (the region at 8192 and with tiles) and report.json go to .e2e/tiles/.
 */
import { createServer } from "node:http";
import { cpSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, existsSync, statSync, mkdirSync, readdirSync } from "node:fs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { MockGitHub } from "./mock-github.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const require = createRequire(path.join(ROOT, "package.json"));
const sharp = require("sharp");
const { chromium, devices } = require("playwright");

const OUT = path.resolve(".e2e/tiles");
const SITE = "http://localhost:4175";
await mkdir(OUT, { recursive: true });
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` (${detail})` : ""}`);
}

/* ── Fixture ── */
const dir = mkdtempSync(path.join(tmpdir(), "wge-tiles-"));
for (const f of ["package.json", "tsconfig.json", "vite.config.ts", "eslint.config.js", "admin", "content", "public", "schema", "scripts", "src"])
  cpSync(path.join(ROOT, f), path.join(dir, f), { recursive: true });
symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"), "dir");
const incoming = path.join(dir, "content/incoming/huge-map.jpg");
// Region: a 6° × 4° box at lon 20, lat 10 (image frame).
const BOX = [17, 8, 23, 12];
if (process.env.TILES_MAP) {
  cpSync(path.resolve(process.env.TILES_MAP), incoming);
} else {
  // 32768 × 16384: a blue-green base with lines and tiny labels that only the 32768 tiles can show.
  const W = 32768;
  const H = 16384;
  const px = (lon, lat) => [((lon + 180) / 360) * W, ((90 - lat) / 180) * H];
  const [x0, y0] = px(BOX[0] - 4, BOX[3] + 4);
  const [x1, y1] = px(BOX[2] + 4, BOX[1] - 4);
  const parts = [];
  for (let y = y0; y < y1; y += 6) parts.push(`<line x1="${x0 - x0}" y1="${y - y0}" x2="${x1 - x0}" y2="${y - y0}" stroke="#e8dcc8" stroke-width="1"/>`);
  for (let i = 0; i < 40; i++)
    parts.push(`<text x="20" y="${30 + i * 26}" font-size="14" font-family="sans-serif" fill="#fff">Hamlet ${i + 1} · mill · ford · old road · ruins</text>`);
  const patch = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(x1 - x0)}" height="${Math.round(y1 - y0)}"><rect width="100%" height="100%" fill="#5a8a3c"/>${parts.join("")}</svg>`);
  await sharp({ create: { width: W, height: H, channels: 3, background: { r: 29, g: 79, b: 122 } }, limitInputPixels: false })
    .composite([{ input: await sharp(patch).png().toBuffer(), left: Math.round(x0), top: Math.round(y0) }])
    .jpeg({ quality: 82 })
    .toFile(incoming);
}
const srcMeta = await sharp(incoming, { limitInputPixels: false }).metadata();
console.log(`Source ${srcMeta.width}×${srcMeta.height}, ${(statSync(incoming).size / 1048576).toFixed(1)} MB`);
const run = (cmd, args) => execFileSync(cmd, args, { cwd: dir, env: { ...process.env, GITHUB_ACTOR: "e2e" }, stdio: "pipe" });
let t0 = Date.now();
run("npx", ["tsx", "scripts/process-maps.ts"]);
const processSeconds = Math.round((Date.now() - t0) / 1000);
const meta = JSON.parse(readFileSync(path.join(dir, "content/maps/huge-map.json"), "utf8"));
const levels = Object.keys(meta.tiles ?? {});
const expectLevels = [16384, 32768].filter((w) => w <= srcMeta.width).map(String);
check("process-maps writes the tile levels the source is wide enough for", levels.join() === expectLevels.join(), `${levels.join(", ")} in ${processSeconds} s`);
const files = readdirSync(path.join(dir, "public/maps/huge-map"));
const bytes = (re) => files.filter((f) => re.test(f)).reduce((n, f) => n + statSync(path.join(dir, "public/maps/huge-map", f)).size, 0);
const sizes = {};
for (const w of Object.keys(meta.sizes)) sizes[w] = bytes(new RegExp(`-${w}\\.webp$`));
for (const w of levels) sizes[`${w} tiles`] = { count: files.filter((f) => new RegExp(`-${w}-\\d+-\\d+\\.webp$`).test(f)).length, bytes: bytes(new RegExp(`-${w}-\\d+-\\d+\\.webp$`)) };
const pad = Math.max(0, (1 - meta.aspect / 2) * 50);
const slotsFile = path.join(dir, "content/slots.json");
const slots = JSON.parse(readFileSync(slotsFile, "utf8"));
slots.slots.tiles = { map: "huge-map", title: "Tiles test", north: Math.round(pad * 10) / 10, south: Math.round(pad * 10) / 10 };
writeFileSync(slotsFile, JSON.stringify(slots, null, 2) + "\n");
const regionsDir = path.join(dir, "content/regions");
if (!existsSync(regionsDir)) mkdirSync(regionsDir, { recursive: true });
const [w0, s0, e0, n0] = process.env.TILES_BOX ? process.env.TILES_BOX.split(",").map(Number) : BOX;
writeFileSync(
  path.join(regionsDir, "close-up.json"),
  JSON.stringify({
    $schema: "../../schema/region.schema.json",
    type: "Feature",
    id: "close-up",
    properties: { name: "Close-up", slot: "tiles", map: "huge-map", color: "#00e5ff", fillOpacity: 0.05, label: false, updated: "2026-11-11T00:00:00Z" },
    geometry: { type: "Polygon", coordinates: [[[w0, s0], [e0, s0], [e0, n0], [w0, n0], [w0, s0]]] },
  }, null, 2) + "\n",
);
run("npm", ["run", "build"]);
const DIST = path.join(dir, "dist");
console.log(`Fixture: ${dir}`);

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".json": "application/json" };
const site = createServer(async (req, res) => {
  let p = path.join(DIST, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (existsSync(p) && statSync(p).isDirectory()) p = path.join(p, "index.html");
  if (!p.startsWith(DIST) || !existsSync(p)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] ?? "application/octet-stream", "Cache-Control": "no-store" });
  res.end(await readFile(p));
}).listen(4175, "localhost");
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });

const label = (u) => {
  const t = /-(\d+)-(\d+)-(\d+)\.webp$/.exec(u);
  if (t) return `${t[1]}:${t[2]},${t[3]}`;
  const m = /-(\d+)\.webp$/.exec(u);
  return m ? m[1] : null;
};
async function settle(page, requested) {
  let last = "";
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(500);
    const now = JSON.stringify([requested.length, await page.evaluate(() => document.documentElement.dataset.tiles ?? "")]);
    if (now === last && i > 3) break;
    last = now;
  }
}
async function open(query, { context = {}, shots = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, ...context });
  const page = await ctx.newPage();
  const errors = [];
  const requested = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("request", (r) => {
    const l = label(r.url());
    if (l) requested.push(l);
  });
  // Hold the tiles back until the 8192 stage is captured.
  let release = () => {};
  if (shots) {
    const held = new Promise((r) => (release = r));
    await page.route(/-\d+-\d+-\d+\.webp$/, async (route) => (await held, route.continue()));
  }
  await page.goto(`${SITE}/${query}`);
  await page.waitForFunction(() => document.documentElement.dataset.tex === "8192" || document.documentElement.dataset.state === "hires", null, { timeout: 120000 });
  const view = query.includes("flat") ? "flat" : "globe";
  if (shots) {
    await page.waitForFunction(() => document.documentElement.dataset.tex === "8192", null, { timeout: 120000 });
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(OUT, `${view}-8192.png`) });
    release();
  }
  await settle(page, requested);
  if (shots) {
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, `${view}-tiles.png`) });
  }
  const tilesShown = await page.evaluate(() => document.documentElement.dataset.tiles ?? "");
  return { ctx, page, requested, errors, tilesShown };
}
const whole = (r) => r.filter((x) => !x.includes(":"));
const tiles = (r, w) => r.filter((x) => x.startsWith(`${w}:`));
const top = levels[levels.length - 1];

for (const view of ["globe", "flat"]) {
  // zoom=99: the embed's closest zoom.
  const q = `v/tiles/?region=close-up&zoom=99${view === "flat" ? "&view=flat" : ""}`;
  const e = await open(q, { shots: true });
  check(`${view}: whole textures 1024 → 4096 → 8192 first`, whole(e.requested).join() === "1024,4096,8192", whole(e.requested).join(" → "));
  const t16 = tiles(e.requested, 16384);
  const tTop = tiles(e.requested, top);
  check(`${view}: then only the tiles under the view`, t16.length > 0 && t16.length <= 8 && tTop.length <= 16, `${levels.map((w) => `${tiles(e.requested, w).length} × ${w}`).join(", ")}`);
  if (levels.length > 1) {
    const first32 = e.requested.findIndex((x) => x.startsWith("32768:"));
    const last16 = e.requested.map((x) => x.startsWith("16384:")).lastIndexOf(true);
    check(`${view}: the 16384 tiles before the 32768 ones`, first32 > last16, e.requested.slice(3).join(" "));
  }
  check(`${view}: shows the finest level`, e.tilesShown === top, `data-tiles=${e.tilesShown}`);
  check(`${view}: no errors`, e.errors.length === 0, e.errors.join("; "));

  // Unlock and pan: new tiles load for the new area, within the budget.
  if (await e.page.locator("#btn-lock").isVisible()) await e.page.click("#btn-lock");
  const before = e.requested.length;
  // Far enough to cross a tile edge: a 32768 tile is 22.5° wide, and the flat view shows ~21° here.
  for (let n = 0; n < 3; n++) {
    await e.page.mouse.move(1100, 400);
    await e.page.mouse.down();
    for (let i = 1; i <= 10; i++) await e.page.mouse.move(1100 - i * 90, 400);
    await e.page.mouse.up();
  }
  await settle(e.page, e.requested);
  const more = e.requested.slice(before).filter((x) => x.includes(":"));
  check(`${view}: panning loads the tiles that come into view`, more.length > 0, more.join(" "));
  check(`${view}: still shows the finest level after the pan`, (await e.page.evaluate(() => document.documentElement.dataset.tiles)) === top);
  check(`${view}: no errors after panning`, e.errors.length === 0, e.errors.join("; "));
  await e.ctx.close();

  const def = await open(`v/tiles/${view === "flat" ? "?view=flat" : ""}`, { context: { deviceScaleFactor: 1 } });
  check(`${view}: default zoom loads no tiles`, def.requested.every((x) => !x.includes(":")), def.requested.join(" "));
  await def.ctx.close();

  const phone = await open(q, { context: devices["Pixel 7"] });
  check(`${view}: a phone loads no tiles and no 8192`, phone.requested.every((x) => !x.includes(":") && x !== "8192"), phone.requested.join(" "));
  await phone.ctx.close();
}

// The admin region editor: zoomed far in, it goes 2048 → 4096 → 8192, then the tiles under the view.
{
  const mock = new MockGitHub({ root: dir });
  // A small laptop: under 1100 px wide, and Chrome reporting 4 GB (as it does for many 8 GB laptops).
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 700 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, "deviceMemory", { get: () => 4 }));
  await ctx.route("https://api.github.com/**", (r) => mock.handle(r));
  const page = await ctx.newPage();
  const errors = [];
  const requested = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("request", (r) => {
    const l = label(r.url());
    if (l) requested.push(l);
  });
  await page.goto(`${SITE}/admin/#regions`);
  await page.fill("#token", "ghp_e2etoken");
  await page.click('#signin-form button[type="submit"]');
  await page.waitForSelector("#regions .rcard", { timeout: 15000 });
  await page.selectOption("#r-new-slot", "tiles");
  await page.locator(".r-new-row .r-new").click();
  await page.waitForSelector("dialog.editor[open]");
  await page.waitForTimeout(1500);
  const shown = () => page.evaluate(() => document.querySelector("dialog.editor")?.dataset.tiles ?? "");
  await page.evaluate(([cx, cy]) => document.querySelector("dialog.editor").wgeEditor.setView(cx, cy, 36), [(w0 + e0) / 2, (s0 + n0) / 2]); // just past the 16384 threshold on a 1x screen
  const box = await page.locator("dialog.editor canvas.ed-canvas").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -1); // a zoom gesture: the editor upgrades on zoom
  for (let i = 0; i < 60 && (await shown()) !== top; i++) await page.waitForTimeout(500);
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, "editor-tiles.png") });
  const edTiles = requested.filter((x) => x.includes(":"));
  check("editor (small laptop, 4 GB reported): zoomed far in, it loads the 8192 map, then the tiles under the view", whole(requested).includes("8192") && edTiles.length > 0 && edTiles.length <= 16, requested.join(" "));
  check("editor: goes all the way to the finest level, even on a 1x screen", (await shown()) === top, `data-tiles=${await shown()}`);
  check("editor: no errors", errors.length === 0, errors.join("; "));
  await ctx.close();
}

await browser.close();
site.close();
console.log(`\nSizes: ${JSON.stringify(sizes)}`);
await writeFile(path.join(OUT, "report.json"), JSON.stringify({ source: { width: srcMeta.width, height: srcMeta.height }, processSeconds, sizes, results }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots and report.json in ${OUT}`);
process.exit(failed.length ? 1 : 0);
