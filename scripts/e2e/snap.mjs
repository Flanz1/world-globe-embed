/**
 * Browser checks for snapping, border tracing, attached vertices and shared-border drawing, in
 * headless Chromium.
 *
 *   npm run e2e:snap
 *
 * Province border tool: draws a line inside the region without changing the parts; click selects, Delete removes.
 * Editor: snapping is on by default (S toggles it); the polygon tool traces along a border between
 * two clicks on it (Tab: the other way round); freehand along a border follows it; vertices on the
 * same spot move, get inserted and get deleted together, and Ctrl+drag pulls one free; a dragged
 * vertex snaps to another region's vertex. Embed: a national border (between parts of different
 * legend colours) is a solid dark line, a provincial one (same colour) dotted.
 *
 * Exits non-zero if any check fails. Screenshots go to .e2e/snap/.
 */
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { SLOT, MAP, makeFixture } from "./fixture.mjs";
import { MockGitHub } from "./mock-github.mjs";
import { geometryBounds } from "../../src/shared/geo.ts";
import { flatFit } from "../../src/shared/region.ts";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const sharp = require("sharp");

const OUT = path.resolve(".e2e/snap");
const BRANCH = "test/snap";
const SITE = "http://localhost:4173";
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
const feature = (id, geometry, props) => ({
  $schema: "../../schema/region.schema.json",
  type: "Feature",
  id,
  properties: { slot: SLOT.slug, map: MAP.id, color: "#00e5ff", fillOpacity: 0.25, label: true, updated: "2026-11-12T12:00:00Z", ...props },
  geometry,
});
// The region edited: one part whose west side (lon 100) has two extra vertices to trace along.
const WEST = [[100, -56], [110, -56], [110, -46], [100, -46], [100, -49], [100, -53], [100, -56]];
// Three provinces in a row for the embed: A and B one colour (provincial border at lon 20), C another (national at 30).
const BORDERS = [box(10, -20, 20, -10), box(20, -20, 30, -10), box(30, -20, 40, -10)];
const regions = [
  feature("snap-test", { type: "Polygon", coordinates: [WEST] }, {}),
  feature("snap-neighbour", { type: "Polygon", coordinates: [box(111, -56, 121, -46)] }, { color: "#ffffff", name: "Neighbour" }),
  feature(
    "borders-test",
    { type: "MultiPolygon", coordinates: BORDERS.map((r) => [r]) },
    { color: "#c0392b", fillOpacity: 0.35, legend: [{ label: "Breza", color: "#c0392b" }, { label: "Selbia", color: "#2e86c1" }], partLegend: [0, 0, 1], provinceBorders: [[[15, -20], [15, -10]]] },
  ),
];

const dir = await makeFixture({ quiet: true });
for (const r of regions) writeFileSync(path.join(dir, "content/regions", `${r.id}.json`), JSON.stringify(r, null, 2) + "\n");
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
}).listen(4173, "localhost");

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });

