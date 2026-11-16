// e2e-suite: roots=ADMIN,WORKER,src/shared/hct.ts weight=1
/**
 * Browser checks for the per-account colour theme: the accent colour menu and the sun/moon switch in the
 * admin header, that a choice is saved to the account through the admin API (PUT /prefs) and comes back at
 * sign-in even with the browser's own storage cleared, that two accounts keep their own, that the page paints
 * in the cached colours before the API answers, and that the API refuses values that aren't a theme.
 *
 *   npm run e2e:theme
 */
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { makeFixture } from "./fixture.mjs";
import { MockGitHub } from "./mock-github.mjs";
import { ADMIN_API, useAdminApi } from "./admin-api.mjs";
import { port } from "./ports.mjs";
import { contrast, schemeFromSeed } from "../../src/shared/hct.ts";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const OUT = path.resolve(".e2e/theme");
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

async function open(as, { colorScheme = "light" } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme });
  await ctx.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const api = await useAdminApi(ctx, mock, { branch: "main", as, adminUrl: ADMIN });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return { ctx, page, api, errors };
}
const token = (page, name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
const waitFor = async (page, fn, ms = 10000) => {
  const t0 = Date.now();
  while (!(await fn()) && Date.now() - t0 < ms) await page.waitForTimeout(100);
};
const puts = (api) => api.requests.filter((r) => r.method === "PUT" && r.url.endsWith("/prefs")).length;
const signedIn = (page) => page.waitForSelector("#theme-ctl:not([hidden]) .theme-swatch", { timeout: 15000 });
const GOLD = schemeFromSeed("#8a6a1f", false);
const SEA = schemeFromSeed("#036879", false);
const SEA_DARK = schemeFromSeed("#036879", true);

const T = "theme";
await step(T, "default, picking a preset, and the switch", async () => {
  const { ctx, page, api, errors } = await open("Flanz1");
  await page.goto(ADMIN);
  await signedIn(page);
  check(T, "the header has the colour swatch and the dark-mode switch", (await page.locator('.theme-swatch[aria-label="Colour theme"]').count()) === 1 && (await page.locator('.theme-mode[aria-label="Dark mode"]').count()) === 1);
  check(T, "an account that never chose is Gold and follows the system (light here)", (await token(page, "--md-sys-color-primary")) === GOLD.primary && (await page.getAttribute(".theme-mode", "aria-pressed")) === "false");
  await page.click(".theme-swatch");
  check(T, "the menu lists 8 presets, Custom… and the three modes", (await page.locator('.theme-menu [data-group="seed"]').count()) === 8 && (await page.locator(".theme-custom").count()) === 1 && (await page.locator('.theme-menu [data-group="mode"]').count()) === 3);
  await waitFor(page, () => page.evaluate(() => !!document.activeElement?.closest(".theme-menu")));
  check(T, "focus moves into the menu and Gold shows as chosen", (await page.getAttribute('.theme-menu [data-group="seed"][aria-checked="true"]', "aria-checked")) === "true" && (await page.evaluate(() => !!document.activeElement?.closest(".theme-menu"))));
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  check(T, "arrow keys and Enter pick a colour (Sea is next after Gold)", (await token(page, "--md-sys-color-primary")) === SEA.primary, await token(page, "--md-sys-color-primary"));
  await page.keyboard.press("Escape");
  check(T, "Escape closes the menu and focus returns to the swatch", !(await page.locator(".theme-menu").evaluate((m) => m.matches(":popover-open"))) && (await page.evaluate(() => document.activeElement?.classList.contains("theme-swatch"))));
  const [p, on] = [await token(page, "--md-sys-color-primary"), await token(page, "--md-sys-color-on-primary")];
  check(T, "primary on on-primary keeps AA contrast", contrast(p, on) >= 4.5, contrast(p, on).toFixed(2));
  await page.screenshot({ path: path.join(OUT, "sea-light.png") });
  await page.click(".theme-mode");
  check(T, "the switch goes dark: pressed, data-theme=dark, dark tokens", (await page.getAttribute(".theme-mode", "aria-pressed")) === "true" && (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark" && (await token(page, "--md-sys-color-primary")) === SEA_DARK.primary);
  await page.screenshot({ path: path.join(OUT, "sea-dark.png") });
  await waitFor(page, async () => puts(api) >= 1);
  check(T, "the choices were saved to the account with one write (debounced), none on page load", puts(api) === 1, `${puts(api)} PUT /prefs`);
  check(T, "no CSP violations or page errors", (await page.evaluate(() => window.__csp)).length === 0 && errors.length === 0, [...(await page.evaluate(() => window.__csp)), ...errors].join(" | ") || "none");
  await ctx.close();
});

await step(T, "kept per account across browsers", async () => {
  // Same account, a fresh browser with nothing stored: the API hands the choice back.
  const a = await open("Flanz1");
  await a.page.goto(ADMIN);
  await signedIn(a.page);
  check(T, "a fresh browser gets Sea and dark from the API", (await token(a.page, "--md-sys-color-primary")) === SEA_DARK.primary && (await a.page.evaluate(() => document.documentElement.dataset.theme)) === "dark");
  await a.page.evaluate(() => localStorage.clear());
  await a.page.reload();
  await signedIn(a.page);
  check(T, "with localStorage cleared and the page reloaded, the choice still comes back", (await token(a.page, "--md-sys-color-primary")) === SEA_DARK.primary);
  check(T, "page load made no write", puts(a.api) === 0, `${puts(a.api)}`);

  // A second account keeps its own colour, and a custom colour is accepted.
  const b = await open("carto-ann");
  await b.page.goto(ADMIN);
  await signedIn(b.page);
  check(T, "another account still has Gold and the system mode", (await token(b.page, "--md-sys-color-primary")) === GOLD.primary && (await b.page.evaluate(() => document.documentElement.dataset.theme)) === undefined);
  await b.page.click(".theme-swatch");
  await b.page.fill(".theme-custom input", "#336699");
  await waitFor(b.page, async () => puts(b.api) >= 1);
  check(T, "a custom colour applies and is saved", (await token(b.page, "--md-sys-color-primary")) === schemeFromSeed("#336699", false).primary && puts(b.api) === 1);
  await b.page.keyboard.press("Escape");
  await b.page.screenshot({ path: path.join(OUT, "custom.png") });
  await a.page.reload();
  await signedIn(a.page);
  check(T, "the first account is unchanged", (await token(a.page, "--md-sys-color-primary")) === SEA_DARK.primary);
  await b.page.evaluate(() => localStorage.clear());
  await b.page.reload();
  await signedIn(b.page);
  check(T, "the custom colour comes back from the API", (await token(b.page, "--md-sys-color-primary")) === schemeFromSeed("#336699", false).primary);
  check(T, "no page errors", a.errors.length === 0 && b.errors.length === 0, [...a.errors, ...b.errors].join(" | ") || "none");
  await a.ctx.close();
  await b.ctx.close();
});

await step(T, "no flash: painted from the cache before the API answers", async () => {
  const { ctx, page } = await open("Flanz1");
  await page.goto(ADMIN);
  await signedIn(page);
  // Now the API goes away: the cached colours must still be there at once.
  await ctx.route(`${ADMIN_API}/**`, (r) => r.abort());
  await page.reload({ waitUntil: "domcontentloaded" });
  check(T, "the boot script sets the cached colours on <html> (no API, no flash of Gold)", (await page.evaluate(() => document.documentElement.style.getPropertyValue("--md-sys-color-primary"))) === SEA_DARK.primary);
  await page.screenshot({ path: path.join(OUT, "offline-cache.png") });
  await ctx.close();
});

await step(T, "system mode follows the OS", async () => {
  const { ctx, page } = await open("Flanz1", { colorScheme: "dark" });
  await page.goto(ADMIN);
  await signedIn(page);
  await page.click(".theme-swatch");
  await page.click('.theme-menu [data-group="mode"]:has-text("Follow system")');
  await page.keyboard.press("Escape");
  check(T, "Follow system: no forced data-theme, dark when the system is dark", (await page.evaluate(() => document.documentElement.dataset.theme)) === undefined && (await page.getAttribute(".theme-mode", "aria-pressed")) === "true" && (await token(page, "--md-sys-color-primary")) === SEA_DARK.primary);
  await page.emulateMedia({ colorScheme: "light" });
  await waitFor(page, async () => (await token(page, "--md-sys-color-primary")) === SEA.primary);
  check(T, "and it follows a change of the system setting", (await token(page, "--md-sys-color-primary")) === SEA.primary && (await page.getAttribute(".theme-mode", "aria-pressed")) === "false");
  await ctx.close();
});

await step(T, "editor has the switch too", async () => {
  const { ctx, page } = await open("Flanz1");
  await page.goto(ADMIN);
  await signedIn(page);
  await page.click("#tab-btn-regions");
  await page.waitForSelector("#regions .rcard", { state: "visible", timeout: 15000 });
  await page.click('#regions [data-region="landmark-disc"] [data-action="edit"]');
  await page.waitForSelector("dialog.editor .theme-mode", { timeout: 15000 });
  const before = await page.getAttribute("dialog.editor .theme-mode", "aria-pressed");
  await page.click("dialog.editor .theme-mode");
  check(T, "the editor's header switch flips light and dark", (await page.getAttribute("dialog.editor .theme-mode", "aria-pressed")) !== before);
  await page.screenshot({ path: path.join(OUT, "editor.png") });
  await ctx.close();
});

await step(T, "header and menu fit at phone, tablet and desktop widths", async () => {
  for (const width of [375, 768, 1440]) {
    for (const scheme of ["light", "dark"]) {
      const { ctx, page } = await open("Flanz1", { colorScheme: scheme });
      await page.setViewportSize({ width, height: 800 });
      await page.goto(ADMIN);
      await signedIn(page);
      await page.click(".theme-swatch");
      const box = await page.locator(".theme-menu").boundingBox();
      const fits = !!box && box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 800;
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      check(T, `${width}px ${scheme}: the menu is on screen and the page doesn't scroll sideways`, fits && !overflow, `${JSON.stringify(box)} overflow=${overflow}`);
      await page.screenshot({ path: path.join(OUT, `${width}-${scheme}-menu.png`) });
      await ctx.close();
    }
  }
});

await step(T, "the API refuses what isn't a theme", async () => {
  const { ctx, page } = await open("Flanz1");
  await page.goto(ADMIN);
  await signedIn(page);
  const put = (body) =>
    page.evaluate(
      async ({ api, body }) => {
        const t = sessionStorage.getItem("wge-admin-session");
        const r = await fetch(`${api}/prefs`, { method: "PUT", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
        return r.status;
      },
      { api: ADMIN_API, body },
    );
  const bad = [{}, { seed: "red", mode: "dark" }, { seed: "#8A6A1F", mode: "dark" }, { seed: "#8a6a1f", mode: "auto" }, { seed: "#8a6a1f", mode: "dark", extra: 1 }, { seed: "url(x)", mode: "dark" }];
  const statuses = [];
  for (const b of bad) statuses.push(await put(b));
  check(T, "bad values get 400", statuses.every((s) => s === 400), statuses.join(","));
  check(T, "a good value gets 200", (await put({ seed: "#8a6a1f", mode: "light" })) === 200);
  await ctx.close();
});

await browser.close();
site.close();
const failed = results.filter((r) => !r.ok);
await writeFile(path.join(OUT, "report.json"), JSON.stringify({ results }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots and report.json in ${OUT}`);
for (const f of failed) console.log(`  ✗ [${f.group}] ${f.name}: ${f.detail}`);
process.exit(failed.length ? 1 : 0);
