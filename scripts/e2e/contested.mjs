/**
 * Browser checks for contested zones, overlaps and moving parts, in headless Chromium.
 *
 *   npm run e2e:contested
 *
 * 1. Builds the e2e fixture (scripts/e2e/fixture.mjs) plus a few overlapping regions, with the admin
 *    page pointed at the branch test/contested.
 * 2. Embeds (globe and flat, cross-origin iframe, padded and shifted slot): dashed borders, hatching,
 *    the "Contested" legend row, key=0, and other regions on the slot never marking each other.
 * 3. Pixel identity: a region without zones or overlaps renders exactly like a build of origin/main
 *    (skipped with a note if origin/main can't be checked out).
 * 4. Editor against the mocked GitHub API: contested zones (polygon, freehand, picker, Parts list),
 *    live dashes on overlap, plain drag / Ctrl+drag / Alt+click / arrow keys, undo/redo, one-commit save,
 *    deleting whole parts behind a warning.
 *
 * Screenshots and report.json go to .e2e/contested/. Exits non-zero if any check fails.
 */
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { SLOT, MAP } from "./fixture.mjs";
import { MockGitHub } from "./mock-github.mjs";
import { geometryBounds } from "../../src/shared/geo.ts";
import { flatFit } from "../../src/shared/region.ts";

import { port } from "./ports.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const sharp = require("sharp");

