/**
 * Browser checks for "Edit together": several regions open in one editor and saving writes each
 * changed one back, in headless Chromium.
 *
 *   npm run e2e:live
 *
 * Three regions on the test slot (live-a with two parts and a legend colour, live-b, live-c) and
 * drives the admin page against the mocked GitHub API:
 * - Combine regions → Edit together opens live-a and live-b together, parts tagged with their region.
 * - A part moved to the other region, a new part, a label edit: one commit changing just those two
 *   files; the region not in the view and nothing else changes; no combined region is created.
 * - Regions…: take live-a out and add live-c; unsaved changes of the region that stays are kept.
 * - A file changed on GitHub meanwhile: the save is refused and offers a reload.
 *
 * Screenshots and report.json go to .e2e/live/. Exits non-zero if any check fails.
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
import { checkGeometry, polygonsOf } from "../../src/shared/geo.ts";

import { port } from "./ports.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const OUT = path.resolve(".e2e/live");
const BRANCH = "test/live";
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

/* ── Fixture: three regions on one slot ── */
const box = (w, s, e, n) => [[w, s], [e, s], [e, n], [w, n], [w, s]];
const dir = await makeFixture({ quiet: true });
const put = (id, props, polys) =>
  writeFileSync(
    path.join(dir, `content/regions/${id}.json`),
    JSON.stringify(
      {
        $schema: "../../schema/region.schema.json",
        type: "Feature",
        id,
        properties: { slot: SLOT.slug, map: MAP.id, fillOpacity: 0.3, label: true, updated: "2026-11-12T12:00:00Z", ...props },
        geometry: polys.length === 1 ? { type: "Polygon", coordinates: [polys[0]] } : { type: "MultiPolygon", coordinates: polys.map((r) => [r]) },
      },
      null,
      2,
    ) + "\n",
  );
put("live-a", { color: "#c0392b", description: "Alpha", legend: [{ label: "Hills", color: "#28b463" }], partLegend: [-1, 0], partLabels: ["A one", "A two"] }, [box(100, -56, 110, -46), box(112, -56, 120, -46)]);
put("live-b", { color: "#2e86c1", colorLabel: "Beta", fillOpacity: 0.6, partLabels: ["B one"] }, [box(124, -56, 132, -46)]);
put("live-c", { color: "#8e44ad", partLabels: ["C one"] }, [box(136, -56, 144, -46)]);
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
const mock = new MockGitHub({ root: dir, branches: ["main", BRANCH] });
const mainAtStart = mock.refs.get("main");
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
  setView: (cx, cy, k) => page.evaluate(([cx, cy, k]) => document.querySelector("dialog.editor").wgeEditor.setView(cx, cy, k), [cx, cy, k]),
  xy: (lon, lat) =>
    page.evaluate(([lon, lat]) => {
      const d = document.querySelector("dialog.editor");
      const r = d.querySelector("canvas.ed-canvas").getBoundingClientRect();
      const [x, y] = d.wgeEditor.toScreen(lon, lat);
      return [r.left + x, r.top + y];
    }, [lon, lat]),
  msg: () => page.textContent("dialog.editor .ed-msg"),
};
const K = 20;
const E = "live";
const read = (id) => JSON.parse(mock.read(BRANCH, `content/regions/${id}.json`) ?? "null");
const parts = (g) => polygonsOf(g).length;
async function clicks(pts) {
  for (const [lon, lat] of pts) {
    const [x, y] = await ed.xy(lon, lat);
    await page.mouse.click(x, y);
    await page.waitForTimeout(30);
  }
}
async function saveAndWait() {
  const n0 = mock.log.length;
  await page.click("dialog.editor .ed-save");
  const t0 = Date.now();
  while (mock.log.length < n0 + 1 && Date.now() - t0 < 15000) await page.waitForTimeout(100);
  await page.waitForTimeout(400);
  return mock.log.slice(n0);
}
const changedPaths = (c) => c.flatMap((x) => x.changes.map((ch) => ch.path)).sort();

