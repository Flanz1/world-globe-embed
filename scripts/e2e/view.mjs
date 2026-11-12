/**
 * Browser checks for the slot's default view (globe or flat map), in headless Chromium.
 *
 *   npm run e2e:view
 *
 * 1. Embeds: a slot with view "flat" opens flat (no Three.js), ?view=globe overrides it, and the
 *    corner switch shows on plain slot embeds and swaps the view.
 * 2. Admin preview: the Default view switch reloads the iframe in the chosen view, keeps the
 *    padding and grid live in the flat view, and "Save to slot" commits view to slots.json
 *    (and removes it again when set back to globe).
 *
 * Screenshots and report.json go to .e2e/view/. Exits non-zero if any check fails.
 */
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { makeFixture, SLOT } from "./fixture.mjs";
import { MockGitHub } from "./mock-github.mjs";

import { port } from "./ports.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const OUT = path.resolve(".e2e/view");
const BRANCH = "test/region-overlays";
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

/* ── Fixture: the alignment slot defaults to the flat map ── */
const dir = await makeFixture({ quiet: true });
const slotsFile = path.join(dir, "content/slots.json");
const slots = JSON.parse(readFileSync(slotsFile, "utf8"));
slots.slots[SLOT.slug].view = "flat";
writeFileSync(slotsFile, JSON.stringify(slots, null, 2) + "\n");
execFileSync("npm", ["run", "build"], { cwd: dir, env: { ...process.env, VITE_CONTENT_BRANCH: BRANCH }, stdio: "pipe" });
const DIST = path.join(dir, "dist");
console.log(`Fixture: ${dir}`);

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".json": "application/json" };
const site = createServer(async (req, res) => {
  let p = path.join(DIST, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (existsSync(p) && statSync(p).isDirectory()) p = path.join(p, "index.html");
  if (!p.startsWith(DIST) || !existsSync(p)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] ?? "application/octet-stream", "Cache-Control": "no-store" });
  res.end(await readFile(p));
}).listen(port(4173), "localhost");

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const ready = (frame) => frame.waitForFunction(() => ["hires", "interactive", "fallback"].includes(document.documentElement.dataset.state), null, { timeout: 30000 });
const isFlat = (frame) => frame.evaluate(() => document.documentElement.classList.contains("flatview"));

