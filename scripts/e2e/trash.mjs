// e2e-suite: roots=ADMIN,src/admin/trash.ts weight=1
/**
 * Browser checks for the trash of deleted regions ("Recently deleted…" on the Regions tab), in headless Chromium.
 *
 *   npm run e2e:trash
 *
 * The owner deletes a region and finds it in the list; a contributor can see it but can't restore someone else's
 * region (nothing is saved); the owner restores it (one commit, back in the list of regions, created by the same
 * person as before); an item deleted before the 3 days are up is gone from the list.
 *
 * Runs against the mock GitHub and admin API (no live data). Screenshots and report.json go to .e2e/trash/.
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

const OUT = path.resolve(".e2e/trash");
const BRANCH = "test/trash";
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
  await page.waitForSelector("#regions .rcard", { timeout: 15000 });
  return { ctx, page, errors };
}

try {
  const owner = await adminPage("Flanz1");
  const { page } = owner;
  check("the region is in the list before it is deleted", (await page.locator(`#regions .rcard[data-region="${ID}"]`).count()) === 1);
  const n0 = mock.log.length;
  await page.locator(`#regions .rcard[data-region="${ID}"] button:has-text("Delete")`).click();
  await page.fill('dialog input[aria-label="Type the region id to confirm"]', ID);
  await page.click('dialog.danger[open] button:has-text("Delete region")');
  await waitCommit(page, n0);
  check("deleting removes the file in one commit", !onBranch(FILE) && mock.log.length === n0 + 1);

  await page.click("#r-trash");
  await page.waitForSelector("dialog .hist-list li", { timeout: 15000 });
  const row = page.locator("dialog .hist-list li", { hasText: ID });
  check("the deleted region is in 'Recently deleted' with who deleted it and how long is left", (await row.count()) === 1 && /deleted by .*\b(2 days|3 days)\b|left/.test(await row.textContent()), await row.textContent());
  await page.screenshot({ path: path.join(OUT, "trash-list.png") });
  await page.keyboard.press("Escape");

  // Someone who may not delete other people's regions can see it, but not restore it.
  const ann = await adminPage("carto-ann");
  await ann.page.click("#r-trash");
  await ann.page.waitForSelector("dialog .hist-list li", { timeout: 15000 });
  const n1 = mock.log.length;
  await ann.page.locator("dialog .hist-list li", { hasText: ID }).locator("button:has-text('Restore')").click();
  await ann.page.waitForSelector("dialog .hist-list li .error", { timeout: 15000 });
  check("a contributor can't restore the owner's region: the reason is shown and nothing is saved", mock.log.length === n1 && !onBranch(FILE), await ann.page.locator("dialog .hist-list li .error").textContent());
  check("no errors in the contributor's page", ann.errors.length === 0, ann.errors.join(" | "));
  await ann.ctx.close();

  // The owner restores it.
  await page.click("#r-trash");
  await page.waitForSelector("dialog .hist-list li", { timeout: 15000 });
  const n2 = mock.log.length;
  await page.locator("dialog .hist-list li", { hasText: ID }).locator("button:has-text('Restore')").click();
  await waitCommit(page, n2);
  const f = onBranch(FILE);
  check("restoring puts the file back in one commit", !!f && mock.log.length === n2 + 1 && mock.log.at(-1).branch === BRANCH, mock.log.slice(n2).map((c) => c.message).join(","));
  check("…as it was, saved by the person restoring", f?.id === ID && f.geometry.coordinates[0].length > 1000 && f.properties.updatedBy.login === "Flanz1" && f.properties.createdBy.login === "Flanz1", JSON.stringify(f?.properties));
  await page.waitForSelector(`#regions .rcard[data-region="${ID}"]`, { timeout: 15000 });
  check("the region is back in the list of regions", true);

  // It was saved again, so it is no longer in the trash.
  await page.click("#r-trash");
  await page.waitForFunction(() => /Nothing was deleted/.test(document.querySelector("dialog[open]")?.textContent ?? ""), null, { timeout: 15000 });
  check("a restored region leaves the list", (await page.locator("dialog .hist-list li", { hasText: ID }).count()) === 0);
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
