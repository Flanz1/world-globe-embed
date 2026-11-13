/**
 * Browser checks for layered parts and colour folders, in headless Chromium.
 *
 *   npm run e2e:layers
 *
 * 1. Builds the e2e fixture (scripts/e2e/fixture.mjs) plus a few overlapping regions, with the admin
 *    page pointed at the branch test/layers.
 * 2. Embeds (globe and flat, cross-origin iframe, padded and shifted slot): where parts overlap the
 *    later part covers the earlier one, and where their colours differ the overlap is contested (the
 *    upper colour filled, the lower one hatched over it, plus a "Contested" legend row); the legend lists every labelled colour (the region's own colour
 *    first once it's renamed); an old contested zone draws as a plain part; other regions on the slot
 *    never mark each other.
 * 3. Pixel identity: a region without overlaps renders exactly like a build of origin/main (skipped
 *    with a note if origin/main can't be checked out).
 * 4. Editor against the mocked GitHub API: colour folders (rename the default colour, fold, move parts,
 *    "+ Part"), Shift/Ctrl+click picking rows without selecting text, the "Other regions" button in the
 *    toolbar, Forward / Back and ] / [ (live on the map), plain drag / Ctrl+drag / Alt+click / arrow keys,
 *    undo/redo, one-commit save, deleting whole parts behind a warning.
 *
 * Screenshots and report.json go to .e2e/layers/. Exits non-zero if any check fails.
 */
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { SLOT, MAP } from "./fixture.mjs";
import { MockGitHub } from "./mock-github.mjs";
import { useAdminApi } from "./admin-api.mjs";
import { geometryBounds } from "../../src/shared/geo.ts";
import { flatFit } from "../../src/shared/region.ts";

import { port } from "./ports.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const sharp = require("sharp");

const OUT = path.resolve(".e2e/layers");
const BRANCH = "test/layers";
const SITE = `http://localhost:${port(4173)}`;
const MAIN_SITE = `http://localhost:${port(4175)}`;
const HOST = `http://127.0.0.1:${port(4181)}`;
await mkdir(OUT, { recursive: true });
const ONLY = (process.env.E2E_ONLY ?? "").split(",").filter(Boolean);
const want = (g) => !ONLY.length || ONLY.includes(g);

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

/* ── Test regions ── */
const box = (w, s, e, n) => [[w, s], [e, s], [e, n], [w, n], [w, s]];
const feature = (id, geometry, props) => ({
  $schema: "../../schema/region.schema.json",
  type: "Feature",
  id,
  properties: { slot: SLOT.slug, map: MAP.id, color: "#ff3b30", fillOpacity: 0.25, label: true, updated: "2026-11-09T12:00:00Z", ...props },
  geometry,
});
/** P (bottom layer, the region's own colour) and Q on top of it (a legend colour). */
const LY = {
  P: [20, -20, 40, -5],
  Q: [30, -15, 46, -8],
};
const NEIGHBOUR = [44, -14, 54, -4];
/** The region the editor checks edit: A (big), B (small), and a hostile neighbour overlapping A. */
const ED = { A: [100, -56, 115, -36], B: [121, -50, 127, -44] };
const HOSTILE = '"><script>alert(1)</script>';
const HOSTILE_N = "<img src=x onerror=alert(4)>";
const extra = [
  feature("layers-test", { type: "MultiPolygon", coordinates: [[box(...LY.P)], [box(...LY.Q)]] }, {
    colorLabel: "Heartland",
    legendTitle: "Realm",
    legend: [{ label: "March", color: "#2979ff" }],
    partLegend: [-1, 0],
    partLabels: ["Heartland", "Claimed March"],
  }),
  // Saved before layers: Z was a contested zone of P. It loads as a plain part in P's colour.
  feature("legacy-zone", { type: "MultiPolygon", coordinates: [[box(...LY.P)], [box(...LY.Q)]] }, { partContested: [-1, 0] }),
  feature("contested-neighbour", { type: "Polygon", coordinates: [box(...NEIGHBOUR)] }, { color: "#2979ff" }),
  feature("editor-test", { type: "MultiPolygon", coordinates: [[box(...ED.A)], [box(...ED.B)]] }, { color: "#00e5ff", partLabels: [HOSTILE, ""] }),
  feature("hostile-overlap", { type: "Polygon", coordinates: [box(108, -38, 112, -33)] }, { color: "#ffffff", partLabels: [HOSTILE_N] }),
];

