/**
 * Browser checks for locked parts in the region editor, in headless Chromium.
 *
 *   npm run e2e:locks
 *
 * Builds the e2e fixture (scripts/e2e/fixture.mjs) plus a two-part region whose first part is saved
 * locked, opens it in the editor against the mocked GitHub API and checks that a locked part can't be
 * dragged, nudged or moved with the whole region, while its vertices and midpoints still edit; that the
 * Lock button and the L key toggle it (every part starts locked; only an explicit false in the saved
 * partLocked opens unlocked); that deleting a part leaves the other parts' locks on the right
 * parts; and that saving writes partLocked in one commit.
 *
 * Screenshots and report.json go to .e2e/locks/. Exits non-zero if any check fails.
 */
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { SLOT, MAP, makeFixture } from "./fixture.mjs";
import { MockGitHub } from "./mock-github.mjs";
import { useAdminApi } from "./admin-api.mjs";

import { port } from "./ports.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const OUT = path.resolve(".e2e/locks");
const BRANCH = "test/locks";
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

const box = (w, s, e, n) => [[w, s], [e, s], [e, n], [w, n], [w, s]];
/** A (big, locked) and B (small, unlocked). */
const ED = { A: [100, -56, 115, -36], B: [121, -50, 127, -44] };
const region = {
  $schema: "../../schema/region.schema.json",
  type: "Feature",
  id: "lock-test",
  properties: { slot: SLOT.slug, map: MAP.id, color: "#00e5ff", fillOpacity: 0.25, label: true, partLabels: ["Keep", ""], partLocked: [true, false], updated: "2026-11-11T12:00:00Z" },
  geometry: { type: "MultiPolygon", coordinates: [[box(...ED.A)], [box(...ED.B)]] },
};

const dir = await makeFixture({ quiet: true });
writeFileSync(path.join(dir, "content/regions/lock-test.json"), JSON.stringify(region, null, 2) + "\n");
execFileSync("npm", ["run", "build"], { cwd: dir, env: { ...process.env, VITE_CONTENT_BRANCH: BRANCH }, stdio: "pipe" });
console.log(`Fixture: ${dir}`);

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".json": "application/json", ".txt": "text/plain" };
const DIST = path.join(dir, "dist");
const server = createServer(async (req, res) => {
  let p = path.join(DIST, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (existsSync(p) && statSync(p).isDirectory()) p = path.join(p, "index.html");
  if (!p.startsWith(DIST) || !existsSync(p)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] ?? "application/octet-stream", "Cache-Control": "no-store" });
  res.end(await readFile(p));
}).listen(port(4173), "localhost");

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const A = "locks";
const mock = new MockGitHub({ root: dir, branches: ["main", BRANCH] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await ctx.route("https://api.github.com/**", (r) => mock.handle(r));
await useAdminApi(ctx, mock, { branch: BRANCH });
const page = await ctx.newPage();
const errors = [];
const dialogs = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && !/^Failed to load resource/.test(m.text()) && errors.push(m.text()));
page.on("dialog", (d) => (dialogs.push(d.message()), d.dismiss()));

const ed = {
  state: () => page.evaluate(() => document.querySelector("dialog.editor").wgeEditor.state()),
  sel: () => page.evaluate(() => document.querySelector("dialog.editor").wgeEditor.selectedPart()),
  setView: (cx, cy, k) => page.evaluate(([cx, cy, k]) => document.querySelector("dialog.editor").wgeEditor.setView(cx, cy, k), [cx, cy, k]),
  xy: (lon, lat) =>
    page.evaluate(([lon, lat]) => {
      const d = document.querySelector("dialog.editor");
      const r = d.querySelector("canvas.ed-canvas").getBoundingClientRect();
      const [x, y] = d.wgeEditor.toScreen(lon, lat);
      return [r.left + x, r.top + y];
    }, [lon, lat]),
  msg: () => page.textContent("dialog.editor .ed-msg"),
  lockBtn: (p) => page.locator(`dialog.editor .ed-part-row[data-row="${p}"] button[data-act="part-lock"]`),
};
async function mdrag(x, y, dx, dy, mods = []) {
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x + (dx * i) / 8, y + (dy * i) / 8);
  await page.mouse.up();
  for (const m of mods) await page.keyboard.up(m);
  await page.waitForTimeout(100);
}
const K = 20;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let start = null;

await step(A, "open the editor", async () => {
  await page.goto(`${SITE}/admin/#regions`);
  await page.waitForSelector('#regions .rcard[data-region="lock-test"]', { timeout: 15000 });
  await page.locator('[data-region="lock-test"] [data-action="edit"]').click();
  await page.waitForSelector("dialog.editor[open]");
  await page.waitForTimeout(600);
  await ed.setView(113, -46, K);
  await page.waitForTimeout(200);
  start = await ed.state();
  check(A, "opens with part 1 locked from the saved partLocked", same(start.locked, [true, false]), JSON.stringify(start.locked));
  const t0 = (await ed.lockBtn(0).textContent()) ?? "";
  const t1 = (await ed.lockBtn(1).textContent()) ?? "";
  check(A, "Parts list shows the lock state", /Locked/.test(t0) && (await ed.lockBtn(0).getAttribute("aria-pressed")) === "true" && t1 === "Lock", `${t0} | ${t1}`);
  await page.mouse.move(2, 2);
  await page.screenshot({ path: path.join(OUT, "editor-locked.png") });
});

