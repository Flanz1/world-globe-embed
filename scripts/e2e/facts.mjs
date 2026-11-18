// e2e-suite: roots=VIEWER weight=2
/**
 * Region cards with computed facts (npm run e2e:facts), in headless Chromium:
 *  1. The build writes facts/<region>.json (area share, bordering regions, pins inside); nothing is fetched
 *     before a click.
 *  2. Flat and globe region embeds: a click on a part opens a card with the area (checked against an independent
 *     calculation), "Borders with", "Pins here", set as plain text (a hostile region name stays text); a click
 *     off the region, Esc and × close it; a drag and the ruler don't open it; a pin card closes it.
 *  3. A part of a multi-part region shows its own label and the whole region's area.
 *  4. A failed facts request still shows the card, with a note; the loading state shows first.
 *  5. Phone width: the card clears the corner buttons.
 *
 * Screenshots and report.json go to .e2e/facts/. Exits non-zero if any check fails.
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

const OUT = path.resolve(".e2e/facts");
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

/* ── Fixture: the hostile-named box (-60..-50 × 0..10) gets a neighbour and a pin; a two-part region with labels ── */
const dir = await makeFixture({ quiet: true });
const box = (w, s, e, n) => [[w, s], [e, s], [e, n], [w, n], [w, s]];
const region = (id, name, rings, extra = {}) => ({
  $schema: "../../schema/region.schema.json",
  type: "Feature",
  id,
  properties: { name, slot: SLOT.slug, map: "landmarks", color: "#2e86de", fillOpacity: 0.3, label: true, updated: "2026-11-18T09:00:00Z", ...extra },
  geometry: rings.length === 1 ? { type: "Polygon", coordinates: [rings[0]] } : { type: "MultiPolygon", coordinates: rings.map((r) => [r]) },
});
const put = (file, data) => writeFileSync(path.join(dir, file), JSON.stringify(data, null, 2) + "\n");
put("content/regions/east-reach.json", region("east-reach", "East Reach", [box(-50, 0, -40, 10)], { color: "#e67e22" }));
put("content/regions/twin-isles.json", region("twin-isles", "Twin Isles", [box(20, -60, 30, -50), box(35, -60, 45, -50)], { partLabels: ["Greater Isle", "Lesser Isle"] }));
const OWNER = { id: 45669787, login: "Flanz1" };
const pinFile = (id, name, kind, at) => ({
  $schema: "../../schema/pin.schema.json",
  type: "Feature",
  id,
  properties: { slot: SLOT.slug, map: "landmarks", name, kind, createdBy: OWNER, created: "2026-11-18T09:00:00Z" },
  geometry: { type: "Point", coordinates: at },
});
await mkdir(path.join(dir, "content/pins"), { recursive: true });
put("content/pins/harbour.json", pinFile("harbour", "Hostile Harbour", "port", [-58, 2]));
put("content/pins/elsewhere.json", pinFile("elsewhere", "Far Away", "city", [100, 40]));
const slotsFile = path.join(dir, "content/slots.json");
const slots = JSON.parse(readFileSync(slotsFile, "utf8"));
slots.slots[SLOT.slug].radius = RADIUS;
writeFileSync(slotsFile, JSON.stringify(slots, null, 2) + "\n");
execFileSync("npm", ["run", "build"], { cwd: dir, env: { ...process.env }, stdio: "pipe" });
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
const HOSTILE = '"><script>alert(1)</script>';
const card = (page) => page.locator(".wfact");
const rows = (page) => page.evaluate(() => [...document.querySelectorAll(".wfact dl > *")].map((e) => e.textContent));
const num = (t) => Number(/([\d,.]+)\s*(million )?km²/.exec(t)?.[1].replace(/,/g, "")) * (/million km²/.test(t) ? 1e6 : 1);
/** Area in km² of the evil-name box (image lat 0..10, lon width 10°) on a sphere of RADIUS, in the slot's padded frame. */
const boxKm2 = () => {
  const lat = (v) => 90 - (SLOT.north / 100 + ((90 - v) / 180) * (1 - SLOT.north / 100 - SLOT.south / 100)) * 180;
  const r = (d) => (d * Math.PI) / 180;
  return RADIUS * RADIUS * r(10) * (Math.sin(r(lat(10))) - Math.sin(r(lat(0))));
};

/* ═════════════ 1. Build ═════════════ */
const B = "build";
await step(B, "facts files", async () => {
  const f = JSON.parse(readFileSync(path.join(DIST, "facts/evil-name.json"), "utf8"));
  check(B, "the build writes facts/<region>.json", f.v === 1 && f.p.length === 1 && f.p[0].a > 0, JSON.stringify(f).slice(0, 200));
  check(B, "it lists the bordering region and the pin inside", f.r.some((r) => r.id === "east-reach") && f.i.length === 1 && f.i[0].name === "Hostile Harbour", JSON.stringify(f));
  const t = JSON.parse(readFileSync(path.join(DIST, "facts/twin-isles.json"), "utf8"));
  check(B, "…and the parts of a multi-part region", t.p.length === 2 && !t.p[0].n && Math.abs(t.t - t.p[0].a - t.p[1].a) < 1e-9);
  check(B, "no personal data", !/createdBy|Flanz1/.test(JSON.stringify(f)));
});

