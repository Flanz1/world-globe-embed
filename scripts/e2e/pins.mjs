// e2e-suite: roots=VIEWER,src/viewer/pins.ts,src/admin/pins.ts,src/admin/editor/pin-tool.ts,src/admin/editor/pins-layer.ts,src/admin/preview-pins.ts cut=src/admin/session.ts,src/admin/github.ts,src/shared/access.ts,src/shared/categories.ts,src/admin/pinmaps.ts,src/shared/pinmaps.ts weight=2
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
import { makeFixture, SLOT, DISC, edTab } from "./fixture.mjs";
import { MockGitHub } from "./mock-github.mjs";
import { useAdminApi } from "./admin-api.mjs";

import { port } from "./ports.mjs";
import { pickRegion } from "./regions-ui.mjs";
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
  pin("magenta-harbour", "Magenta Harbour", "city", [DISC.lon, DISC.lat], { pinMap: "cities", description: "A busy port on the magenta isle.", link: NOTE }),
  pin("old-ruin", "Old Ruin", "ruin", [-175, -20], { pinMap: "holy-sites" }),
  pin("red-field", "Battle of the Red Field", "battle", [65, -35], { pinMap: "battles", color: "#ff0000" }),
  pin("markup", "<img src=x onerror=alert(1)>", "landmark", [-120, 30], { description: "<b>bold?</b>" }),
];

const PINMAPS = {
  $schema: "../schema/pinmaps.schema.json",
  folders: [
    { id: "places", name: "Places", regions: ["holy-sites"] },
    { id: "war", name: "War", parent: "places", regions: ["battles"] },
  ],
  maps: [
    { id: "holy-sites", name: "Holy sites", slot: SLOT.slug },
    { id: "battles", name: "Battles", slot: SLOT.slug },
    { id: "cities", name: "Cities", slot: SLOT.slug },
  ],
};
const dir = await makeFixture({ quiet: true });
writeFileSync(path.join(dir, "content/pinmaps.json"), JSON.stringify(PINMAPS, null, 2) + "\n");
{
  // The magenta region includes the "Cities" pin map, so its embed shows those pins by itself.
  const rf = path.join(dir, "content/regions/landmark-disc.json");
  const r = JSON.parse(readFileSync(rf, "utf8"));
  r.properties.pinMaps = ["cities"];
  writeFileSync(rf, JSON.stringify(r, null, 2) + "\n");
}
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
    // The label is nudged clear of the pin (below, above or beside it), so it sits near the pin, not on it.
    check(E, `${view}: the pin sits on the landmark it marks, with the region drawn there`, d < 70, `${d.toFixed(1)}px from the region's label`);
    const pb = await harbour.boundingBox();
    const lb = await label.boundingBox();
    const overlap = !!pb && !!lb && pb.x < lb.x + lb.width && lb.x < pb.x + pb.width && pb.y < lb.y + lb.height && lb.y < pb.y + pb.height;
    check(E, `${view}: the region's label doesn't cover the pin`, !overlap, JSON.stringify({ pb, lb }));
    await page.screenshot({ path: path.join(OUT, `embed-${view}-region.png`) });

    // A region that includes a pin map shows its pins by itself; ?pins= overrides, ?pins=0 turns them off.
    await page.goto(`${SITE}/v/${SLOT.slug}/?view=${view}&region=landmark-disc&lock=0`);
    await ready(page);
    await page.waitForSelector(".wpin", { state: "attached", timeout: 15000 });
    check(E, `${view}: a region with a pin map shows just that pin map's pins`, (await page.locator(".wpin").count()) === 1 && (await page.locator('.wpin[data-name="Magenta Harbour"]').count()) === 1);
    await page.goto(`${SITE}/v/${SLOT.slug}/?view=${view}&region=landmark-disc&pins=0&lock=0`);
    await ready(page);
    await page.waitForTimeout(300);
    check(E, `${view}: pins=0 turns a region's pin maps off`, (await page.locator(".wpin").count()) === 0);
    await page.goto(`${SITE}/v/${SLOT.slug}/?view=${view}&region=landmark-disc&pins=1&lock=0`);
    await ready(page);
    await page.waitForSelector(".wpin", { state: "attached", timeout: 15000 });
    check(E, `${view}: pins=1 on a region embed shows every pin`, (await page.locator(".wpin").count()) === SEED.length);

    // Opening a marker.
    await harbour.click();
    const card = page.locator(".wpin-card");
    check(E, `${view}: clicking a marker opens its card`, await card.isVisible());
    check(E, `${view}: the card shows name, kind and description`, /Magenta Harbour/.test(await card.textContent()) && /City/.test(await card.textContent()) && /busy port/.test(await card.textContent()));
    const a = card.locator("a");
    check(E, `${view}: the link is https and opens a new tab safely`, (await a.getAttribute("href")) === NOTE && (await a.getAttribute("target")) === "_blank" && /noopener/.test((await a.getAttribute("rel")) ?? ""));
    await page.keyboard.press("Escape");
    check(E, `${view}: Escape closes the card`, !(await card.isVisible()));

    // A hovered or focused pin (and so its name label) sits above the pins around it.
    const z = (loc) => loc.evaluate((el) => getComputedStyle(el).zIndex);
    await harbour.focus();
    check(E, `${view}: a focused pin rises above the others, so its name isn't covered`, Number(await z(harbour)) >= 2);
    await page.evaluate(() => document.activeElement?.blur());

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
    // Pin maps (by id); a pin map and a kind can be mixed.
    await page.goto(`${SITE}/v/${SLOT.slug}/?view=${view}&pins=battles`);
    await ready(page);
    await page.waitForSelector(".wpin", { state: "attached", timeout: 15000 });
    check(E, `${view}: pins=battles draws only that pin map`, (await page.locator(".wpin").count()) === 1 && (await page.locator('.wpin[data-name="Battle of the Red Field"]').count()) === 1);
    await page.goto(`${SITE}/v/${SLOT.slug}/?view=${view}&pins=holy-sites,cities`);
    await ready(page);
    await page.waitForSelector(".wpin", { state: "attached", timeout: 15000 });
    check(E, `${view}: pins=holy-sites,cities draws both pin maps`, (await page.locator(".wpin").count()) === 2);
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

