// e2e-suite: roots=EDITOR,VIEWER weight=4
/**
 * Browser checks for "layer groups" in the region editor, in headless Chromium.
 *
 *   npm run e2e:underlays
 *
 * Picking a region adds its row at once; the editor map and the globe preview show it under the region
 * (cut to the region's outline); naming it, switching it off and the heading reach the preview's toggles;
 * saving writes layerGroups/layerLabel in one commit.
 *
 * Screenshots and report.json go to .e2e/underlays/. Exits non-zero if any check fails.
 */
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { SLOT, MAP, makeFixture, edTab } from "./fixture.mjs";
import { MockGitHub } from "./mock-github.mjs";
import { useAdminApi } from "./admin-api.mjs";

import { port } from "./ports.mjs";
import { pickRegion } from "./regions-ui.mjs";
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
  await page.waitForSelector('#regions .rrow[data-region="country"]', { timeout: 15000 });
  await pickRegion(page, "country");
  await page.locator('[data-region="country"] [data-action="edit"]').click();
  await page.waitForSelector(`${D}[open]`);
  await page.waitForTimeout(600);
  await page.evaluate(() => document.querySelector("dialog.editor").wgeEditor.setView(110, -46, 12));
  await page.waitForTimeout(300);
});

let plain = [];
let outsideBefore = [];
const G = `${D} .ed-group`;
await step(A, "adding a group of regions", async () => {
  plain = await pixel(104, -46);
  outsideBefore = await pixel(95, -46);
  await edTab(page, "underlays");
  check(A, "no groups before one is made", (await page.locator(G).count()) === 0);
  await page.click(`${D} [data-act="group-new"]`);
  // No wait: the card must be there straight away.
  check(A, "the group card shows at once", (await page.locator(G).count()) === 1);
  await page.fill(`${G}[data-group="r0"] input[name="group-name"]`, "Religion");
  await page.selectOption(`${G}[data-group="r0"] select[name="group-add"]`, "faith");
  check(A, "a region added to the group shows as a row", (await page.locator(`${G}[data-group="r0"] .ed-group-row`).count()) === 1);
  await page.click(`${D} [data-act="group-new"]`);
  await page.fill(`${G}[data-group="r1"] input[name="group-name"]`, "Culture");
  await page.selectOption(`${G}[data-group="r1"] select[name="group-add"]`, "culture");
  check(A, "…and a second group", (await page.locator(G).count()) === 2 && (await page.locator(`${G}[data-group="r1"] .ed-group-row`).count()) === 1);
  await page.waitForTimeout(500);
  const now = await pixel(104, -46);
  check(A, "the editor map paints the group's region under the region", JSON.stringify(now) !== JSON.stringify(plain), `${plain} → ${now}`);
  const outside = await pixel(95, -46); // in the faith region, outside the country
  check(A, "…cut to the region's outline (outside it nothing is added)", JSON.stringify(outside) === JSON.stringify(outsideBefore), `${outsideBefore} → ${outside}`);
  await page.screenshot({ path: path.join(OUT, "editor-groups.png") });
});

await step(A, "preview", async () => {
  await page.waitForFunction(() => [...document.querySelectorAll("iframe")].some((f) => f.contentDocument?.querySelectorAll(".rgroup").length === 2), null, { timeout: 15000 }).catch(() => {});
  const labels = await pv().locator(".rgroup-head span").allTextContents();
  check(A, "the globe preview has a section per group (not the region)", labels.length === 2 && labels[0] === "Religion" && labels[1] === "Culture", labels.join(" | "));
  const on = await pv().locator(".rgroup input").evaluateAll((e) => e.map((x) => x.checked));
  check(A, "first group on, the second off, as the defaults say", JSON.stringify(on) === JSON.stringify([true, false]), JSON.stringify(on));
  await page.fill(`${G}[data-group="r0"] input[name="group-name"]`, "Faiths");
  await page.waitForTimeout(900);
  const l2 = await pv().locator(".rgroup-head span").allTextContents();
  check(A, "a name set in the editor reaches the preview", l2[0] === "Faiths", l2.join(" | "));
  await page.locator(`${G}[data-group="r1"] input[name="group-on"]`).check();
  await page.waitForTimeout(700);
  const on2 = await pv().locator(".rgroup input").evaluateAll((e) => e.map((x) => x.checked));
  check(A, "switching 'Shown when the embed opens' in the editor shows it in the preview", on2[1] === true, JSON.stringify(on2));
  await page.check(`${D} input[name="own-toggle"]`);
  await page.fill(`${D} input[name="layer-label"]`, "Borders");
  await page.waitForTimeout(900);
  const l3 = await pv().locator(".rgroup-head span").allTextContents();
  check(A, "'Readers can switch this region off too' adds the region's own switch", l3.length === 3 && l3.includes("Borders"), l3.join(" | "));
  await page.screenshot({ path: path.join(OUT, "editor-preview.png") });
});

await step(A, "group fill", async () => {
  const slider = page.locator(`${G}[data-group="r0"] input[name="group-fill"]`);
  check(A, "each group has a Fill slider with its own accessible name", /^Fill for /.test((await slider.getAttribute("aria-label")) ?? ""), await slider.getAttribute("aria-label"));
  await slider.fill("0.8");
  await page.waitForTimeout(900);
  check(A, "the output reads 80%", (await page.locator(`${G}[data-group="r0"] output`).textContent()) === "80%");
});

await step(A, "order and delete", async () => {
  await page.locator(`${G}[data-group="r1"] .ed-group-foot button`, { hasText: "↑" }).click();
  await page.waitForTimeout(300);
  const names = await page.locator(`${G} input[name="group-name"]`).evaluateAll((e) => e.map((x) => x.value));
  check(A, "a group moves up the list", names.join(",") === "Culture,Faiths", names.join(","));
  await page.locator(`${G}[data-group="r0"] .ed-group-foot button`, { hasText: "↓" }).click();
  await page.waitForTimeout(300);
  await page.click(`${D} [data-act="group-new"]`);
  check(A, "a new group card starts empty and open", (await page.locator(`${G}[data-group="r2"] .ed-group-row`).count()) === 0 && (await page.locator(`${G}[data-group="r2"] .ed-group-body`).isVisible()));
  await page.locator(`${G}[data-group="r2"] [data-act="group-delete"]`).click();
  check(A, "Delete group removes it", (await page.locator(G).count()) === 2);
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
  const lg = f.properties.layerGroups ?? [];
  check(A, "saved as layerGroups with each group's name, members, start state and fill", lg.length === 2 && lg[0].name === "Culture" && lg[0].regions[0].id === "culture" && lg[0].on === true && lg[1].name === "Faiths" && lg[1].regions[0].id === "faith" && lg[1].fill === 0.8, JSON.stringify(lg));
  check(A, "…and none of the older fields", f.properties.under === undefined && f.properties.underTitle === undefined);
  check(A, "…with the region's own switch", f.properties.ownToggle === true && f.properties.layerLabel === "Borders");
});

check(A, "no errors in the admin page", errors.length === 0, errors.join(" | ") || "none");
await ctx.close();
await browser.close();
server.close();
await writeFile(path.join(OUT, "report.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed:\n${failed.map((f) => `  [${f.group}] ${f.name} ${f.detail}`).join("\n")}` : ""}`);
process.exit(failed.length ? 1 : 0);