/* ═════════════ Editor ═════════════ */
const A = "editor";
const mock = new MockGitHub({ root: dir, branches: ["main", BRANCH] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await ctx.route("https://api.github.com/**", (r) => mock.handle(r));
const page = await ctx.newPage();
const errors = [];
const dialogs = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && !/^Failed to load resource/.test(m.text()) && errors.push(m.text()));
page.on("dialog", (d) => (dialogs.push(d.message()), d.dismiss()));

const call = (fn, ...args) => page.evaluate(([fn, args]) => document.querySelector("dialog.editor").wgeEditor[fn](...args), [fn, args]);
const ed = {
  state: () => call("state"),
  xy: (lon, lat) =>
    page.evaluate(([lon, lat]) => {
      const d = document.querySelector("dialog.editor");
      const r = d.querySelector("canvas.ed-canvas").getBoundingClientRect();
      const [x, y] = d.wgeEditor.toScreen(lon, lat);
      return [r.left + x, r.top + y];
    }, [lon, lat]),
};
const K = 20;
async function click(lon, lat, mods = []) {
  const [x, y] = await ed.xy(lon, lat);
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
  for (const m of mods) await page.keyboard.up(m);
  await page.waitForTimeout(60);
}
/** Drags from a map position along a list of map positions. */
async function clicks(pts) {
  for (const [lon, lat] of pts) await click(lon, lat);
}
async function dragPath(pts, mods = []) {
  const [x0, y0] = await ed.xy(...pts[0]);
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (const p of pts.slice(1)) {
    const [x, y] = await ed.xy(...p);
    await page.mouse.move(x, y, { steps: 3 });
  }
  await page.mouse.up();
  for (const m of mods) await page.keyboard.up(m);
  await page.waitForTimeout(120);
}
const has = (ring, [x, y]) => ring.some((p) => p[0] === x && p[1] === y);
const near = (p, [x, y], tol = 0.06) => Math.abs(p[0] - x) < tol && Math.abs(p[1] - y) < tol;
const undo = async () => (await page.keyboard.press("Control+z"), await page.waitForTimeout(80));

await step(A, "open the editor", async () => {
  await page.goto(`${SITE}/admin/#regions`);
  await page.fill("#token", "ghp_e2etoken");
  await page.click('#signin-form button[type="submit"]');
  await page.waitForSelector('#regions .rcard[data-region="snap-test"]', { timeout: 15000 });
  await page.locator('[data-region="snap-test"] [data-action="edit"]').click();
  await page.waitForSelector("dialog.editor[open]");
  await page.waitForTimeout(600);
  await call("setView", 108, -51, K);
  await page.waitForTimeout(200);
  check(A, "snapping is on by default", (await call("snapOn")) === true && (await page.getAttribute('dialog.editor button[data-act="snap"]', "aria-pressed")) === "true");
});

await step(A, "polygon tool traces along a border", async () => {
  await page.keyboard.press("p");
  await click(95, -46);
  await click(100.2, -45.85); // snaps to the corner (100, -46)
  await click(100.2, -55.85); // snaps to (100, -56): the vertices between are traced in
  const d = await call("drawing");
  check(A, "a click near a vertex lands on it exactly", d && has(d, [100, -46]) && has(d, [100, -56]), JSON.stringify(d));
  check(A, "the border's vertices between the two clicks are filled in", d && d.length === 5 && has(d, [100, -49]) && has(d, [100, -53]), JSON.stringify(d));
  await click(95, -56);
  await click(95, -46); // close on the first point
  const s = await ed.state();
  const ring = s.parts[1]?.[0] ?? [];
  check(A, "the new part shares the whole west border exactly", s.parts.length === 2 && ring.length === 6 && [[100, -46], [100, -49], [100, -53], [100, -56]].every((p) => has(ring, p)), JSON.stringify(ring));
  const b = await call("borders");
  check(A, "a line shared by two same-colour parts isn't a national border", b === null || b.national.length === 0, JSON.stringify(b));
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(OUT, "editor-traced.png") });
});

await step(A, "attached vertices", async () => {
  const s0 = await ed.state();
  await dragPath([[100, -49], [100.5, -49], [101, -49]]);
  let s = await ed.state();
  const a = s.parts[0][0].find((p) => near(p, [101, -49]));
  const b = s.parts[1][0].find((p) => near(p, [101, -49]));
  check(A, "dragging a shared vertex moves both parts' vertices, to the same spot", a && b && a[0] === b[0] && a[1] === b[1], JSON.stringify([a, b]));
  await undo();
  await dragPath([[100, -49], [100.5, -49], [101, -49]], ["Control"]);
  s = await ed.state();
  const moved = [s.parts[0][0], s.parts[1][0]].filter((r) => r.some((p) => near(p, [101, -49]))).length;
  check(A, "Ctrl+drag pulls just one free", moved === 1, `${moved} moved`);
  await undo();
  // The shared line's midpoint (100, -51): a vertex goes into both sides.
  await dragPath([[100, -51], [99.5, -51], [99, -51]]);
  s = await ed.state();
  const m0 = s.parts[0][0].filter((p) => near(p, [99, -51]));
  const m1 = s.parts[1][0].filter((p) => near(p, [99, -51]));
  check(
    A,
    "dragging a shared line's midpoint inserts an attached vertex on both sides",
    s.parts[0][0].length === s0.parts[0][0].length + 1 && s.parts[1][0].length === s0.parts[1][0].length + 1 && m0.length === 1 && m1.length === 1 && m0[0][0] === m1[0][0],
    JSON.stringify([m0, m1]),
  );
  await undo();
  await click(100, -53, ["Alt"]);
  s = await ed.state();
  check(A, "Alt+click deletes a shared vertex from both parts", s.parts[0][0].length === 5 && s.parts[1][0].length === 5 && !has(s.parts[1][0], [100, -53]), `${s.parts[0][0].length}, ${s.parts[1][0].length}`);
  await undo();
  s = await ed.state();
  check(A, "undo brings everything back", JSON.stringify(s.parts) === JSON.stringify(s0.parts));
});