/* ── Embed: kind filter chips and clusters (a synthetic pins file served by the test) ── */
for (const view of ["flat", "globe"]) {
  await step(E, `${view} filter and clusters`, async () => {
    const ctx = await browser.newContext({ viewport: { width: 900, height: 520 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const at = (i, base) => [Math.round((base[0] + (i % 3) * 0.01) * 1e4) / 1e4, Math.round((base[1] + Math.floor(i / 3) * 0.01) * 1e4) / 1e4];
    const mk = (id, kind, pos) => ({ id, name: `Pin ${id}`, kind, at: pos });
    const pins = [
      ...Array.from({ length: 6 }, (_, i) => mk(`town-${i}`, "town", at(i, [DISC.lon, DISC.lat]))), // one tight group
      mk("same-a", "city", [DISC.lon + 25, DISC.lat + 4]),
      mk("same-b", "city", [DISC.lon + 25, DISC.lat + 4]), // exactly the same spot: can't be zoomed apart
      mk("lone-ruin", "ruin", [65, -35]),
    ];
    await page.route("**/pins/*.json", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ pins, maps: [] }) }));
    await page.goto(`${SITE}/v/${SLOT.slug}/?view=${view}&pins=1&lon=${DISC.lon}&lat=${DISC.lat}&zoom=1&rotate=0`);
    await ready(page);
    await page.waitForSelector(".wpin.wcl:not([hidden])", { timeout: 15000 });
    await page.waitForTimeout(400);
    const cl = page.locator(".wpin.wcl:not([hidden])");
    check(E, `${view}: pins on one spot merge into a numbered cluster`, (await cl.filter({ hasText: "6" }).count()) === 1, await cl.allTextContents().then((t) => t.join(",")));
    check(E, `${view}: a cluster is a button with an accessible name`, /6 pins, zoom in/.test((await cl.filter({ hasText: "6" }).getAttribute("aria-label")) ?? ""));
    check(E, `${view}: the merged pins are not drawn singly`, (await page.locator('.wpin:not(.wcl):not([hidden])[data-name^="Pin town"]').count()) === 0);

    // The filter panel: a chip per kind with its count, pressed when on.
    const chips = page.locator(".wpl-chip");
    check(E, `${view}: one chip per kind present`, (await chips.count()) === 3, String(await chips.count()));
    check(E, `${view}: chip name has the kind and count`, (await chips.first().getAttribute("aria-label")) === "City, 2 pins");
    await page.locator('.wpl-chip[aria-label^="Town"]').click();
    await page.waitForTimeout(200);
    check(E, `${view}: switching a kind off hides its pins and cluster`, (await page.locator(".wpin.wcl:not([hidden])").filter({ hasText: "6" }).count()) === 0 && (await page.locator('.wpl-chip[aria-label^="Town"]').getAttribute("aria-pressed")) === "false");
    await page.locator('.wpl-chip[aria-label^="Town"]').click();
    await page.waitForTimeout(200);
    check(E, `${view}: and back on shows them again`, (await page.locator(".wpin.wcl:not([hidden])").filter({ hasText: "6" }).count()) === 1);
    await page.locator(".wpl-head").click();
    check(E, `${view}: the panel folds`, (await page.locator(".wpl-chips").isHidden()) && (await page.locator(".wpl-head").getAttribute("aria-expanded")) === "false");
    await page.locator(".wpl-head").click();
    await page.screenshot({ path: path.join(OUT, `embed-${view}-clusters.png`) });

    // Pins on exactly the same spot open a list instead of zooming.
    const pair = page.locator(".wpin.wcl:not([hidden])").filter({ hasText: "2" });
    if (await pair.count()) {
      await pair.first().click();
      check(E, `${view}: a cluster that can't zoom apart opens a list of its pins`, (await page.locator(".wcl-list button").count()) === 2);
      await page.locator(".wcl-list button").first().click();
      check(E, `${view}: choosing one opens its card`, await page.locator(".wpin-card").isVisible());
    } else check(E, `${view}: the same-spot pair is a cluster`, false, "not in view");

    // Clicking the big cluster zooms in until its pins separate.
    await page.keyboard.press("Escape");
    // (each click zooms a step; the globe zooms about 2x per click, so a few clicks may be needed)
    let after = 0;
    for (let i = 0; i < 6 && after < 2; i++) {
      const big = page.locator(".wpin.wcl:not([hidden])").filter({ hasText: "6" });
      if (!(await big.count())) break;
      await big.click();
      await page.waitForTimeout(900);
      after = await page.locator('.wpin:not(.wcl):not([hidden])[data-name^="Pin town"]').count();
    }
    check(E, `${view}: clicking a cluster zooms in and splits it`, after > 1 || (await page.locator(".wcl-list button").count()) > 0, `${after} single pins`);
    check(E, `${view}: no page errors`, errors.length === 0, errors.join(" | "));
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

await step(A, "the region editor lists pin maps in collapsible folders", async () => {
  const { ctx, page, errors } = await adminPage("Flanz1");
  await page.goto(`${SITE}/admin/#regions`);
  await pickRegion(page, "landmark-disc");
  await page.waitForSelector('[data-region="landmark-disc"] [data-action="edit"]', { timeout: 15000 });
  await pickRegion(page, "landmark-disc");
  await page.click('[data-region="landmark-disc"] [data-action="edit"]');
  await page.waitForSelector("dialog.editor[open]");
  await edTab(page, "underlays");
  await page.waitForSelector("dialog.editor[open] .ed-pinmaps");
  const picker = page.locator("dialog.editor .ed-pinmaps-list");
  check(A, "pin maps sit in the folders of the Pins tab, nested", (await picker.locator('.ed-pinfolder input[data-pinmap="holy-sites"]').count()) === 1 && (await picker.locator('.ed-pinfolder .ed-pinfolder input[data-pinmap="battles"]').count()) === 1);
  check(A, "a pin map in no folder is listed on its own", (await picker.locator('input[data-pinmap="cities"]').isChecked()) && (await picker.locator('.ed-pinfolder input[data-pinmap="cities"]').count()) === 0);
  check(A, "folders without a ticked pin map start closed", !(await picker.locator('input[data-pinmap="holy-sites"]').isVisible()));
  await picker.locator('.ed-pinfolder-toggle[data-pinfolder="places"]').click();
  check(A, "opening a folder shows its pin maps", await picker.locator('input[data-pinmap="holy-sites"]').isVisible());
  check(A, "a subfolder opens on its own", !(await picker.locator('input[data-pinmap="battles"]').isVisible()));
  await picker.locator('.ed-pinfolder-toggle[data-pinfolder="war"]').click();
  await picker.locator('input[data-pinmap="battles"]').check();
  await page.waitForTimeout(200);
  check(A, "ticking inside a folder keeps it open and shows the count on its badge", (await picker.locator('input[data-pinmap="battles"]').isVisible()) && /1\/2/.test((await picker.locator('.ed-pinfolder-toggle[data-pinfolder="places"] .badge').textContent()) ?? ""), await picker.locator('.ed-pinfolder-toggle[data-pinfolder="places"] .badge').textContent());
  await page.screenshot({ path: path.join(OUT, "editor-pin-folders.png"), clip: (await page.locator("dialog.editor .ed-pinmaps").boundingBox()) ?? undefined });
  check(A, "no errors in the admin page", errors.length === 0, errors.join(" | "));
  await ctx.close();
});

await step(A, "the region editor can show the slot's pins over the map", async () => {
  const { ctx, page, errors } = await adminPage("Flanz1");
  await page.goto(`${SITE}/admin/#regions`);
  await pickRegion(page, "landmark-disc");
  await page.waitForSelector('[data-region="landmark-disc"] [data-action="edit"]', { timeout: 15000 });
  await pickRegion(page, "landmark-disc");
  await page.click('[data-region="landmark-disc"] [data-action="edit"]');
  await page.waitForSelector("dialog.editor[open]");
  await edTab(page, "underlays");
  await page.waitForSelector("dialog.editor[open] .ed-pinmaps");
  check(A, "pins are hidden in the editor until switched on", !(await page.locator("dialog.editor .ed-pin-tip").isVisible()));
  await page.click('dialog.editor [data-act="overlays"]');
  const sw = page.locator('dialog.editor input[name="ed-pins-show"]');
  check(A, "the Other regions panel has a Show pins switch", await sw.isEnabled());
  await sw.check();
  await page.waitForTimeout(300);
  await page.click('dialog.editor [data-act="overlays"]');
  // Pins are painted on the canvas (under the region's handles), so find the marker by hovering its position.
  const at = await page.evaluate(([lon, lat]) => document.querySelector("dialog.editor").wgeEditor.toScreen(lon, lat), [DISC.lon, DISC.lat]);
  const cv = await page.locator("dialog.editor canvas.ed-canvas").boundingBox();
  await page.mouse.move(cv.x + at[0], cv.y + at[1]);
  const tip = page.locator("dialog.editor .ed-pin-tip");
  check(A, "hovering a pin shows its name and kind", (await tip.isVisible()) && /Magenta Harbour · City/.test((await tip.textContent()) ?? ""), await tip.textContent());
  await page.mouse.move(cv.x + 5, cv.y + 5);
  check(A, "the tooltip goes away off the pin", !(await tip.isVisible()));
  // A pin never takes the click: the part under it is still selected by clicking there.
  await page.mouse.click(cv.x + at[0], cv.y + at[1]);
  check(A, "clicking a pin passes through to the map", (await page.evaluate(() => document.querySelector("dialog.editor").wgeEditor.selectedPart())) >= 0);
  for (const [w, hgt] of [[1440, 900], [768, 900], [375, 800]])
    for (const scheme of ["light", "dark"]) {
      await page.setViewportSize({ width: w, height: hgt });
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(OUT, `editor-pins-layer-${w}-${scheme}.png`) });
      await page.click('dialog.editor [data-act="overlays"]');
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(OUT, `editor-pins-panel-${w}-${scheme}.png`) });
      await page.click('dialog.editor [data-act="overlays"]');
    }
  await page.setViewportSize({ width: 1440, height: 900 });
  check(A, "no errors in the admin page", errors.length === 0, errors.join(" | "));
  await ctx.close();
});

