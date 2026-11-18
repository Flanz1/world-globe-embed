// e2e-suite: roots=VIEWER,src/admin/preview.ts weight=2
/**
 * The real-size ruler (npm run e2e:ruler):
 *  1. Embed: a slot with a world radius gets the ruler button; one without doesn't; controls=0 hides it.
 *  2. Flat map: two clicks give the great-circle distance for that radius (checked against an independent
 *     calculation), the area tool measures a triangle, km/mi switches, undo/clear work, drags don't add points.
 *  3. Globe: a click lands where it was clicked (pick and projection agree), and a second one measures.
 *  4. Admin preview: typing a radius shows the button live; saving writes `radius` to slots.json; blank removes it.
 *
 * Screenshots and report.json go to .e2e/ruler/. Exits non-zero if any check fails.
 */
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { makeFixture, SLOT } from "./fixture.mjs";
import { MockGitHub } from "./mock-github.mjs";
import { useAdminApi } from "./admin-api.mjs";

import { port } from "./ports.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const OUT = path.resolve(".e2e/ruler");
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
slots.slots[SLOT.slug].travel = [
  { label: "On foot", kmPerDay: 30 },
  { label: "Sailing ship", kmPerDay: 100 },
];
// The radius-less checks use the real "inara" slot, which can get a world size from the admin page at
// any time: take it off in the fixture so they don't depend on live content.
delete slots.slots.inara.radius;
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

/** Great-circle distance (km) on a sphere of RADIUS, positions [lon, lat] in degrees. */
const rad = (d) => (d * Math.PI) / 180;
function haversine(a, b) {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * RADIUS * Math.asin(Math.sqrt(h));
}
/** Map-image position → globe position for the fixture slot's padding and shift. */
const toGlobe = ([lon, lat]) => {
  const n = SLOT.north / 100;
  const s = SLOT.south / 100;
  const t = n + ((90 - lat) / 180) * (1 - n - s);
  return [((((lon + SLOT.shift + 180) % 360) + 360) % 360) - 180, 90 - t * 180];
};
const number = (text) => Number(/([\d,.]+)/.exec(text.replace(/^[^\d]*/, ""))?.[1].replace(/,/g, ""));