await step(A, "snapping to another region", async () => {
  // Part 1's corner (110, -46) dragged to near the neighbour's corner (111, -46).
  await dragPath([[110, -46], [110.6, -46.05], [111.18, -46.12]]);
  let s = await ed.state();
  check(A, "a dragged vertex lands exactly on the neighbour's vertex", has(s.parts[0][0], [111, -46]), JSON.stringify(s.parts[0][0]));
  await undo();
  await dragPath([[110, -46], [110.6, -46.05], [111.18, -46.12]], ["Control"]);
  s = await ed.state();
  check(A, "holding Ctrl places it freely", !has(s.parts[0][0], [111, -46]) && s.parts[0][0].some((p) => near(p, [111.18, -46.12], 0.08)), JSON.stringify(s.parts[0][0]));
  await undo();
  await page.keyboard.press("s");
  check(A, "S turns snapping off", (await call("snapOn")) === false);
  await dragPath([[110, -46], [110.6, -46.05], [111.18, -46.12]]);
  s = await ed.state();
  check(A, "with snapping off it doesn't snap", !has(s.parts[0][0], [111, -46]));
  await undo();
  await page.keyboard.press("s");
  check(A, "S turns it back on", (await call("snapOn")) === true);
});

await step(A, "Tab traces the other way round", async () => {
  await page.keyboard.press("p");
  await click(110.2, -45.85); // part 1's corner (110, -46)
  await page.keyboard.press("Tab");
  await click(110.2, -55.85); // (110, -56): the short way is straight down; flipped goes round the west side
  const d = await call("drawing");
  check(A, "flipped, the trace goes round the long way", d && has(d, [100, -46]) && has(d, [100, -56]), JSON.stringify(d));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(80);
  check(A, "Esc cancels the outline", (await call("drawing")) === null);
  await page.keyboard.press("v");
});

await step(A, "freehand follows a border", async () => {
  await page.keyboard.press("f");
  const n0 = (await ed.state()).parts.length;
  // Along the neighbour's east side (lon 121), 4 px off it, then out east and back.
  const pts = [[126, -45.8], [123, -45.8], [121.2, -45.85]];
  for (let lat = -46.5; lat >= -55.5; lat -= 0.5) pts.push([121.2, lat]);
  pts.push([121.2, -56.15], [123, -56.2], [126, -56.2], [126.1, -50]);
  await dragPath(pts);
  const s = await ed.state();
  const ring = s.parts[n0]?.[0] ?? [];
  check(A, "the stroke along the border gets the border's corners exactly", s.parts.length === n0 + 1 && has(ring, [121, -46]) && has(ring, [121, -56]), JSON.stringify(ring));
  check(A, "…and nothing else of it sits off the border on that side", ring.filter((p) => p[0] > 120.6 && p[0] < 121.6).every((p) => p[0] === 121), JSON.stringify(ring));
  await undo();
  await page.keyboard.press("v");
});

await step(A, "province border tool", async () => {
  await page.click('dialog.editor button[data-act="province-border"]');
  const parts0 = (await ed.state()).parts;
  // Polygon tool: click two points; the first snaps to part 0's corner (110, -56), the last is free.
  await page.keyboard.press("p");
  await click(110.15, -55.9);
  await click(105, -51);
  await click(100.1, -46.1);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(100);
  let lines = await call("lines");
  check(A, "a province border is added as a line", lines.length === 1 && lines[0].length === 3, JSON.stringify(lines));
  check(A, "its ends snapped to the outline's corners", has(lines[0], [110, -56]) && has(lines[0], [100, -46]), JSON.stringify(lines));
  check(A, "the parts didn't change", JSON.stringify((await ed.state()).parts) === JSON.stringify(parts0));
  // It belongs to part 1 (the big square): moving the part carries it, vertex drags slide its pinned ends.
  const L0 = lines[0];
  await page.keyboard.press("v");
  await dragPath([[108, -48], [109.5, -48], [111, -48]]);
  lines = await call("lines");
  check(A, "moving the part moves its province border too", lines[0].every((q, i) => Math.abs(q[0] - (L0[i][0] + 3)) < 0.06 && Math.abs(q[1] - L0[i][1]) < 0.06), JSON.stringify(lines));
  await undo();
  lines = await call("lines");
  check(A, "undo puts both back", JSON.stringify(lines) === JSON.stringify([L0]));
  await dragPath([[110, -56], [110, -57], [110, -58]]);
  lines = await call("lines");
  check(
    A,
    "dragging a vertex the border is attached to takes that end of the border with it; the free point stays",
    Math.abs(lines[0][0][1] + 58) < 0.06 && Math.abs(lines[0][0][0] - 110) < 0.06 && lines[0][1][0] === L0[1][0] && lines[0][1][1] === L0[1][1],
    JSON.stringify(lines),
  );
  await undo();
  // Cut a bite out of the part: the border stays where it was (only what's inside the parts shows).
  await page.click('dialog.editor button[data-act="cut-hole"]');
  await page.keyboard.press("p");
  await clicks([[108, -50], [112, -50], [112, -44], [108, -44]]);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  lines = await call("lines");
  check(A, "cutting the part leaves its province border", JSON.stringify(lines) === JSON.stringify([L0]), JSON.stringify(lines));
  await undo();
  await page.keyboard.press("v");
  // Select it by clicking and delete it.
  await click(107.5, -53.5);
  await page.keyboard.press("Delete");
  await page.waitForTimeout(100);
  check(A, "click selects it and Delete removes it", (await call("lines")).length === 0);
  await undo();
  check(A, "undo brings it back", (await call("lines")).length === 1);
});

