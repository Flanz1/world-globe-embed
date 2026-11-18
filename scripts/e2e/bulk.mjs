// e2e-suite: roots=ADMIN,src/admin/bulk.ts weight=1
/**
 * Browser checks for selecting several regions on the Regions tab, in headless Chromium.
 *
 *   npm run e2e -- bulk
 *
 * "Select regions" shows checkboxes and a bar; ticking two cards and Move to folder, Change colour or Delete each
 * save in ONE commit; a contributor can't recolour or delete the owner's regions (buttons disabled, with the
 * reason); the deleted regions are in "Recently deleted"; Esc leaves the mode.
 *
 * Runs against the mock GitHub and admin API (no live data). Screenshots and report.json go to .e2e/bulk/.
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

const OUT = path.resolve(".e2e/bulk");
const BRANCH = "test/bulk";
const SITE = `http://localhost:${port(4173)}`;
await mkdir(OUT, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` (${detail})` : ""}`);
}

const dir = await makeFixture({ quiet: true });
const accessFile = path.join(dir, "content/access.json");
const access = JSON.parse(readFileSync(accessFile, "utf8"));
access.users.push({ id: 5002, login: "carto-ann", permissions: ["regions"] });
writeFileSync(accessFile, JSON.stringify(access, null, 2) + "\n");
writeFileSync(path.join(dir, "content/categories.json"), JSON.stringify({ categories: [{ id: "north", name: "Northern realms", regions: [] }] }, null, 2) + "\n");
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
  await page.waitForSelector("#regions .rcard", { timeout: 15000 });
  return { ctx, page, errors };
}

const A = "landmark-disc";
const B = "dateline-box";
const tick = (page, id) => page.locator(`#regions .rcard[data-region="${id}"] input.bulk-box`).check();
const cats = () => onBranch("content/categories.json")?.categories ?? [];

try {
  const owner = await adminPage("Flanz1");
  const { page } = owner;
  check("no checkboxes or bar before 'Select regions'", (await page.locator("input.bulk-box").count()) === 0 && (await page.locator(".bulk-bar:not([hidden])").isHidden()));
  await page.click("#r-select");
  check("the button is pressed and the bar shows", (await page.getAttribute("#r-select", "aria-pressed")) === "true" && (await page.locator(".bulk-bar:not([hidden])").isVisible()));
  check("with nothing ticked every action is disabled", (await page.locator('.bulk-bar:not([hidden]) [data-action="bulk-move"]').isDisabled()) && (await page.locator('.bulk-bar:not([hidden]) [data-action="bulk-delete"]').isDisabled()));
  await tick(page, A);
  await tick(page, B);
  check("the bar counts the ticked regions", (await page.locator(".bulk-bar:not([hidden]) .bulk-count").textContent()) === "2 selected");
  await page.screenshot({ path: path.join(OUT, "selected.png") });

  let n = mock.log.length;
  await page.click('.bulk-bar:not([hidden]) [data-action="bulk-move"]');
  await page.selectOption('dialog select[data-field="bulk-folder"]', "north");
  await page.click('dialog [data-action="confirm-bulk-move"]');
  await waitCommit(page, n);
  check("moving both to a folder is one commit", mock.log.length === n + 1 && JSON.stringify(cats()[0]?.regions?.slice().sort()) === JSON.stringify([B, A].sort()), mock.log.slice(n).map((c) => c.message).join(","));
  check("the ticks survive the save", (await page.locator(".bulk-bar:not([hidden]) .bulk-count").textContent()) === "2 selected");

  n = mock.log.length;
  await page.click('.bulk-bar:not([hidden]) [data-action="bulk-colour"]');
  await page.fill('dialog input[data-field="bulk-colour"]', "#00aa00");
  await page.click('dialog [data-action="confirm-bulk-colour"]');
  await waitCommit(page, n);
  check("changing the colour is one commit that changes both files", mock.log.length === n + 1 && onBranch(`content/regions/${A}.json`)?.properties.color === "#00aa00" && onBranch(`content/regions/${B}.json`)?.properties.color === "#00aa00", mock.log.slice(n).map((c) => c.message).join(","));

  // A contributor can't recolour or delete regions made by someone else.
  const ann = await adminPage("carto-ann");
  await ann.page.click("#r-select");
  await tick(ann.page, A);
  const why = await ann.page.locator('.bulk-bar:not([hidden]) [data-action="bulk-colour"]').getAttribute("title");
  check("a contributor can't recolour the owner's region: disabled, with the reason", (await ann.page.locator('.bulk-bar:not([hidden]) [data-action="bulk-colour"]').isDisabled()) && /can't change the colour/.test(why ?? ""), why);
  check("…or delete it", (await ann.page.locator('.bulk-bar:not([hidden]) [data-action="bulk-delete"]').isDisabled()) && /can't delete/.test((await ann.page.locator('.bulk-bar:not([hidden]) [data-action="bulk-delete"]').getAttribute("title")) ?? ""));
  check("no errors in the contributor's page", ann.errors.length === 0, ann.errors.join(" | "));
  await ann.ctx.close();

  n = mock.log.length;
  await page.click('.bulk-bar:not([hidden]) [data-action="bulk-delete"]');
  check("the delete dialog lists the regions and the trash", /landmark-disc/.test(await page.locator("dialog[open]").textContent()) && /Recently deleted/.test(await page.locator("dialog[open]").textContent()));
  await page.screenshot({ path: path.join(OUT, "delete-dialog.png") });
  await page.click('dialog [data-action="confirm-bulk-delete"]');
  await waitCommit(page, n);
  check("deleting both is one commit", mock.log.length === n + 1 && !onBranch(`content/regions/${A}.json`) && !onBranch(`content/regions/${B}.json`), mock.log.slice(n).map((c) => c.message).join(","));
  check("the cards are gone and the selection is empty", (await page.locator(`#regions .rcard[data-region="${A}"]`).count()) === 0 && (await page.locator(".bulk-bar:not([hidden]) .bulk-count").textContent()) !== "2 selected");

  await page.click("#r-trash");
  await page.waitForSelector("dialog .hist-list li", { timeout: 15000 });
  check("both are in 'Recently deleted'", (await page.locator("dialog .hist-list li", { hasText: A }).count()) === 1 && (await page.locator("dialog .hist-list li", { hasText: B }).count()) === 1);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  check("Esc leaves selection mode", (await page.getAttribute("#r-select", "aria-pressed")) === "false" && (await page.locator(".bulk-bar:not([hidden])").isHidden()) && (await page.locator("input.bulk-box").count()) === 0);
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
