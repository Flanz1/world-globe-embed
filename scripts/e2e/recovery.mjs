/**
 * Browser checks for crash recovery of unsaved work in the region editor, in headless Chromium.
 *
 *   npm run e2e:recovery
 *
 * Opens a region in the editor (mocked GitHub API), edits it and closes the page without saving (a
 * crash or closed tab), then opens it again: the editor offers the unsaved work back (Restore /
 * Discard). Also checks that saving or discarding on purpose leaves nothing to recover, that a draft
 * of a region that changed on GitHub since says so, and that a region never leaks into another's draft.
 *
 * Screenshots and report.json go to .e2e/recovery/. Exits non-zero if any check fails.
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

const OUT = path.resolve(".e2e/recovery");
const BRANCH = "test/recovery";
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
const mk = (id, b) => ({
  $schema: "../../schema/region.schema.json",
  type: "Feature",
  id,
  properties: { slot: SLOT.slug, map: MAP.id, color: "#00e5ff", fillOpacity: 0.25, label: true, partLabels: ["A"], partLocked: [false], updated: "2026-11-11T12:00:00Z" },
  geometry: { type: "MultiPolygon", coordinates: [[box(...b)]] },
});
const dir = await makeFixture({ quiet: true });
writeFileSync(path.join(dir, "content/regions/rec-a.json"), JSON.stringify(mk("rec-a", [100, -56, 115, -36]), null, 2) + "\n");
writeFileSync(path.join(dir, "content/regions/rec-b.json"), JSON.stringify(mk("rec-b", [121, -50, 127, -44]), null, 2) + "\n");
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
const A = "recovery";
const mock = new MockGitHub({ root: dir, branches: ["main", BRANCH] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await ctx.route("https://api.github.com/**", (r) => mock.handle(r));
await useAdminApi(ctx, mock, { branch: BRANCH });
let page;
const errors = [];
const dialogs = [];
/** A fresh tab on the admin page (the old one is closed without a word, like a crash or a closed tab: no beforeunload prompt). */
async function fresh() {
  if (page) await page.close({ runBeforeUnload: false });
  page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && !/^Failed to load resource/.test(m.text()) && errors.push(m.text()));
  page.on("dialog", (d) => (dialogs.push(d.message()), d.dismiss()));
  await page.goto(`${SITE}/admin/#regions`);
}
async function openRegion(id) {
  await fresh();
  await page.waitForSelector(`#regions .rcard[data-region="${id}"]`, { timeout: 15000 });
  await page.locator(`[data-region="${id}"] [data-action="edit"]`).click();
  await page.waitForSelector("dialog.editor[open]");
  await page.waitForTimeout(700);
}
const ed = {
  state: () => page.evaluate(() => document.querySelector("dialog.editor").wgeEditor.state()),
  setView: (cx, cy, k) => page.evaluate(([cx, cy, k]) => document.querySelector("dialog.editor").wgeEditor.setView(cx, cy, k), [cx, cy, k]),
  xy: (lon, lat) =>
    page.evaluate(([lon, lat]) => {
      const d = document.querySelector("dialog.editor");
      const r = d.querySelector("canvas.ed-canvas").getBoundingClientRect();
      const [x, y] = d.wgeEditor.toScreen(lon, lat);
      return [r.left + x, r.top + y];
    }, [lon, lat]),
  bar: () => page.locator("dialog.editor [data-draft=bar]"),
  barText: async () => (await page.locator("dialog.editor [data-draft=bar]").isVisible()) ? (await page.textContent("dialog.editor [data-draft=bar]")) ?? "" : null,
  msg: () => page.textContent("dialog.editor .ed-msg"),
};
/** Drags the first part (the one whose middle is at lon/lat) 2 degrees right, then waits for the local copy to be written. */
async function moveA() {
  await ed.setView(108, -46, 20);
  await page.waitForTimeout(200);
  const [x, y] = await ed.xy(107, -46);
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x + (40 * i) / 8, y);
  await page.mouse.up();
  await page.waitForTimeout(1600);
}
const lon0 = (s) => s.parts[0][0][0][0];
const BASE = 100;

await step(A, "a clean editor has nothing to recover", async () => {
  await openRegion("rec-a");
  check(A, "no restore bar when nothing was kept", (await ed.barText()) === null);
  check(A, "starts at the saved shape", lon0(await ed.state()) === BASE);
});

