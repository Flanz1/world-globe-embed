/**
 * Browser checks for the texture stages, in headless Chromium (system Playwright, like `npm run measure`).
 *
 *   npm run e2e:tiers
 *
 * Builds a throwaway copy of the repo with an 8192 × 4096 test map, a slot and a small region on it,
 * then checks which textures each embed loads, and in what order:
 * - a zoomed-in region embed (globe and flat) loads 1024, then 4096, then 8192, and shows each in turn;
 * - the plain slot at the default zoom stops at 2048;
 * - a GPU that only takes 4096 textures, and a phone, never load the 8192;
 * - a map processed from a smaller source has no 8192 and stops at 4096.
 *
 * Screenshots (the region at 4096 and at 8192) and report.json go to .e2e/tiers/. Exits non-zero if any check fails.
 */
import { createServer } from "node:http";
import { cpSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const require = createRequire(path.join(ROOT, "package.json"));
const sharp = require("sharp");
const { chromium, devices } = require("playwright");

const OUT = path.resolve(".e2e/tiers");
const SITE = "http://localhost:4174";
await mkdir(OUT, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` (${detail})` : ""}`);
}

/* ── Fixture: a detailed 8192 map (fine lines and small text, so the stages differ visibly) ── */
function mapSvg(W, H) {
  const parts = [`<rect width="100%" height="100%" fill="#1d4f7a"/>`];
  // An island near lon 20, lat 10 with a dense grid of thin lines and labels.
  const x0 = ((20 + 180) / 360) * W;
  const y0 = ((90 - 10) / 180) * H;
  parts.push(`<ellipse cx="${x0}" cy="${y0}" rx="${W * 0.03}" ry="${H * 0.05}" fill="#5a8a3c"/>`);
  for (let i = -40; i <= 40; i++) {
    parts.push(`<line x1="${x0 - W * 0.03}" y1="${y0 + i * 5}" x2="${x0 + W * 0.03}" y2="${y0 + i * 5}" stroke="#e8dcc8" stroke-width="1"/>`);
  }
  for (let i = 0; i < 12; i++) {
    parts.push(`<text x="${x0 - 180}" y="${y0 - 160 + i * 28}" font-size="18" font-family="sans-serif" fill="#fff">Village ${i + 1} · road · river · ford</text>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${parts.join("")}</svg>`;
}

const dir = mkdtempSync(path.join(tmpdir(), "wge-tiers-"));
for (const f of ["package.json", "tsconfig.json", "vite.config.ts", "eslint.config.js", "admin", "content", "public", "schema", "scripts", "src"])
  cpSync(path.join(ROOT, f), path.join(dir, f), { recursive: true });
symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"), "dir");
await sharp(Buffer.from(mapSvg(8192, 4096))).png().toFile(path.join(dir, "content/incoming/big-map.png"));
await sharp(Buffer.from(mapSvg(6000, 3000))).png().toFile(path.join(dir, "content/incoming/mid-map.png"));
const run = (cmd, args) => execFileSync(cmd, args, { cwd: dir, env: { ...process.env, GITHUB_ACTOR: "e2e" }, stdio: "pipe" });
run("npx", ["tsx", "scripts/process-maps.ts"]);
const bigMeta = JSON.parse(readFileSync(path.join(dir, "content/maps/big-map.json"), "utf8"));
const midMeta = JSON.parse(readFileSync(path.join(dir, "content/maps/mid-map.json"), "utf8"));
check("process-maps: 8192 source gets 1024/2048/4096/8192", Object.keys(bigMeta.sizes).join() === "1024,2048,4096,8192", Object.keys(bigMeta.sizes).join());
check("process-maps: 6000 source stops at 4096", Object.keys(midMeta.sizes).join() === "1024,2048,4096", Object.keys(midMeta.sizes).join());
const sizes = {};
for (const w of Object.keys(bigMeta.sizes)) sizes[w] = statSync(path.join(dir, "public", bigMeta.sizes[w])).size;

const slotsFile = path.join(dir, "content/slots.json");
const slots = JSON.parse(readFileSync(slotsFile, "utf8"));
slots.slots.tiers = { map: "big-map", title: "Tiers test" };
slots.slots["tiers-mid"] = { map: "mid-map", title: "Tiers test (6000 source)" };
writeFileSync(slotsFile, JSON.stringify(slots, null, 2) + "\n");
const regionsDir = path.join(dir, "content/regions");
if (!existsSync(regionsDir)) mkdirSync(regionsDir, { recursive: true });
const region = (id, slot, map) => ({
  $schema: "../../schema/region.schema.json",
  type: "Feature",
  id,
  properties: { name: "Small Isle", slot, map, color: "#00e5ff", fillOpacity: 0.15, label: true, updated: "2026-11-10T12:00:00Z" },
  geometry: { type: "Polygon", coordinates: [[[17, 6], [23, 6], [23, 14], [17, 14], [17, 6]]] },
});
writeFileSync(path.join(regionsDir, "small-isle.json"), JSON.stringify(region("small-isle", "tiers", "big-map"), null, 2) + "\n");
writeFileSync(path.join(regionsDir, "small-isle-mid.json"), JSON.stringify(region("small-isle-mid", "tiers-mid", "mid-map"), null, 2) + "\n");
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
}).listen(4174, "localhost");

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });

/** Opens an embed, waits until the texture upgrades stop, and returns the widths requested and shown in order. */
async function open(query, { context = {}, maxTex, shots } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 800, height: 480 }, deviceScaleFactor: 1, ...context });
  if (maxTex)
    await ctx.addInitScript((limit) => {
      for (const C of [WebGL2RenderingContext, WebGLRenderingContext]) {
        const orig = C.prototype.getParameter;
        C.prototype.getParameter = function (p) {
          return p === this.MAX_TEXTURE_SIZE ? limit : orig.call(this, p);
        };
      }
    }, maxTex);
  const page = await ctx.newPage();
  const errors = [];
  const requested = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("request", (r) => {
    const m = /-(\d+)\.webp$/.exec(r.url());
    if (m) requested.push(Number(m[1]));
  });
  // Every width the page shows, in order (data-tex changes once per finished crossfade).
  await page.addInitScript(() => {
    window.__shown = [];
    new MutationObserver(() => {
      const t = document.documentElement.dataset.tex;
      if (t && window.__shown[window.__shown.length - 1] !== Number(t)) window.__shown.push(Number(t));
    }).observe(document, { attributes: true, subtree: true, attributeFilter: ["data-tex"] });
  });
  // For the screenshots, hold the 8192 back until the 4096 stage has been captured.
  let release8k = () => {};
  if (shots) {
    const held = new Promise((r) => (release8k = r));
    await page.route(/-8192\.webp$/, async (route) => (await held, route.continue()));
  }
  await page.goto(`${SITE}/${query}`);
  await page.waitForFunction(() => document.documentElement.dataset.state === "hires", null, { timeout: 60000 });
  if (shots) {
    // Screenshot each stage as it lands.
    for (const w of shots) {
      await page.waitForFunction((w) => document.documentElement.dataset.tex === String(w), w, { timeout: 60000 });
      await page.waitForTimeout(700); // past the crossfade
      await page.screenshot({ path: path.join(OUT, `${query.includes("flat") ? "flat" : "globe"}-${w}.png`) });
      release8k();
    }
  }
  // Let any further stage finish.
  let last = "";
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(500);
    const now = JSON.stringify([requested, await page.evaluate(() => window.__shown)]);
    if (now === last && i > 3) break;
    last = now;
  }
  const shown = await page.evaluate(() => window.__shown);
  await ctx.close();
  return { requested, shown, errors };
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

for (const view of ["globe", "flat"]) {
  const q = `v/tiers/?region=small-isle${view === "flat" ? "&view=flat" : ""}`;
  const r = await open(q, { shots: [4096, 8192] });
  check(`${view}: zoomed-in region loads 1024, then 4096, then 8192`, eq(r.requested, [1024, 4096, 8192]), `requested ${r.requested.join(" → ")}`);
  check(`${view}: and shows each stage in turn`, eq(r.shown, [1024, 4096, 8192]), `shown ${r.shown.join(" → ")}`);
  check(`${view}: no errors`, r.errors.length === 0, r.errors.join("; "));

  if (view === "globe") {
    // The flat view draws on a 2D canvas, so the GPU texture limit doesn't apply there.
    const gpu = await open(q, { maxTex: 4096 });
    check(`${view}: GPU limited to 4096 textures never loads 8192`, eq(gpu.requested, [1024, 4096]), `requested ${gpu.requested.join(" → ")}`);
  }

  const phone = await open(q, { context: devices["Pixel 7"] });
  check(`${view}: phone never loads 8192`, !phone.requested.includes(8192), `requested ${phone.requested.join(" → ")}`);

  const mid = await open(`v/tiers-mid/?region=small-isle-mid${view === "flat" ? "&view=flat" : ""}`);
  check(`${view}: map with no 8192 stops at 4096`, eq(mid.requested, [1024, 4096]), `requested ${mid.requested.join(" → ")}`);
}

const plain = await open("v/tiers/");
check("globe: plain slot at default zoom stops at 2048", eq(plain.requested, [1024, 2048]), `requested ${plain.requested.join(" → ")}`);

await browser.close();
site.close();

const kb = (b) => `${Math.round(b / 1024)} KB`;
console.log(`\nTexture sizes for the 8192 test map: ${Object.entries(sizes).map(([w, b]) => `${w}: ${kb(b)}`).join(" · ")}`);
await writeFile(path.join(OUT, "report.json"), JSON.stringify({ results, sizes }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots and report.json in ${OUT}`);
process.exit(failed.length ? 1 : 0);
