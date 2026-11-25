// e2e-suite: roots=ADMIN,WORKER,src/shared/health.ts weight=1
/**
 * Browser checks for the Health tab: a region drawn on a map its slot no longer shows is listed under
 * "Drawn on a different map" (open, with a count on the tab), its id opens the region, nothing scrolls sideways
 * at 375 px, and once the problem is gone the tab says all clear. E2E_SHOTS=1 also saves screenshots
 * (375/768/1440, light and dark, problems and all clear) to .e2e/health.
 *
 *   npm run e2e:health
 */
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync, statSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { makeFixture } from "./fixture.mjs";
import { MockGitHub } from "./mock-github.mjs";
import { useAdminApi } from "./admin-api.mjs";
import { port } from "./ports.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const OUT = path.resolve(".e2e/health");
const PORT = port(4173);
const ADMIN = `http://localhost:${PORT}/admin/`;
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

const dir = await makeFixture({ quiet: true });
writeFileSync(
  path.join(dir, "content/access.json"),
  JSON.stringify(
    {
      $schema: "../schema/access.schema.json",
      users: [
        { id: 45669787, login: "Flanz1", permissions: ["maps", "regions", "editOthers", "deleteOthers", "users"] },
        { id: 5002, login: "carto-ann", permissions: ["regions"] },
      ],
    },
    null,
    2,
  ) + "\n",
);
execFileSync("npm", ["run", "build"], { cwd: dir, stdio: "pipe" });
const DIST = path.join(dir, "dist");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".json": "application/json", ".txt": "text/plain", ".bin": "application/octet-stream" };
const site = createServer(async (req, res) => {
  let p = path.join(DIST, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (existsSync(p) && statSync(p).isDirectory()) p = path.join(p, "index.html");
  if (!p.startsWith(DIST) || !existsSync(p)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] ?? "application/octet-stream", "Cache-Control": "no-store" });
  res.end(await readFile(p));
}).listen(PORT, "localhost");

const browser = await chromium.launch();
const mock = new MockGitHub({ root: dir, branches: ["main"] });

async function open(as, { colorScheme = "light", width = 1440, mockOf = mock } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, colorScheme });
  await ctx.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const api = await useAdminApi(ctx, mockOf, { branch: "main", as, adminUrl: ADMIN });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return { ctx, page, api, errors };
}
const waitFor = async (page, fn, ms = 10000) => {
  const t0 = Date.now();
  while (!(await fn()) && Date.now() - t0 < ms) await page.waitForTimeout(100);
};


const T = "health";
const SHOTS = process.env.E2E_SHOTS === "1";
const loaded = (page) => waitFor(page, () => page.evaluate(() => !!document.querySelector("#hl-summary") && document.querySelector("#hl-summary").textContent !== "Loading…"), 20000);
const shot = (page, name) => (SHOTS ? page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false }) : null);

await step(T, "a problem is listed, grouped and openable", async () => {
  const { ctx, page, errors } = await open("Flanz1");
  await page.goto(ADMIN + "#health");
  await loaded(page);
  const summary = await page.textContent("#hl-summary");
  check(T, "the summary counts the problem with a glyph and text", /✕ 1 problem/.test(summary), summary);
  check(T, "the tab button shows the count, named \"Health, …\"", (await page.getAttribute("#tab-btn-health", "aria-label"))?.startsWith("Health, 1 problem"), await page.getAttribute("#tab-btn-health", "aria-label"));
  const group = page.locator('details[data-check="older-map"]');
  check(T, "the \"Drawn on a different map\" group is open and names the region", (await group.getAttribute("open")) !== null && (await group.textContent()).includes("old-map-region") && (await group.textContent()).includes("retired-map"));
  check(T, "checks with nothing found are named in one closing line", (await page.textContent("#tab-health")).includes("Also checked:"));
  await shot(page, "1440-light-problems");
  await page.click('details[data-check="older-map"] button.link');
  await waitFor(page, () => page.locator("#editor, .editor, dialog[open]").count().then((n) => n > 0), 10000);
  check(T, "the id opens the region", (await page.locator("dialog[open], .editor").count()) > 0);
  check(T, "no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
  for (const [width, scheme] of [[375, "light"], [768, "light"], [768, "dark"], [1440, "dark"], [375, "dark"]]) {
    const c = await open("Flanz1", { width, colorScheme: scheme });
    await c.page.goto(ADMIN + "#health");
    await loaded(c.page);
    if (width === 375) {
      const wide = await c.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      check(T, `no sideways scrolling at 375 (${scheme})`, !wide);
    }
    await shot(c.page, `${width}-${scheme}-problems`);
    await c.ctx.close();
  }
});

await step(T, "all clear once the problem is gone", async () => {
  rmSync(path.join(dir, "content/regions/old-map-region.json"));
  const clean = new MockGitHub({ root: dir, branches: ["main"] });
  const { ctx, page } = await open("Flanz1", { mockOf: clean });
  await page.goto(ADMIN + "#health");
  await loaded(page);
  check(T, "says all clear, once", (await page.textContent("#hl-summary")).includes("All clear") && (await page.textContent("#hl-summary")).includes("nothing to fix"));
  check(T, "no count on the tab", (await page.getAttribute("#tab-btn-health", "aria-label")) === "Health");
  await page.click("#tab-health button:has-text('Check again')");
  check(T, "Check again says so", (await page.textContent("#tab-health")).includes("Checked just now"));
  await shot(page, "1440-light-clear");
  await ctx.close();
  for (const [width, scheme] of [[375, "light"], [768, "dark"], [1440, "dark"]]) {
    const c = await open("Flanz1", { width, colorScheme: scheme, mockOf: clean });
    await c.page.goto(ADMIN + "#health");
    await loaded(c.page);
    await shot(c.page, `${width}-${scheme}-clear`);
    await c.ctx.close();
  }
});

await browser.close();
site.close();
const failed = results.filter((r) => !r.ok);
await writeFile(path.join(OUT, "report.json"), JSON.stringify({ results }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Report in ${OUT}`);
for (const f of failed) console.log(`  ✗ [${f.group}] ${f.name}: ${f.detail}`);
process.exit(failed.length ? 1 : 0);
