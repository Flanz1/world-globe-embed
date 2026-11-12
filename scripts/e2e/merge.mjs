/**
 * Browser checks for the editor's Combine and Extend tools, in headless Chromium.
 *
 *   npm run e2e:merge
 *
 * Builds the e2e fixture (scripts/e2e/fixture.mjs) plus a region with parts that overlap, nearly touch
 * (a small gap), stand apart, and a contested zone, then drives the editor against the mocked GitHub API:
 * - Combine (C) picks the selected part and the parts touching it, fills the gap, keeps colour, label
 *   and the zone; clicking parts adds or removes them; parts that are apart are refused; one undo step.
 * - Extend (E) adds a freehand or polygon shape to the selected part (a small gap is filled), refuses a
 *   shape that doesn't touch it, and takes the part the shape starts in when none is selected.
 * - Extending and combining across the antimeridian, saved as one commit with valid geometry.
 *
 * Screenshots and report.json go to .e2e/merge/. Exits non-zero if any check fails.
 */
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { SLOT, MAP, makeFixture } from "./fixture.mjs";
import { MockGitHub } from "./mock-github.mjs";
import { checkGeometry, pointInRing, polygonsOf } from "../../src/shared/geo.ts";

import { port } from "./ports.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const OUT = path.resolve(".e2e/merge");
const BRANCH = "test/merge";
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