await step(A, "the region editor's Pin tool places, moves, edits and deletes pins", async () => {
  const { ctx, page, errors } = await adminPage("Flanz1");
  await page.goto(`${SITE}/admin/#regions`);
  await pickRegion(page, "landmark-disc");
  await page.waitForSelector('[data-region="landmark-disc"] [data-action="edit"]', { timeout: 15000 });
  await pickRegion(page, "landmark-disc");
  await page.click('[data-region="landmark-disc"] [data-action="edit"]');
  await page.waitForSelector("dialog.editor[open]");
  await edTab(page, "underlays");
  await page.waitForSelector("dialog.editor[open] .ed-pinmaps");
  const tool = page.locator('dialog.editor [data-act="pin-tool"]');
  check(A, "the toolbar has a Pin toggle, off at first", (await tool.getAttribute("aria-pressed")) === "false");
  await tool.click();
  check(A, "turning it on shows the pins and presses the toggle", (await tool.getAttribute("aria-pressed")) === "true");
  const cv = await page.locator("dialog.editor canvas.ed-canvas").boundingBox();
  const toScreen = (lon, lat) => page.evaluate(([a, b]) => document.querySelector("dialog.editor").wgeEditor.toScreen(a, b), [lon, lat]);
  // Click an empty spot (the map's top-left corner area) to place a pin.
  const n0 = mock.log.length;
  await page.mouse.click(cv.x + 40, cv.y + 60);
  const pop = page.locator("dialog.editor .ed-pin-pop");
  await pop.waitFor({ state: "visible", timeout: 5000 });
  check(A, "clicking the map opens the new-pin popover with Name focused", (await pop.locator("strong").textContent()) === "New pin" && (await page.evaluate(() => document.activeElement?.getAttribute("name"))) === "pin-name");
  // The tool buttons' pressed state is redrawn on the editor's next frame, which can lag on a loaded CI runner.
  await page.waitForFunction(() => !document.querySelector('dialog.editor button.tool[aria-pressed="true"]'), null, { timeout: 3000 }).catch(() => {});
  const pressed = await page.$$eval('dialog.editor button.tool[aria-pressed="true"]', (bs) => bs.map((b) => b.dataset.tool));
  check(A, "while Pin is on, no drawing tool shows as pressed", pressed.length === 0, pressed.join(", "));
  const pr = await pop.boundingBox();
  check(A, "the popover is beside the new pin, not over it", pr.x > cv.x + 40 + 10 || pr.x + pr.width < cv.x + 40 - 10, JSON.stringify(pr));
  await page.focus('dialog.editor [data-kind="city"]');
  await page.keyboard.press("ArrowRight");
  check(A, "arrow keys move through the kinds", (await pop.locator('[data-kind="town"]').getAttribute("aria-checked")) === "true" && (await page.evaluate(() => document.activeElement?.getAttribute("data-kind"))) === "town");
  await pop.locator('[data-kind="city"]').click();
  // Two fingers still pinch-zoom while the tool is on.
  const v0 = await page.evaluate(() => document.querySelector("dialog.editor").wgeEditor.view());
  const k0 = v0.k;
  await page.evaluate(([x, y]) => {
    const c = document.querySelector("dialog.editor canvas.ed-canvas");
    const ev = (type, id, dx) => c.dispatchEvent(new PointerEvent(type, { pointerId: id, button: 0, clientX: x + dx, clientY: y, bubbles: true, cancelable: true, pointerType: "touch" }));
    ev("pointerdown", 11, -40);
    ev("pointerdown", 12, 40);
    for (let i = 1; i <= 5; i++) {
      ev("pointermove", 11, -40 - i * 10);
      ev("pointermove", 12, 40 + i * 10);
    }
    ev("pointerup", 11, -90);
    ev("pointerup", 12, 90);
  }, [cv.x + 400, cv.y + 300]);
  const k1 = await page.evaluate(() => document.querySelector("dialog.editor").wgeEditor.view().k);
  await page.evaluate((v) => document.querySelector("dialog.editor").wgeEditor.setView(v.cx, v.cy, v.k), v0);
  await page.waitForTimeout(200);
  check(A, "a two-finger pinch zooms the map while Pin is on", k1 > k0 * 1.3, `${k0} -> ${k1}`);
  check(A, "…and the pinch does not place a pin", (await pop.locator("strong").textContent()) === "New pin");
  check(A, "the status line names the Pin mode", /^Pin · click the map/.test((await page.textContent("dialog.editor .ed-status")) ?? ""), await page.textContent("dialog.editor .ed-status"));
  check(A, "kinds are a radiogroup of chips", (await pop.locator('[role=radiogroup] [role=radio]').count()) === 10);
  await pop.locator('input[name="pin-name"]').fill("Editor Port");
  for (const [w, hgt] of [[1440, 900], [768, 900], [375, 800]])
    for (const scheme of ["light", "dark"]) {
      await page.setViewportSize({ width: w, height: hgt });
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(OUT, `editor-pin-tool-${w}-${scheme}.png`) });
      if (w === 375 && scheme === "light") {
        const sv = await pop.locator('[data-act="pin-save"]').boundingBox();
        check(A, "at 375 the sheet's Save pin button is in view", !!sv && sv.y + sv.height <= 800 && sv.y >= 0, JSON.stringify(sv));
      }
    }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForTimeout(300);
  await pop.locator('[data-kind="port"]').click();
  check(A, "choosing a kind checks its chip", (await pop.locator('[data-kind="port"]').getAttribute("aria-checked")) === "true" && (await pop.locator('[data-kind="city"]').getAttribute("aria-checked")) === "false");
  await pop.locator('select[name="pin-map"]').selectOption("battles");
  await pop.locator('input[name="pin-link"]').fill(NOTE);
  await pop.locator('[data-act="pin-save"]').click();
  await waitCommit(page, n0);
  const c = mock.log.slice(n0);
  check(A, "Save pin is one commit of just that pin (the region isn't saved)", c.length === 1 && c[0].changes.length === 1 && c[0].changes[0].path === "content/pins/editor-port.json", JSON.stringify(c.map((x) => x.changes.map((y) => y.path))));
  const f = onBranch("content/pins/editor-port.json");
  const p = f?.properties;
  check(A, "the file has the popover's values", p?.name === "Editor Port" && p.kind === "port" && p.pinMap === "battles" && p.link === NOTE && p.slot === SLOT.slug && p.createdBy?.login === "Flanz1", JSON.stringify(p));
  check(A, "the popover closes after saving", !(await pop.isVisible()));
  // Place another: it starts with the last kind and pin map.
  await page.mouse.click(cv.x + 90, cv.y + 60);
  await pop.waitFor({ state: "visible" });
  check(A, "the next pin starts with the last kind and pin map", (await pop.locator('[data-kind="port"]').getAttribute("aria-checked")) === "true" && (await pop.locator('select[name="pin-map"]').inputValue()) === "battles");
  // Unsaved changes ask before they are lost.
  await pop.locator('input[name="pin-name"]').fill("Half done");
  await tool.click();
  await page.waitForSelector("dialog.small-dlg.danger[open]");
  check(A, "turning the tool off asks before dropping an unsaved pin", /Unsaved pin/.test((await page.textContent("dialog.small-dlg.danger[open]")) ?? ""));
  await page.click("dialog.small-dlg.danger[open] button:has-text('Keep editing')");
  check(A, "Keep editing leaves the popover as it was", (await pop.isVisible()) && (await pop.locator('input[name="pin-name"]').inputValue()) === "Half done");
  // A new pin map from the popover.
  const nm = mock.log.length;
  await pop.locator('select[name="pin-map"]').selectOption({ label: "New pin map…" });
  await page.fill('dialog[open] input[data-field="pinmap-name"]', "Fresh map");
  await page.click('dialog[open] button[data-action="confirm-pinmap"]');
  await waitCommit(page, nm);
  await page.waitForFunction(() => /Fresh map/.test(document.querySelector('dialog.editor select[name="pin-map"]')?.selectedOptions[0]?.textContent ?? ""), null, { timeout: 5000 });
  check(A, "New pin map… creates the map and picks it", !!(onBranch("content/pinmaps.json")?.maps ?? []).find((m) => m.name === "Fresh map"));
  await pop.locator('[data-act="pin-save"]').click();
  await waitCommit(page, nm + 1);
  check(A, "…and the pin is saved into it", onBranch("content/pins/half-done.json")?.properties.pinMap === "fresh-map", JSON.stringify(onBranch("content/pins/half-done.json")?.properties));
  // Click a pin to edit it, drag to move it.
  const [px, py] = await toScreen(...onBranch("content/pins/editor-port.json").geometry.coordinates);
  await page.mouse.click(cv.x + px, cv.y + py);
  await pop.waitFor({ state: "visible" });
  check(A, "clicking a pin opens it for editing", (await pop.locator('input[name="pin-name"]').inputValue()) === "Editor Port" && (await pop.locator("strong").textContent()) === "Pin");
  const n1 = mock.log.length;
  await page.mouse.move(cv.x + px, cv.y + py);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(cv.x + px + (40 * i) / 6, cv.y + py + (20 * i) / 6);
  await page.mouse.up();
  check(A, "dragging a pin moves it without saving yet", mock.log.length === n1);
  await pop.locator('[data-act="pin-save"]').click();
  await waitCommit(page, n1);
  const g = onBranch("content/pins/editor-port.json");
  check(A, "Save pin writes the new position and keeps who placed it", g.geometry.coordinates[0] !== f.geometry.coordinates[0] && g.properties.created === p.created, JSON.stringify(g.geometry));
  // Delete.
  const n2 = mock.log.length;
  await page.mouse.click(cv.x + (await toScreen(...g.geometry.coordinates))[0], cv.y + (await toScreen(...g.geometry.coordinates))[1]);
  await pop.waitFor({ state: "visible" });
  await pop.locator('[data-act="pin-delete"]').click();
  await page.click("dialog.small-dlg.danger[open] button:has-text('Delete pin')");
  await waitCommit(page, n2);
  check(A, "Delete pin removes the file in one commit", !onBranch("content/pins/editor-port.json") && mock.log.length === n2 + 1);
  // Tidy up: the second pin goes too.
  const [hx, hy] = await toScreen(...onBranch("content/pins/half-done.json").geometry.coordinates);
  await page.mouse.click(cv.x + hx, cv.y + hy);
  await pop.waitFor({ state: "visible" });
  const n3 = mock.log.length;
  await pop.locator('[data-act="pin-delete"]').click();
  await page.click("dialog.small-dlg.danger[open] button:has-text('Delete pin')");
  await waitCommit(page, n3);
  // Escape leaves the tool.
  await page.keyboard.press("Escape");
  check(A, "Escape turns the tool off", (await tool.getAttribute("aria-pressed")) === "false");
  await page.screenshot({ path: path.join(OUT, "editor-pin-tool.png") });
  check(A, "no errors in the admin page", errors.length === 0, errors.join(" | "));
  await ctx.close();
});

