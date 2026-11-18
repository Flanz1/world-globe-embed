// e2e-suite: roots=VIEWER weight=2
/**
 * Embed corner buttons and the touch hint (npm run e2e:embed-ui): fixed labels, tooltips (delayed on hover, instant
 * on focus, Esc hides, never on touch), lock state mark, 44 px touch targets, and the one-time "drag to move" hint.
 * Screenshots and report.json go to .e2e/embed-ui/.
 */
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { makeFixture, SLOT } from "./fixture.mjs";

import { port } from "./ports.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const OUT = path.resolve(".e2e/embed-ui");
const BRANCH = "test/region-overlays";
const SITE = `http://localhost:${port(4173)}`;
const RADIUS = 6371;
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
const slotsFile = path.join(dir, "content/slots.json");
const slots = JSON.parse(readFileSync(slotsFile, "utf8"));
slots.slots[SLOT.slug].view = "flat";
slots.slots[SLOT.slug].radius = RADIUS;
writeFileSync(slotsFile, JSON.stringify(slots, null, 2) + "\n");
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
const ready = (frame) => frame.waitForFunction(() => ["hires", "interactive", "fallback"].includes(document.documentElement.dataset.state), null, { timeout: 30000 });
const tip = (page, id) => page.evaluate((i) => parseFloat(getComputedStyle(document.getElementById(i), "::after").opacity), id);
const URL_REGION = `${SITE}/v/${SLOT.slug}/?region=landmark-disc`;

const D = "desktop";
await step(D, "labels, tooltips and lock state", async () => {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 520 } });
  const page = await ctx.newPage();
  await page.goto(URL_REGION);
  await ready(page.mainFrame());
  const labels = await page.$$eval("#ui button:not([hidden])", (bs) => bs.map((b) => `${b.id}:${b.getAttribute("aria-label")}`));
  check(D, "every visible button has a label and no native title", labels.every((l) => !l.endsWith(":null")) && (await page.$$eval("#ui button[title]", (b) => b.length)) === 0, labels.join(", "));
  check(D, "lock label is fixed", (await page.locator("#btn-lock").getAttribute("aria-label")) === "Lock view");
  const size = await page.locator("#btn-grid").boundingBox();
  check(D, "mouse buttons stay 28 px", Math.round(size.width) === 28, String(size.width));

  await page.locator("#btn-grid").focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  // "At once" = no transition delay on focus (hover has one). Poll the opacity rather than a fixed wait, since busy CI lags the fade.
  const focusDelay = await page.evaluate(() => getComputedStyle(document.getElementById("btn-grid"), "::after").transitionDelay);
  await page.waitForFunction(() => parseFloat(getComputedStyle(document.getElementById("btn-grid"), "::after").opacity) > 0.9, null, { timeout: 3000 }).catch(() => {});
  check(D, "focus shows the tooltip at once", /^0s(,|$)/.test(focusDelay) && (await tip(page, "btn-grid")) > 0.9, `delay ${focusDelay}`);
  await page.screenshot({ path: path.join(OUT, "desktop-tooltip.png") });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  check(D, "Esc hides it", (await tip(page, "btn-grid")) < 0.1);
  await page.mouse.move(5, 5);
  await page.locator("#btn-fs").hover();
  await page.waitForTimeout(150);
  check(D, "hover waits before showing", (await tip(page, "btn-fs")) < 0.5);
  await page.waitForTimeout(700);
  check(D, "…and shows it after the delay", (await tip(page, "btn-fs")) > 0.9);

  const mark = (id) => page.evaluate((i) => { const c = getComputedStyle(document.getElementById(i), "::before"); return `${c.width}x${c.height}`; }, id);
  const locked = await mark("btn-lock");
  await page.locator("#btn-lock").click();
  const unlocked = await mark("btn-lock");
  check(D, "lock shows a different mark locked (tick) and unlocked (slash)", locked !== unlocked && (await page.locator("#btn-lock").getAttribute("aria-pressed")) === "false", `${locked} → ${unlocked}`);
  await page.locator("#btn-lock").focus();
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, "desktop-unlocked.png") });
  check(D, "no hint on a mouse device", (await page.locator("#hint").count()) === 0);
  await ctx.close();
});

const T = "touch";
await step(T, "44 px targets, no tooltip, one hint that goes at the first touch", async () => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 640 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(`${SITE}/v/${SLOT.slug}/`);
  await ready(page.mainFrame());
  const b = await page.locator("#btn-grid").boundingBox();
  check(T, "buttons are 44 px", Math.round(b.width) === 44 && Math.round(b.height) === 44, `${b.width}x${b.height}`);
  await page.waitForSelector("#hint.on", { timeout: 5000 });
  check(T, "the hint shows", (await page.locator("#hint").getAttribute("aria-hidden")) === "true" && /Drag to move/.test(await page.locator("#hint").innerText()));
  await page.screenshot({ path: path.join(OUT, "touch-hint.png") });
  await page.touchscreen.tap(100, 200);
  await page.waitForTimeout(700);
  check(T, "a touch removes it", (await page.locator("#hint").count()) === 0);
  const p2 = await ctx.newPage();
  await p2.goto(`${SITE}/v/${SLOT.slug}/`);
  await ready(p2.mainFrame());
  await p2.waitForSelector("#hint.on", { timeout: 5000 });
  await p2.waitForTimeout(3600);
  check(T, "it also goes by itself after ~3 s", (await p2.locator("#hint").count()) === 0);
  const p3 = await ctx.newPage();
  await p3.goto(`${URL_REGION}`);
  await ready(p3.mainFrame());
  await p3.waitForTimeout(2000);
  check(T, "a locked region embed shows no hint", (await p3.locator("#hint").count()) === 0);
  const p4 = await ctx.newPage();
  await p4.goto(`${SITE}/v/${SLOT.slug}/?controls=0`);
  await ready(p4.mainFrame());
  await p4.waitForTimeout(2000);
  check(T, "controls=0 shows no hint", (await p4.locator("#hint").count()) === 0);
  await ctx.close();
});

const S = "shots";
await step(S, "screenshots at 375/768/1440 (locked, tooltip on the lock)", async () => {
  for (const [w, h] of [[375, 640], [768, 600], [1440, 800]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    await page.goto(URL_REGION);
    await ready(page.mainFrame());
    await page.locator("#btn-lock").focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(OUT, `${w}-locked-tooltip.png`) });
    check(S, `${w}: no element wider than the screen`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await ctx.close();
  }
});

await writeFile(path.join(OUT, "report.json"), JSON.stringify(results, null, 2));
await browser.close();
site.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