/* ═════════════ 1 + 2. Embed, flat map ═════════════ */
const E = "embed";
await step(E, "ruler button and flat-map measuring", async () => {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 520 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(`${SITE}/v/${SLOT.slug}/`);
  await ready(page.mainFrame());
  const btn = page.locator("#btn-ruler");
  check(E, "slot with a radius shows the ruler button", await btn.isVisible());
  check(E, "…and the panel is closed until it is pressed", !(await page.locator(".rl").isVisible()));

  // Where image lon/lat fall on screen: the poster's CSS variables are the flat renderer's own framing.
  const frame = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return { fx: parseFloat(cs.getPropertyValue("--fx")), fy: parseFloat(cs.getPropertyValue("--fy")), fw: parseFloat(cs.getPropertyValue("--fw")), fh: parseFloat(cs.getPropertyValue("--fh")) };
  });
  const at = ([lon, lat]) => ({ x: frame.fx + ((lon + 180) / 360) * frame.fw, y: frame.fy + ((90 - lat) / 180) * frame.fh });
  const A = [-60, 20];
  const B = [40, -30];
  const C = [-60, -30];

  await btn.click();
  check(E, "pressing it opens the panel", await page.locator(".rl").isVisible() && (await btn.getAttribute("aria-pressed")) === "true");
  const click = async (p) => page.mouse.click(p.x, p.y);
  await click(at(A));
  check(E, "one point: still asking for more", /Click the map/.test(await page.locator(".rl output").innerText()));
  await click(at(B));
  const text = await page.locator(".rl output").innerText();
  const got = number(text);
  const want = haversine(toGlobe(A), toGlobe(B));
  check(E, "distance matches the great-circle distance", Math.abs(got - want) / want < 0.01, `${text} vs ${want.toFixed(0)} km`);
  await page.screenshot({ path: path.join(OUT, "embed-flat-distance.png") });

  // Travel time: the slot's speeds are in a select, the reading follows the choice.
  const days = (t) => {
    const m = /\((\d[\d,]*) days\)|(\d+) days?\b/.exec(t.split("\n")[1] ?? "");
    return Number((m?.[1] ?? m?.[2] ?? "NaN").replace(/,/g, ""));
  };
  const sel = page.locator(".rl select");
  check(E, "two speeds show a labelled select", (await sel.isVisible()) && (await sel.getAttribute("aria-label")) === "Travel by");
  const t1 = await page.locator(".rl output").innerText();
  check(E, "first speed (on foot) gives the time for the distance", /\nAbout .* on foot/.test(t1) && Math.abs(days(t1) - want / 30) <= 1, t1);
  await sel.selectOption({ index: 1 });
  const t2 = await page.locator(".rl output").innerText();
  check(E, "sailing ship is faster", /\nAbout .* by sailing ship/.test(t2) && Math.abs(days(t2) - want / 100) <= 1, t2);
  await page.screenshot({ path: path.join(OUT, "embed-flat-travel.png") });
  await sel.selectOption({ index: 0 });

  await page.locator(".rl button", { hasText: /^km$/ }).click();
  const mi = number(await page.locator(".rl output").innerText());
  check(E, "unit switch gives miles", Math.abs(mi - want / 1.609344) / (want / 1.609344) < 0.01, await page.locator(".rl output").innerText());
  await page.locator(".rl button", { hasText: /^mi$/ }).click();

  // A drag is not a click.
  const a = at(A);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 40, a.y + 20, { steps: 4 });
  await page.mouse.up();
  const after = await page.locator(".rl output").innerText();
  check(E, "dragging the map adds no point", number(after) !== 0 && /Distance/.test(after) && !/last leg/.test(after), after);

  // The drag moved the view: measure again from fresh points.
  await page.locator(".rl button", { hasText: "Clear" }).click();
  check(E, "Clear empties the measurement", /Click the map/.test(await page.locator(".rl output").innerText()));
  await page.reload();
  await ready(page.mainFrame());
  await page.locator("#btn-ruler").click();
  await page.locator(".rl button", { hasText: "Area" }).click();
  for (const p of [A, B, C]) await click(at(p));
  const area = await page.locator(".rl output").innerText();
  check(E, "three points give an area, a share of the world and a perimeter", /Area: .*km² \(.*% of the world\)\. Perimeter/.test(area), area);
  await page.screenshot({ path: path.join(OUT, "embed-flat-area.png") });
  await page.locator(".rl button", { hasText: "Undo" }).click();
  check(E, "Undo removes the last point", /3 points or more/.test(await page.locator(".rl output").innerText()));
  await page.keyboard.press("Escape");
  check(E, "Escape closes the tool", !(await page.locator(".rl").isVisible()));

  await page.goto(`${SITE}/v/${SLOT.slug}/?controls=0`);
  await ready(page.mainFrame());
  check(E, "controls=0 hides the ruler button", !(await page.locator("#btn-ruler").isVisible()));
  await page.goto(`${SITE}/v/inara/`);
  await ready(page.mainFrame());
  check(E, "a slot without a radius has no ruler", !(await page.locator("#btn-ruler").isVisible()));
  await page.goto(`${SITE}/v/inara/?radius=6371`);
  await ready(page.mainFrame());
  check(E, "…and ?radius= can't switch one on", !(await page.locator("#btn-ruler").isVisible()));
  check(E, "no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
});