/* ═════════════ 1. Embeds ═════════════ */
const E = "embed";
await step(E, "slot defaults", async () => {
  const ctx = await browser.newContext({ viewport: { width: 800, height: 480 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  const requests = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  ctx.on("request", (r) => requests.push(r.url()));

  await page.goto(`${SITE}/v/${SLOT.slug}/`);
  await ready(page.mainFrame());
  check(E, "flat-default slot opens on the flat map", await isFlat(page.mainFrame()));
  check(E, "…without loading Three.js", !requests.some((u) => /globe-[^/]*\.js|three/i.test(u)), requests.filter((u) => u.endsWith(".js")).map((u) => u.split("/").pop()).join(", "));
  const vb = page.locator("#btn-view");
  check(E, "corner switch shows on a plain slot embed", await vb.isVisible());
  check(E, "…labelled for the other view", (await vb.getAttribute("aria-label")) === "Show globe");
  await page.screenshot({ path: path.join(OUT, "embed-flat-default.png") });
  await vb.click();
  await page.waitForURL(/view=globe/);
  await ready(page.mainFrame());
  check(E, "switch opens the globe", !(await isFlat(page.mainFrame())) && (await page.locator("#btn-view").getAttribute("aria-label")) === "Show flat map");

  await page.goto(`${SITE}/v/${SLOT.slug}/?view=globe`);
  await ready(page.mainFrame());
  check(E, "?view=globe overrides the slot's default", !(await isFlat(page.mainFrame())));

  await page.goto(`${SITE}/v/inara/`);
  await ready(page.mainFrame());
  check(E, "slot without view still opens on the globe", !(await isFlat(page.mainFrame())));
  await page.goto(`${SITE}/v/${SLOT.slug}/?controls=0`);
  await ready(page.mainFrame());
  check(E, "controls=0 hides the switch", !(await page.locator("#btn-view").isVisible()));
  check(E, "no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
});

/* ═════════════ 2. Admin preview ═════════════ */
const A = "admin";
const mock = new MockGitHub({ root: dir });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await ctx.route("https://api.github.com/**", (r) => mock.handle(r));
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const slotsOnBranch = () => JSON.parse(mock.read(BRANCH, "content/slots.json").toString()).slots;
const waitCommit = async (n) => {
  const t0 = Date.now();
  while (mock.log.length <= n && Date.now() - t0 < 15000) await page.waitForTimeout(100);
  await page.waitForTimeout(300);
};
const frame = () => page.frame({ url: /\/preview\// });
const openSlotPreview = async (slug) => {
  await page.locator(".slot", { has: page.locator("code", { hasText: slug }) }).getByRole("button", { name: "Preview" }).click();
  await page.waitForSelector("dialog#preview[open]");
  await page.waitForTimeout(300);
  await ready(frame());
};

await step(A, "default view in the preview", async () => {
  await page.goto(`${SITE}/admin/`);
  await page.fill("#token", "ghp_e2etoken");
  await page.click('#signin-form button[type="submit"]');
  await page.waitForSelector("#slots .slot", { timeout: 15000 });

  await openSlotPreview(SLOT.slug);
  check(A, "opens in the slot's saved view (flat)", (await page.getAttribute("#pv-view-flat", "aria-pressed")) === "true" && (await isFlat(frame())));
  check(A, "preview iframe has no corner switch of its own", !(await frame().locator("#btn-view").isVisible()));
  // Live settings reach the flat viewer: turning the grid on changes the picture.
  const before = await frame().locator("#globe").screenshot();
  await page.check("#pv-grid");
  await page.waitForTimeout(300);
  const after = await frame().locator("#globe").screenshot();
  check(A, "grid toggles live on the flat map", Buffer.compare(before, after) !== 0);
  await page.screenshot({ path: path.join(OUT, "admin-preview-flat.png") });

  await page.click("#pv-view-globe");
  await page.waitForTimeout(300);
  await ready(frame());
  check(A, "switching to Globe reloads the iframe as the globe", !(await isFlat(frame())) && /view=globe/.test(frame().url()));
  check(A, "…keeping the settings", /grid=1/.test(frame().url()) && new RegExp(`north=${SLOT.north}\\b`).test(frame().url()), frame().url());
  await page.screenshot({ path: path.join(OUT, "admin-preview-globe.png") });

  let n = mock.log.length;
  await page.click("#pv-save");
  await waitCommit(n);
  let s = slotsOnBranch()[SLOT.slug];
  check(A, "saving Globe removes view from slots.json", mock.log.length === n + 1 && !("view" in s), JSON.stringify(s));
  check(A, "commit message names the view", /globe view/.test(mock.log.at(-1)?.message ?? ""), mock.log.at(-1)?.message);

  await page.waitForSelector("#slots .slot", { timeout: 15000 });
  await page.waitForTimeout(500);
  await openSlotPreview("inara");
  check(A, "slot without view opens as Globe", (await page.getAttribute("#pv-view-globe", "aria-pressed")) === "true");
  await page.click("#pv-view-flat");
  await page.waitForTimeout(300);
  await ready(frame());
  check(A, "switching to Flat map reloads as the flat map", await isFlat(frame()));
  n = mock.log.length;
  await page.click("#pv-save");
  await waitCommit(n);
  s = slotsOnBranch().inara;
  check(A, "saving Flat map writes view: flat", s.view === "flat", JSON.stringify(s));
  check(A, "nothing written to main", mock.log.every((c) => c.branch === BRANCH));
  check(A, "no page errors", errors.length === 0, errors.join(" | "));
});

await browser.close();
site.close();
await writeFile(path.join(OUT, "report.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${OUT}`);
process.exit(failed.length ? 1 : 0);
