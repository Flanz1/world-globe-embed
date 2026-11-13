/**
 * Browser checks for the editor's Cut and Split tools, in headless Chromium.
 *
 *   npm run e2e:cut
 *
 * Builds the e2e fixture (scripts/e2e/fixture.mjs) plus a region with a coloured, labelled part and a
 * contested zone, then drives the editor against the mocked GitHub API:
 * - Cut inside a part still makes a hole; Cut right across a part splits it into separate parts.
 * - Split draws a line (freehand or polygon) across a part; a line that only goes partway in is refused.
 * - The pieces keep the part's colour; the zone stays with the largest piece; one undo step each.
 * - Splitting the dateline-box region along the antimeridian, saved as one commit with valid geometry.
 *
 * Screenshots and report.json go to .e2e/cut/. Exits non-zero if any check fails.
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

const OUT = path.resolve(".e2e/cut");
const BRANCH = "test/cut";
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

/* ── Fixture: one extra region with a coloured part, a label and a contested zone ── */
const box = (w, s, e, n) => [[w, s], [e, s], [e, n], [w, n], [w, s]];
const CUT = { A: [100, -56, 120, -36], Z: [116, -50, 126, -42] };
const dir = await makeFixture({ quiet: true });
writeFileSync(
  path.join(dir, "content/regions/cut-test.json"),
  JSON.stringify(
    {
      $schema: "../../schema/region.schema.json",
      type: "Feature",
      id: "cut-test",
      properties: {
        slot: SLOT.slug,
        map: MAP.id,
        color: "#00e5ff",
        fillOpacity: 0.3,
        label: true,
        legend: [{ label: "Crown land", color: "#28b463" }],
        partLegend: [0, -1],
        partLabels: ["Vael", ""],
        partContested: [-1, 0],
        updated: "2026-11-09T12:00:00Z",
      },
      geometry: { type: "MultiPolygon", coordinates: [[box(...CUT.A)], [box(...CUT.Z)]] },
    },
    null,
    2,
  ) + "\n",
);
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
// Software GL on a small CI runner can take over a minute for one screenshot (a frame of the big map);
// the default 30 s then fails a suite that is only slow, so give every action room.
page.setDefaultTimeout(120000);
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
/** Freehand drag through map points. */
async function stroke(pts) {
  const xy = [];
  for (const [lon, lat] of pts) xy.push(await ed.xy(lon, lat));
  await page.mouse.move(...xy[0]);
  await page.mouse.down();
  for (let i = 1; i < xy.length; i++) {
    const [a, b] = [xy[i - 1], xy[i]];
    for (let t = 1; t <= 6; t++) await page.mouse.move(a[0] + ((b[0] - a[0]) * t) / 6, a[1] + ((b[1] - a[1]) * t) / 6);
  }
  await page.mouse.up();
  await page.waitForTimeout(100);
}
async function clicks(pts) {
  for (const [lon, lat] of pts) {
    const [x, y] = await ed.xy(lon, lat);
    await page.mouse.click(x, y);
    await page.waitForTimeout(30);
  }
}
const circle = (cx, cy, r, n = 24) => Array.from({ length: n + 1 }, (_, i) => [cx + Math.cos((i / n) * 2 * Math.PI) * r, cy + Math.sin((i / n) * 2 * Math.PI) * r]);
async function openRegion(id, cx, cy) {
  await page.goto(`${SITE}/admin/#regions`);
  await page.waitForTimeout(300);
  await page.waitForSelector(`#regions .rcard[data-region="${id}"]`, { timeout: 15000 });
  await page.locator(`[data-region="${id}"] [data-action="edit"]`).click();
  await page.waitForSelector("dialog.editor[open]");
  await page.waitForTimeout(600);
  await ed.setView(cx, cy, K);
  await page.waitForTimeout(200);
}
async function save(id) {
  const n0 = mock.log.length;
  await page.click("dialog.editor .ed-save");
  const t0 = Date.now();
  while (mock.log.length < n0 + 1 && Date.now() - t0 < 15000) await page.waitForTimeout(100);
  await page.waitForTimeout(400);
  const c = mock.log.slice(n0);
  if (!c.length) console.log("save message:", await ed.msg());
  check(E, `save is one commit of content/regions/${id}.json on the branch`, c.length === 1 && c[0].branch === BRANCH && JSON.stringify(c[0].changes) === JSON.stringify([{ path: `content/regions/${id}.json`, deleted: false }]), JSON.stringify(c));
  return JSON.parse(mock.read(BRANCH, `content/regions/${id}.json`));
}