/* ── Fixture: parts that overlap, nearly touch, stand apart, plus a contested zone ── */
const box = (w, s, e, n) => [[w, s], [e, s], [e, n], [w, n], [w, s]];
const M = {
  A: [100, -56, 112, -40], // part 1 "Breza", legend colour
  B: [112.3, -54, 122, -42], // part 2: 0.3° (6 px at the test zoom) east of A
  Z: [120, -50, 126, -44], // part 3: contested zone of part 2
  F: [140, -56, 150, -46], // part 4: far away
  O: [96, -48, 101, -38], // part 5: overlaps A
};
const dir = await makeFixture({ quiet: true });
writeFileSync(
  path.join(dir, "content/regions/merge-test.json"),
  JSON.stringify(
    {
      $schema: "../../schema/region.schema.json",
      type: "Feature",
      id: "merge-test",
      properties: {
        slot: SLOT.slug,
        map: MAP.id,
        color: "#00e5ff",
        fillOpacity: 0.3,
        label: true,
        legend: [{ label: "Crown land", color: "#28b463" }],
        partLegend: [0, -1, -1, -1, -1],
        partLabels: ["Breza", "", "", "Far", ""],
        partContested: [-1, -1, 1, -1, -1],
        updated: "2026-11-12T12:00:00Z",
      },
      geometry: { type: "MultiPolygon", coordinates: [[box(...M.A)], [box(...M.B)], [box(...M.Z)], [box(...M.F)], [box(...M.O)]] },
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
async function openRegion(id, cx, cy) {
  await page.goto(`${SITE}/admin/#regions`);
  await page.waitForTimeout(300);
  if (await page.isVisible("#token")) {
    await page.fill("#token", "ghp_e2etoken");
    await page.click('#signin-form button[type="submit"]');
  }
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
const inPart = (rings, pt) => !!rings && pointInRing(pt, rings[0]) && !rings.slice(1).some((h) => pointInRing(pt, h));
async function clickAt(lon, lat, opts) {
  const [x, y] = await ed.xy(lon, lat);
  await page.mouse.click(x, y, opts);
  await page.waitForTimeout(60);
}
const info = () => page.textContent("dialog.editor .ed-comb-info");

await step(E, "combine and extend", async () => {
  await openRegion("merge-test", 116, -48);
  // Zoomed out a little so every part fits on the canvas (the 0.3° gap is then about 4 px).
  await ed.setView(126, -50, 14);
  await page.waitForTimeout(150);
  let s = await ed.state();
  check(E, "opens with five parts and a contested zone", s.parts.length === 5 && JSON.stringify(s.contested) === "[-1,-1,1,-1,-1]", JSON.stringify(s.contested));

  // 0. Pick parts with Shift+click: Combine works off the picks, not the touching parts.
  const shiftClick = async (lon, lat) => {
    await page.keyboard.down("Shift");
    await clickAt(lon, lat);
    await page.keyboard.up("Shift");
  };
  await clickAt(97, -43); // part 5 (overlaps part 1)
  await shiftClick(104, -50); // part 1
  await shiftClick(116, -48); // part 2
  check(E, "Shift+click picks several parts and says so", /3 parts picked/.test(await ed.msg()), await ed.msg());
  await page.mouse.move(2, 2);
  await page.screenshot({ path: path.join(OUT, "editor-multi-pick.png") });
  await page.keyboard.press("c");
  await page.waitForSelector("dialog.editor .ed-combine:not([hidden])");
  let t = await info();
  check(E, "C combines the picks, in the order picked (part 5 keeps its place)", /^Parts 5, 1, 2 → one part \(part 5 keeps/.test(t), t);
  await page.keyboard.press("Escape");
  await clickAt(145, -50); // part 4, far from the rest
  await shiftClick(116, -48); // part 2
  await page.keyboard.press("c");
  await page.waitForSelector("dialog.editor .ed-combine:not([hidden])");
  t = await info();
  check(E, "the picked parts are used as they are: a far part isn't swapped for touching ones", /^Parts 4, 2: .*don't touch/.test(t), t);
  await page.keyboard.press("Escape");

  // 1. Select part 1, press C: it and the parts touching it (5 overlaps, 2 is 6 px away) are picked.
  await clickAt(104, -50);
  await page.keyboard.press("c");
  await page.waitForSelector("dialog.editor .ed-combine:not([hidden])");
  t = await info();
  check(E, "Combine picks the selected part and the parts touching it, not the far one or the zone", /^Parts 1, 2, 5 → one part/.test(t), t);
  await page.mouse.move(2, 2);
  await page.screenshot({ path: path.join(OUT, "editor-combine-preview.png") });

  // 2. Click the far part: refused as apart; click it again to drop it.
  await clickAt(145, -50);
  t = await info();
  check(E, "adding a part that doesn't touch says so and disables Combine", /don't touch/.test(t) && (await page.isDisabled('dialog.editor [data-act="combine-apply"]')), t);
  await clickAt(145, -50);
  // Clicking the contested zone (other kind) is refused.
  await clickAt(125, -47);
  t = await info();
  check(E, "the contested zone can't be mixed in", /^Parts 1, 2, 5 → one part/.test(t) && /same kind/.test(await ed.msg()), `${t} / ${await ed.msg()}`);

  // 3. Gap slider at 0: the 6 px gap is no longer bridged.
  await page.fill('dialog.editor input[name="combine-gap"]', "0");
  await page.dispatchEvent('dialog.editor input[name="combine-gap"]', "input");
  t = await info();
  check(E, "with the gap at 0 px the near part counts as apart", /don't touch/.test(t), t);
  await page.fill('dialog.editor input[name="combine-gap"]', "10");
  await page.dispatchEvent('dialog.editor input[name="combine-gap"]', "input");

  // 4. Enter combines: one part, gap filled, colour/label kept, the zone follows.
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  s = await ed.state();
  check(E, "Enter combines three parts into one", s.parts.length === 3, `${s.parts.length} parts; ${await ed.msg()}`);
  check(E, "the gap between them is filled", inPart(s.parts[0], [112.15, -48]) && !inPart(s.parts[0], [112.15, -55]), "");
  check(E, "the combined part keeps part 1's colour and label; the zone now extends it", JSON.stringify(s.styles) === "[0,-1,-1]" && JSON.stringify(s.labels) === '["Breza","","Far"]' && JSON.stringify(s.contested) === "[-1,0,-1]", JSON.stringify([s.styles, s.labels, s.contested]));
  check(E, "the panel closes and the result is selected", (await page.isHidden("dialog.editor .ed-combine")) && (await page.evaluate(() => document.querySelector("dialog.editor").wgeEditor.selectedPart())) === 0);
  await page.mouse.move(2, 2);
  await page.screenshot({ path: path.join(OUT, "editor-combined.png") });

  // 5. One undo step, then redo.
  await page.keyboard.press("Control+z");
  s = await ed.state();
  check(E, "one undo puts all five parts back", s.parts.length === 5 && JSON.stringify(s.contested) === "[-1,-1,1,-1,-1]", `${s.parts.length} parts ${JSON.stringify(s.contested)}`);
  await page.keyboard.press("Control+Shift+z");
  s = await ed.state();
  check(E, "redo combines again", s.parts.length === 3);

  // 6. Extend the far part (selected) with a freehand shape that starts inside it.
  await clickAt(145, -50);
  await page.keyboard.press("f");
  await page.keyboard.press("e");
  await stroke([[147, -52], [156, -52], [156, -40], [147, -44], [147, -52]]);
  s = await ed.state();
  check(E, "Extend (freehand) adds the shape to the selected part", s.parts.length === 3 && inPart(s.parts[2], [154, -42]) && inPart(s.parts[2], [142, -54]), `${s.parts.length} parts; ${await ed.msg()}`);
  check(E, "the extended part keeps its label", s.labels[2] === "Far", JSON.stringify(s.labels));
  await page.mouse.move(2, 2);
  await page.screenshot({ path: path.join(OUT, "editor-extended.png") });
  await page.keyboard.press("Control+z");
  s = await ed.state();
  check(E, "one undo takes the extension back", !inPart(s.parts[2], [154, -42]) && s.parts[2][0].length === 4);
  await page.keyboard.press("Control+Shift+z");

  // 7. A shape that doesn't touch the part is refused.
  await clickAt(145, -50);
  await page.keyboard.press("e");
  const before = JSON.stringify(await ed.state());
  await stroke([[140, -66], [146, -66], [146, -62], [140, -66]]);
  const m = await ed.msg();
  check(E, "a shape that doesn't touch the part is refused", JSON.stringify(await ed.state()) === before && /touch or overlap/.test(m), m);
  // Esc cancels Extend first (the part stays selected); a click on empty map clears that.
  await page.keyboard.press("v");
  check(E, "V leaves Extend with the part still selected", (await page.evaluate(() => document.querySelector("dialog.editor").wgeEditor.selectedPart())) === 2);
  await clickAt(132, -46);
  check(E, "a click on empty map clears the part selection", (await page.evaluate(() => document.querySelector("dialog.editor").wgeEditor.selectedPart())) === -1);

  // 8. Nothing selected: the polygon tool; the shape starts inside the combined part, so that one grows.
  await page.keyboard.press("p");
  await page.keyboard.press("e");
  await clicks([[104, -55], [104, -62], [110, -62], [110, -55]]);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(100);
  s = await ed.state();
  check(E, "Extend (polygon, nothing selected) grows the part the shape starts in", inPart(s.parts[0], [107, -60]), await ed.msg());

  // 9. A polygon shape 0.3° (4 px) away from the part: the gap is filled.
  await ed.setView(110, -50, 14);
  await page.waitForTimeout(100);
  await clickAt(104, -50);
  await page.keyboard.press("e");
  await clicks([[90, -50], [95.7, -50], [95.7, -44], [90, -44]]);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(100);
  s = await ed.state();
  check(E, "a shape a few pixels from the part is joined to it, gap filled", inPart(s.parts[0], [92, -47]) && inPart(s.parts[0], [95.85, -47]), await ed.msg());

  const f = await save("merge-test");
  check(E, "saved geometry is valid, one polygon per part", checkGeometry(f.geometry).length === 0 && polygonsOf(f.geometry).length === 3, checkGeometry(f.geometry).join("; "));
  check(E, "saved partLegend / partLabels / partContested match", JSON.stringify(f.properties.partLegend) === "[0,-1,-1]" && JSON.stringify(f.properties.partContested) === "[-1,0,-1]" && f.properties.partLabels[0] === "Breza", JSON.stringify(f.properties));
  await page.click("dialog.editor .pv-head button.ghost");
  await page.waitForSelector("dialog.editor", { state: "detached", timeout: 5000 }).catch(() => {});
});

await step(E, "across the antimeridian", async () => {
  await openRegion("dateline-box", 180, -20);
  // Extend the only part from inside it, eastwards past the map edge.
  await page.keyboard.press("f");
  await page.keyboard.press("e");
  await stroke([[186, -28], [196, -28], [196, -36], [186, -32], [186, -28]]);
  let s = await ed.state();
  check(E, "extending across the antimeridian keeps one part", s.parts.length === 1 && inPart(s.parts[0], [194, -32]), `${s.parts.length} parts; ${await ed.msg()}`);
  // A new part in the west copy (196.3 = -163.7), 0.3° from the part; then combine.
  await page.keyboard.press("p");
  await page.click('dialog.editor [data-act="add-part"]');
  await clicks([[196.3, -34], [202, -34], [202, -30], [196.3, -30]]);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(100);
  s = await ed.state();
  check(E, "the new part is added", s.parts.length === 2, await ed.msg());
  await clickAt(178, -20);
  await page.click('dialog.editor [data-act="combine"]');
  await page.waitForTimeout(100);
  const t = await info();
  check(E, "Combine across the antimeridian finds the near part", /^Parts 1, 2 → one part/.test(t), t);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  s = await ed.state();
  check(E, "combined across the antimeridian into one part", s.parts.length === 1 && inPart(s.parts[0], [196.15, -32]), `${s.parts.length} parts; ${await ed.msg()}`);
  await page.mouse.move(2, 2);
  await page.screenshot({ path: path.join(OUT, "editor-dateline.png") });
  const f = await save("dateline-box");
  const lons = polygonsOf(f.geometry).flatMap((poly) => poly[0].map((p) => p[0]));
  check(E, "saved valid, longitudes within ±180", checkGeometry(f.geometry).length === 0 && lons.every((x) => x >= -180 && x <= 180), JSON.stringify(f.geometry.coordinates).slice(0, 300));
});

check(E, "main untouched", mock.refs.get("main") === mainAtStart);
check(E, "no errors or dialogs in the admin page", errors.length === 0 && dialogs.length === 0, [...errors, ...dialogs].join(" | ") || "none");

await browser.close();
server.close();
await writeFile(path.join(OUT, "report.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed:\n${failed.map((f) => `  [${f.group}] ${f.name} ${f.detail}`).join("\n")}` : ""}`);
process.exit(failed.length ? 1 : 0);