/* ── Build the fixture (and origin/main, for the pixel-identity check) ── */
async function build(fixtureModule, regions, branch) {
  const { makeFixture: make } = await import(pathToFileURL(fixtureModule).href);
  const dir = await make({ quiet: true });
  for (const r of regions) writeFileSync(path.join(dir, "content/regions", `${r.id}.json`), JSON.stringify(r, null, 2) + "\n");
  execFileSync("npm", ["run", "build"], { cwd: dir, env: { ...process.env, VITE_CONTENT_BRANCH: branch }, stdio: "pipe" });
  return dir;
}
const dir = await build(path.resolve("scripts/e2e/fixture.mjs"), extra, BRANCH);
console.log(`Fixture: ${dir}`);
let mainDir = null;
let mainNote = "";
if (want("identity")) {
  try {
    const wt = mkdtempSync(path.join(tmpdir(), "wge-main-"));
    rmSync(wt, { recursive: true, force: true });
    execFileSync("git", ["worktree", "add", "--detach", wt, "origin/main"], { stdio: "pipe" });
    symlinkSync(path.resolve("node_modules"), path.join(wt, "node_modules"), "dir");
    // The embeds' line width was made thinner on purpose: give the main build the same widths so only the zone work is compared
    // (a no-op once main has them).
    for (const [file, from, to] of [["src/viewer/flat.ts", "lineWidth: 2,", "lineWidth: 1.2,"], ["src/viewer/globe.ts", "lineWidth: (W / 2048) * 2.5,", "lineWidth: (W / 2048) * 1.5,"]]) {
      const f = path.join(wt, file);
      writeFileSync(f, readFileSync(f, "utf8").replace(from, to));
    }
    mainDir = await build(path.join(wt, "scripts/e2e/fixture.mjs"), [], BRANCH);
    execFileSync("git", ["worktree", "remove", "--force", wt], { stdio: "pipe" });
    console.log(`origin/main fixture: ${mainDir}`);
  } catch (e) {
    mainNote = `couldn't build origin/main: ${(e && e.message) || e}`.slice(0, 300);
  }
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".json": "application/json", ".txt": "text/plain" };
const serve = (root, port) =>
  createServer(async (req, res) => {
    const DIST = path.join(root, "dist");
    let p = path.join(DIST, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (existsSync(p) && statSync(p).isDirectory()) p = path.join(p, "index.html");
    if (!p.startsWith(DIST) || !existsSync(p)) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    res.end(await readFile(p));
  }).listen(port, "localhost");
const servers = [serve(dir, port(4173))];
if (mainDir) servers.push(serve(mainDir, port(4175)));
// Host page on another origin; src is a full URL on one of the two sites.
const host = createServer((req, res) => {
  const src = new URL(req.url, "http://x").searchParams.get("src") ?? "";
  const ok = src.startsWith(SITE) || src.startsWith(MAIN_SITE);
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<!doctype html><html><body style="margin:0;background:#202020">
<iframe id="embed" src="${ok ? src.replace(/"/g, "") : ""}" width="800" height="480" style="border:0;display:block" allow="fullscreen" title="region"></iframe></body></html>`);
}).listen(port(4181), "127.0.0.1");

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--disable-features=IsolateOrigins,site-per-process"],
});

async function openEmbed(url) {
  const ctx = await browser.newContext({ viewport: { width: 800, height: 480 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  const dialogs = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("dialog", (d) => (dialogs.push(d.message()), d.dismiss()));
  await page.goto(`${HOST}/?src=${encodeURIComponent(url)}`);
  const frame = page.frames().find((f) => f.url().startsWith(url.slice(0, 21)));
  await frame.waitForFunction(() => ["hires", "fallback"].includes(document.documentElement.dataset.state), null, { timeout: 30000 });
  await page.mouse.move(799, 479);
  await page.waitForTimeout(600);
  return { ctx, page, frame, errors, dialogs };
}
const canvasShot = (e) => e.frame.locator("#globe").screenshot();
const raw = async (png) => sharp(png).raw().toBuffer({ resolveWithObject: true });
const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
/** Fraction of samples along a screen segment whose pixel is close to `colour`, and how often it switches on/off. */
function lineProfile(img, a, b, colour, tol = 60) {
  const [r, g, bl] = hex(colour);
  const { data, info } = img;
  const n = Math.max(2, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1])));
  let on = 0;
  let flips = 0;
  let prev = null;
  for (let i = 0; i <= n; i++) {
    const x = Math.round(a[0] + ((b[0] - a[0]) * i) / n);
    const y = Math.round(a[1] + ((b[1] - a[1]) * i) / n);
    // Best match within ±3 px across the line (outlines sit just inside the edge), so a line between pixel rows still counts.
    let hit = false;
    for (let d = -3; d <= 3 && !hit; d++) {
      const dx = Math.abs(b[1] - a[1]) > Math.abs(b[0] - a[0]) ? d : 0;
      const dy = dx ? 0 : d;
      const xx = x + dx;
      const yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= info.width || yy >= info.height) continue;
      const k = (yy * info.width + xx) * info.channels;
      if (Math.abs(data[k] - r) + Math.abs(data[k + 1] - g) + Math.abs(data[k + 2] - bl) < tol) hit = true;
    }
    if (hit) on++;
    if (prev !== null && prev !== hit) flips++;
    prev = hit;
  }
  return { on: on / (n + 1), flips, n };
}
const isSolid = (p) => p.on > 0.9 && p.flips <= 2;
const fmt = (p) => `${Math.round(p.on * 100)}% on, ${p.flips} flips over ${p.n} px`;
const diffCount = (a, b, rect) => {
  let n = 0;
  for (let y = rect.y0; y < rect.y1; y++)
    for (let x = rect.x0; x < rect.x1; x++) {
      const k = (y * a.info.width + x) * a.info.channels;
      if (Math.abs(a.data[k] - b.data[k]) + Math.abs(a.data[k + 1] - b.data[k + 1]) + Math.abs(a.data[k + 2] - b.data[k + 2]) > 30) n++;
    }
  return n;
};