const E = "editor";
await step(E, "cut and split", async () => {
  await openRegion("cut-test", 112, -46);
  const start = await ed.state();
  check(E, "opens with a coloured part and its contested zone", start.parts.length === 2 && JSON.stringify(start.contested) === "[-1,0]" && JSON.stringify(start.styles) === "[0,-1]", JSON.stringify(start));

  // 1. Cut (freehand) wholly inside part 1: a hole, as before.
  await page.click('dialog.editor [data-act="cut-hole"]');
  await stroke(circle(105, -40, 2));
  let s = await ed.state();
  check(E, "Cut inside a part makes a hole", s.parts.length === 2 && s.parts[0].length === 2, `${s.parts.length} parts, part 1 has ${s.parts[0].length} rings`);

  // 2. Cut (polygon) right across part 1, top to bottom: split into two parts.
  await page.keyboard.press("p");
  await page.click('dialog.editor [data-act="cut-hole"]');
  await clicks([[108, -60], [109, -60], [109, -32], [108, -32], [108, -60]]);
  s = await ed.state();
  check(E, "Cut right across a part splits it into separate parts", s.parts.length === 3, `${s.parts.length} parts`);
  check(E, "the new part keeps the colour, the zone stays with the larger piece", JSON.stringify(s.styles) === "[0,-1,0]" && JSON.stringify(s.contested) === "[-1,0,-1]" && JSON.stringify(s.labels) === '["Vael","",""]', JSON.stringify([s.styles, s.contested, s.labels]));
  check(E, "the hole stays with its piece", s.parts.some((rings) => rings.length === 2), s.parts.map((r) => r.length).join(","));
  await page.screenshot({ path: path.join(OUT, "editor-cut-across.png") });

  // 3. Undo is one step.
  await page.keyboard.press("Control+z");
  s = await ed.state();
  check(E, "one undo puts the part back together", s.parts.length === 2 && s.parts[0].length === 2);
  await page.keyboard.press("Control+Shift+z");

  // 4. Split with the polygon tool (Enter finishes the line), across both pieces and the zone.
  await page.click('dialog.editor [data-act="split"]');
  await clicks([[96, -46], [130, -46]]);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(100);
  s = await ed.state();
  check(E, "Split (polygon line, Enter) splits every part it crosses", s.parts.length === 6, `${s.parts.length} parts; ${await ed.msg()}`);
  check(E, "both pieces of the contested zone still extend part 1", s.contested.filter((k) => k === 0).length === 2 && s.contested[0] === -1, JSON.stringify(s.contested));

  // 5. Split (freehand) that only goes partway in: refused, nothing changes.
  await page.keyboard.press("f");
  await page.click('dialog.editor [data-act="split"]');
  const before = JSON.stringify(await ed.state());
  await stroke([[101.5, -60], [101.5, -50]]);
  const after = JSON.stringify(await ed.state());
  const m = await ed.msg();
  check(E, "a split line that doesn't go right across is refused", before === after && /right across/.test(m), m);

  // 6. Freehand split across the left piece's two halves.
  await page.click('dialog.editor [data-act="split"]');
  await stroke([[101.5, -60], [102, -45], [101.5, -30]]);
  s = await ed.state();
  check(E, "Split (freehand line) splits the parts it crosses", s.parts.length === 8, `${s.parts.length} parts`);
  await page.mouse.move(2, 2);
  await page.screenshot({ path: path.join(OUT, "editor-split.png") });

  const f = await save("cut-test");
  check(E, "saved geometry is valid, one polygon per part", checkGeometry(f.geometry).length === 0 && polygonsOf(f.geometry).length === 8, checkGeometry(f.geometry).join("; "));
  check(E, "saved partLegend / partContested match", f.properties.partLegend.length === 8 && f.properties.partContested.length === 8 && f.properties.partLabels[0] === "Vael", JSON.stringify([f.properties.partLegend, f.properties.partContested]));
  await page.keyboard.press("Escape");
});

await step(E, "split across the antimeridian", async () => {
  await openRegion("dateline-box", 180, -20);
  // Drawn in the copy west of the map edge too: lon -180 is the same line as 180.
  await page.keyboard.press("p");
  await page.click('dialog.editor [data-act="split"]');
  await clicks([[180, -34], [180, -6]]);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(100);
  const s = await ed.state();
  check(E, "split along the antimeridian gives two parts", s.parts.length === 2, `${s.parts.length} parts; ${await ed.msg()}`);
  await page.mouse.move(2, 2);
  await page.screenshot({ path: path.join(OUT, "editor-dateline.png") });
  const f = await save("dateline-box");
  const lons = polygonsOf(f.geometry).flatMap((poly) => poly[0].map((p) => p[0]));
  check(E, "saved as two valid parts, longitudes within ±180", checkGeometry(f.geometry).length === 0 && polygonsOf(f.geometry).length === 2 && lons.every((x) => x >= -180 && x <= 180), JSON.stringify(f.geometry.coordinates).slice(0, 300));
});

check(E, "main untouched", mock.refs.get("main") === mainAtStart);
check(E, "no errors or dialogs in the admin page", errors.length === 0 && dialogs.length === 0, [...errors, ...dialogs].join(" | ") || "none");

await browser.close();
server.close();
await writeFile(path.join(OUT, "report.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed:\n${failed.map((f) => `  [${f.group}] ${f.name} ${f.detail}`).join("\n")}` : ""}`);
process.exit(failed.length ? 1 : 0);