await step(A, "owner places, moves and deletes a pin", async () => {
  const { ctx, page, errors } = await adminPage("Flanz1");
  check(A, "the list shows the slot's saved pins", (await page.locator(".pn-row").count()) === SEED.length, String(await page.locator(".pn-row").count()));
  check(A, "…and the map shows a marker for each", (await page.locator(".pn-marker").count()) === SEED.length);

  const n0 = mock.log.length;
  await page.click("#tab-pins button:has-text('Place pins')");
  const pane = await page.locator(".pn-pane").boundingBox();
  await page.mouse.click(pane.x + pane.width / 2, pane.y + pane.height / 2);
  await page.waitForSelector(".pn-form");
  // The new marker is drawn a frame after the form opens, so wait for it instead of counting once.
  await page.waitForFunction((n) => document.querySelectorAll(".pn-marker").length === n, SEED.length + 1, { timeout: 5000 }).catch(() => {});
  check(A, "clicking the map opens the new-pin form", (await page.locator(".pn-marker").count()) === SEED.length + 1);
  await page.fill('.pn-form input[aria-label="Name"]', "Test Harbour");
  await page.click('.pn-form [data-kind="port"]');
  await page.fill(".pn-form input[type=url]", "http://not-https.example/x");
  await page.click(".pn-form button[type=submit]");
  check(A, "a link that isn't https is refused", /https/.test((await page.textContent(".pn-form .error")) ?? "") && mock.log.length === n0);
  await page.fill(".pn-form input[type=url]", NOTE);
  await page.fill(".pn-form textarea", "A test.");
  await page.selectOption('.pn-form select[aria-label="Pin map"]', "battles");
  await page.screenshot({ path: path.join(OUT, "admin-new-pin.png") });
  await page.click(".pn-form button[type=submit]");
  await waitCommit(page, n0);
  const c = mock.log.slice(n0);
  check(A, "saving is one commit to content/pins/test-harbour.json", c.length === 1 && c[0].branch === BRANCH && c[0].changes.length === 1 && c[0].changes[0].path === "content/pins/test-harbour.json", JSON.stringify(c));
  const f = onBranch("content/pins/test-harbour.json");
  const p = f?.properties;
  check(A, "the file has the form's values", p?.name === "Test Harbour" && p.kind === "port" && p.link === NOTE && p.description === "A test." && p.slot === SLOT.slug && p.map === "landmarks" && p.pinMap === "battles", JSON.stringify(p));
  check(A, "…placed by and saved by the signed-in person", p?.createdBy?.login === "Flanz1" && p?.updatedBy?.login === "Flanz1" && /^\d{4}-\d\d-\d\dT/.test(p?.created ?? ""));
  const [lon, lat] = f?.geometry.coordinates ?? [99, 99];
  check(A, "the position is where the map was clicked (the middle of the map)", Math.abs(lon) < 1 && Math.abs(lat) < 1, `${lon}, ${lat}`);
  await page.waitForSelector('.pn-row:has-text("Test Harbour")');
  check(A, "the new pin is in the list", (await page.locator(".pn-row").count()) === SEED.length + 1);

  // Place mode is sticky and remembers the last kind and pin map.
  check(A, "place mode stays on after a pin is saved", await page.locator(".pn-placing").isVisible());
  await page.mouse.click(pane.x + pane.width * 0.25, pane.y + pane.height * 0.25);
  await page.waitForFunction(() => document.querySelector(".pn-form input[aria-label=Name]")?.value === "");
  check(A, "the next pin starts with the last kind and pin map", (await page.locator('.pn-form [data-kind="port"]').getAttribute("aria-checked")) === "true" && (await page.inputValue('.pn-form select[aria-label="Pin map"]')) === "battles");
  check(A, "kinds are a radiogroup", (await page.locator(".pn-form [role=radiogroup] [role=radio]").count()) === 10);
  await page.fill('.pn-form input[aria-label="Name"]', "Unsaved one");
  await page.locator(".pn-row", { hasText: "Old Ruin" }).click();
  await page.waitForSelector("dialog.small-dlg.danger[open]");
  check(A, "leaving an unsaved pin asks first", /Unsaved pin/.test((await page.textContent("dialog.small-dlg.danger[open]")) ?? ""));
  await page.click("dialog.small-dlg.danger[open] button:has-text('Keep editing')");
  check(A, "Keep editing leaves the form as it was", (await page.inputValue('.pn-form input[aria-label="Name"]')) === "Unsaved one");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
  check(A, "Esc ends place mode", !(await page.locator(".pn-placing").isVisible()));
  await page.locator(".pn-row", { hasText: "Test Harbour" }).click();
  await page.click("dialog.small-dlg.danger[open] button:has-text('Discard pin')");
  await page.waitForFunction(() => document.querySelector(".pn-form input[aria-label=Name]")?.value === "Test Harbour");
  check(A, "Discard pin drops the unsaved pin and opens the other", (await page.locator(".pn-marker").count()) === SEED.length + 1);
  // Labels, region outlines and the kind filter.
  await page.click('.pn-zoom button[data-action="pin-labels"]');
  await page.waitForTimeout(200);
  check(A, "Labels shows names next to the pins", (await page.locator(".pn-layer").getAttribute("data-labels")) === "true" && (await page.locator(".pn-marker .pn-label").first().isVisible()));
  await page.click('.pn-zoom button[data-action="pin-regions"]');
  check(A, "Regions is a pressed toggle", (await page.locator('.pn-zoom button[data-action="pin-regions"]').getAttribute("aria-pressed")) === "true");
  await page.click('.pn-kindbar [data-kind="battle"]');
  for (const [w, hgt] of [[1440, 900], [768, 900], [375, 800]])
    for (const scheme of ["light", "dark"]) {
      await page.setViewportSize({ width: w, height: hgt });
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(300);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(OUT, `pins-tab-${w}-${scheme}.png`), fullPage: true });
      if (w !== 768) {
        const bar = page.locator("#tab-pins .pn-tools");
        const top = page.locator("#tab-pins .pn-actions button:has-text('Place pins')");
        await top.click();
        await page.waitForSelector(".pn-placing:not([hidden])");
        const box = await page.locator("#tab-pins h2").boundingBox();
        await page.screenshot({ path: path.join(OUT, `pins-placing-${w}-${scheme}.png`), clip: { x: 0, y: Math.max(0, box.y - 10), width: w, height: Math.min(520, hgt - box.y) } });
        if (w === 375 && scheme === "light") {
          const b = await bar.boundingBox();
          check(A, "at 375 the header actions sit under the fields on a row of their own", b.width <= 375);
          const more = page.locator('.pinmap[data-pinmap="battles"] .act-more button[data-action="more"]');
          check(A, "at 375 a pin map row keeps Embed code… and moves the rest into More…", (await page.locator('.pinmap[data-pinmap="battles"] button[data-action="embed-map"]').isVisible()) && !(await page.locator('.pinmap[data-pinmap="battles"] button[data-action="rename-map"]').isVisible()) && (await more.isVisible()));
          await more.click();
          check(A, "…the menu has Move, Rename and Delete", (await page.locator('.rmenu:popover-open button').allTextContents()).join("|") === "Move…|Rename…|Delete…");
          await page.keyboard.press("Escape");
          check(A, "folder reorder buttons have names", (await page.locator('.rfolder button[data-action="up"]').first().getAttribute("aria-label")) !== null);
        }
        if (await page.locator("#tab-pins button[data-action=place-done]").isVisible()) await page.click("#tab-pins button[data-action=place-done]");
      }
    }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForTimeout(300);
  const kinds = await page.locator(".pn-row .muted").allTextContents();
  check(A, "the kind chips narrow the list", kinds.length > 0 && kinds.every((k) => k === "Battle"), JSON.stringify(kinds));
  await page.click('.pn-kindbar [data-kind="battle"]');
  await page.click('.pn-zoom button[data-action="pin-labels"]');
  await page.click('.pn-zoom button[data-action="pin-regions"]');
  // Arrow keys nudge the selected marker.
  await page.locator(".pn-row", { hasText: "Test Harbour" }).click();
  await page.locator(".pn-marker[aria-pressed=true]").focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  const posAfter = await page.textContent(".pn-pos");
  check(A, "arrow keys move the selected pin and the readout is plain", /° [NS], .*° [EW]/.test(posAfter ?? "") && !/frame/.test(posAfter ?? ""), posAfter);
  await page.keyboard.press("Escape");
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
  await page.click("#tab-pins button:has-text('Embed code')");
  await page.waitForSelector(".embed-dlg .pn-cats, .pn-cats");
  await page.check('.pn-cats input[aria-label="Battles"]');
  await page.check('.pn-cats input[aria-label="Holy sites"]');
  const embedCode = await page.inputValue('textarea[aria-label="Embed code"]');
  check(A, "the embed code builder picks pin maps", /pins=holy-sites,battles"/.test(embedCode) && (await page.locator('.pn-cats input[aria-label="All pins"]').isChecked()) === false, embedCode);
  await page.keyboard.press("Escape");
  check(A, "deleting removes the file in one commit", !onBranch("content/pins/test-harbour.json") && mock.log.length === n2 + 1);
  await page.waitForTimeout(500);
  check(A, "…and the pin leaves the list", (await page.locator(".pn-row").count()) === SEED.length);
  check(A, "no errors in the admin page", errors.length === 0, errors.join(" | "));
  await ctx.close();
});