/* ═════════════ 1. Embeds ═════════════ */
const lyGeom = extra[0].geometry;
const flatMap = () => {
  // Same framing as the flat viewer: flatFit of the region's bounds, in an 800 × 480 stage.
  const aspect = MAP.w / MAP.h;
  const v = flatFit(geometryBounds(lyGeom), aspect, 800, 480);
  const ky = 2 / aspect;
  return (lon, lat) => [(lon - v.cx) * v.k + 400, (v.cy - lat) * v.k * ky + 240];
};
const absent = (p) => p.on < 0.15;

for (const view of want("embed") ? ["flat", "globe"] : []) {
  const G = `embed ${view}`;
  const q = (region, extraQ = "") => `${SITE}/v/${SLOT.slug}/?region=${region}${view === "flat" ? "&view=flat" : ""}${extraQ}`;
  await step(G, "layers and legend", async () => {
    const e = await openEmbed(q("layers-test"));
    check(G, "loads without errors", e.errors.length === 0, e.errors.join(" | ") || "no errors");
    const key = await e.frame.evaluate(() => {
      const k = document.querySelector(".rkey");
      return k && { visible: k.checkVisibility(), head: k.querySelector(".rkey-head").textContent, rows: [...k.querySelectorAll("li")].map((li) => [li.textContent, getComputedStyle(li.querySelector("i")).backgroundColor]) };
    });
    check(
      G,
      "legend lists the renamed default colour first, then the other colours, then Contested (the parts overlap)",
      key?.visible && key.head === "Realm" && JSON.stringify(key.rows.slice(0, 2)) === JSON.stringify([["Heartland", "rgb(255, 59, 48)"], ["March", "rgb(41, 121, 255)"]]) && key.rows.length === 3 && key.rows[2][0] === "Contested",
      JSON.stringify(key),
    );
    const shot = await canvasShot(e);
    await writeFile(path.join(OUT, `embed-${view}.png`), shot);
    if (view === "flat") {
      const img = await raw(shot);
      const at = flatMap();
      // P's east edge (lon 40) runs under Q between lat -15 and -8: covered there, solid below Q.
      const pUnder = lineProfile(img, at(40, -9), at(40, -14), "#ff3b30", 120);
      const pOut = lineProfile(img, at(40, -16), at(40, -19.5), "#ff3b30", 120);
      check(G, "the lower part's border is hidden under the part on top", absent(pUnder), fmt(pUnder));
      check(G, "…and solid where nothing covers it", isSolid(pOut), fmt(pOut));
      // Q's south edge (lat -15) between lon 31 and 39 lies inside P: Q is on top, so it's drawn.
      const qIn = lineProfile(img, at(31, -15), at(39, -15), "#2979ff", 120);
      check(G, "the upper part's border shows over the lower part", isSolid(qIn), fmt(qIn));
      // Contested: the overlap (lon 30…40, lat -15…-8) is Q's blue with P's red hatched over it; Q alone (lon 41…46) has no red.
      const redness = (w, s, e, n) => {
        const [x0, y0] = at(w, n);
        const [x1, y1] = at(e, s);
        let red = 0;
        let all = 0;
        for (let y = Math.round(y0); y < Math.round(y1); y++)
          for (let x = Math.round(x0); x < Math.round(x1); x++) {
            const k = (y * img.info.width + x) * img.info.channels;
            all++;
            if (img.data[k] - img.data[k + 2] > 40) red++;
          }
        return red / all;
      };
      const hatched = redness(32, -13.5, 38, -9.5);
      const plainQ = redness(41.5, -13.5, 45, -9.5);
      check(G, "the overlap is contested: hatched in the lower part's colour over the upper one's", hatched > 0.1 && plainQ < 0.02, `${Math.round(hatched * 100)}% red in the overlap, ${Math.round(plainQ * 100)}% in Q alone`);
    }
    await e.page.screenshot({ path: path.join(OUT, `embed-${view}-page.png`) });
    await e.ctx.close();

    const k0 = await openEmbed(q("layers-test", "&key=0"));
    check(G, "key=0 hides the legend", !(await k0.frame.evaluate(() => document.querySelector(".rkey")?.checkVisibility() ?? false)));
    await k0.ctx.close();
  });

  await step(G, "an old contested zone is a plain part", async () => {
    const data = await (await fetch(`${SITE}/regions/legacy-zone.json`)).json();
    check(G, "regions/legacy-zone.json has no contested field", data.contested === undefined && data.clash === undefined, JSON.stringify(Object.keys(data)));
    const e = await openEmbed(q("legacy-zone"));
    const rows = await e.frame.evaluate(() => [...document.querySelectorAll(".rkey li")].map((li) => li.textContent));
    check(G, "no legend rows (no Contested row)", rows.length === 0, JSON.stringify(rows));
    if (view === "flat") {
      const shot = await canvasShot(e);
      await writeFile(path.join(OUT, "embed-flat-legacy.png"), shot);
      const img = await raw(shot);
      const at = flatMap();
      // The zone (second part, so on top) is drawn in its parent's colour, solid.
      const zEast = lineProfile(img, at(46, -9.5), at(46, -14.5), "#ff3b30", 120);
      check(G, "the former zone is drawn in its parent's colour with a solid border", isSolid(zEast), fmt(zEast));
    }
    check(G, "no errors", e.errors.length === 0, e.errors.join(" | "));
    await e.ctx.close();
  });

  await step(G, "other regions on the slot never mark this one", async () => {
    const data = await (await fetch(`${SITE}/regions/layers-test.json`)).json();
    check(G, "regions/layers-test.json carries nothing about the neighbour", data.clash === undefined && !JSON.stringify(data).includes("#2979ff\"}]") === !JSON.stringify(data).includes("March"), JSON.stringify(data.clash));
    const on = await openEmbed(q("layers-test"));
    const off = await openEmbed(q("layers-test", "&clash=0"));
    const a = await raw(await canvasShot(on));
    const b = await raw(await canvasShot(off));
    const d = diffCount(a, b, { x0: 0, y0: 0, x1: a.info.width, y1: a.info.height });
    check(G, "nothing changes with an old clash=0 param", d === 0, `${d} px differ`);
    await on.ctx.close();
    await off.ctx.close();
  });
}

