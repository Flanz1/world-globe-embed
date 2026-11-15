// e2e-suite: roots=VIEWER,src/viewer/pins.ts,src/admin/pins.ts cut=src/admin/session.ts,src/admin/github.ts,src/shared/access.ts,src/shared/categories.ts weight=2
/**
 * Browser checks for map pins, in headless Chromium.
 *
 *   npm run e2e:pins
 *
 * 1. Embeds: ?pins=1 draws the slot's pins on the flat map and on the globe, lined up with the landmark
 *    they mark (and with a region drawn on it), ?pins=city only that kind, no param (or pins=0) none and
 *    no request for the pins file; a marker's name and link are plain text and an https link, and clicking
 *    one opens a card.
 * 2. Admin Pins tab: place a pin by clicking the map (one commit, createdBy and updatedBy set), drag it
 *    to move it, delete it; a contributor can place a pin but not change or delete someone else's.
 *
 * Screenshots and report.json go to .e2e/pins/. Exits non-zero if any check fails.
 */
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { makeFixture, SLOT, DISC } from "./fixture.mjs";
import { MockGitHub } from "./mock-github.mjs";
import { useAdminApi } from "./admin-api.mjs";

import { port } from "./ports.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const OUT = path.resolve(".e2e/pins");
const BRANCH = "test/pins";
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

/* ── Fixture: three saved pins on the alignment slot, one with markup in its name, plus a contributor ── */
const OWNER = { id: 45669787, login: "Flanz1" };
const pin = (id, name, kind, at, extra = {}) => ({
  $schema: "../../schema/pin.schema.json",
  type: "Feature",
  id,
  properties: { slot: SLOT.slug, map: "landmarks", name, kind, createdBy: OWNER, created: "2026-11-14T10:00:00Z", updatedBy: OWNER, updated: "2026-11-14T10:00:00Z", ...extra },
  geometry: { type: "Point", coordinates: at },
});
const NOTE = "https://garmeley.example/Places/Magenta-Harbour";
const SEED = [
  pin("magenta-harbour", "Magenta Harbour", "city", [DISC.lon, DISC.lat], { description: "A busy port on the magenta isle.", link: NOTE }),
  pin("old-ruin", "Old Ruin", "ruin", [-175, -20]),
  pin("red-field", "Battle of the Red Field", "battle", [65, -35], { color: "#ff0000" }),
  pin("markup", "<img src=x onerror=alert(1)>", "landmark", [-120, 30], { description: "<b>bold?</b>" }),
];

const dir = await makeFixture({ quiet: true });
mkdirSync(path.join(dir, "content/pins"), { recursive: true });
for (const p of SEED) writeFileSync(path.join(dir, "content/pins", `${p.id}.json`), JSON.stringify(p, null, 2) + "\n");
const accessFile = path.join(dir, "content/access.json");
const access = JSON.parse(readFileSync(accessFile, "utf8"));
access.users.push({ id: 5002, login: "carto-ann", permissions: ["regions"] });
writeFileSync(accessFile, JSON.stringify(access, null, 2) + "\n");
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
const ready = (page) => page.waitForFunction(() => ["hires", "interactive", "fallback"].includes(document.documentElement.dataset.state), null, { timeout: 30000 });
const centre = async (loc) => {
  const b = await loc.boundingBox();
  return [b.x + b.width / 2, b.y + b.height / 2];
};
const dist = ([ax, ay], [bx, by]) => Math.hypot(ax - bx, ay - by);

/* ═════════════ 1. Embeds ═════════════ */
const E = "embed";
await step(E, "pin file", async () => {
  const f = JSON.parse(readFileSync(path.join(DIST, "pins", `${SLOT.slug}.json`), "utf8"));
  check(E, "the build writes pins/<slot>.json with every pin", f.pins.length === SEED.length && f.pins.some((p) => p.id === "magenta-harbour" && p.at[0] === DISC.lon && p.link === NOTE), JSON.stringify(f).slice(0, 200));
  check(E, "…without who placed them", !JSON.stringify(f).includes("createdBy") && !JSON.stringify(f).includes("Flanz1"));
});