await step(A, "owner organises pin maps and folders", async () => {
  const { ctx, page, errors } = await adminPage("Flanz1");
  check(A, "pin maps show in their folders, nested", (await page.locator('.rfolder[data-pinfolder="places"] .rfolder[data-pinfolder="war"] .pinmap[data-pinmap="battles"]').count()) === 1 && (await page.locator('.rfolder[data-pinfolder="places"] > .rfolder-body > .pinmap[data-pinmap="holy-sites"]').count()) === 1);
  check(A, "a pin map outside any folder is listed too", (await page.locator('.pinmap[data-pinmap="cities"]').count()) === 1);
  // A new pin map.
  let n = mock.log.length;
  await page.click("#tab-pins button[data-action=new-pinmap]");
  await page.fill('dialog[open] input[data-field="pinmap-name"]', "Trade ports");
  await page.click('dialog[open] button[data-action="confirm-pinmap"]');
  await waitCommit(page, n);
  let f = onBranch("content/pinmaps.json");
  check(A, "adding a pin map is one commit to content/pinmaps.json", mock.log.length === n + 1 && f?.maps.some((m) => m.id === "trade-ports" && m.slot === SLOT.slug && m.name === "Trade ports"), JSON.stringify(f?.maps));
  await page.waitForSelector('.pinmap[data-pinmap="trade-ports"]');
  // Duplicate names on a slot are refused.
  n = mock.log.length;
  await page.click("#tab-pins button[data-action=new-pinmap]");
  await page.fill('dialog[open] input[data-field="pinmap-name"]', "trade PORTS");
  await page.click('dialog[open] button[data-action="confirm-pinmap"]');
  check(A, "a second pin map with the same name is refused", /already a pin map/.test((await page.textContent("dialog[open] .error")) ?? "") && mock.log.length === n);
  await page.keyboard.press("Escape");
  // A new folder, then the pin map into it.
  n = mock.log.length;
  await page.click("#tab-pins button[data-action=new-pinfolder]");
  await page.fill('dialog[open] input[data-field="pinmap-name"]', "Trade");
  await page.click('dialog[open] button[data-action="confirm-pinmap"]');
  await waitCommit(page, n);
  f = onBranch("content/pinmaps.json");
  check(A, "adding a folder is one commit", mock.log.length === n + 1 && f?.folders.some((k) => k.id === "trade" && !k.parent), JSON.stringify(f?.folders.map((k) => k.id)));
  n = mock.log.length;
  await page.click('.pinmap[data-pinmap="trade-ports"] button[data-action="move-map"]');
  await page.selectOption('dialog[open] select[data-field="pinmap-folder"]', "trade");
  await page.click('dialog[open] button[data-action="confirm-move-pinmap"]');
  await waitCommit(page, n);
  f = onBranch("content/pinmaps.json");
  check(A, "moving a pin map into a folder", f?.folders.find((k) => k.id === "trade")?.regions.includes("trade-ports"), JSON.stringify(f?.folders));
  // A subfolder, then rename the pin map.
  n = mock.log.length;
  await page.click('.rfolder[data-pinfolder="trade"] > .rfolder-head button[data-action="subfolder"]');
  await page.fill('dialog[open] input[data-field="pinmap-name"]', "Sea");
  await page.click('dialog[open] button[data-action="confirm-pinmap"]');
  await waitCommit(page, n);
  f = onBranch("content/pinmaps.json");
  check(A, "a subfolder nests under its folder", f?.folders.some((k) => k.id === "sea" && k.parent === "trade"), JSON.stringify(f?.folders.map((k) => [k.id, k.parent])));
  n = mock.log.length;
  await page.click('.pinmap[data-pinmap="trade-ports"] button[data-action="rename-map"]');
  await page.fill('dialog[open] input[data-field="pinmap-name"]', "Ports of trade");
  await page.click('dialog[open] button[data-action="confirm-pinmap"]');
  await waitCommit(page, n);
  f = onBranch("content/pinmaps.json");
  check(A, "renaming keeps the id (embeds keep working)", f?.maps.some((m) => m.id === "trade-ports" && m.name === "Ports of trade"));
  // Deleting a pin map leaves its pins.
  n = mock.log.length;
  await page.click('.pinmap[data-pinmap="battles"] button[data-action="delete-map"]');
  await page.click("dialog.small-dlg.danger[open] button:has-text('Delete pin map')");
  await waitCommit(page, n);
  f = onBranch("content/pinmaps.json");
  check(A, "deleting a pin map removes it from its folder and keeps the pins", !f?.maps.some((m) => m.id === "battles") && !f?.folders.some((k) => k.regions.includes("battles")) && !!onBranch("content/pins/red-field.json"));
  await page.waitForTimeout(400);
  check(A, "…the pin shows as not in a pin map", (await page.locator('.pinmap.loose .pn-row:has-text("Battle of the Red Field")').count()) === 1);
  // Embed code for one pin map.
  await page.click('.pinmap[data-pinmap="holy-sites"] button[data-action="embed-map"]');
  const code = await page.inputValue('textarea[aria-label="Embed code"]');
  check(A, "a pin map's own embed code points at it", /pins=holy-sites"/.test(code), code);
  check(A, "no errors in the admin page", errors.length === 0, errors.join(" | "));
  await ctx.close();
});

await step(A, "a contributor", async () => {
  const { ctx, page, errors } = await adminPage("carto-ann");
  await page.locator(".pn-row", { hasText: "Old Ruin" }).click();
  await page.waitForSelector(".pn-form");
  check(A, "can open someone else's pin but not change it", (await page.locator('.pn-form input[aria-label="Name"]').isDisabled()) && (await page.locator(".pn-form button[type=submit]").count()) === 0 && (await page.locator(".pn-form button:has-text('Delete pin')").count()) === 0);
  await page.screenshot({ path: path.join(OUT, "admin-contributor.png") });
  const n0 = mock.log.length;
  await page.click("#tab-pins button:has-text('Place pins')");
  const pane = await page.locator(".pn-pane").boundingBox();
  await page.mouse.click(pane.x + pane.width / 3, pane.y + pane.height / 2);
  await page.waitForSelector('.pn-form input[aria-label="Name"]:not([disabled])');
  await page.fill('.pn-form input[aria-label="Name"]', "Ann's Camp");
  await page.click(".pn-form button[type=submit]");
  await waitCommit(page, n0);
  const f = onBranch("content/pins/ann-s-camp.json");
  check(A, "can place their own pin", f?.properties.createdBy.login === "carto-ann" && f.properties.name === "Ann's Camp", JSON.stringify(f?.properties));
  check(A, "no errors in the admin page", errors.length === 0, errors.join(" | "));
  await ctx.close();
});

await step(A, "the region preview shows the pins of its pin maps", async () => {
  const { ctx, page, errors } = await adminPage("Flanz1");
  await page.goto(`${SITE}/admin/#regions`);
  await pickRegion(page, "landmark-disc");
  await page.waitForSelector('[data-region="landmark-disc"] [data-action="preview"]', { timeout: 15000 });
  await pickRegion(page, "landmark-disc");
  await page.click('[data-region="landmark-disc"] [data-action="preview"]');
  const frame = page.frameLocator("dialog[open] iframe.rp-frame");
  // The region includes the "Cities" pin map: its one pin shows, though the pins aren't part of the preview page.
  await frame.locator('.wpin[data-name="Magenta Harbour"]').waitFor({ state: "attached", timeout: 30000 });
  check(A, "the region preview draws the pins of the pin maps the region includes", (await frame.locator(".wpin").count()) === 1);
  check(A, "no errors in the admin page", errors.length === 0, errors.join(" | "));
  await ctx.close();
});

await step(A, "legend names: set per pin map in the region editor's Underlays section and saved on the region", async () => {
  const { ctx, page, errors } = await adminPage("Flanz1");
  await page.goto(`${SITE}/admin/#regions`);
  await pickRegion(page, "landmark-disc");
  await page.waitForSelector('[data-region="landmark-disc"] [data-action="edit"]', { timeout: 15000 });
  await pickRegion(page, "landmark-disc");
  await page.click('[data-region="landmark-disc"] [data-action="edit"]');
  await page.waitForSelector("dialog.editor[open]");
  await edTab(page, "underlays");
  await page.waitForSelector("dialog.editor[open] .ed-pinmaps");
  check(A, "no Legend names button in the Pins tab any more", true);
  const btn = page.locator('dialog.editor .ed-pinmaps [data-action="legend-names"][data-pinmap="cities"]');
  check(A, "a ticked pin map has its own Legend names… button", (await btn.count()) === 1 && (await page.locator('dialog.editor .ed-pinmaps [data-action="legend-names"]').count()) === 1);
  for (const [w, h] of [[375, 800], [1440, 900]])
    for (const scheme of ["light", "dark"]) {
      await page.setViewportSize({ width: w, height: h });
      await page.emulateMedia({ colorScheme: scheme });
      const tab = page.locator('dialog.editor .ed-tab[data-sec="underlays"]');
      if (await tab.isVisible()) await tab.click();
      await page.waitForTimeout(300);
      await page.locator("dialog.editor .ed-pinmaps").scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      await page.screenshot({ path: path.join(OUT, `legend-names-${w}-${scheme}-button.png`) });
    }
  await page.setViewportSize({ width: 1440, height: 900 });
  await btn.click();
  const dlg = page.locator("dialog.legend-dlg[open]");
  await dlg.waitFor();
  check(A, "one input per kind plus the title, default names as placeholders", (await dlg.locator("input").count()) === 11 && (await dlg.locator('input[data-field="legend-kind-temple"]').getAttribute("placeholder")) === "Temple or shrine");
  for (const [w, h] of [[375, 800], [1440, 900]])
    for (const scheme of ["light", "dark"]) {
      await page.setViewportSize({ width: w, height: h });
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(OUT, `legend-names-${w}-${scheme}-modal.png`) });
    }
  await page.setViewportSize({ width: 1440, height: 900 });
  await dlg.locator('input[data-field="legend-title"]').fill("Places of note");
  await dlg.locator('input[data-field="legend-kind-city"]').fill("Settlement");
  await dlg.locator('[data-action="confirm-legend"]').click();
  await page.waitForTimeout(300);
  check(A, "the button shows the words are set", /✓/.test((await btn.textContent()) ?? "") && /custom names set/.test((await btn.getAttribute("aria-label")) ?? ""));
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(200);
    await page.locator("dialog.editor .ed-pinmaps").screenshot({ path: path.join(OUT, `legend-names-1440-${scheme}-button-set.png`) });
  }
  const n0 = mock.log.length;
  await page.click("dialog.editor .ed-save");
  await waitCommit(page, n0);
  const r = onBranch("content/regions/landmark-disc.json");
  check(A, "saved on the region under pinLegends[pin map id]", JSON.stringify(r?.properties.pinLegends) === JSON.stringify({ cities: { title: "Places of note", kinds: { city: "Settlement" } } }), JSON.stringify(r?.properties.pinLegends));
  check(A, "pin maps themselves are untouched", !JSON.stringify(onBranch("content/pinmaps.json")).includes("legend"));
  await btn.click();
  await dlg.waitFor();
  check(A, "reopening shows the saved words", (await dlg.locator('input[data-field="legend-kind-city"]').inputValue()) === "Settlement");
  await dlg.locator('[data-action="reset-legend"]').click();
  await dlg.locator('[data-action="confirm-legend"]').click();
  await page.waitForTimeout(300);
  check(A, "Reset all then Save clears the words", !/✓/.test((await btn.textContent()) ?? ""));
  check(A, "no errors in the admin page", errors.length === 0, errors.join(" | "));
  await ctx.close();
});