/* ═════════════ 2. Pixel identity with origin/main ═════════════ */
if (want("identity")) {
  const G = "identity";
  if (!mainDir) check(G, "origin/main build for comparison", false, mainNote);
  else
    for (const [region, view] of [["provinces", "flat"], ["provinces", "globe"], ["landmark-disc", "flat"], ["landmark-disc", "globe"], ["dateline-box", "flat"]]) {
      await step(G, `${region} ${view}`, async () => {
        const qs = `/v/${SLOT.slug}/?region=${region}${view === "flat" ? "&view=flat" : ""}`;
        const a = await openEmbed(SITE + qs);
        const b = await openEmbed(MAIN_SITE + qs);
        const sa = await canvasShot(a);
        const sb = await canvasShot(b);
        const same = Buffer.compare(sa, sb) === 0;
        if (!same) {
          await writeFile(path.join(OUT, `identity-${region}-${view}-branch.png`), sa);
          await writeFile(path.join(OUT, `identity-${region}-${view}-main.png`), sb);
        }
        const ra = await raw(sa);
        const rb = await raw(sb);
        // Outlines now sit inside their part (so touching borders stay side by side) and the globe overlay is sharper,
        // so only the outline pixels may differ: fills, map and everything else must still match origin/main.
        const nDiff = diffCount(ra, rb, { x0: 0, y0: 0, x1: ra.info.width, y1: ra.info.height });
        check(G, `${region} (${view}) differs from origin/main only along the outlines`, same || nDiff < 0.03 * ra.info.width * ra.info.height, `${nDiff} px differ`);
        await a.ctx.close();
        await b.ctx.close();
      });
    }
}

