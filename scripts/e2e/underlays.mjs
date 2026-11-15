// e2e-suite: roots=EDITOR,VIEWER weight=4
/**
 * Browser checks for "Show under this region" in the region editor, in headless Chromium.
 *
 *   npm run e2e:underlays
 *
 * Picking a region adds its row at once; the editor map and the globe preview show it under the region
 * (cut to the region's outline); naming it, switching it off and the heading reach the preview's toggles;
 * saving writes under/underTitle/layerLabel in one commit.
 *
 * Screenshots and report.json go to .e2e/underlays/. Exits non-zero if any check fails.
 */
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { SLOT, MAP, makeFixture } from "./fixture.mjs";
import { MockGitHub } from "./mock-github.mjs";
import { useAdminApi } from "./admin-api.mjs";

import { port } from "./ports.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const OUT = path.resolve(".e2e/underlays");
const BRANCH = "test/underlays";
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
const mk = (id, b, props) => ({ $schema: "../../schema/region.schema.json", type: "Feature", id, properties: { slot: SLOT.slug, map: MAP.id, fillOpacity: 0.8, label: false, updated: "2026-11-11T12:00:00Z", ...props }, geometry: { type: "Polygon", coordinates: [box(...b)] } });
const dir = await makeFixture({ quiet: true });
const w = (f) => writeFileSync(path.join(dir, `content/regions/${f.id}.json`), JSON.stringify(f, null, 2) + "\n");
w(mk("country", [100, -56, 120, -36], { color: "#00e5ff" }));
w(mk("faith", [90, -60, 112, -30], { color: "#ff9100" }));
w(mk("culture", [108, -60, 130, -30], { color: "#d500f9" }));
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
const A = "underlays";
const mock = new MockGitHub({ root: dir, branches: ["main", BRANCH] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await ctx.route("https://api.github.com/**", (r) => mock.handle(r));
await useAdminApi(ctx, mock, { branch: BRANCH });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && !/^Failed to load resource/.test(m.text()) && errors.push(m.text()));
page.on("dialog", (d) => d.dismiss());
const D = "dialog.editor";
const pv = () => page.frames().find((f) => /\/preview\//.test(f.url()));
const pixel = (lon, lat) =>
  page.evaluate(([lon, lat]) => {
    const d = document.querySelector("dialog.editor");
    const c = d.querySelector("canvas.ed-canvas");
    const [x, y] = d.wgeEditor.toScreen(lon, lat);
    const dp = c.width / c.getBoundingClientRect().width;
    return [...c.getContext("2d").getImageData(Math.round(x * dp), Math.round(y * dp), 1, 1).data];
  }, [lon, lat]);

await step(A, "open the editor on the country", async () => {
  await page.goto(`${SITE}/admin/#regions`);
  await page.waitForSelector('#regions .rcard[data-region="country"]', { timeout: 15000 });
  await page.locator('[data-region="country"] [data-action="edit"]').click();
  await page.waitForSelector(`${D}[open]`);
  await page.waitForTimeout(600);
  await page.evaluate(() => document.querySelector("dialog.editor").wgeEditor.setView(110, -46, 12));
  await page.waitForTimeout(300);
});

let plain = [];
let outsideBefore = [];
await step(A, "adding an underlay", async () => {
  plain = await pixel(104, -46);
  outsideBefore = await pixel(95, -46);
  check(A, "no layer list before anything is added", (await page.locator(`${D} .ed-under-row`).count()) === 0);
  await page.selectOption(`${D} select[name="under-add"]`, "faith");
  // No wait: the row must be there straight away.
  check(A, "the row shows at once", (await page.locator(`${D} .ed-under-row`).count()) === 1);
  await page.selectOption(`${D} select[name="under-add"]`, "culture");
  check(A, "…and a second one", (await page.locator(`${D} .ed-under-row`).count()) === 2);
  await page.waitForTimeout(500);
  const now = await pixel(104, -46);
  check(A, "the editor map paints the underlay under the region", JSON.stringify(now) !== JSON.stringify(plain), `${plain} → ${now}`);
  const outside = await pixel(95, -46); // in the faith region, outside the country
  check(A, "…cut to the region's outline (outside it nothing is added)", JSON.stringify(outside) === JSON.stringify(outsideBefore), `${outsideBefore} → ${outside}`);
  await page.screenshot({ path: path.join(OUT, "editor-underlays.png") });
});

await step(A, "preview", async () => {
  await page.waitForFunction(() => [...document.querySelectorAll("iframe")].some((f) => f.contentDocument?.querySelectorAll(".rlayers label").length === 2), null, { timeout: 15000 }).catch(() => {});
  const labels = await pv().locator(".rlayers label span").allTextContents();
  check(A, "the globe preview lists a toggle per underlay (not the region)", labels.length === 2, labels.join(" | "));
  await page.fill(`${D} .ed-under-row:nth-of-type(1) input[type="text"]`, "Religion");
  await page.fill(`${D} input[name="under-title"]`, "Map layers");
  await page.waitForTimeout(900);
  const l2 = await pv().locator(".rlayers label span").allTextContents();
  check(A, "a name set in the editor reaches the preview", l2[0] === "Religion", l2.join(" | "));
  check(A, "…and the heading", (await pv().locator(".rlayers-head").textContent()) === "Map layers");
  const on = await pv().locator(".rlayers input").evaluateAll((e) => e.map((x) => x.checked));
  check(A, "first underlay on, the second off, as the defaults say", JSON.stringify(on) === JSON.stringify([true, false]), JSON.stringify(on));
  await page.locator(`${D} .ed-under-row`).nth(1).locator('input[type="checkbox"]').check();
  await page.waitForTimeout(700);
  const on2 = await pv().locator(".rlayers input").evaluateAll((e) => e.map((x) => x.checked));
  check(A, "switching 'On' in the editor shows it in the preview", on2[1] === true, JSON.stringify(on2));
  await page.check(`${D} input[name="own-toggle"]`);
  await page.fill(`${D} input[name="layer-label"]`, "Borders");
  await page.waitForTimeout(900);
  const l3 = await pv().locator(".rlayers label span").allTextContents();
  check(A, "'Readers can switch this region off too' adds the region's own toggle", l3.length === 3 && l3.includes("Borders"), l3.join(" | "));
  await page.screenshot({ path: path.join(OUT, "editor-preview.png") });
});

await step(A, "save", async () => {
  const n0 = mock.log.length;
  await page.click(`${D} .ed-save`);
  const t0 = Date.now();
  while (mock.log.length < n0 + 1 && Date.now() - t0 < 15000) await page.waitForTimeout(100);
  await page.waitForTimeout(400);
  const c = mock.log.slice(n0);
  check(A, "save is one commit to content/regions/country.json", c.length === 1 && c[0].branch === BRANCH, JSON.stringify(c));
  const f = JSON.parse(mock.read(BRANCH, "content/regions/country.json"));
  check(A, "saved with under, its names and the heading", f.properties.under?.length === 2 && f.properties.under[0].label === "Religion" && f.properties.underTitle === "Map layers", JSON.stringify(f.properties.under));
});

check(A, "no errors in the admin page", errors.length === 0, errors.join(" | ") || "none");
await ctx.close();
await browser.close();
server.close();
await writeFile(path.join(OUT, "report.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed:\n${failed.map((f) => `  [${f.group}] ${f.name} ${f.detail}`).join("\n")}` : ""}`);
process.exit(failed.length ? 1 : 0);