await step(E, "a region embed shows its pin map's legend words", async () => {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 520 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  // The built region index (inline in the page) carries pl; check the shipped page, then the embed with a legend injected.
  const html = readFileSync(path.join(DIST, "v", SLOT.slug, "index.html"), "utf8");
  check(E, "the page's region index has no legend words when none are set", !html.includes('"pl"'));
  await ctx.route(/\/v\/[a-z0-9-]+\/(\?.*)?$/, async (r) => {
    const resp = await r.fetch();
    const body = (await resp.text()).replace('"pm":["cities"]', '"pm":["cities"],"pl":{"cities":{"title":"Places of note","kinds":{"city":"Settlement"}}}');
    await r.fulfill({ response: resp, body });
  });
  await page.goto(`${SITE}/v/${SLOT.slug}/?region=landmark-disc&view=flat`);
  await ready(page);
  await page.waitForSelector(".wpin", { timeout: 15000, state: "attached" });
  // One pin map with one kind shows no panel (needs 2+ kinds): the pin card shows the label instead.
  await page.locator(".wpin:not([hidden])").first().click();
  check(E, "the pin card uses the renamed kind", /Settlement/.test((await page.locator(".wpin-card .kind").textContent()) ?? ""), await page.locator(".wpin-card .kind").textContent());
  await ctx.close();
});

await browser.close();
site.close();
await writeFile(path.join(OUT, "report.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed:\n${failed.map((f) => `  [${f.group}] ${f.name} ${f.detail}`).join("\n")}` : ""}`);
process.exit(failed.length ? 1 : 0);
