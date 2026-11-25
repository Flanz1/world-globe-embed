// e2e-suite: roots=ADMIN,src/admin/warp.ts,src/shared/warp.ts weight=1
/**
 * Browser checks for "Warp regions…" (Maps & slots → a slot's More… menu), in headless Chromium.
 *
 *   npm run e2e:warp
 *
 * The slot "align" is switched to a redrawn copy of its map (landmarks-v2), so its regions show the usual
 * "drawn on a different map" badge and nothing opens by itself. The owner opens the tool from More…, places point
 * pairs that move everything 10° east, sees Apply stay disabled until 3 pairs, sees the per-pair error from 4 pairs,
 * applies (one save here), and every region and the pin move 10° east onto landmarks-v2. Someone with Maps but not
 * "edit others" gets no Warp item. Screenshots at 1440, 768 and 375 px in light and dark go to .e2e/warp/.
 *
 * Runs against the mock GitHub and admin API (no live data).
 */
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { makeFixture, MAP, SLOT } from "./fixture.mjs";
import { MockGitHub } from "./mock-github.mjs";
import { useAdminApi } from "./admin-api.mjs";
import { port } from "./ports.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const OUT = path.resolve(".e2e/warp");
const BRANCH = "test/warp";
const SITE = `http://localhost:${port(4173)}`;
const NEW = "landmarks-v2";
await mkdir(OUT, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` (${detail})` : ""}`);
}

const dir = await makeFixture({ quiet: true });
// A "redrawn" map: the same picture under a new id, which the slot now shows.
const meta = JSON.parse(readFileSync(path.join(dir, `content/maps/${MAP.id}.json`), "utf8"));
writeFileSync(path.join(dir, `content/maps/${NEW}.json`), JSON.stringify({ ...meta, id: NEW, name: "Landmarks redrawn", date: "2026-11-18T08:00:00.000Z" }, null, 2) + "\n");
const slotsFile = path.join(dir, "content/slots.json");
const slots = JSON.parse(readFileSync(slotsFile, "utf8"));
slots.slots[SLOT.slug].map = NEW;
// A world size, so errors read in km.
slots.slots[SLOT.slug].radius = 6000;
writeFileSync(slotsFile, JSON.stringify(slots, null, 2) + "\n");
// One pin on the slot, on the old map.
writeFileSync(
  path.join(dir, "content/pins/warp-pin.json"),
  JSON.stringify({ $schema: "../../schema/pin.schema.json", type: "Feature", id: "warp-pin", properties: { slot: SLOT.slug, map: MAP.id, name: "Warp Pin", kind: "city" }, geometry: { type: "Point", coordinates: [30, 20] } }, null, 2) + "\n",
);
// Someone who may change maps but not other people's regions.
const accessFile = path.join(dir, "content/access.json");
const access = JSON.parse(readFileSync(accessFile, "utf8"));
access.users.push({ id: 5003, login: "drafter-bo", permissions: ["maps", "regions"] });
writeFileSync(accessFile, JSON.stringify(access, null, 2) + "\n");
execFileSync("npm", ["run", "build"], { cwd: dir, env: { ...process.env, VITE_CONTENT_BRANCH: BRANCH }, stdio: "pipe" });
const DIST = path.join(dir, "dist");

const before = Object.fromEntries(
  readdirSync(path.join(dir, "content/regions"))
    .map((f) => JSON.parse(readFileSync(path.join(dir, "content/regions", f), "utf8")))
    .filter((r) => r.properties.slot === SLOT.slug && r.properties.map === MAP.id)
    .map((r) => [r.id, r]),
);

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".json": "application/json" };
const site = createServer(async (req, res) => {
  let p = path.join(DIST, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (existsSync(p) && statSync(p).isDirectory()) p = path.join(p, "index.html");
  if (!p.startsWith(DIST) || !existsSync(p)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] ?? "application/octet-stream", "Cache-Control": "no-store" });
  res.end(await readFile(p));
}).listen(port(4173), "localhost");

const browser = await chromium.launch();
const mock = new MockGitHub({ root: dir, branches: ["main", BRANCH] });
const onBranch = (p) => (mock.read(BRANCH, p) ? JSON.parse(mock.read(BRANCH, p).toString()) : null);
const waitCommit = async (page, n) => {
  const t0 = Date.now();
  while (mock.log.length <= n && Date.now() - t0 < 20000) await page.waitForTimeout(100);
  await page.waitForTimeout(400);
};
async function adminPage(as, viewport = { width: 1440, height: 900 }, scheme = "light", storage = null) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: scheme });
  if (storage) await ctx.addInitScript((s) => Object.entries(s).forEach(([k, v]) => localStorage.setItem(k, v)), storage);
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
const slotCard = (page) => page.locator("#slots .slot", { has: page.locator(`code:text-is("${SLOT.slug}")`) });
async function openWarp(page) {
  await page.click("#tab-btn-maps");
  await slotCard(page).locator('[data-action="more"]').click();
  await page.locator(`.rmenu[data-region="${SLOT.slug}"] button:has-text("Warp regions")`).click();
  await page.waitForSelector("dialog.warp[open]", { timeout: 10000 });
  // Both pictures drawn.
  await page.waitForTimeout(800);
}
/** Clicks a map spot in a pane at its "whole map" view (the view the tool opens with). */
async function clickAt(page, which, [lon, lat]) {
  const pane = page.locator(`dialog.warp .wp-col-${which} .wp-pane`);
  const r = await pane.boundingBox();
  const aspect = MAP.w / MAP.h;
  const s = Math.min(r.height, r.width / aspect) * 0.96;
  const u = (lon + 180) / 360;
  const v = (90 - lat) / 180;
  await page.mouse.click(r.x + r.width / 2 + (u - 0.5) * s * aspect, r.y + r.height / 2 + (v - 0.5) * s);
  await page.waitForTimeout(120);
}
const PAIRS = [
  [[-60, -40], [-50, -40]],
  [[60, -40], [70, -40]],
  [[0, 50], [10, 50]],
  [[100, 10], [110, 10]],
];
const shots = [];

try {
  const owner = await adminPage("Flanz1");
  const { page } = owner;
  const badge = await page.locator("#r-tree .rrow .badge.warn", { hasText: "different map" }).count();
  check("regions still on the old map keep the 'drawn on a different map' badge", badge >= Object.keys(before).length, `${badge} badges`);
  await page.click("#tab-btn-maps");
  await page.waitForTimeout(500);
  check("nothing opens or prompts by itself when a slot's map changed", (await page.locator("dialog[open]").count()) === 0);
  await openWarp(page);
  check("the tool starts from the map the regions were drawn on", (await page.locator('dialog.warp select[name="from-map"]').inputValue()) === MAP.id);
  const apply = page.locator('dialog.warp [data-action="apply"]');
  check("Apply is disabled with a reason until there are 3 pairs", (await apply.isDisabled()) && /at least 3/.test((await apply.getAttribute("title")) ?? ""), await apply.getAttribute("title"));

  for (const [k, [from, to]] of PAIRS.slice(0, 3).entries()) {
    await clickAt(page, "old", from);
    await clickAt(page, "new", to);
    if (k === 1) check("after 2 pairs Apply is still disabled", await apply.isDisabled());
  }
  check("3 pairs: Apply is enabled", !(await apply.isDisabled()));
  check("each pair has a numbered marker on both maps", (await page.locator("dialog.warp .wp-col-old .wp-mark").count()) === 3 && (await page.locator("dialog.warp .wp-col-new .wp-mark").count()) === 3);
  check("the footer says what will move", /regions? and 1 pin will move onto landmarks-v2/.test(await page.locator("dialog.warp .wp-status").textContent()), await page.locator("dialog.warp .wp-status").textContent());
  await clickAt(page, "old", PAIRS[3][0]);
  await clickAt(page, "new", PAIRS[3][1]);
  let errs = await page.locator("dialog.warp .wp-point").allTextContents();
  check("from 4 pairs every pair shows its error (all 0 for a clean move)", errs.length === 4 && errs.every((t) => /Error 0 km/.test(t)) && !errs.some((t) => /Largest/.test(t)), errs.join(" | "));
  // A misplaced fifth pair (5° off) stands out by name, in text.
  await clickAt(page, "old", [-100, -20]);
  await clickAt(page, "new", [-85, -25]);
  errs = await page.locator("dialog.warp .wp-point").allTextContents();
  check("a misplaced pair is flagged as the largest error, in text and km", /Largest error: [\d.]+ km/.test(errs[4] ?? "") && errs.filter((t) => /Largest/.test(t)).length === 1, errs.join(" | "));

  // Keyboard: a marker nudges with the arrows, and Delete removes its pair.
  const mark = page.locator('dialog.warp .wp-col-new .wp-mark[data-index="4"]');
  const b0 = await mark.boundingBox();
  await mark.focus();
  await page.keyboard.press("Shift+ArrowRight");
  await page.waitForTimeout(150);
  const b1 = await page.locator('dialog.warp .wp-col-new .wp-mark[data-index="4"]').boundingBox();
  check("arrow keys nudge a focused marker (Shift = 10 px)", Math.abs(b1.x - b0.x - 10) < 1.5, `${b1.x - b0.x}`);
  await page.locator('dialog.warp .wp-col-new .wp-mark[data-index="4"]').focus();
  await page.keyboard.press("Delete");
  await page.waitForTimeout(150);
  check("Delete on a marker removes its pair", (await page.locator("dialog.warp .wp-point").count()) === 4);

  // The points are kept in this browser until applied.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await openWarp(page);
  check("closing and reopening keeps the placed points", (await page.locator("dialog.warp .wp-point").count()) === 4);

  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(300);
    const f = `1440-${scheme}-points.png`;
    await page.screenshot({ path: path.join(OUT, f) });
    shots.push(f);
  }
  await page.emulateMedia({ colorScheme: "light" });

  // The same points at tablet and phone width, light and dark (the draft is per browser, so it's copied over).
  const draft = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([k]) => k.startsWith("wge-warp"))));
  for (const [w, hgt] of [[768, 1024], [375, 812]]) {
    for (const scheme of ["light", "dark"]) {
      const p = await adminPage("Flanz1", { width: w, height: hgt }, scheme, draft);
      await openWarp(p.page);
      check(`${w} px ${scheme}: the placed points come along`, (await p.page.locator("dialog.warp .wp-point").count()) === 4);
      const wide = await p.page.evaluate(() => [...document.querySelectorAll("dialog.warp *")].some((el) => el.getBoundingClientRect().right > window.innerWidth + 1 && !el.closest(".wp-bar, .wp-pane-head, .wp-pane")));
      check(`${w} px ${scheme}: nothing sticks out of the screen`, !wide);
      check(`${w} px ${scheme}: Apply warp is on screen`, await p.page.locator('dialog.warp [data-action="apply"]').isVisible() && (await p.page.locator('dialog.warp [data-action="apply"]').boundingBox()).y + 30 < hgt);
      if (w === 375) {
        const segs = await p.page.locator("dialog.warp .wp-seg button").allTextContents();
        check(`${w} px: one pane at a time behind Old / New / Points / Preview`, segs.join(",") === "Old,New,Points,Preview" && !(await p.page.locator("dialog.warp .wp-col-new").isVisible()), segs.join(","));
        for (const v of ["old", "new", "points", "preview"]) {
          await p.page.click(`dialog.warp .wp-seg [data-view="${v}"]`);
          await p.page.waitForTimeout(400);
          const f = `${w}-${scheme}-${v}.png`;
          await p.page.screenshot({ path: path.join(OUT, f) });
          shots.push(f);
        }
      } else {
        const f = `${w}-${scheme}.png`;
        await p.page.screenshot({ path: path.join(OUT, f) });
        shots.push(f);
      }
      check(`no errors in the ${w} px ${scheme} page`, p.errors.length === 0, p.errors.join(" | "));
      await p.ctx.close();
    }
  }

  const n0 = mock.log.length;
  await apply.click();
  await page.waitForSelector('dialog[open] [data-action="confirm-warp"]', { timeout: 10000 });
  const confirmText = await page.locator("dialog[open]:not(.warp) .dlg-body").textContent();
  check("the confirm says what moves and in how many saves", /Moves \d+ regions? and 1 pin from landmarks onto landmarks-v2, in 1 save/.test(confirmText), confirmText);
  await page.screenshot({ path: path.join(OUT, "1440-light-confirm.png") });
  shots.push("1440-light-confirm.png");
  await page.click('dialog[open] [data-action="confirm-warp"]');
  await waitCommit(page, n0);
  await page.waitForFunction(() => /Moved \d+ regions?/.test(document.querySelector("dialog.warp .wp-status")?.textContent ?? ""), null, { timeout: 20000 });
  check("applying is one commit here", mock.log.length === n0 + 1, mock.log.slice(n0).map((c) => c.message).join(" / "));
  check("the commit message names the maps and the pairs", /Warp \d+ regions? and 1 pin from map "landmarks" onto "landmarks-v2" \(4 point pairs\)/.test(mock.log.at(-1)?.message ?? ""), mock.log.at(-1)?.message);

  let movedOk = 0;
  let worst = 0;
  const ids = Object.keys(before);
  for (const id of ids) {
    const r = onBranch(`content/regions/${id}.json`);
    if (r?.properties.map !== NEW) continue;
    const a = before[id].geometry.type === "Polygon" ? before[id].geometry.coordinates[0][0] : before[id].geometry.coordinates[0][0][0];
    const b = r.geometry.type === "Polygon" ? r.geometry.coordinates[0][0] : r.geometry.coordinates[0][0][0];
    const dLon = ((b[0] - a[0] + 540) % 360) - 180;
    worst = Math.max(worst, Math.abs(dLon - 10), Math.abs(b[1] - a[1]));
    if (Math.abs(dLon - 10) < 1.5 && Math.abs(b[1] - a[1]) < 1.5 && r.properties.updatedBy?.login === "Flanz1") movedOk++;
  }
  check("every region moved about 10° east onto the new map, saved by the owner", movedOk === ids.length, `${movedOk}/${ids.length}, worst off by ${worst.toFixed(2)}°`);
  const pin = onBranch("content/pins/warp-pin.json");
  check("the pin moved with them", pin?.properties.map === NEW && Math.abs(pin.geometry.coordinates[0] - 40) < 1.5 && Math.abs(pin.geometry.coordinates[1] - 20) < 1.5, JSON.stringify(pin?.geometry));
  const other = onBranch("content/regions/old-map-region.json");
  check("regions of other slots are left alone", other?.properties.map === "retired-map");
  check("no errors in the owner's page", owner.errors.length === 0, owner.errors.join(" | "));
  await owner.ctx.close();

  const mo = await adminPage("drafter-bo");
  await mo.page.click("#tab-btn-maps");
  await mo.page.waitForSelector("#slots .slot", { timeout: 10000 });
  check("someone without 'edit others' gets no Warp regions item", (await slotCard(mo.page).locator('[data-action="more"]').count()) === 0 && (await mo.page.locator('button:has-text("Warp regions")').count()) === 0);
  await mo.ctx.close();
} catch (e) {
  check("ran to the end", false, `threw: ${(e && e.message) || e}`.slice(0, 400));
}

await browser.close();
site.close();
await writeFile(path.join(OUT, "report.json"), JSON.stringify({ results, shots }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed:\n${failed.map((f) => `  ${f.name} ${f.detail}`).join("\n")}` : ""}`);
process.exit(failed.length ? 1 : 0);