for (const view of ["flat", "globe"]) {
  await step(E, `${view} embed`, async () => {
    const ctx = await browser.newContext({ viewport: { width: 900, height: 520 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    const dialogs = [];
    const requests = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("dialog", (d) => (dialogs.push(d.message()), d.dismiss()));
    ctx.on("request", (r) => requests.push(r.url()));

    // Without ?pins nothing is fetched or drawn.
    await page.goto(`${SITE}/v/${SLOT.slug}/?view=${view}`);
    await ready(page);
    await page.waitForTimeout(300);
    check(E, `${view}: no pins without ?pins`, (await page.locator(".wpin").count()) === 0 && !requests.some((u) => u.includes("/pins/")));
    await page.goto(`${SITE}/v/${SLOT.slug}/?view=${view}&pins=0`);
    await ready(page);
    check(E, `${view}: pins=0 shows none`, (await page.locator(".wpin").count()) === 0);

    // A region embed: the pin on the magenta isle sits where the region's label is.
    await page.goto(`${SITE}/v/${SLOT.slug}/?view=${view}&region=landmark-disc&pins=1&lock=0`);
    await ready(page);
    await page.waitForSelector(".wpin:not([hidden])", { timeout: 15000 });
    await page.waitForTimeout(500);
    const harbour = page.locator('.wpin[data-name="Magenta Harbour"]');
    const label = page.locator(".rlabel:not([hidden])").first();
    const d = dist(await centre(harbour), await centre(label));
    check(E, `${view}: the pin sits on the landmark it marks, with the region drawn there`, d < 14, `${d.toFixed(1)}px from the region's label`);
    await page.screenshot({ path: path.join(OUT, `embed-${view}-region.png`) });

    // Opening a marker.
    await harbour.click();
    const card = page.locator(".wpin-card");
    check(E, `${view}: clicking a marker opens its card`, await card.isVisible());
    check(E, `${view}: the card shows name, kind and description`, /Magenta Harbour/.test(await card.textContent()) && /City/.test(await card.textContent()) && /busy port/.test(await card.textContent()));
    const a = card.locator("a");
    check(E, `${view}: the link is https and opens a new tab safely`, (await a.getAttribute("href")) === NOTE && (await a.getAttribute("target")) === "_blank" && /noopener/.test((await a.getAttribute("rel")) ?? ""));
    await page.keyboard.press("Escape");
    check(E, `${view}: Escape closes the card`, !(await card.isVisible()));

    // The whole slot: every pin; markup in a name is text.
    await page.goto(`${SITE}/v/${SLOT.slug}/?view=${view}&pins=1`);
    await ready(page);
    await page.waitForSelector(".wpin:not([hidden])", { timeout: 15000 });
    await page.waitForTimeout(400);
    const total = await page.locator(".wpin").count();
    check(E, `${view}: pins=1 draws every pin of the slot`, total === SEED.length, String(total));
    check(E, `${view}: markup in a name stays text`, (await page.locator("img[src='x']").count()) === 0 && dialogs.length === 0 && (await page.locator('.wpin[data-name="<img src=x onerror=alert(1)>"]').count()) === 1);
    await page.locator('.wpin[data-name="<img src=x onerror=alert(1)>"]').click();
    check(E, `${view}: …in the card too`, (await page.locator(".wpin-card img, .wpin-card b").count()) === 0 && /bold\?/.test(await page.locator(".wpin-card").textContent()));

    // Kinds.
    await page.goto(`${SITE}/v/${SLOT.slug}/?view=${view}&pins=city,ruin`);
    await ready(page);
    await page.waitForSelector(".wpin", { state: "attached", timeout: 15000 });
    check(E, `${view}: pins=city,ruin draws only those kinds`, (await page.locator(".wpin").count()) === 2);
    await page.goto(`${SITE}/v/${SLOT.slug}/?view=${view}&pins=nonsense`);
    await ready(page);
    await page.waitForTimeout(300);
    check(E, `${view}: an unknown kind draws nothing`, (await page.locator(".wpin").count()) === 0);

    if (view === "globe") {
      // The far side of the globe hides its pins: facing the magenta isle, the ruin at -175° is on the other side.
      await page.goto(`${SITE}/v/${SLOT.slug}/?view=globe&pins=1&lon=${DISC.lon}&lat=${DISC.lat}&rotate=0&zoom=1`);
      await ready(page);
      await page.waitForSelector(".wpin:not([hidden])", { timeout: 15000 });
      await page.waitForTimeout(400);
      const visible = await page.locator(".wpin:not([hidden])").count();
      check(E, "globe: pins on the far side are hidden", visible > 0 && visible < SEED.length, `${visible} of ${SEED.length} visible`);
      await page.screenshot({ path: path.join(OUT, "embed-globe.png") });
    }
    check(E, `${view}: no page errors or dialogs`, errors.length === 0 && dialogs.length === 0, [...errors, ...dialogs].join(" | "));
    await ctx.close();
  });
}

/* ═════════════ 2. Admin ═════════════ */
const A = "admin";
const mock = new MockGitHub({ root: dir, branches: ["main", BRANCH] });
async function adminPage(as) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await ctx.route("https://api.github.com/**", (r) => mock.handle(r));
  await useAdminApi(ctx, mock, { branch: BRANCH, as });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && !/^Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await page.goto(`${SITE}/admin/#pins`);
  await page.waitForSelector("#tab-pins .pn-pane", { timeout: 15000 });
  await page.selectOption("#tab-pins select[aria-label=Slot]", SLOT.slug);
  await page.waitForSelector(".pn-row", { timeout: 15000 });
  await page.waitForTimeout(500);
  return { ctx, page, errors };
}
const waitCommit = async (page, n) => {
  const t0 = Date.now();
  while (mock.log.length <= n && Date.now() - t0 < 15000) await page.waitForTimeout(100);
  await page.waitForTimeout(400);
};
const onBranch = (p) => (mock.read(BRANCH, p) ? JSON.parse(mock.read(BRANCH, p).toString()) : null);

await step(A, "owner places, moves and deletes a pin", async () => {
  const { ctx, page, errors } = await adminPage("Flanz1");
  check(A, "the list shows the slot's saved pins", (await page.locator(".pn-row").count()) === SEED.length, String(await page.locator(".pn-row").count()));
  check(A, "…and the map shows a marker for each", (await page.locator(".pn-marker").count()) === SEED.length);

  const n0 = mock.log.length;
  await page.click("#tab-pins button:has-text('Place a pin')");
  const pane = await page.locator(".pn-pane").boundingBox();
  await page.mouse.click(pane.x + pane.width / 2, pane.y + pane.height / 2);
  await page.waitForSelector(".pn-form");
  check(A, "clicking the map opens the new-pin form", (await page.locator(".pn-marker").count()) === SEED.length + 1);
  await page.fill(".pn-form input[type=text]", "Test Harbour");
  await page.selectOption(".pn-form select", "port");
  await page.fill(".pn-form input[type=url]", "http://not-https.example/x");
  await page.click(".pn-form button[type=submit]");
  check(A, "a link that isn't https is refused", /https/.test((await page.textContent(".pn-form .error")) ?? "") && mock.log.length === n0);
  await page.fill(".pn-form input[type=url]", NOTE);
  await page.fill(".pn-form textarea", "A test.");
  await page.screenshot({ path: path.join(OUT, "admin-new-pin.png") });
  await page.click(".pn-form button[type=submit]");
  await waitCommit(page, n0);
  const c = mock.log.slice(n0);
  check(A, "saving is one commit to content/pins/test-harbour.json", c.length === 1 && c[0].branch === BRANCH && c[0].changes.length === 1 && c[0].changes[0].path === "content/pins/test-harbour.json", JSON.stringify(c));
  const f = onBranch("content/pins/test-harbour.json");
  const p = f?.properties;
  check(A, "the file has the form's values", p?.name === "Test Harbour" && p.kind === "port" && p.link === NOTE && p.description === "A test." && p.slot === SLOT.slug && p.map === "landmarks", JSON.stringify(p));
  check(A, "…placed by and saved by the signed-in person", p?.createdBy?.login === "Flanz1" && p?.updatedBy?.login === "Flanz1" && /^\d{4}-\d\d-\d\dT/.test(p?.created ?? ""));
  const [lon, lat] = f?.geometry.coordinates ?? [99, 99];
  check(A, "the position is where the map was clicked (the middle of the map)", Math.abs(lon) < 1 && Math.abs(lat) < 1, `${lon}, ${lat}`);
  await page.waitForSelector('.pn-row:has-text("Test Harbour")');
  check(A, "the new pin is in the list", (await page.locator(".pn-row").count()) === SEED.length + 1);

  // Move it by dragging its marker, then save.
  const marker = page.locator(".pn-marker[aria-pressed=true]");
  const [mx, my] = await centre(marker);
  await page.mouse.move(mx, my);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(mx + (60 * i) / 6, my + (30 * i) / 6);
  await page.mouse.up();
  const n1 = mock.log.length;
  await page.click(".pn-form button[type=submit]");
  await waitCommit(page, n1);
  const g = onBranch("content/pins/test-harbour.json");
  check(A, "dragging the marker moves the pin east and south", g && g.geometry.coordinates[0] > lon + 1 && g.geometry.coordinates[1] < lat - 0.5, JSON.stringify(g?.geometry));
  check(A, "…and keeps who placed it", g?.properties.createdBy.login === "Flanz1" && g?.properties.created === p.created);

  // Delete it.
  const n2 = mock.log.length;
  await page.waitForSelector(".pn-form button:has-text('Delete pin')");
  await page.click(".pn-form button:has-text('Delete pin')");
  await page.click("dialog.small-dlg.danger[open] button:has-text('Delete pin')");
  await waitCommit(page, n2);
  check(A, "deleting removes the file in one commit", !onBranch("content/pins/test-harbour.json") && mock.log.length === n2 + 1);
  await page.waitForTimeout(500);
  check(A, "…and the pin leaves the list", (await page.locator(".pn-row").count()) === SEED.length);
  check(A, "no errors in the admin page", errors.length === 0, errors.join(" | "));
  await ctx.close();
});

await step(A, "a contributor", async () => {
  const { ctx, page, errors } = await adminPage("carto-ann");
  await page.locator(".pn-row", { hasText: "Old Ruin" }).click();
  await page.waitForSelector(".pn-form");
  check(A, "can open someone else's pin but not change it", (await page.locator(".pn-form input[type=text]").isDisabled()) && (await page.locator(".pn-form button[type=submit]").count()) === 0 && (await page.locator(".pn-form button:has-text('Delete pin')").count()) === 0);
  await page.screenshot({ path: path.join(OUT, "admin-contributor.png") });
  const n0 = mock.log.length;
  await page.click("#tab-pins button:has-text('Place a pin')");
  const pane = await page.locator(".pn-pane").boundingBox();
  await page.mouse.click(pane.x + pane.width / 3, pane.y + pane.height / 2);
  await page.waitForSelector(".pn-form input[type=text]:not([disabled])");
  await page.fill(".pn-form input[type=text]", "Ann's Camp");
  await page.click(".pn-form button[type=submit]");
  await waitCommit(page, n0);
  const f = onBranch("content/pins/ann-s-camp.json");
  check(A, "can place their own pin", f?.properties.createdBy.login === "carto-ann" && f.properties.name === "Ann's Camp", JSON.stringify(f?.properties));
  check(A, "no errors in the admin page", errors.length === 0, errors.join(" | "));
  await ctx.close();
});

await browser.close();
site.close();
await writeFile(path.join(OUT, "report.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed:\n${failed.map((f) => `  [${f.group}] ${f.name} ${f.detail}`).join("\n")}` : ""}`);
process.exit(failed.length ? 1 : 0);