await step(A, "a locked part doesn't move", async () => {
  let [x, y] = await ed.xy(106, -50);
  await mdrag(x, y, 3 * K, 0);
  let s = await ed.state();
  check(A, "dragging inside a locked part leaves it where it is", same(s.parts, start.parts));
  check(A, "and says why", /locked/i.test((await ed.msg()) ?? ""), await ed.msg());
  await page.mouse.click(x, y);
  check(A, "a click still selects the locked part", (await ed.sel()) === 0, String(await ed.sel()));
  await page.keyboard.press("ArrowRight");
  s = await ed.state();
  check(A, "arrow keys don't nudge a locked part", same(s.parts, start.parts));
  // Ctrl+drag on the unlocked part: the whole region can't move while a part is locked.
  [x, y] = await ed.xy(124, -47);
  await mdrag(x, y, 2 * K, 0, ["Control"]);
  s = await ed.state();
  check(A, "Ctrl+drag can't move the whole region while a part is locked", same(s.parts, start.parts) && /whole region/.test((await ed.msg()) ?? ""), await ed.msg());
  // The unlocked part still moves on its own.
  await mdrag(x, y, 2 * K, 0);
  s = await ed.state();
  check(A, "the unlocked part still moves", same(s.parts[0], start.parts[0]) && s.parts[1][0][0][0] === start.parts[1][0][0][0] + 2, JSON.stringify(s.parts[1][0][0]));
});

await step(A, "vertices and midpoints of a locked part still edit", async () => {
  const before = await ed.state();
  let [x, y] = await ed.xy(115, -36);
  await mdrag(x, y, K, 0);
  let s = await ed.state();
  const moved = s.parts[0][0].some((q) => Math.abs(q[0] - 116) < 1e-3 && Math.abs(q[1] + 36) < 1e-3);
  check(A, "dragging a vertex of the locked part moves that vertex", moved && s.parts[0][0].length === before.parts[0][0].length, JSON.stringify(s.parts[0][0]));
  const n = s.parts[0][0].length;
  [x, y] = await ed.xy(107.5, -56);
  await mdrag(x, y, 0, 2 * K);
  s = await ed.state();
  check(A, "dragging a midpoint of the locked part inserts a vertex", s.parts[0][0].length === n + 1, `${n} → ${s.parts[0][0].length}`);
  check(A, "the part is still locked", s.locked[0] === true);
});

await step(A, "toggle the lock", async () => {
  await ed.lockBtn(1).click();
  let s = await ed.state();
  check(A, "the Lock button locks a part", same(s.locked, [true, true]) && /Locked/.test((await ed.lockBtn(1).textContent()) ?? ""), JSON.stringify(s.locked));
  const before = s.parts;
  let [x, y] = await ed.xy(126, -47);
  await mdrag(x, y, K, 0);
  s = await ed.state();
  check(A, "the newly locked part doesn't move", same(s.parts, before));
  // Select part 1 and press L to unlock it.
  [x, y] = await ed.xy(104, -40);
  await page.mouse.click(x, y);
  await page.keyboard.press("l");
  s = await ed.state();
  check(A, "L unlocks the selected part", same(s.locked, [false, true]), JSON.stringify(s.locked));
  await mdrag(x, y, K, 0);
  s = await ed.state();
  check(A, "an unlocked part moves again", s.parts[0][0].every((q, i) => q[0] === before[0][0][i][0] + 1), JSON.stringify(s.parts[0][0][0]));
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  s = await ed.state();
  check(A, "undo brings the lock back", same(s.locked, [true, true]) && same(s.parts, before), JSON.stringify(s.locked));
  await page.mouse.move(2, 2);
  await page.screenshot({ path: path.join(OUT, "editor-both-locked.png") });
});

await step(A, "deleting a part keeps the other parts' locks", async () => {
  await ed.lockBtn(0).click();
  let s = await ed.state();
  check(A, "unlock part 1 from its row", same(s.locked, [false, true]), JSON.stringify(s.locked));
  await page.click('dialog.editor .ed-part-row[data-row="0"] [data-act="part-delete"]');
  await page.click('dialog.small-dlg.danger[open] button:has-text("Delete part")');
  await page.waitForTimeout(150);
  s = await ed.state();
  check(A, "after deleting part 1, the remaining part is still locked", s.parts.length === 1 && same(s.locked, [true]), JSON.stringify(s.locked));
  await page.click('dialog.editor [data-act="undo"]');
  await page.click('dialog.editor [data-act="undo"]');
  s = await ed.state();
  check(A, "undo brings the part and both locks back", s.parts.length === 2 && same(s.locked, [true, true]), JSON.stringify(s.locked));
});

await step(A, "save", async () => {
  // Both parts are locked now; unlock part 2 so the saved file has something to say.
  await ed.lockBtn(1).click();
  check(A, "unlocking part 2 from its row", same((await ed.state()).locked, [true, false]), JSON.stringify((await ed.state()).locked));
  const n0 = mock.log.length;
  await page.click("dialog.editor .ed-save");
  const t0 = Date.now();
  while (mock.log.length < n0 + 1 && Date.now() - t0 < 15000) await page.waitForTimeout(100);
  await page.waitForTimeout(400);
  const c = mock.log.slice(n0);
  check(A, "save is one commit to content/regions/lock-test.json", c.length === 1 && c[0].branch === BRANCH, JSON.stringify(c));
  const f = JSON.parse(mock.read(BRANCH, "content/regions/lock-test.json"));
  check(A, "saved with partLocked (true = locked, false = left unlocked)", same(f.properties.partLocked, [true, false]), JSON.stringify(f.properties.partLocked));
});

check(A, "no errors or dialogs in the admin page", errors.length === 0 && dialogs.length === 0, [...errors, ...dialogs].join(" | ") || "none");
await ctx.close();
await browser.close();
server.close();
await writeFile(path.join(OUT, "report.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed:\n${failed.map((f) => `  [${f.group}] ${f.name} ${f.detail}`).join("\n")}` : ""}`);
process.exit(failed.length ? 1 : 0);