/* ═════════════ 3. Editor ═════════════ */
const A = "editor";
const mock = new MockGitHub({ root: dir, branches: ["main", BRANCH] });
const mainAtStart = mock.refs.get("main");
let page;
let editorErrors = [];
const dialogs = [];
const ed = {
  state: () => page.evaluate(() => document.querySelector("dialog.editor").wgeEditor.state()),
  sel: () => page.evaluate(() => document.querySelector("dialog.editor").wgeEditor.selectedPart()),
  clashes: () => page.evaluate(() => document.querySelector("dialog.editor").wgeEditor.clashes()),
  setView: (cx, cy, k) => page.evaluate(([cx, cy, k]) => document.querySelector("dialog.editor").wgeEditor.setView(cx, cy, k), [cx, cy, k]),
  /** Page coordinates of a map point. */
  xy: (lon, lat) =>
    page.evaluate(([lon, lat]) => {
      const d = document.querySelector("dialog.editor");
      const r = d.querySelector("canvas.ed-canvas").getBoundingClientRect();
      const [x, y] = d.wgeEditor.toScreen(lon, lat);
      return [r.left + x, r.top + y];
    }, [lon, lat]),
  /** Canvas-local coordinates of a map point. */
  local: (lon, lat) => page.evaluate(([lon, lat]) => document.querySelector("dialog.editor").wgeEditor.toScreen(lon, lat), [lon, lat]),
  msg: () => page.textContent("dialog.editor .ed-msg"),
  status: () => page.textContent("dialog.editor .ed-status"),
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
/** Parts open locked (and new ones start locked): unlock every part that is, through the Parts list. */
async function unlockAll() {
  const locked = page.locator('dialog.editor [data-act="part-lock"][aria-pressed="true"]');
  while (await locked.count()) await locked.first().click();
}
const K = 20; // px per degree of longitude in the editor checks
const KY = K * (2 / (MAP.w / MAP.h)); // px per degree of latitude (the map isn't 2:1)
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const canvasImg = async () => {
  await page.mouse.move(2, 2);
  await page.waitForTimeout(120);
  return raw(await page.locator("dialog.editor canvas.ed-canvas").screenshot());
};
const edgeProfile = async (img, a, b, colour) => lineProfile(img, await ed.local(...a), await ed.local(...b), colour);
const partBox = (s, p) => {
  const xs = s.parts[p][0].map((q) => q[0]);
  const ys = s.parts[p][0].map((q) => q[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};
const moved = (a, b) => a.map((v, i) => +(b[i] - v).toFixed(4));
/** Unselects by clicking empty map, so the selection outline doesn't cover the borders. */
const unselect = async () => {
  const [x, y] = await ed.xy(134, -58); // empty map, clear of the layer bar at the top right
  await page.mouse.click(x, y);
  await page.waitForTimeout(80);
};
const folders = () =>
  page.evaluate(() => [...document.querySelectorAll("dialog.editor .ed-folder")].map((f) => [f.dataset.key, [...f.querySelectorAll(".ed-part-row")].map((r) => Number(r.dataset.row))]));

if (want("editor")) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await ctx.route("https://api.github.com/**", (r) => mock.handle(r));
  await useAdminApi(ctx, mock, { branch: BRANCH });
  page = await ctx.newPage();
  page.on("pageerror", (e) => editorErrors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && !/^Failed to load resource/.test(m.text()) && editorErrors.push(m.text()));
  page.on("dialog", (d) => (dialogs.push(d.message()), d.dismiss()));
  let start = null;
  let final = null;
  const A_COL = "#00e5ff";
  let B_COL = "";

  await step(A, "open the editor", async () => {
    await page.goto(`${SITE}/admin/#regions`);
    await page.waitForSelector('#regions .rcard[data-region="editor-test"]', { timeout: 15000 });
    await page.locator('[data-region="editor-test"] [data-action="edit"]').click();
    await page.waitForSelector("dialog.editor[open]");
    await page.waitForTimeout(600);
    await ed.setView(115, -45, K);
    await page.waitForTimeout(200);
    start = await ed.state();
    check(A, "opens with two parts", start.parts.length === 2 && JSON.stringify(start.contested) === "[-1,-1]", JSON.stringify(start.contested));
    const list = await page.evaluate(() => [...document.querySelectorAll("dialog.editor .ed-clashes li")].map((li) => li.textContent));
    const imgs = await page.evaluate(() => document.querySelectorAll("dialog.editor img").length);
    check(A, "another region overlapping a part isn't listed as an overlap", list.length === 1 && list[0] === "No overlaps." && imgs === 0 && dialogs.length === 0, JSON.stringify(list));
    check(A, "no 'Contested of' or 'Add contested zone' left", (await page.locator('dialog.editor [data-contested-of], dialog.editor [data-act="add-contested"], dialog.editor input[name="zones-follow"]').count()) === 0);
    // "Other regions" sits at the right end of the toolbar.
    const pos = await page.evaluate(() => {
      const b = document.querySelector("dialog.editor .ed-ov-btn");
      const bar = document.querySelector("dialog.editor .ed-toolbar");
      return { inBar: bar.contains(b), b: b.getBoundingClientRect().toJSON(), bar: bar.getBoundingClientRect().toJSON(), help: document.querySelector('dialog.editor [data-act="help"]').getBoundingClientRect().toJSON() };
    });
    check(A, "'Other regions' is in the toolbar, at its right end", pos.inBar && pos.bar.right - pos.b.right < 20 && pos.b.left > pos.help.right, JSON.stringify([pos.b.left, pos.b.right, pos.bar.right, pos.help.right]));
    await page.click("dialog.editor .ed-ov-btn");
    const panel = await page.evaluate(() => {
      const p = document.querySelector("dialog.editor .ed-ov-panel");
      return { open: !p.hidden, inMap: document.querySelector("dialog.editor .ed-canvas-wrap").contains(p) };
    });
    check(A, "it opens its panel over the top right of the map", panel.open && panel.inMap, JSON.stringify(panel));
    await page.screenshot({ path: path.join(OUT, "editor-other-regions.png") });
    await page.keyboard.press("Escape");
  });

  await step(A, "colour folders", async () => {
    check(A, "one folder (Default colour) holding both parts", JSON.stringify(await folders()) === JSON.stringify([["-1", [0, 1]]]), JSON.stringify(await folders()));
    await page.click('dialog.editor [data-act="key-add"]');
    await page.keyboard.type("March");
    await page.selectOption('dialog.editor select[data-part="1"]', "0");
    let s = await ed.state();
    B_COL = s.props.legend[0].color;
    check(A, "Add colour makes a folder; moving part 2 into it", JSON.stringify(await folders()) === JSON.stringify([["-1", [0]], ["0", [1]]]) && s.props.legend[0].label === "March" && JSON.stringify(s.styles) === "[-1,0]", JSON.stringify([await folders(), s.styles]));
    // The default colour is renamed like any other colour.
    await page.fill('dialog.editor input[name="color-label"]', "Heartland");
    s = await ed.state();
    const opts = await page.evaluate(() => [...document.querySelectorAll('dialog.editor select[data-part="1"] option')].map((o) => o.textContent));
    check(A, "the default colour can be renamed; part colour menus follow", s.props.colorLabel === "Heartland" && JSON.stringify(opts) === '["Heartland","March"]', JSON.stringify([s.props.colorLabel, opts]));
    // Fold and unfold.
    await page.click('dialog.editor .ed-folder[data-key="-1"] [data-act="fold"]');
    const hidden = await page.evaluate(() => {
      const f = document.querySelector('dialog.editor .ed-folder[data-key="-1"]');
      return { rowVisible: f.querySelector(".ed-part-row")?.checkVisibility() ?? false, exp: f.querySelector('[data-act="fold"]').getAttribute("aria-expanded") };
    });
    check(A, "a folder folds its parts away", !hidden.rowVisible && hidden.exp === "false", JSON.stringify(hidden));
    await page.screenshot({ path: path.join(OUT, "editor-folded.png"), clip: await page.locator("dialog.editor .ed-colours").boundingBox() });
    await page.click('dialog.editor .ed-folder[data-key="-1"] [data-act="fold"]');
    check(A, "…and unfolds again", await page.locator('dialog.editor .ed-part-row[data-row="0"]').isVisible());
    // Shift+click and Ctrl+click on rows pick parts, with no text selection across the panel.
    await page.click('dialog.editor .ed-part-row[data-row="0"] .ed-badge');
    await page.click('dialog.editor .ed-part-row[data-row="1"] .ed-badge', { modifiers: ["Shift"] });
    let picked = await page.evaluate(() => ({ text: getSelection().toString(), picks: [...document.querySelectorAll("dialog.editor .ed-part-row.pick")].map((r) => r.dataset.row) }));
    check(A, "Shift+click on a row picks a second part", /2 parts picked/.test(await ed.msg()) && JSON.stringify(picked.picks) === '["0","1"]', `${await ed.msg()} ${JSON.stringify(picked.picks)}`);
    check(A, "…without selecting any text", picked.text === "", JSON.stringify(picked.text));
    await page.click('dialog.editor .ed-part-row[data-row="1"] .ed-badge', { modifiers: ["Control"] });
    picked = await page.evaluate(() => ({ text: getSelection().toString(), picks: [...document.querySelectorAll("dialog.editor .ed-part-row.pick")].map((r) => r.dataset.row) }));
    check(A, "Ctrl+click takes it out again, still no text selected", JSON.stringify(picked.picks) !== '["0","1"]' && picked.text === "", JSON.stringify(picked));
    // (One Esc per user action: Chrome closes a dialog on a second Esc without a click in between.)
    await page.keyboard.press("Escape");
    await page.screenshot({ path: path.join(OUT, "editor-folders.png"), clip: await page.locator("dialog.editor .ed-colours").boundingBox() });
  });

  await step(A, "layers: Forward and Back", async () => {
    await unlockAll();
    // Drag B onto A's east edge: B (part 2) is the upper layer.
    let [x, y] = await ed.xy(124, -47);
    await mdrag(x, y, -8 * K, 0);
    let s = await ed.state();
    const cl = await ed.clashes();
    check(A, "the overlap is detected live", cl.internal.some(([i, j]) => i === 0 && j === 1), JSON.stringify(cl));
    const listed = await page.evaluate(() => [...document.querySelectorAll("dialog.editor .ed-clashes li")].map((li) => li.textContent));
    check(A, "Overlaps says which part is on top in the contested overlap", listed.length === 1 && /^Part 2 over part 1 .*: contested, part 2's colour is the main one$/.test(listed[0]), JSON.stringify(listed));
    await unselect();
    let img = await canvasImg();
    const [bw] = partBox(s, 1);
    let aUnder = await edgeProfile(img, [115, -45], [115, -48.5], A_COL);
    let bOver = await edgeProfile(img, [bw, -45], [bw, -48.5], B_COL);
    check(A, "editor: the lower part's border is hidden under the upper part", absent(aUnder), fmt(aUnder));
    check(A, "editor: the upper part's border shows", isSolid(bOver), fmt(bOver));
    await page.screenshot({ path: path.join(OUT, "editor-layers-b-on-top.png") });
    // Back on part 2: it goes under part 1 (and becomes part 1).
    await page.click('dialog.editor .ed-part-row[data-row="1"] [data-act="part-backward"]');
    s = await ed.state();
    check(A, "Back sends part 2 under part 1: they swap numbers, colours and labels go along", JSON.stringify(s.styles) === "[0,-1]" && JSON.stringify(s.labels) === JSON.stringify(["", HOSTILE]) && JSON.stringify(partBox(s, 1)) === JSON.stringify(ED.A), JSON.stringify([s.styles, s.labels]));
    check(A, "…says so, and the moved part stays selected", /Part 2 is now part 1, under part 2/.test(await ed.msg()) && (await ed.sel()) === 0, `${await ed.msg()} / ${await ed.sel()}`);
    check(A, "…and its row moved with it (folders by colour, numbers renewed)", JSON.stringify(await folders()) === JSON.stringify([["-1", [1]], ["0", [0]]]), JSON.stringify(await folders()));
    await unselect();
    img = await canvasImg();
    aUnder = await edgeProfile(img, [115, -45], [115, -48.5], A_COL);
    bOver = await edgeProfile(img, [bw, -45], [bw, -48.5], B_COL);
    // (A vertex handle sits on this edge, hence a short gap.)
    check(A, "editor: now A's border shows over B…", aUnder.on > 0.8, fmt(aUnder));
    check(A, "…and B's border is hidden under A (only its contested hatch shows there)", !isSolid(bOver) && bOver.on < 0.7, fmt(bOver));
    await page.screenshot({ path: path.join(OUT, "editor-layers-a-on-top.png") });
    await page.waitForTimeout(500);
    // ] brings the selected part forward again.
    await page.click('dialog.editor .ed-part-row[data-row="0"] [data-act="part-select"]');
    await page.focus("dialog.editor canvas.ed-canvas");
    await page.keyboard.press("]");
    s = await ed.state();
    check(A, "] brings the selected part forward", JSON.stringify(s.styles) === "[-1,0]" && (await ed.sel()) === 1, JSON.stringify(s.styles));
    check(A, "Forward is off for the top layer, Back for the bottom", (await page.isDisabled('dialog.editor .ed-part-row[data-row="1"] [data-act="part-forward"]')) && (await page.isDisabled('dialog.editor .ed-part-row[data-row="0"] [data-act="part-backward"]')));
    await page.keyboard.press("[");
    await page.keyboard.press("]");
    check(A, "[ then ] ends where it started", JSON.stringify((await ed.state()).styles) === "[-1,0]");
    // The layer bar in the top right of the map, while a part is selected.
    // (The bar updates on the next frame.)
    const bar = () => page.evaluate(async () => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const b = document.querySelector("dialog.editor .ed-layer-bar");
      const r = b.getBoundingClientRect();
      const w = document.querySelector("dialog.editor .ed-canvas-wrap").getBoundingClientRect();
      return { shown: !b.hidden, text: b.querySelector(".ed-layer-name").textContent, fwd: b.querySelector('[data-act="layer-forward"]').disabled, back: b.querySelector('[data-act="layer-backward"]').disabled, topRight: Math.abs(r.right - w.right) < 20 && Math.abs(r.top - w.top) < 20 };
    });
    let lb = await bar();
    check(A, "a selected part shows the layer bar in the map's top right", lb.shown && lb.topRight && lb.text === "Part 2 of 2" && lb.fwd && !lb.back, JSON.stringify(lb));
    await page.click('dialog.editor .ed-layer-bar [data-act="layer-backward"]');
    lb = await bar();
    check(A, "its Back sends the part under the other", JSON.stringify((await ed.state()).styles) === "[0,-1]" && (await ed.sel()) === 0 && lb.text === "Part 1 of 2" && !lb.fwd && lb.back, JSON.stringify(lb));
    await page.click('dialog.editor .ed-layer-bar [data-act="layer-forward"]');
    check(A, "…and Forward brings it back on top", JSON.stringify((await ed.state()).styles) === "[-1,0]" && (await ed.sel()) === 1);
    await unselect();
    check(A, "nothing selected: no layer bar", !(await bar()).shown);
    await page.screenshot({ path: path.join(OUT, "editor-overlap.png") });
  });

  await step(A, "moving parts", async () => {
    const s0 = await ed.state();
    const [w, so, e, n] = partBox(s0, 1);
    // Alt+click cycles through the parts under the pointer (top first).
    let [x, y] = await ed.xy(114, -47);
    await page.mouse.click(x, y);
    const top = await ed.sel();
    await page.keyboard.down("Alt");
    await page.mouse.click(x, y);
    const next = await ed.sel();
    await page.waitForTimeout(100);
    const hint = await ed.status();
    await page.mouse.click(x, y);
    const back = await ed.sel();
    await page.keyboard.up("Alt");
    check(A, "click picks the top layer; Alt+click cycles", top === 1 && next === 0 && back === 1, `${top} → ${next} → ${back}`);
    check(A, "status line says which of the parts here", /Part 1 \(2 of 2 here, Alt\+click for the next\)/.test(hint), hint);
    // Arrow keys nudge the selected part.
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Shift+ArrowUp");
    const s1 = await ed.state();
    check(A, "arrow keys nudge the selected part only", JSON.stringify(moved([w, so, e, n], partBox(s1, 1))) === JSON.stringify([r4(1 / K), r4(10 / KY), r4(1 / K), r4(10 / KY)]) && JSON.stringify(s1.parts[0]) === JSON.stringify(s0.parts[0]), JSON.stringify(moved([w, so, e, n], partBox(s1, 1))));
    // Ctrl+drag moves the whole region.
    [x, y] = await ed.xy(102, -52);
    await mdrag(x, y, 2 * K, 0, ["Control"]);
    const s2 = await ed.state();
    check(A, "Ctrl+drag moves the whole region", [0, 1].every((p) => JSON.stringify(moved(partBox(s1, p), partBox(s2, p))) === "[2,0,2,0]"), [0, 1].map((p) => JSON.stringify(moved(partBox(s1, p), partBox(s2, p)))).join(" "));
  });

  await step(A, "+ Part draws a part in that colour", async () => {
    await page.keyboard.press("p");
    await page.click('dialog.editor .ed-folder[data-key="0"] [data-act="folder-add-part"]');
    for (const [lon, lat] of [[95, -40], [99, -40], [99, -32], [95, -32]]) {
      const [x, y] = await ed.xy(lon, lat);
      await page.mouse.click(x, y);
    }
    const [x, y] = await ed.xy(95, -40);
    await page.mouse.click(x, y);
    const s = await ed.state();
    check(A, "the new part goes into that colour's folder", s.parts.length === 3 && s.styles[2] === 0 && JSON.stringify(await folders()) === JSON.stringify([["-1", [0]], ["0", [1, 2]]]), `${JSON.stringify(s.styles)} ${await ed.msg()}`);
    check(A, "…and says where it went", /added to March/.test(await ed.msg()), await ed.msg());
    await page.keyboard.press("v");
    final = s;
  });

  await step(A, "undo/redo and save", async () => {
    await page.click("dialog.editor canvas.ed-canvas", { position: { x: 3, y: 3 }, button: "middle" });
    let undos = 0;
    while (!(await page.isDisabled('dialog.editor [data-act="undo"]')) && undos < 80) {
      await page.keyboard.press("Control+z");
      undos++;
    }
    let s = await ed.state();
    check(A, "undo all of it back to the start", JSON.stringify(s) === JSON.stringify(start), `${undos} steps`);
    let redos = 0;
    while (!(await page.isDisabled('dialog.editor [data-act="redo"]')) && redos < 80) {
      await page.keyboard.press("Control+Shift+z");
      redos++;
    }
    s = await ed.state();
    check(A, "redo all of it", JSON.stringify(s) === JSON.stringify(final) && redos === undos, `${redos} steps`);
    const n0 = mock.log.length;
    await page.click("dialog.editor .ed-save");
    const t0 = Date.now();
    while (mock.log.length < n0 + 1 && Date.now() - t0 < 15000) await page.waitForTimeout(100);
    await page.waitForTimeout(400);
    const c = mock.log.slice(n0);
    check(A, "save is exactly one commit to content/regions/editor-test.json on the branch", c.length === 1 && c[0].branch === BRANCH && JSON.stringify(c[0].changes) === JSON.stringify([{ path: "content/regions/editor-test.json", deleted: false }]), JSON.stringify(c));
    const f = JSON.parse(mock.read(BRANCH, "content/regions/editor-test.json"));
    const p = f.properties;
    check(
      A,
      "saved with the renamed default colour, the folders and the layer order; no partContested",
      p.colorLabel === "Heartland" && JSON.stringify(p.legend) === JSON.stringify([{ label: "March", color: B_COL }]) && JSON.stringify(p.partLegend) === "[-1,0,0]" && p.partLabels[0] === HOSTILE && !("partContested" in p),
      JSON.stringify(p),
    );
    check(A, "main untouched", mock.refs.get("main") === mainAtStart);
    await page.screenshot({ path: path.join(OUT, "editor-saved.png") });
  });

  await step(A, "delete a whole part (always asks first)", async () => {
    const warn = "dialog.small-dlg.danger[open]";
    const s0 = await ed.state();
    await page.click('dialog.editor .ed-part-row[data-row="2"] [data-act="part-delete"]');
    await page.waitForSelector(warn);
    const text = await page.textContent(`${warn} .dlg-body`);
    check(A, "Delete in a folder row shows a warning first", /This deletes Part 3 with all \d+ of its vertices/.test(text) && /undo/i.test(text), text);
    await page.click(`${warn} button:has-text("Keep it")`);
    await page.waitForTimeout(150);
    check(A, "'Keep it' leaves the region as it was", JSON.stringify(await ed.state()) === JSON.stringify(s0));
    await page.click('dialog.editor .ed-part-row[data-row="2"] [data-act="part-delete"]');
    await page.click(`${warn} button:has-text("Delete part")`);
    await page.waitForTimeout(150);
    const s1 = await ed.state();
    check(A, "'Delete part' removes the whole part", s1.parts.length === 2 && JSON.stringify(s1.parts) === JSON.stringify(s0.parts.slice(0, 2)) && JSON.stringify(s1.styles) === "[-1,0]", JSON.stringify(s1.styles));
    // Delete key on a selected part also asks; Esc keeps it.
    await page.click('dialog.editor .ed-part-row[data-row="0"] [data-act="part-select"]');
    await page.focus("dialog.editor canvas.ed-canvas");
    await page.keyboard.press("Delete");
    await page.waitForSelector(warn);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    check(A, "Delete key on a selected part asks, Esc keeps it", JSON.stringify(await ed.state()) === JSON.stringify(s1) && (await page.locator(warn).count()) === 0);
    await page.keyboard.press("Control+z");
    check(A, "undo brings the deleted part back", JSON.stringify(await ed.state()) === JSON.stringify(s0));
  });
  check(A, "no errors or dialogs in the admin page", editorErrors.length === 0 && dialogs.length === 0, [...editorErrors, ...dialogs].join(" | ") || "none");
  await ctx.close();
}

await browser.close();
for (const s of servers) s.close();
host.close();
await writeFile(path.join(OUT, "report.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed:\n${failed.map((f) => `  [${f.group}] ${f.name} ${f.detail}`).join("\n")}` : ""}`);
process.exit(failed.length ? 1 : 0);