const before = Object.fromEntries(["live-a", "live-b", "live-c"].map((id) => [id, mock.read(BRANCH, `content/regions/${id}.json`)]));

await step(E, "open together", async () => {
  await page.goto(`${SITE}/admin/#regions`);
  await page.waitForSelector('#regions .rcard[data-region="live-a"]', { timeout: 15000 });
  await page.click("#r-combine");
  await page.waitForSelector("dialog.combine-dlg[open]");
  const go = page.locator('dialog.combine-dlg [data-action="edit-together"]');
  check(E, "Edit together is disabled until two regions are ticked", await go.isDisabled());
  await page.check('dialog.combine-dlg input[value="live-a"]');
  await page.check('dialog.combine-dlg input[value="live-b"]');
  check(E, "Edit together is enabled for two editable regions on one slot", !(await go.isDisabled()), await go.getAttribute("title"));
  await page.screenshot({ path: path.join(OUT, "combine-dialog.png") });
  await go.click();
  await page.waitForSelector("dialog.editor[open]");
  await page.waitForTimeout(800);
  await ed.setView(122, -51, K * 0.7);
  await page.waitForTimeout(200);
  const s = await ed.state();
  check(E, "opens every part of both regions, tagged with its region", s.parts.length === 3 && JSON.stringify(s.owners) === JSON.stringify(["live-a", "live-a", "live-b"]), JSON.stringify(s.owners));
  check(E, "the title names both regions", /Edit together: live-a, live-b/.test(await page.textContent("dialog.editor h2")));
  check(E, "region-wide settings are hidden", await page.locator('dialog.editor input[name="id"]').isHidden());
  check(E, "nothing to save before an edit", (await saveAndWait()).length === 0 && /Nothing to save/.test(await ed.msg()), await ed.msg());
});

await step(E, "edit and save", async () => {
  // Part 2 (live-a's Hills part) moves to live-b; live-b's label changes; a new part goes to live-a.
  await page.selectOption('dialog.editor select[data-part-owner="1"]', "live-b");
  await page.fill('dialog.editor input[data-part-label="2"]', "B renamed");
  await page.selectOption('dialog.editor select[name="new-owner"]', "live-a");
  await page.click('dialog.editor [data-act="add-part"]');
  await page.keyboard.press("p");
  await clicks([[100, -44], [108, -44], [108, -38], [100, -38]]);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  const s = await ed.state();
  check(E, "the new part belongs to the picked region", s.parts.length === 4 && s.owners[3] === "live-a", JSON.stringify(s.owners));
  await page.mouse.move(2, 2);
  await page.screenshot({ path: path.join(OUT, "editor-together.png") });
  const c = await saveAndWait();
  check(E, "save is one commit changing just the two regions", c.length === 1 && c[0].branch === BRANCH && JSON.stringify(changedPaths(c)) === JSON.stringify(["content/regions/live-a.json", "content/regions/live-b.json"]), JSON.stringify(c) + " " + (await ed.msg()));
  const a = read("live-a");
  const b = read("live-b");
  check(E, "live-a: its first part plus the new one, its settings kept", parts(a.geometry) === 2 && a.properties.description === "Alpha" && a.properties.color === "#c0392b" && JSON.stringify(a.properties.legend) === JSON.stringify([{ label: "Hills", color: "#28b463" }]), JSON.stringify(a.properties));
  check(
    E,
    "live-b: the moved part keeps its colour (borrowed into its legend) and label; the edited label saved",
    parts(b.geometry) === 2 && JSON.stringify(b.properties.partLabels) === JSON.stringify(["A two", "B renamed"]) && b.properties.legend?.[0]?.color === "#28b463" && b.properties.partLegend?.[0] === 0 && b.properties.fillOpacity === 0.6 && b.properties.colorLabel === "Beta",
    JSON.stringify(b.properties),
  );
  check(E, "both saved valid", checkGeometry(a.geometry).length === 0 && checkGeometry(b.geometry).length === 0);
  check(E, "live-c and every other file untouched", mock.read(BRANCH, "content/regions/live-c.json") === before["live-c"]);
});

