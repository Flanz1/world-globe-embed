// e2e-suite: roots=ADMIN weight=1
/**
 * Browser checks for changing a region's id (More… → Change id… on the Regions tab), in headless Chromium.
 *
 *   npm run e2e -- rename
 *
 * The dialog warns that old embeds break and keeps Rename off until the id is valid, free and the box is ticked;
 * renaming moves the file (new id inside it, old file gone), updates a region that shows it as an underlay and the
 * folder that lists it, and the card appears under the new id with a note. A contributor can't change someone
 * else's region.
 *
 * Runs against the mock GitHub and admin API (no live data). Screenshots and report.json go to .e2e/rename/.
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
import { pickRegion } from "./regions-ui.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const OUT = path.resolve(".e2e/rename");
const BRANCH = "test/rename";
const SITE = `http://localhost:${port(4173)}`;
await mkdir(OUT, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` (${detail})` : ""}`);
}

const dir = await makeFixture({ quiet: true });
const regionsDir = path.join(dir, "content/regions");
const base = JSON.parse(readFileSync(path.join(regionsDir, "big-ring.json"), "utf8"));
const other = structuredClone(base);
other.id = "shows-ring";
other.properties.layerGroups = [{ name: "Rings", regions: [{ id: "big-ring" }] }];
writeFileSync(path.join(regionsDir, "shows-ring.json"), JSON.stringify(other));
writeFileSync(path.join(dir, "content/categories.json"), JSON.stringify({ categories: [{ id: "rings", name: "Rings", regions: ["big-ring"] }] }));
const accessFile = path.join(dir, "content/access.json");
const access = JSON.parse(readFileSync(accessFile, "utf8"));
access.users.push({ id: 5002, login: "carto-ann", permissions: ["regions"] });
writeFileSync(accessFile, JSON.stringify(access, null, 2) + "\n");
execFileSync("npm", ["run", "build"], { cwd: dir, env: { ...process.env, VITE_CONTENT_BRANCH: BRANCH }, stdio: "pipe" });
const DIST = path.join(dir, "dist");

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".json": "application/json" };
const site = createServer(async (req, res) => {
  let p = path.join(DIST, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (existsSync(p) && statSync(p).isDirectory()) p = path.join(p, "index.html");
  if (!p.startsWith(DIST) || !existsSync(p)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] ?? "application/octet-stream", "Cache-Control": "no-store" });
  res.end(await readFile(p));
}).listen(port(4173), "localhost");

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const mock = new MockGitHub({ root: dir, branches: ["main", BRANCH] });
const ID = "big-ring";
const FILE = `content/regions/${ID}.json`;
const onBranch = (p) => (mock.read(BRANCH, p) ? JSON.parse(mock.read(BRANCH, p).toString()) : null);
const waitCommit = async (page, n) => {
  const t0 = Date.now();
  while (mock.log.length <= n && Date.now() - t0 < 15000) await page.waitForTimeout(100);
  await page.waitForTimeout(400);
};
async function adminPage(as) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await ctx.route("https://api.github.com/**", (r) => mock.handle(r));
  await useAdminApi(ctx, mock, { branch: BRANCH, as });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && !/^Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await page.goto(`${SITE}/admin/#regions`);
  await page.waitForSelector("#regions .rrow", { timeout: 15000 });
  return { ctx, page, errors };
}

try {
  const owner = await adminPage("Flanz1");
  const { page } = owner;
  const card = (id) => page.locator(`#regions .rcard[data-region="${id}"]`);
  await pickRegion(page, ID);
  // Rename… changes only the display name: one commit, same id and file.
  {
    const n = mock.log.length;
    await page.click(`#regions .rcard[data-region="${ID}"] [data-action="more"]`);
    await page.locator(`.rmenu[data-region="${ID}"] button:has-text("Rename")`).click();
    const nd = page.locator("dialog.name-dlg[open]");
    await nd.waitFor();
    check("Rename… opens a name dialog with Save off until the name changes", await nd.locator('[data-action="name-save"]').isDisabled());
    await nd.locator('input[name="display-name"]').fill("The Big Ring Union");
    await nd.locator('[data-action="name-save"]').click();
    await waitCommit(page, n);
    const f = onBranch(FILE);
    check("the name is saved with its capitals, the id and file are unchanged", f?.id === ID && f.properties.name === "The Big Ring Union" && mock.log.length === n + 1, JSON.stringify(f?.properties.name));
    check("the list shows the new name", (await page.locator(`#regions .rrow[data-region="${ID}"] .rrow-name`).textContent()) === "The Big Ring Union");
    await pickRegion(page, ID);
  }
  // Maps: Rename… changes only the map's name.
  {
    await page.goto(`${SITE}/admin/#maps`);
    await page.waitForSelector('#maps [data-action="rename-map"]', { timeout: 15000 });
    const btn = page.locator('#maps [data-action="rename-map"]').first();
    const mapId = await btn.getAttribute("data-map");
    const n = mock.log.length;
    await btn.click();
    const nd = page.locator("dialog.name-dlg[open]");
    await nd.waitFor();
    await nd.locator('input[name="display-name"]').fill("Inara, Second Age");
    await nd.locator('[data-action="name-save"]').click();
    await waitCommit(page, n);
    const f = onBranch(`content/maps/${mapId}.json`);
    check("a map's name changes, its id and sizes stay", f?.id === mapId && f.name === "Inara, Second Age" && !!f.sizes, JSON.stringify(f?.name));
    await page.goto(`${SITE}/admin/#regions`);
    await page.waitForSelector("#regions .rrow", { timeout: 15000 });
    await pickRegion(page, ID);
  }
  await page.click(`#regions .rcard[data-region="${ID}"] [data-action="more"]`);
  await page.locator(`.rmenu[data-region="${ID}"] button:has-text("Change id")`).click();
  const dlg = page.locator("dialog.rename-dlg[open]");
  await dlg.waitFor();
  const go = dlg.locator('[data-action="rename-go"]');
  check("the dialog warns that old embeds break", /stop working/.test(await dlg.locator('[role="note"]').textContent()));
  check("it names the region that will be updated", /shows-ring/.test(await dlg.locator('[data-role="rename-refs"]').textContent()));
  check("Rename is off while the id is unchanged", await go.isDisabled());
  const field = dlg.locator('[data-role="new-id"]');
  await field.fill("Bad Id");
  check("an invalid id shows an error and keeps Rename off", (await dlg.locator('[data-role="rename-error"]').textContent()).length > 0 && (await go.isDisabled()));
  await field.fill("shows-ring");
  check("a taken id is refused", /taken/.test(await dlg.locator('[data-role="rename-error"]').textContent()) && (await go.isDisabled()));
  await field.fill("small-ring");
  check("a free id still needs the box ticked", (await go.isDisabled()) && /Tick the box/.test((await go.getAttribute("title")) ?? ""));
  check("the new embed address is shown", /v\/[^/]+\/\?region=small-ring/.test(await dlg.locator('[data-role="new-url"]').textContent()));
  await page.screenshot({ path: path.join(OUT, "dialog.png") });
  await dlg.locator("#rename-ack").check();
  check("ticking the box enables Rename", !(await go.isDisabled()));
  const n0 = mock.log.length;
  await go.click();
  await waitCommit(page, n0 + 1);
  const moved = onBranch("content/regions/small-ring.json");
  check("the region is saved under the new id, the old file is gone", moved?.id === "small-ring" && !onBranch(FILE) && moved.properties.updatedBy.login === "Flanz1" && moved.geometry.coordinates[0].length > 1000);
  check("a region that showed it now shows the new id", onBranch("content/regions/shows-ring.json")?.properties.layerGroups?.[0]?.regions?.[0]?.id === "small-ring");
  check("the folder lists the new id", JSON.stringify(onBranch("content/categories.json")?.categories?.[0]?.regions) === '["small-ring"]');
  await page.waitForSelector('#regions .rrow[data-region="small-ring"]', { timeout: 15000 });
  check("the card shows under the new id with a note about the old embeds", (await card(ID).count()) === 0 && /Renamed from big-ring/.test(await card("small-ring").locator("[data-renamed]").textContent()));
  const ann = await adminPage("carto-ann");
  await pickRegion(ann.page, "small-ring");
  await ann.page.click(`#regions .rcard[data-region="small-ring"] [data-action="more"]`);
  check("a contributor can't change someone else's region", await ann.page.locator(`.rmenu[data-region="small-ring"] button:has-text("Rename")`).isDisabled());
  await ann.ctx.close();
  check("no errors in the admin page", owner.errors.length === 0, owner.errors.join(" | "));
  await owner.ctx.close();
} catch (e) {
  check("ran to the end", false, `threw: ${(e && e.message) || e}`.slice(0, 400));
}

await browser.close();
site.close();
await writeFile(path.join(OUT, "report.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed:\n${failed.map((f) => `  ${f.name} ${f.detail}`).join("\n")}` : ""}`);
process.exit(failed.length ? 1 : 0);
