// e2e-suite: roots=src/admin/bulk.ts,src/admin/pins.ts cut=src/admin/session.ts,src/admin/pinmaps.ts weight=1
/**
 * Browser checks for selecting several pins on the Pins tab, in headless Chromium.
 *
 *   npm run e2e -- bulk-pins
 *
 * "Select pins" shows checkboxes and the bar; ticking pins and Change pin map or Delete each save in ONE commit;
 * a contributor can't delete the owner's pins; clicking a row ticks it instead of opening it; Esc leaves the mode.
 *
 * Runs against the mock GitHub and admin API (no live data). Screenshots and report.json go to .e2e/bulk-pins/.
 */
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { makeFixture, SLOT } from "./fixture.mjs";
import { MockGitHub } from "./mock-github.mjs";
import { useAdminApi } from "./admin-api.mjs";
import { port } from "./ports.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const OUT = path.resolve(".e2e/bulk-pins");
const BRANCH = "test/bulk-pins";
const SITE = `http://localhost:${port(4173)}`;
await mkdir(OUT, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` (${detail})` : ""}`);
}

const OWNER = { id: 45669787, login: "Flanz1" };
const pin = (id, name, kind, at, extra = {}) => ({
  $schema: "../../schema/pin.schema.json",
  type: "Feature",
  id,
  properties: { slot: SLOT.slug, map: "landmarks", name, kind, createdBy: OWNER, created: "2026-11-14T10:00:00Z", updatedBy: OWNER, updated: "2026-11-14T10:00:00Z", ...extra },
  geometry: { type: "Point", coordinates: at },
});
const SEED = [
  pin("alpha", "Alpha Harbour", "city", [10, 10], { pinMap: "cities" }),
  pin("beta", "Beta Ruin", "ruin", [-20, -20], { pinMap: "cities" }),
  pin("gamma", "Gamma Field", "battle", [30, -35], { pinMap: "cities" }),
  pin("delta", "Delta Stone", "landmark", [-40, 30]),
];
const PINMAPS = {
  $schema: "../schema/pinmaps.schema.json",
  folders: [],
  maps: [
    { id: "cities", name: "Cities", slot: SLOT.slug },
    { id: "battles", name: "Battles", slot: SLOT.slug },
  ],
};

const dir = await makeFixture({ quiet: true });
writeFileSync(path.join(dir, "content/pinmaps.json"), JSON.stringify(PINMAPS, null, 2) + "\n");
mkdirSync(path.join(dir, "content/pins"), { recursive: true });
for (const p of SEED) writeFileSync(path.join(dir, "content/pins", `${p.id}.json`), JSON.stringify(p, null, 2) + "\n");
const accessFile = path.join(dir, "content/access.json");
const access = JSON.parse(readFileSync(accessFile, "utf8"));
access.users.push({ id: 5002, login: "carto-ann", permissions: ["regions"] });
writeFileSync(accessFile, JSON.stringify(access, null, 2) + "\n");
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
const mock = new MockGitHub({ root: dir, branches: ["main", BRANCH] });
const onBranch = (p) => (mock.read(BRANCH, p) ? JSON.parse(mock.read(BRANCH, p).toString()) : null);
const waitCommit = async (page, n) => {
  const t0 = Date.now();
  while (mock.log.length <= n && Date.now() - t0 < 15000) await page.waitForTimeout(100);
  await page.waitForTimeout(400);
};
async function adminPage(as, width = 1440, height = 900) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
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
const tick = (page, id) => page.locator(`#tab-pins .pn-item[data-pin="${id}"] input.bulk-box`).check();