await step(A, "work is offered back after the tab is lost", async () => {
  await moveA();
  const moved = lon0(await ed.state());
  check(A, "the drag moved the part", moved === BASE + 2, String(moved));
  await openRegion("rec-a");
  const t = await ed.barText();
  check(A, "reopening shows a restore bar", t !== null && /Unsaved work/.test(t), String(t));
  check(A, "and not the 'changed on GitHub' warning", t !== null && !/changed on GitHub/.test(t), String(t));
  check(A, "the editor still shows the saved shape until you choose", lon0(await ed.state()) === BASE);
  await page.screenshot({ path: path.join(OUT, "editor-restore-bar.png") });
  await page.click("dialog.editor [data-draft=restore]");
  await page.waitForTimeout(200);
  check(A, "Restore brings the unsaved shape back", lon0(await ed.state()) === BASE + 2, String(lon0(await ed.state())));
  check(A, "the bar goes away", (await ed.barText()) === null);
  await page.click('dialog.editor [data-act="undo"]');
  check(A, "Undo goes back to the saved shape", lon0(await ed.state()) === BASE);
});

await step(A, "Discard throws the draft away", async () => {
  // Still the draft from the previous step? That one was restored, so it is kept: reopen and discard it.
  await openRegion("rec-a");
  check(A, "the restored (still unsaved) work is offered again", (await ed.barText()) !== null);
  await page.click("dialog.editor [data-draft=discard]");
  await page.waitForTimeout(300);
  check(A, "Discard keeps the saved shape and hides the bar", lon0(await ed.state()) === BASE && (await ed.barText()) === null);
  await openRegion("rec-a");
  check(A, "nothing is offered the next time", (await ed.barText()) === null);
});

await step(A, "drafts are per region", async () => {
  await openRegion("rec-a");
  await moveA();
  await openRegion("rec-b");
  check(A, "another region doesn't get region A's draft", (await ed.barText()) === null);
});

await step(A, "saving clears the draft", async () => {
  await openRegion("rec-a");
  await page.click("dialog.editor [data-draft=restore]");
  await page.waitForTimeout(200);
  check(A, "restored to save it", lon0(await ed.state()) === BASE + 2);
  const n0 = mock.log.length;
  await page.click("dialog.editor .ed-save");
  const t0 = Date.now();
  while (mock.log.length < n0 + 1 && Date.now() - t0 < 15000) await page.waitForTimeout(100);
  await page.waitForTimeout(800);
  check(A, "saved in one commit", mock.log.length === n0 + 1);
  await openRegion("rec-a");
  check(A, "after a save nothing is offered", (await ed.barText()) === null);
  check(A, "and the editor shows the saved shape", lon0(await ed.state()) === BASE + 2, String(lon0(await ed.state())));
});

await step(A, "closing on purpose clears the draft", async () => {
  await moveA();
  await page.click("dialog.editor .ed-close, dialog.editor button:has-text('Close')");
  await page.click('dialog.small-dlg[open] button:has-text("Discard changes")');
  await page.waitForTimeout(500);
  await openRegion("rec-a");
  check(A, "discarding at Close leaves nothing to recover", (await ed.barText()) === null);
});

await step(A, "a draft of a region that changed on GitHub says so", async () => {
  await moveA();
  const cur = JSON.parse(mock.read(BRANCH, "content/regions/rec-a.json"));
  cur.properties.description = "Edited by someone else";
  mock.externalWrite(BRANCH, "content/regions/rec-a.json", JSON.stringify(cur, null, 2) + "\n");
  await openRegion("rec-a");
  const t = await ed.barText();
  check(A, "the restore bar warns that GitHub's copy changed", t !== null && /changed on GitHub/.test(t), String(t));
  await page.screenshot({ path: path.join(OUT, "editor-restore-bar-changed.png") });
  await page.click("dialog.editor [data-draft=restore]");
  await page.waitForTimeout(200);
  check(A, "Restore still brings the draft back", lon0(await ed.state()) === BASE + 4, String(lon0(await ed.state())));
  await page.click('dialog.editor [data-act="undo"]');
  check(A, "and Undo shows GitHub's version", lon0(await ed.state()) === BASE + 2 && (await ed.state()).props.description === "Edited by someone else", String((await ed.state()).props?.description));
});

check(A, "no errors or dialogs in the admin page", errors.length === 0 && dialogs.length === 0, [...errors, ...dialogs].join(" | ") || "none");
await ctx.close();
await browser.close();
server.close();
await writeFile(path.join(OUT, "report.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed:\n${failed.map((f) => `  [${f.group}] ${f.name} ${f.detail}`).join("\n")}` : ""}`);
process.exit(failed.length ? 1 : 0);