check(A, "no errors or dialogs in the admin page", errors.length === 0 && dialogs.length === 0, [...errors, ...dialogs].join(" | ") || "none");
await ctx.close();

/* ═════════════ Embed ═════════════ */
const raw = async (png) => sharp(png).raw().toBuffer({ resolveWithObject: true });
/** Along a screen segment: fraction of pixels that are dark ink, and how often it switches on/off. */
function inkProfile(img, a, b) {
  const { data, info } = img;
  const n = Math.max(2, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1])));
  let on = 0;
  let flips = 0;
  let prev = null;
  for (let i = 0; i <= n; i++) {
    const x = Math.round(a[0] + ((b[0] - a[0]) * i) / n);
    const y = Math.round(a[1] + ((b[1] - a[1]) * i) / n);
    let hit = false;
    for (let d = -1; d <= 1 && !hit; d++) {
      const k = (y * info.width + x + d) * info.channels;
      if (data[k] + data[k + 1] + data[k + 2] < 150) hit = true;
    }
    if (hit) on++;
    if (prev !== null && prev !== hit) flips++;
    prev = hit;
  }
  return { on: on / (n + 1), flips };
}
const fmt = (p) => `${Math.round(p.on * 100)}% ink, ${p.flips} flips`;

for (const view of ["flat", "globe"]) {
  const G = `embed ${view}`;
  await step(G, "borders", async () => {
    const c = await browser.newContext({ viewport: { width: 800, height: 480 }, deviceScaleFactor: 1 });
    const p = await c.newPage();
    const errs = [];
    p.on("pageerror", (e) => errs.push(String(e)));
    p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
    await p.goto(`${SITE}/v/${SLOT.slug}/?region=borders-test${view === "flat" ? "&view=flat" : ""}`);
    await p.waitForFunction(() => ["hires", "fallback"].includes(document.documentElement.dataset.state), null, { timeout: 30000 });
    await p.mouse.move(799, 479);
    await p.waitForTimeout(700);
    const shot = await p.locator("#globe").screenshot();
    await writeFile(path.join(OUT, `embed-${view}.png`), shot);
    check(G, "loads without errors", errs.length === 0, errs.join(" | ") || "no errors");
    if (view === "flat") {
      const img = await raw(shot);
      const aspect = MAP.w / MAP.h;
      const ky = 2 / aspect;
      const v = flatFit(geometryBounds({ type: "MultiPolygon", coordinates: BORDERS.map((r) => [r]) }), aspect, 800, 480);
      const at = (lon, lat) => [(lon - v.cx) * v.k + 400, (v.cy - lat) * v.k * ky + 240];
      const nat = inkProfile(img, at(30, -11), at(30, -19));
      const prov = inkProfile(img, at(15, -11.2), at(15, -18.8));
      const none = inkProfile(img, at(20, -11), at(20, -19));
      const outer = inkProfile(img, at(11, -10), at(19, -10));
      check(G, "national border (different colours) is a solid dark line", nat.on > 0.9 && nat.flips <= 2, fmt(nat));
      check(G, "no line where two same-colour parts meet", none.on < 0.1, fmt(none));
      check(G, "province border is dotted dark ink", prov.on > 0.15 && prov.on < 0.8 && prov.flips >= 6, fmt(prov));
      check(G, "outer borders stay in the part's colour", outer.on < 0.1, fmt(outer));
    }
    await c.close();
  });
}

await browser.close();
server.close();
await writeFile(path.join(OUT, "report.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed:\n${failed.map((f) => `  [${f.group}] ${f.name} ${f.detail}`).join("\n")}` : ""}`);
process.exit(failed.length ? 1 : 0);