/* ═════════════ 2. Embeds ═════════════ */
for (const view of ["flat", "globe"]) {
  const E = `embed-${view}`;
  await step(E, "card", async () => {
    const ctx = await browser.newContext({ viewport: { width: 900, height: 520 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    const dialogs = [];
    const requests = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("dialog", (d) => (dialogs.push(d.message()), d.dismiss()));
    ctx.on("request", (r) => requests.push(r.url()));
    await page.goto(`${SITE}/v/${SLOT.slug}/?region=evil-name&view=${view}&pins=1&rotate=0`);
    await ready(page);
    await page.waitForTimeout(500);
    check(E, "nothing is fetched before a click", !requests.some((u) => u.includes("/facts/")) && (await card(page).count()) === 1 && !(await card(page).isVisible()));

    const c = { x: 450, y: 260 };
    await page.mouse.click(c.x, c.y);
    await card(page).waitFor({ state: "visible" });
    await page.waitForSelector(".wfact dl");
    const title = await page.locator(".wfact h3").innerText();
    check(E, "the card names the region (hostile text stays text)", title === HOSTILE && (await page.locator(".wfact script").count()) === 0 && dialogs.length === 0, title);
    check(E, "it is a labelled dialog", (await card(page).getAttribute("role")) === "dialog" && /facts$/.test((await card(page).getAttribute("aria-label")) ?? ""));
    const r = await rows(page);
    const area = r[1] ?? "";
    check(E, "area matches an independent calculation", Math.abs(num(area) - boxKm2()) / boxKm2() < 0.02 && /of the world/.test(area), `${area} vs ${boxKm2().toFixed(0)} km²`);
    check(E, "a one-part region has no 'Whole region' row", !r.includes("Whole region"), r.join(" | "));
    check(E, "borders with the neighbouring region", r.includes("Borders with") && /East Reach/.test(r.join(" ")), r.join(" | "));
    check(E, "lists the pin inside, with its kind", /Hostile Harbour/.test(r.join(" ")) && /Port/.test(r.join(" ")), r.join(" | "));
    check(E, "facts were fetched once, on the click", requests.filter((u) => u.includes("/facts/")).length === 1);
    await page.screenshot({ path: path.join(OUT, `embed-${view}-card.png`) });
    const inked = () => page.evaluate(() => {
      const cv = document.querySelector(".wfact-hl");
      const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i]) return true;
      return false;
    });
    check(E, "the part is outlined while the card is open", await inked());
    const xb = await page.locator(".wfact .x").boundingBox();
    check(E, "× is a 32px button labelled Close", xb.width >= 32 && xb.height >= 32 && (await page.locator(".wfact .x").getAttribute("aria-label")) === "Close", `${xb.width}x${xb.height}`);

    await page.keyboard.press("Escape");
    check(E, "Esc closes it", !(await card(page).isVisible()));
    check(E, "…and the outline goes", !(await inked()));
    await page.mouse.click(c.x, c.y);
    await card(page).waitFor({ state: "visible" });
    await page.locator(".wfact .x").click();
    check(E, "× closes it", !(await card(page).isVisible()));
    await page.mouse.click(c.x, c.y);
    await card(page).waitFor({ state: "visible" });
    await page.mouse.click(8, 8);
    check(E, "a click off the region closes it", !(await card(page).isVisible()));

    // A pin card replaces it.
    await page.mouse.click(c.x, c.y);
    await card(page).waitFor({ state: "visible" });
    await page.locator('.wpin[data-name="Hostile Harbour"]').click();
    check(E, "opening a pin closes it", !(await card(page).isVisible()) && (await page.locator(".wpin-card").isVisible()));
    await page.mouse.click(c.x, c.y);
    check(E, "…and a click on the map brings it back", await card(page).isVisible());
    await page.mouse.click(8, 8);

    // A drag isn't a click (unlock first: a region embed starts locked).
    await page.locator("#btn-lock").click();
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x + 40, c.y + 10, { steps: 5 });
    await page.mouse.up();
    check(E, "a drag doesn't open it", !(await card(page).isVisible()));

    // The ruler is in charge while it's on.
    await page.locator("#btn-ruler").click();
    await page.mouse.click(c.x + 20, c.y);
    check(E, "ignored while the ruler is on", !(await card(page).isVisible()));
    check(E, "no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  });
}

/* ═════════════ 3. Multi-part region ═════════════ */
const M = "multi-part";
await step(M, "part label and whole region", async () => {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 520 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(`${SITE}/v/${SLOT.slug}/?region=twin-isles&view=flat&rotate=0&lock=0`);
  await ready(page);
  await page.waitForTimeout(500);
  // Two boxes 10° wide with a 5° gap, centred: the second one is right of the centre by about 10° of lon.
  const px = await page.evaluate(() => innerWidth);
  const tries = [[450 - 130, 260], [450 + 130, 260]];
  for (const [x, y] of tries) {
    await page.mouse.click(x, y);
    if (await card(page).isVisible()) break;
  }
  await card(page).waitFor({ state: "visible" });
  await page.waitForSelector(".wfact dl");
  const t = await page.locator(".wfact h3").innerText();
  const r = await rows(page);
  check(M, "the title is the part's own label, the region name under it", /Isle$/.test(t) && /Twin Isles/.test(await card(page).innerText()), `${t} (${px}px)`);
  check(M, "the whole region's area is listed too", r.includes("Whole region") && num(r[r.indexOf("Whole region") + 1]) > num(r[1]), r.join(" | "));
  check(M, "no neighbours or pins rows when there are none", !r.includes("Borders with") && !r.includes("Pins here"), r.join(" | "));
  await page.screenshot({ path: path.join(OUT, "embed-flat-multipart.png") });
  await ctx.close();
});

/* ═════════════ 4. Loading and failure ═════════════ */
const L = "states";
await step(L, "loading note, then a note when the facts can't be fetched", async () => {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 520 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  let release;
  const gate = new Promise((r) => (release = r));
  await page.route("**/facts/**", async (route) => {
    await gate;
    await route.abort();
  });
  await page.goto(`${SITE}/v/${SLOT.slug}/?region=evil-name&view=flat&rotate=0`);
  await ready(page);
  await page.waitForTimeout(400);
  await page.mouse.click(450, 260);
  await card(page).waitFor({ state: "visible" });
  check(L, "the title shows at once with a loading line", (await page.locator(".wfact h3").innerText()) === HOSTILE && /Loading facts/.test(await card(page).innerText()));
  await page.screenshot({ path: path.join(OUT, "embed-flat-loading.png") });
  release();
  await page.waitForFunction(() => /aren't available/.test(document.querySelector(".wfact")?.textContent ?? ""));
  check(L, "a failed request says so", /Facts aren't available right now/.test(await card(page).innerText()));
  await ctx.close();
});

/* ═════════════ 5. Phone ═════════════ */
const P = "phone";
await step(P, "375px", async () => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 560 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await page.goto(`${SITE}/v/${SLOT.slug}/?region=evil-name&view=flat&rotate=0&pins=1`);
  await ready(page);
  await page.waitForTimeout(400);
  await page.touchscreen.tap(190, 240);
  await card(page).waitFor({ state: "visible" });
  await page.waitForSelector(".wfact dl");
  const [c, ui] = await Promise.all([card(page).boundingBox(), page.locator("#ui").boundingBox()]);
  check(P, "the card sits above the corner buttons", c.y + c.height <= ui.y, `card bottom ${c.y + c.height}, buttons top ${ui.y}`);
  check(P, "…inside the viewport", c.x >= 0 && c.x + c.width <= 375);
  check(P, "touch moves focus to ×", await page.evaluate(() => document.activeElement?.classList.contains("x")));
  await page.screenshot({ path: path.join(OUT, "embed-375-card.png") });
  await ctx.close();
});

/* ═════════════ 6. Screenshots for the PR: 375 / 768 / 1440, flat and globe, multi-part region, loading state ═════════════ */
const S = "shots";
for (const [w, h] of [[375, 640], [768, 600], [1440, 800]]) {
  for (const view of ["flat", "globe"]) {
    await step(S, `${w}px ${view}`, async () => {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, hasTouch: w < 500, isMobile: w < 500 });
      const page = await ctx.newPage();
      await page.goto(`${SITE}/v/${SLOT.slug}/?region=twin-isles&view=${view}&rotate=0&pins=1`);
      await ready(page);
      await page.waitForTimeout(500);
      // The two isles flank the middle: try points either side of the centre, across the stage.
      let opened = false;
      for (const f of [0.3, 0.7, 0.25, 0.75, 0.35, 0.65, 0.2, 0.8, 0.4, 0.6]) {
        await page.mouse.click(w * f, h * 0.45);
        if (await card(page).isVisible()) {
          opened = true;
          break;
        }
      }
      check(S, `${w}px ${view}: a part opens the card`, opened);
      if (opened) await page.waitForSelector(".wfact dl");
      await page.screenshot({ path: path.join(OUT, `shot-${w}-${view}-multipart.png`) });
      await ctx.close();
    });
  }
  await step(S, `${w}px loading`, async () => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, hasTouch: w < 500, isMobile: w < 500 });
    const page = await ctx.newPage();
    await page.route("**/facts/**", () => {}); // never answers
    await page.goto(`${SITE}/v/${SLOT.slug}/?region=evil-name&view=flat&rotate=0&pins=1`);
    await ready(page);
    await page.waitForTimeout(400);
    await page.mouse.click(w / 2, h * 0.45);
    await card(page).waitFor({ state: "visible" });
    check(S, `${w}px: loading state`, /Loading facts/.test(await card(page).innerText()));
    await page.screenshot({ path: path.join(OUT, `shot-${w}-loading.png`) });
    await ctx.close();
  });
}

await browser.close();
site.close();
await writeFile(path.join(OUT, "report.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${OUT}`);
process.exit(failed.length ? 1 : 0);
