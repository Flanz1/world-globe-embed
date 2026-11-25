// e2e-suite: roots=VIEWER weight=2
/**
 * Browser checks for stacked regions in the embed, in headless Chromium.
 *
 *   npm run e2e:stack
 *
 * 1. A region with underlays (properties.under): they're drawn over it, each with a legend toggle named and
 *    started on/off as set, under the set heading; toggling one redraws; under=0 leaves them out.
 * 2. ?regions=a,b: stacks the regions, a toggle each, no contest marks across regions.
 *
 * Exits non-zero if any check fails. Screenshots go to .e2e/stack/.
 */
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { makeFixture, SLOT } from "./fixture.mjs";

import { port } from "./ports.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const OUT = path.resolve(".e2e/stack");
const SITE = `http://localhost:${port(4173)}`;
await mkdir(OUT, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` (${detail})` : ""}`);
}

const dir = await makeFixture({ quiet: true });
const file = path.join(dir, "content/regions/provinces.json");
const f = JSON.parse(readFileSync(file, "utf8"));
f.properties.layerGroups = [
  { name: "Magenta layer", regions: [{ id: "landmark-disc" }], on: true },
  { name: "Yellow layer", regions: [{ id: "dateline-box" }], on: false },
];
f.properties.layerLabel = "Provinces";
writeFileSync(file, JSON.stringify(f, null, 2) + "\n");
// A group of two regions: one switch, one section.
const grouped = structuredClone(f);
grouped.id = "grouped";
grouped.properties.layerGroups = [{ name: "Overlays", regions: [{ id: "landmark-disc" }, { id: "dateline-box" }], on: true, fill: 0.6 }];
writeFileSync(path.join(dir, "content/regions/grouped.json"), JSON.stringify(grouped, null, 2) + "\n");
execFileSync("npm", ["run", "build"], { cwd: dir, stdio: "pipe" });
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
const ready = (page) => page.waitForFunction(() => ["hires", "interactive", "fallback"].includes(document.documentElement.dataset.state), null, { timeout: 30000 });
const names = (page) => page.locator(".rlayers label span").allTextContents();
const checked = (page) => page.locator(".rlayers input").evaluateAll((els) => els.map((e) => e.checked));

try {
  for (const view of ["flat", "globe"]) {
    const ctx = await browser.newContext({ viewport: { width: 900, height: 520 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${SITE}/v/${SLOT.slug}/?region=provinces&view=${view}`);
    await ready(page);
    await page.waitForSelector(".rlayers label", { timeout: 15000 });
    check(`[${view}] toggles use the names set in the editor`, JSON.stringify(await names(page)) === JSON.stringify(["Magenta layer", "Yellow layer"]), (await names(page)).join(" | "));
    check(`[${view}] starts as set (on, off)`, JSON.stringify(await checked(page)) === JSON.stringify([true, false]));
    const before = await page.locator("#globe, canvas").first().screenshot();
    await page.locator(".rlayers label", { hasText: "Yellow layer" }).locator("input").check();
    await page.waitForTimeout(500);
    check(`[${view}] toggling a layer on redraws`, !before.equals(await page.locator("#globe, canvas").first().screenshot()));
    await page.screenshot({ path: path.join(OUT, `underlay-${view}.png`) });
    check(`[${view}] the region itself has no toggle`, !(await names(page)).includes("Provinces"));
    await page.locator(".rlayers label", { hasText: "Magenta layer" }).locator("input").uncheck();
    await page.locator(".rlayers label", { hasText: "Yellow layer" }).locator("input").uncheck();
    await page.waitForTimeout(200);
    check(`[${view}] both underlays can be switched off (the region stays)`, (await checked(page)).every((c) => !c));
    check(`[${view}] no page errors`, errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  const ctx = await browser.newContext({ viewport: { width: 900, height: 520 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${SITE}/v/${SLOT.slug}/?region=grouped&view=flat`);
  await ready(page);
  await page.waitForSelector(".rgroup", { timeout: 15000 });
  check("a group of two regions is one section with one switch", (await page.locator(".rgroup").count()) === 1 && (await names(page)).join("|") === "Overlays" && (await checked(page)).join() === "true");
  const keysOn = await page.locator(".rgroup-keys li").allTextContents();
  await page.setViewportSize({ width: 375, height: 700 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, "embed-groups-375.png") });
  await page.setViewportSize({ width: 900, height: 520 });
  await page.locator(".rgroup input").uncheck();
  check("switching the group off folds its colour keys", await page.locator(".rgroup-keys").evaluate((e) => !e || e.hidden).catch(() => true), keysOn.join("|"));
  await page.locator(".rgroup input").check();
  await page.goto(`${SITE}/v/${SLOT.slug}/?region=provinces&view=flat&under=0`);
  await ready(page);
  await page.waitForTimeout(500);
  check("under=0 leaves the underlays out", (await page.locator(".rlayers").count()) === 0 || !(await page.locator(".rlayers").first().isVisible()));

  await page.goto(`${SITE}/v/${SLOT.slug}/?regions=landmark-disc,dateline-box&view=flat`);
  await ready(page);
  await page.waitForSelector(".rlayers label", { timeout: 15000 });
  check("?regions=a,b: a toggle each, both on", JSON.stringify(await checked(page)) === JSON.stringify([true, true]) && (await names(page)).length === 2);
  check("…no contested row in the legend", (await page.locator(".rkey-contested").count()) === 0);
  await page.locator(".rlayers input").nth(0).uncheck();
  await page.locator(".rlayers input").nth(1).click(); // refused: snaps back
  await page.waitForTimeout(200);
  check("?regions=a,b: the last shown layer can't be switched off", (await checked(page)).filter(Boolean).length === 1);
  // A stacked region brings its own underlays (each its own toggle, off/on as set); under=0 leaves them out.
  await page.goto(`${SITE}/v/${SLOT.slug}/?regions=provinces,landmark-disc&view=flat`);
  await ready(page);
  await page.waitForSelector(".rlayers label", { timeout: 15000 });
  const stackNames = await names(page);
  check("?regions= with a region that has underlays: its underlays get toggles", stackNames.includes("Magenta layer") && stackNames.includes("Yellow layer"), stackNames.join("|"));
  await page.goto(`${SITE}/v/${SLOT.slug}/?regions=provinces,landmark-disc&view=flat&under=0`);
  await ready(page);
  await page.waitForSelector(".rlayers label", { timeout: 15000 });
  check("…under=0 leaves them out", !(await names(page)).includes("Magenta layer"));
  await page.goto(`${SITE}/v/${SLOT.slug}/?regions=landmark-disc,dateline-box&view=flat&toggle=0`);
  await ready(page);
  await page.waitForTimeout(500);
  check("toggle=0 hides the toggles", (await page.locator(".rlayers label").count()) === 0);
  await page.goto(`${SITE}/v/${SLOT.slug}/?regions=nope,also-nope&view=flat`);
  await ready(page).catch(() => {});
  check("unknown regions: a note, no crash", (await page.locator(".rnote").count()) > 0);
  check("no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
} finally {
  await browser.close();
  site.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