await step(E, "add and remove regions", async () => {
  await page.fill('dialog.editor input[data-part-label="0"]', "A edited");
  await page.click('dialog.editor [data-act="live-regions"]');
  await page.waitForSelector("dialog.combine-dlg[open]");
  check(E, "the list marks the region with unsaved changes", (await page.locator('dialog.combine-dlg label:has(input[value="live-a"]) .badge').count()) === 1);
  await page.uncheck('dialog.combine-dlg input[value="live-a"]');
  check(E, "taking out a region with unsaved changes warns", /discards/.test(await page.textContent("dialog.combine-dlg [role=status]")));
  await page.check('dialog.combine-dlg input[value="live-a"]');
  await page.check('dialog.combine-dlg input[value="live-c"]');
  await page.click('dialog.combine-dlg [data-action="live-apply"]');
  await page.waitForSelector("dialog.editor[open]");
  await page.waitForTimeout(600);
  let s = await ed.state();
  check(E, "live-c added; live-a's unsaved label kept", JSON.stringify(s.owners) === JSON.stringify(["live-a", "live-a", "live-b", "live-b", "live-c"]) && s.labels[0] === "A edited", JSON.stringify([s.owners, s.labels]));
  // Now take live-a out (discarding its edit) and save live-c's label.
  await page.click('dialog.editor [data-act="live-regions"]');
  await page.waitForSelector("dialog.combine-dlg[open]");
  await page.uncheck('dialog.combine-dlg input[value="live-a"]');
  await page.click('dialog.combine-dlg [data-action="live-apply"]');
  await page.waitForSelector("dialog.editor[open]");
  await page.waitForTimeout(600);
  s = await ed.state();
  check(E, "live-a taken out of the view", JSON.stringify(s.owners) === JSON.stringify(["live-b", "live-b", "live-c"]), JSON.stringify(s.owners));
  await page.fill('dialog.editor input[data-part-label="2"]', "C renamed");
  const c = await saveAndWait();
  check(E, "save writes just live-c", c.length === 1 && JSON.stringify(changedPaths(c)) === JSON.stringify(["content/regions/live-c.json"]) && read("live-c").properties.partLabels[0] === "C renamed" && read("live-a").properties.partLabels[0] === "A one", JSON.stringify(c));
});

await step(E, "conflict", async () => {
  const p = "content/regions/live-b.json";
  const f = read("live-b");
  f.properties.description = "Changed elsewhere";
  mock.externalWrite(BRANCH, p, JSON.stringify(f, null, 2) + "\n");
  await page.fill('dialog.editor input[data-part-label="1"]', "B again");
  const n = mock.log.length;
  await page.click("dialog.editor .ed-save");
  const title = await page.locator("dialog.small-dlg h2").textContent({ timeout: 5000 });
  check(E, "save refuses to overwrite a region changed on GitHub", title === "Changed on GitHub" && mock.log.length === n && /live-b/.test(await page.textContent("dialog.small-dlg")));
  await page.click('dialog.small-dlg button:has-text("Reload from GitHub")');
  await page.waitForSelector("dialog.editor[open]");
  await page.waitForTimeout(600);
  const s = await ed.state();
  check(E, "reload brings the latest version and drops the unsaved edit", s.labels[1] === "B renamed" && s.owners.length === 3, JSON.stringify(s.labels));
});

check(E, "no region file was created or deleted", mock.log.every((c) => c.changes.every((ch) => ["content/regions/live-a.json", "content/regions/live-b.json", "content/regions/live-c.json"].includes(ch.path) && !ch.deleted)), JSON.stringify(mock.log.map((c) => c.changes)));
check(E, "main untouched", mock.refs.get("main") === mainAtStart);
check(E, "no errors or dialogs in the admin page", errors.length === 0 && dialogs.length === 0, [...errors, ...dialogs].join(" | ") || "none");

await browser.close();
server.close();
await writeFile(path.join(OUT, "report.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed:\n${failed.map((f) => `  [${f.group}] ${f.name} ${f.detail}`).join("\n")}` : ""}`);
process.exit(failed.length ? 1 : 0);