/* ═════════════ 3. Globe ═════════════ */
const G = "globe";
await step(G, "picking and measuring on the globe", async () => {
  const ctx = await browser.newContext({ viewport: { width: 700, height: 700 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${SITE}/v/${SLOT.slug}/?view=globe&rotate=0&lat=0&lon=0&controls=1`);
  await ready(page.mainFrame());
  await page.locator("#btn-ruler").click();
  const cx = 350;
  const cy = 350;
  await page.mouse.click(cx, cy);
  await page.mouse.click(cx + 120, cy - 80);
  const text = await page.locator(".rl output").innerText();
  check(G, "two clicks give a distance", /Distance: [\d,.]+ km/.test(text) && number(text) > 100, text);
  // The marker is drawn where the click was: pick → globe position → projection round-trips.
  const dots = await page.evaluate(() => {
    const cv = document.querySelector(".rl-cv");
    const g = cv.getContext("2d");
    return [[350, 350], [470, 270]].map(([x, y]) => [...g.getImageData(x - 1, y - 1, 3, 3).data].filter((v, i) => i % 4 === 3).some((a) => a > 200));
  });
  check(G, "markers sit under the clicks", dots.every(Boolean), JSON.stringify(dots));
  const sky = await page.evaluate(() => 0);
  void sky;
  await page.mouse.click(5, 5); // off the globe
  check(G, "a click on empty space adds nothing", /Distance/.test(await page.locator(".rl output").innerText()) && !/last leg/.test(await page.locator(".rl output").innerText()));
  await page.screenshot({ path: path.join(OUT, "embed-globe-distance.png") });
  check(G, "no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
});

/* ═════════════ 4. Admin preview ═════════════ */
const A = "admin";
const mock = new MockGitHub({ root: dir });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await ctx.route("https://api.github.com/**", (r) => mock.handle(r));
await useAdminApi(ctx, mock, { branch: BRANCH });
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

await step(A, "world size in the preview dialog", async () => {
  await page.goto(`${SITE}/admin/`);
  await page.waitForSelector("#slots .slot", { timeout: 15000 });

  await openSlotPreview("inara");
  check(A, "a slot without a radius starts empty, ruler hidden", (await page.inputValue("#pv-radius")) === "" && !(await frame().locator("#btn-ruler").isVisible()));
  await page.fill("#pv-radius", "50");
  check(A, "a too-small radius is refused", (await page.isDisabled("#pv-save")) && /between 100/.test(await page.innerText("#pv-radius-hint")));
  await page.click("#pv-earth");
  await page.waitForTimeout(300);
  check(A, "Earth fills in 6,371 km and shows the ruler live", (await page.inputValue("#pv-radius")) === "6371" && (await frame().locator("#btn-ruler").isVisible()));
  await page.selectOption("#pv-radius-unit", "mi");
  check(A, "switching to miles converts the number", Math.abs(Number(await page.inputValue("#pv-radius")) - 3958.76) < 0.1, await page.inputValue("#pv-radius"));
  await page.screenshot({ path: path.join(OUT, "admin-preview-radius.png") });
  let n = mock.log.length;
  await page.click("#pv-save");
  await waitCommit(n);
  let s = slotsOnBranch().inara;
  check(A, "saving writes the radius in km", mock.log.length === n + 1 && Math.abs(s.radius - 6371) < 0.2, JSON.stringify(s));
  check(A, "commit message names the radius", /world radius/.test(mock.log.at(-1)?.message ?? ""), mock.log.at(-1)?.message);

  await page.waitForSelector("#slots .slot", { timeout: 15000 });
  await page.waitForTimeout(500);
  await openSlotPreview("inara");
  check(A, "reopening shows it again", Math.abs(Number(await page.inputValue("#pv-radius")) - 6371) < 0.2);
  await page.fill("#pv-radius", "");
  await page.waitForTimeout(300);
  check(A, "clearing hides the ruler live", !(await frame().locator("#btn-ruler").isVisible()));
  n = mock.log.length;
  await page.click("#pv-save");
  await waitCommit(n);
  s = slotsOnBranch().inara;
  check(A, "saving a blank radius removes it", !("radius" in s), JSON.stringify(s));
  await page.waitForSelector("#slots .slot", { timeout: 15000 });
  await page.waitForTimeout(500);
  await openSlotPreview("inara");
  check(A, "travel speeds are disabled with a reason until a world size is set", (await page.isDisabled("#pv-tr-foot")) && /Set a world size first/.test(await page.innerText("#pv-travel-hint")));
  await page.fill("#pv-radius", "6371");
  check(A, "…and open up with one", !(await page.isDisabled("#pv-tr-foot")));
  await page.check("#pv-tr-foot");
  await page.check("#pv-tr-custom");
  check(A, "a ticked custom speed without a name is refused", await page.isDisabled("#pv-save"));
  await page.fill("#pv-tr-custom-name", "Dragon");
  await page.fill("#pv-tr-custom-km", "900");
  await page.waitForTimeout(300);
  check(A, "…and accepted once named", !(await page.isDisabled("#pv-save")));
  n = mock.log.length;
  await page.click("#pv-save");
  await waitCommit(n);
  s = slotsOnBranch().inara;
  check(A, "saving writes the ticked speeds", JSON.stringify(s.travel) === JSON.stringify([{ label: "On foot", kmPerDay: 30 }, { label: "Dragon", kmPerDay: 900 }]), JSON.stringify(s));
  check(A, "commit message names them", /On foot 30 km\/day/.test(mock.log.at(-1)?.message ?? ""), mock.log.at(-1)?.message);
  await page.waitForSelector("#slots .slot", { timeout: 15000 });
  await page.waitForTimeout(500);
  await openSlotPreview("inara");
  check(A, "reopening shows them again", (await page.isChecked("#pv-tr-foot")) && (await page.inputValue("#pv-tr-custom-name")) === "Dragon" && !(await page.isChecked("#pv-tr-horse")));
  await page.uncheck("#pv-tr-foot");
  await page.uncheck("#pv-tr-custom");
  await page.fill("#pv-radius", "");
  n = mock.log.length;
  await page.click("#pv-save");
  await waitCommit(n);
  check(A, "unticking all removes travel from the slot", !("travel" in slotsOnBranch().inara));
  check(A, "nothing written to main", mock.log.every((c) => c.branch === BRANCH));
  check(A, "no page errors", errors.length === 0, errors.join(" | "));
});

await browser.close();
site.close();
await writeFile(path.join(OUT, "report.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${OUT}`);
process.exit(failed.length ? 1 : 0);