const OUT = path.resolve(".e2e/contested");
const BRANCH = "test/contested";
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
/** P, its contested zone Z (overlapping P), and Q overlapping P: everything the embed draws dashed. */
const CT = {
  P: [20, -20, 40, -5],
  Z: [36, -18, 46, -8],
  Q: [10, -15, 24, -10],
};
const NEIGHBOUR = [44, -14, 54, -4];
/** The region the editor checks edit: A (big), B (small), and a hostile neighbour overlapping A. */
const ED = { A: [100, -56, 115, -36], B: [121, -50, 127, -44] };
const HOSTILE = '"><script>alert(1)</script>';
const HOSTILE_N = "<img src=x onerror=alert(4)>";
const extra = [
  feature("contested-test", { type: "MultiPolygon", coordinates: [[box(...CT.P)], [box(...CT.Z)], [box(...CT.Q)]] }, { partContested: [-1, 0, -1], partLabels: ["Heartland", "Claimed March", ""] }),
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
    // Best match within ±1 px across the line, so a line between pixel rows still counts.
    let hit = false;
    for (let d = -1; d <= 1 && !hit; d++) {
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
const isDashed = (p) => p.on > 0.25 && p.on < 0.85 && p.flips >= 4;
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
const ctGeom = extra[0].geometry;
const flatMap = () => {
  // Same framing as the flat viewer: flatFit of the region's bounds, in an 800 × 480 stage.
  const aspect = MAP.w / MAP.h;
  const v = flatFit(geometryBounds(ctGeom), aspect, 800, 480);
  const ky = 2 / aspect;
  return (lon, lat) => [(lon - v.cx) * v.k + 400, (v.cy - lat) * v.k * ky + 240];
};

for (const view of want("embed") ? ["flat", "globe"] : []) {
  const G = `embed ${view}`;
  const q = (extraQ = "") => `${SITE}/v/${SLOT.slug}/?region=contested-test${view === "flat" ? "&view=flat" : ""}${extraQ}`;
  await step(G, "contested zone, overlaps, legend", async () => {
    const e = await openEmbed(q());
    check(G, "loads without errors", e.errors.length === 0, e.errors.join(" | ") || "no errors");
    const key = await e.frame.evaluate(() => {
      const k = document.querySelector(".rkey");
      return k && { visible: k.checkVisibility(), rows: [...k.querySelectorAll("li")].map((li) => ({ text: li.textContent, dashed: getComputedStyle(li.querySelector("i")).borderStyle })) };
    });
    check(G, "legend has a 'Contested' row with a dashed swatch", key?.visible && key.rows.length === 1 && key.rows[0].text === "Contested" && key.rows[0].dashed === "dashed", JSON.stringify(key));
    const shot = await canvasShot(e);
    await writeFile(path.join(OUT, `embed-${view}.png`), shot);
    if (view === "flat") {
      const img = await raw(shot);
      const at = flatMap();
      // Q's top edge (lat -10): solid west of P (lon 10…20), dashed inside P (lon 20…24).
      const solid = lineProfile(img, at(11, -10), at(19, -10), "#ff3b30");
      const dashed = lineProfile(img, at(20.6, -10), at(23.6, -10), "#ff3b30");
      check(G, "a normal border is solid outside the parts it overlaps", isSolid(solid), fmt(solid));
      check(G, "…and dashed inside them", isDashed(dashed), fmt(dashed));
      // The contested zone Z: dashed all round, also outside P (its east edge, lon 46).
      const zEast = lineProfile(img, at(46, -9.5), at(46, -16.5), "#ff3b30");
      check(G, "a contested zone's border is dashed all round", isDashed(zEast), fmt(zEast));
      // P's east edge (lon 40) runs inside Z between lat -18 and -8: dashed there; solid above -8.
      const pIn = lineProfile(img, at(40, -9), at(40, -17), "#ff3b30");
      const pOut = lineProfile(img, at(40, -7.6), at(40, -5.6), "#ff3b30");
      check(G, "a part's border inside its own contested zone is dashed", isDashed(pIn), fmt(pIn));
      check(G, "…and solid where it leaves the zone", pOut.on > 0.85, fmt(pOut));
      // Hatch: inside Z (outside P) there are pixels of the zone colour that a plain fill wouldn't have.
      const [hx0, hy0] = at(41, -9);
      const [hx1, hy1] = at(45, -12);
      let lines = 0;
      for (let y = Math.round(hy0); y < Math.round(hy1); y++)
        for (let x = Math.round(hx0); x < Math.round(hx1); x++) {
          const k = (y * img.info.width + x) * img.info.channels;
          if (img.data[k] > 160 && img.data[k + 2] < 120) lines++;
        }
      check(G, "contested zone is hatched", lines > 15, `${lines} hatch pixels`);
    }
    await e.page.screenshot({ path: path.join(OUT, `embed-${view}-page.png`) });
    await e.ctx.close();

    const k0 = await openEmbed(q("&key=0"));
    check(G, "key=0 hides the legend, Contested row included", !(await k0.frame.evaluate(() => document.querySelector(".rkey")?.checkVisibility() ?? false)));
    await k0.ctx.close();
  });

  await step(G, "other regions on the slot never mark this one", async () => {
    // contested-neighbour overlaps contested-test, but each region is its own map: no clash data, no marks.
    const data = await (await fetch(`${SITE}/regions/contested-test.json`)).json();
    check(G, "regions/contested-test.json carries nothing about the neighbour", data.clash === undefined && !JSON.stringify(data).includes("2979ff"), JSON.stringify(data.clash));
    const nd = await (await fetch(`${SITE}/regions/contested-neighbour.json`)).json();
    check(G, "regions/contested-neighbour.json carries nothing about contested-test", nd.clash === undefined, JSON.stringify(nd.clash));
    // Old embed codes may still carry clash=0: it's ignored, and the picture is the same either way.
    const on = await openEmbed(q());
    const off = await openEmbed(q("&clash=0"));
    const a = await raw(await canvasShot(on));
    const b = await raw(await canvasShot(off));
    const d = diffCount(a, b, { x0: 0, y0: 0, x1: a.info.width, y1: a.info.height });
    check(G, "nothing changes with an old clash=0 param (no cross-region marks to turn off)", d === 0, `${d} px differ`);
    check(G, "no errors", on.errors.length === 0 && off.errors.length === 0, [...on.errors, ...off.errors].join(" | "));
    await on.ctx.close();
    await off.ctx.close();
    // The neighbour's own embed is a plain region: no "Contested" row, no hatching.
    const n = await openEmbed(`${SITE}/v/${SLOT.slug}/?region=contested-neighbour${view === "flat" ? "&view=flat" : ""}`);
    const nk = await n.frame.evaluate(() => [...document.querySelectorAll(".rkey li")].map((li) => li.textContent));
    check(G, "the other region shows no contested marks of its own (no legend rows)", nk.length === 0, JSON.stringify(nk));
    await writeFile(path.join(OUT, `embed-${view}-neighbour.png`), await canvasShot(n));
    await n.ctx.close();
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
        check(G, `${region} (${view}) renders pixel-identical to origin/main`, same, same ? "" : `${diffCount(ra, rb, { x0: 0, y0: 0, x1: ra.info.width, y1: ra.info.height })} px differ`);
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

if (want("editor")) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await ctx.route("https://api.github.com/**", (r) => mock.handle(r));
  page = await ctx.newPage();
  page.on("pageerror", (e) => editorErrors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && !/^Failed to load resource/.test(m.text()) && editorErrors.push(m.text()));
  page.on("dialog", (d) => (dialogs.push(d.message()), d.dismiss()));
  let start = null;
  let final = null;

  await step(A, "open the editor", async () => {
    await page.goto(`${SITE}/admin/#regions`);
    await page.fill("#token", "ghp_e2etoken");
    await page.click('#signin-form button[type="submit"]');
    await page.waitForSelector('#regions .rcard[data-region="editor-test"]', { timeout: 15000 });
    await page.locator('[data-region="editor-test"] [data-action="edit"]').click();
    await page.waitForSelector("dialog.editor[open]");
    await page.waitForTimeout(600);
    await ed.setView(115, -45, K);
    await page.waitForTimeout(200);
    start = await ed.state();
    check(A, "opens with two normal parts", start.parts.length === 2 && JSON.stringify(start.contested) === "[-1,-1]", JSON.stringify(start.contested));
    const list = await page.evaluate(() => [...document.querySelectorAll("dialog.editor .ed-clashes li")].map((li) => li.textContent));
    const imgs = await page.evaluate(() => document.querySelectorAll("dialog.editor img").length);
    // Part 1 lies under the (hostile-named) neighbour, a different map: not an overlap.
    check(A, "another region overlapping a part isn't listed as an overlap", list.length === 1 && list[0] === "No overlaps." && imgs === 0 && dialogs.length === 0, JSON.stringify(list));
  });

  await step(A, "contested zones", async () => {
    // Polygon tool, then select part 1 and add a zone to it.
    await page.click('dialog.editor [data-tool="polygon"]');
    await page.click('dialog.editor [data-tool="select"]');
    let [x, y] = await ed.xy(108, -45);
    await page.mouse.click(x, y);
    check(A, "click inside a part selects it", (await ed.sel()) === 0, String(await ed.sel()));
    await page.click('dialog.editor [data-act="add-contested"]');
    for (const [lon, lat] of [[95, -40], [103, -40], [103, -32], [95, -32]]) {
      [x, y] = await ed.xy(lon, lat);
      await page.mouse.click(x, y);
    }
    [x, y] = await ed.xy(95, -40);
    await page.mouse.click(x, y);
    let s = await ed.state();
    check(A, "add a contested zone to the selected part with the polygon tool", s.parts.length === 3 && JSON.stringify(s.contested) === "[-1,-1,0]" && s.labels[2] === "", JSON.stringify(s.contested));
    // Freehand: select part 2 (B), add a zone by dragging.
    await page.keyboard.press("f");
    await page.keyboard.press("v");
    [x, y] = await ed.xy(124, -47);
    await page.mouse.click(x, y);
    await page.click('dialog.editor [data-act="add-contested"]');
    const ring = [];
    for (let i = 0; i <= 24; i++) {
      const t = (i / 24) * Math.PI * 2;
      ring.push(await ed.xy(133 + Math.cos(t) * 3, -47 + Math.sin(t) * 3));
    }
    await page.mouse.move(...ring[0]);
    await page.mouse.down();
    for (const p of ring.slice(1)) await page.mouse.move(...p);
    await page.mouse.up();
    await page.waitForTimeout(100);
    s = await ed.state();
    check(A, "add a contested zone with freehand", s.parts.length === 4 && JSON.stringify(s.contested) === "[-1,-1,0,1]", JSON.stringify(s.contested));
    // With nothing selected: the "Extends which part?" picker.
    await page.keyboard.press("Escape");
    check(A, "Esc clears the selected part", (await ed.sel()) === -1);
    await page.click('dialog.editor [data-act="add-contested"]');
    const pick = await page.evaluate(() => [...document.querySelectorAll("dialog.zone-pick [data-pick-part]")].map((b) => b.textContent));
    check(A, "'Extends which part?' lists the normal parts, labels as plain text", JSON.stringify(pick) === JSON.stringify([`Part 1 (${HOSTILE})`, "Part 2"]) && dialogs.length === 0, JSON.stringify(pick));
    await page.click("dialog.zone-pick .pv-head button");
    // Parts list: zones are indented under their parent, with "Contested of" dropdowns.
    const rows = await page.evaluate(() => [...document.querySelectorAll("dialog.editor .ed-part-row")].map((r) => `${r.dataset.row}${r.classList.contains("zone") ? "z" : ""}`));
    check(A, "Parts list: zones indented under their parent", JSON.stringify(rows) === '["0","2z","1","3z"]', JSON.stringify(rows));
    const opts = await page.evaluate(() => [...document.querySelectorAll('dialog.editor select[data-contested-of="0"] option')].map((o) => [o.textContent, o.disabled]));
    check(A, "a part with zones can't become one (options disabled), hostile label stays text", JSON.stringify(opts) === JSON.stringify([["— (normal part)", false], ["Part 2", true]]), JSON.stringify(opts));
    const opts2 = await page.evaluate(() => [...document.querySelectorAll('dialog.editor select[data-contested-of="3"] option')].map((o) => o.textContent));
    check(A, "'Contested of' offers the normal parts except itself", JSON.stringify(opts2) === JSON.stringify(["— (normal part)", `Part 1 (${HOSTILE})`, "Part 2"]), JSON.stringify(opts2));
    await page.selectOption('dialog.editor select[data-contested-of="3"]', "-1");
    s = await ed.state();
    check(A, "turn a zone into a normal part via the Parts list", JSON.stringify(s.contested) === "[-1,-1,0,-1]", JSON.stringify(s.contested));
    await page.selectOption('dialog.editor select[data-contested-of="3"]', "1");
    s = await ed.state();
    check(A, "…and back", JSON.stringify(s.contested) === "[-1,-1,0,1]", JSON.stringify(s.contested));
    await page.screenshot({ path: path.join(OUT, "editor-parts-list.png"), clip: await page.locator("dialog.editor .ed-colours").boundingBox() });
  });

  await step(A, "moving parts and live dashes", async () => {
    // Every part starts locked: a drag inside one leaves it where it is, until it's unlocked.
    const locked0 = await ed.state();
    const [lx, ly] = await ed.xy(124, -47);
    await mdrag(lx, ly, -2 * K, 0);
    check(A, "parts start locked: dragging inside one doesn't move it", locked0.locked.every((l) => l === true) && JSON.stringify((await ed.state()).parts) === JSON.stringify(locked0.parts), JSON.stringify(locked0.locked));
    await unlockAll();
    const before = await ed.state();
    const frameBefore = await page.locator("dialog.editor iframe.ed-globe").screenshot();
    // Plain drag inside B moves just B (its zone stays: "Move contested zones with their part" is off).
    let [x, y] = await ed.xy(124, -47);
    await mdrag(x, y, -8 * K, 0);
    let s = await ed.state();
    check(A, "plain drag moves only that part", JSON.stringify(moved(partBox(before, 1), partBox(s, 1))) === "[-8,0,-8,0]" && [0, 2, 3].every((p) => JSON.stringify(s.parts[p]) === JSON.stringify(before.parts[p])), JSON.stringify(moved(partBox(before, 1), partBox(s, 1))));
    const cl = await ed.clashes();
    check(A, "the overlap is detected live", cl.internal.some(([i, j]) => i === 0 && j === 1), JSON.stringify(cl));
    await page.keyboard.press("Escape"); // unselect, so the selection outline doesn't cover the borders
    let img = await canvasImg();
    // A's east edge (lon 115) runs inside B (now 113…119) between lat -50 and -44.
    const aIn = await edgeProfile(img, [115, -45], [115, -49], "#00e5ff");
    const aOut = await edgeProfile(img, [115, -38], [115, -42], "#00e5ff");
    check(A, "editor: border dashed inside the other part", isDashed(aIn), fmt(aIn));
    check(A, "editor: and solid outside it", isSolid(aOut), fmt(aOut));
    await page.screenshot({ path: path.join(OUT, "editor-overlap.png") });
    await page.waitForTimeout(500);
    const frameAfter = await page.locator("dialog.editor iframe.ed-globe").screenshot();
    const fa = await raw(frameBefore);
    const fb = await raw(frameAfter);
    const changed = diffCount(fa, fb, { x0: 0, y0: 0, x1: fa.info.width, y1: fa.info.height });
    check(A, "the preview globe follows live", changed > 50, `${changed} px changed`);
    // Further in: B lies wholly inside A, so its whole outline is dashed.
    [x, y] = await ed.xy(116, -47);
    await mdrag(x, y, -8 * K, 0);
    s = await ed.state();
    await page.keyboard.press("Escape");
    img = await canvasImg();
    const [w, so, e, n] = partBox(s, 1);
    const sides = [
      await edgeProfile(img, [w + 1, so], [e - 1, so], "#00e5ff"),
      await edgeProfile(img, [e, so + 1], [e, n - 1], "#00e5ff"),
      await edgeProfile(img, [e - 1, n], [w + 1, n], "#00e5ff"),
      await edgeProfile(img, [w, n - 1], [w, so + 1], "#00e5ff"),
    ];
    check(A, "a part inside another has its whole outline dashed", sides.every(isDashed), sides.map(fmt).join(" | "));
    await page.screenshot({ path: path.join(OUT, "editor-inside.png") });

    // Alt+click cycles through the parts under the pointer.
    [x, y] = await ed.xy((w + e) / 2, (so + n) / 2);
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
    check(A, "click picks the topmost part; Alt+click cycles", top === 1 && next === 0 && back === 1, `${top} → ${next} → ${back}`);
    check(A, "status line says which of the parts here", /Part 1 \(2 of 2 here, Alt\+click for the next\)/.test(hint), hint);

    // Arrow keys nudge the selected part.
    const s0 = await ed.state();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Shift+ArrowUp");
    const s1 = await ed.state();
    check(A, "arrow keys nudge the selected part only", JSON.stringify(moved(partBox(s0, 1), partBox(s1, 1))) === JSON.stringify([r4(1 / K), r4(10 / KY), r4(1 / K), r4(10 / KY)]) && JSON.stringify(s1.parts[0]) === JSON.stringify(s0.parts[0]), JSON.stringify(moved(partBox(s0, 1), partBox(s1, 1))));

    // Ctrl+drag moves the whole region.
    [x, y] = await ed.xy(102, -52);
    await mdrag(x, y, 2 * K, 0, ["Control"]);
    const s2 = await ed.state();
    check(A, "Ctrl+drag moves the whole region", [0, 1, 2, 3].every((p) => JSON.stringify(moved(partBox(s1, p), partBox(s2, p))) === "[2,0,2,0]"), [0, 1, 2, 3].map((p) => JSON.stringify(moved(partBox(s1, p), partBox(s2, p)))).join(" "));

    // With "Move contested zones with their part" on, a part takes its zones along.
    await page.check('dialog.editor input[name="zones-follow"]');
    [x, y] = await ed.xy(104, -52);
    await mdrag(x, y, 0, -KY);
    const s3 = await ed.state();
    check(A, "with the checkbox on, a part's zones move with it", JSON.stringify(moved(partBox(s2, 0), partBox(s3, 0))) === "[0,1,0,1]" && JSON.stringify(moved(partBox(s2, 2), partBox(s3, 2))) === "[0,1,0,1]" && JSON.stringify(s3.parts[1]) === JSON.stringify(s2.parts[1]), JSON.stringify(moved(partBox(s2, 2), partBox(s3, 2))));
    await page.uncheck('dialog.editor input[name="zones-follow"]');
    final = s3;
  });

  await step(A, "undo/redo and save", async () => {
    await page.click("dialog.editor canvas.ed-canvas", { position: { x: 3, y: 3 }, button: "middle" });
    let undos = 0;
    while (!(await page.isDisabled('dialog.editor [data-act="undo"]')) && undos < 60) {
      await page.keyboard.press("Control+z");
      undos++;
    }
    let s = await ed.state();
    check(A, "undo all of it back to the start", JSON.stringify(s) === JSON.stringify(start), `${undos} steps`);
    let redos = 0;
    while (!(await page.isDisabled('dialog.editor [data-act="redo"]')) && redos < 60) {
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
    check(A, "saved with the right partContested", JSON.stringify(f.properties.partContested) === "[-1,-1,0,1]", JSON.stringify(f.properties.partContested));
    check(A, "main untouched", mock.refs.get("main") === mainAtStart);
    await page.screenshot({ path: path.join(OUT, "editor-saved.png") });
  });
  await step(A, "delete a whole part (always asks first)", async () => {
    const warn = "dialog.small-dlg.danger[open]";
    const s0 = await ed.state();
    // Parts list button, cancelled: nothing changes.
    await page.click('dialog.editor .ed-part-row[data-row="3"] [data-act="part-delete"]');
    await page.waitForSelector(warn);
    const text = await page.textContent(`${warn} .dlg-body`);
    check(A, "Delete in the Parts list shows a warning first", /This deletes Part 4 with all \d+ of its vertices/.test(text) && /undo/i.test(text), text);
    await page.click(`${warn} button:has-text("Keep it")`);
    await page.waitForTimeout(150);
    check(A, "'Keep it' leaves the region as it was", JSON.stringify(await ed.state()) === JSON.stringify(s0));
    // Confirmed: part 4 (a zone of part 2) goes, the rest keep their colours, labels and zones.
    await page.click('dialog.editor .ed-part-row[data-row="3"] [data-act="part-delete"]');
    await page.click(`${warn} button:has-text("Delete part")`);
    await page.waitForTimeout(150);
    const s1 = await ed.state();
    check(A, "'Delete part' removes the whole part", s1.parts.length === 3 && JSON.stringify(s1.parts) === JSON.stringify(s0.parts.slice(0, 3)) && JSON.stringify(s1.contested) === "[-1,-1,0]" && JSON.stringify(s1.labels) === JSON.stringify(s0.labels.slice(0, 3)), JSON.stringify(s1.contested));
    // Right-click inside part 1 (which has a zone): menu → warning names the zone → confirm.
    await page.click('dialog.editor .ed-part-row[data-row="0"] [data-act="part-select"]');
    const b = partBox(s1, 0);
    const [x, y] = await ed.xy((b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
    await page.mouse.click(x, y, { button: "right" });
    const item = await page.textContent("dialog.editor .ed-menu:not([hidden]) button");
    check(A, "right-click inside a part offers 'Delete part 1…'", item === "Delete part 1…", item);
    await page.click("dialog.editor .ed-menu button");
    await page.waitForSelector(warn);
    await page.screenshot({ path: path.join(OUT, "editor-delete-warning.png") });
    const text2 = await page.textContent(`${warn} .dlg-body`);
    check(A, "the warning says its contested zone becomes a normal part", /contested zone stays and becomes a normal part/.test(text2), text2);
    await page.click(`${warn} button:has-text("Delete part")`);
    await page.waitForTimeout(150);
    const s2 = await ed.state();
    check(A, "deleting a parent keeps its zone as a normal part", s2.parts.length === 2 && JSON.stringify(s2.contested) === "[-1,-1]" && JSON.stringify(s2.parts) === JSON.stringify(s1.parts.slice(1)), JSON.stringify(s2.contested));
    // Delete key on a selected part also asks; Esc keeps it.
    await page.click('dialog.editor .ed-part-row[data-row="0"] [data-act="part-select"]');
    await page.focus("dialog.editor canvas.ed-canvas");
    await page.keyboard.press("Delete");
    await page.waitForSelector(warn);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    check(A, "Delete key on a selected part asks, Esc keeps it", JSON.stringify(await ed.state()) === JSON.stringify(s2) && (await page.locator(warn).count()) === 0);
    // Undo brings both parts back.
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+z");
    check(A, "undo brings deleted parts back", JSON.stringify(await ed.state()) === JSON.stringify(s0));
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
