// e2e-suite: roots=ADMIN,src/admin/snackbar.ts weight=1
/**
 * Browser checks for the snackbar (short success messages, with Undo after deleting a region) and the error banner,
 * in headless Chromium.
 *
 *   npm run e2e:snackbar
 *
 * Deleting a region shows "Deleted region …" with Undo; Undo restores the file in one commit; a plain success message
 * waits until a message with Undo has had its time; the snackbar disappears by itself; the test-branch warning is
 * the header badge only (no second "!" row in Checks).
 *
 * Runs against the mock GitHub and admin API (no live data). Screenshots and report.json go to .e2e/snackbar/.
 */
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
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

const OUT = path.resolve(".e2e/snackbar");
const BRANCH = "test/snackbar";
const SITE = `http://localhost:${port(4173)}`;
await mkdir(OUT, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` (${detail})` : ""}`);
}

const dir = await makeFixture({ quiet: true });
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
  check("the header badge says it's a test branch", /test\/snackbar/.test((await page.textContent("#branch")) ?? ""));
  check("Checks has no second test-branch warning row", (await page.locator('#checks li[data-check="branch"]').count()) === 0);
  check("the snackbar starts hidden", await page.locator("#snackbar").isHidden());

  const n0 = mock.log.length;
  await pickRegion(page, ID);
  await page.click(`#regions .rcard[data-region="${ID}"] [data-action="more"]`);
  await page.locator(`.rmenu[data-region="${ID}"] button:has-text("Delete")`).click();
  await page.fill('dialog input[aria-label="Type the region id to confirm"]', ID);
  await page.click('dialog.danger[open] button:has-text("Delete region")');
  await page.waitForSelector("#snackbar:not([hidden])", { timeout: 5000 });
  check("deleting shows 'Deleted region …' with Undo", /Deleted region big-ring/.test((await page.textContent("#snackbar-text")) ?? "") && (await page.locator("#snackbar-action").textContent()) === "Undo");
  check("the snackbar is a polite live region", (await page.getAttribute("#snackbar", "role")) === "status" && (await page.getAttribute("#snackbar", "aria-live")) === "polite");
  await page.screenshot({ path: path.join(OUT, "snackbar-undo.png") });
  await waitCommit(page, n0);
  check("the delete was one commit", !onBranch(FILE) && mock.log.length === n0 + 1);
  await page.waitForTimeout(600);
  check("the 'saved' message did not replace Undo", /Deleted region big-ring/.test((await page.textContent("#snackbar-text")) ?? ""), await page.textContent("#snackbar-text"));

  // Hovering pauses the timer.
  await page.hover("#snackbar");
  await page.waitForTimeout(6000);
  check("it stays while the pointer is on it", await page.locator("#snackbar").isVisible());
  const n1 = mock.log.length;
  await page.click("#snackbar-action");
  await waitCommit(page, n1);
  const f = onBranch(FILE);
  check("Undo restores the file in one commit", !!f && mock.log.length === n1 + 1 && /^Restore region big-ring/.test(mock.log.at(-1).message), mock.log.slice(n1).map((c) => c.message).join(","));
  await page.waitForSelector(`#regions .rrow[data-region="${ID}"]`, { timeout: 15000 });
  check("the region is back in the list", true);
  await page.waitForFunction(() => /Saved/.test(document.querySelector("#snackbar-text")?.textContent ?? "") || document.querySelector("#snackbar")?.hidden === false, null, { timeout: 8000 }).catch(() => {});
  await page.mouse.move(5, 5);
  await page.waitForTimeout(7000);
  await page.waitForFunction(() => document.querySelector("#snackbar")?.hidden === true, null, { timeout: 15000 }).catch(() => {});
  check("the snackbar goes away by itself", await page.locator("#snackbar").isHidden());
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