try {
  const owner = await adminPage("Flanz1");
  const { page } = owner;
  check("no checkboxes or bar before 'Select pins'", (await page.locator("#tab-pins input.bulk-box").count()) === 0 && (await page.locator(".bulk-bar:not([hidden])").count()) === 0);
  await page.click('#tab-pins [data-action="select-pins"]');
  check("the button is pressed and the bar shows", (await page.getAttribute('#tab-pins [data-action="select-pins"]', "aria-pressed")) === "true" && (await page.locator(".bulk-bar:not([hidden])").isVisible()));
  check("with nothing ticked every action is disabled", (await page.locator('.bulk-bar:not([hidden]) [data-action="bulk-move"]').isDisabled()) && (await page.locator('.bulk-bar:not([hidden]) [data-action="bulk-delete"]').isDisabled()));
  check("Place pins is off while selecting", await page.locator('#tab-pins [data-action="place-pins"]').isDisabled().catch(() => true));
  await tick(page, "alpha");
  await page.click('#tab-pins .pn-item[data-pin="beta"] .pn-row');
  check("a row click ticks it instead of opening the pin", (await page.locator(".bulk-bar:not([hidden]) .bulk-count").textContent()) === "2 selected" && (await page.locator(".pn-form input[type=text]").count()) === 0);
  await page.screenshot({ path: path.join(OUT, "selected.png") });

  let n = mock.log.length;
  await page.click('.bulk-bar:not([hidden]) [data-action="bulk-move"]');
  await page.selectOption('dialog select[data-field="bulk-pinmap"]', "battles");
  await page.click('dialog [data-action="confirm-bulk-move"]');
  await waitCommit(page, n);
  check("moving both to a pin map is one commit", mock.log.length === n + 1 && onBranch("content/pins/alpha.json")?.properties.pinMap === "battles" && onBranch("content/pins/beta.json")?.properties.pinMap === "battles" && onBranch("content/pins/gamma.json")?.properties.pinMap === "cities", mock.log.slice(n).map((c) => c.message).join(","));
  check("the ticks survive the save", (await page.locator(".bulk-bar:not([hidden]) .bulk-count").textContent()) === "2 selected");

  // A contributor can't delete pins made by someone else.
  const ann = await adminPage("carto-ann");
  await ann.page.click('#tab-pins [data-action="select-pins"]');
  await tick(ann.page, "gamma");
  const why = (await ann.page.locator('.bulk-bar:not([hidden]) [data-action="bulk-delete"]').getAttribute("title")) ?? "";
  check("a contributor can't delete the owner's pin: disabled, with the reason", (await ann.page.locator('.bulk-bar:not([hidden]) [data-action="bulk-delete"]').isDisabled()) && /can't delete/.test(why), why);
  check("no errors in the contributor's page", ann.errors.length === 0, ann.errors.join(" | "));
  await ann.ctx.close();

  n = mock.log.length;
  await page.click('.bulk-bar:not([hidden]) [data-action="bulk-delete"]');
  const text = await page.locator("dialog[open]").textContent();
  check("the delete dialog lists the pins and the trash", /alpha/.test(text ?? "") && /Recently deleted/.test(text ?? ""));
  await page.screenshot({ path: path.join(OUT, "delete-dialog.png") });
  await page.click('dialog [data-action="confirm-bulk-delete"]');
  await waitCommit(page, n);
  check("deleting both is one commit", mock.log.length === n + 1 && !onBranch("content/pins/alpha.json") && !onBranch("content/pins/beta.json") && !!onBranch("content/pins/gamma.json"), mock.log.slice(n).map((c) => c.message).join(","));
  check("the rows are gone and the selection is empty", (await page.locator('#tab-pins .pn-item[data-pin="alpha"]').count()) === 0 && (await page.locator(".bulk-bar:not([hidden]) .bulk-count").textContent()) !== "2 selected");

  // Filtered-out ticks are counted.
  await tick(page, "gamma");
  await page.fill('#tab-pins input[type=search]', "delta");
  await page.waitForTimeout(200);
  check("pins hidden by the search are still counted, with a note", /1 selected · 1 hidden by filters/.test((await page.locator(".bulk-bar:not([hidden]) .bulk-count").textContent()) ?? ""), await page.locator(".bulk-bar:not([hidden]) .bulk-count").textContent());
  await page.fill('#tab-pins input[type=search]', "");

  await page.keyboard.press("Escape");
  check("Esc leaves selection mode", (await page.getAttribute('#tab-pins [data-action="select-pins"]', "aria-pressed")) === "false" && (await page.locator(".bulk-bar:not([hidden])").count()) === 0 && (await page.locator("#tab-pins input.bulk-box").count()) === 0);
  check("no errors in the admin page", owner.errors.length === 0, owner.errors.join(" | "));
  await owner.ctx.close();
} catch (e) {
  check("ran to the end", false, `threw: ${(e && e.message) || e}`.slice(0, 400));
}

await browser.close();
site.close();
await writeFile(path.join(OUT, "report.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed:\n${failed.map((f) => `  ${f.name} ${f.detail}`).join("\n")}` : ""}`);
process.exit(failed.length ? 1 : 0);
