/**
 * Browser checks for regions, in headless Chromium (system Playwright, like `npm run measure`).
 *
 *   npm run e2e:regions
 *
 * 1. Builds a throwaway copy of the repo with test content (scripts/e2e/fixture.mjs), with the admin
 *    page pointed at the branch test/region-overlays.
 * 2. Embeds: loads region embeds in a cross-origin iframe and checks rendering, the label, the lock,
 *    the motion model, the fallback for unknown ids, and that view=flat never loads Three.js.
 * 3. Admin page: drives the Regions tab and the editor against an in-memory GitHub API and checks
 *    every commit (exactly one per action, on the configured branch, nothing on main).
 * 4. Alignment: screenshots of a landmark region on a padded, shifted globe, the flat view and the editor.
 *
 * Screenshots and report.json go to .e2e/regions/. Exits non-zero if any check fails.
 */
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { makeFixture, PROVINCES, SLOT } from "./fixture.mjs";
import { MockGitHub } from "./mock-github.mjs";
import { checkGeometry } from "../../src/shared/geo.ts";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const sharp = require("sharp");

const OUT = path.resolve(".e2e/regions");
const BRANCH = "test/region-overlays";
const SITE = "http://localhost:4173";
const HOST = "http://127.0.0.1:4180";
await mkdir(OUT, { recursive: true });
// E2E_ONLY=embed,admin,alignment runs some groups only (for debugging).
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

/* ── Build the fixture ── */
const dir = await makeFixture({ quiet: true });
execFileSync("npm", ["run", "build"], { cwd: dir, env: { ...process.env, VITE_CONTENT_BRANCH: BRANCH }, stdio: "pipe" });
if (process.env.E2E_PROFILE) {
  const env = { ...process.env, VITE_CONTENT_BRANCH: BRANCH };
  execFileSync("npx", ["vite", "build", "--minify", "false"], { cwd: dir, env, stdio: "pipe" });
  execFileSync("npx", ["tsx", "scripts/generate-pages.ts"], { cwd: dir, env, stdio: "pipe" });
}
const DIST = path.join(dir, "dist");
console.log(`Fixture: ${dir}`);

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".json": "application/json", ".txt": "text/plain" };
const site = createServer(async (req, res) => {
  let p = path.join(DIST, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (existsSync(p) && statSync(p).isDirectory()) p = path.join(p, "index.html");
  if (!p.startsWith(DIST) || !existsSync(p)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] ?? "application/octet-stream", "Cache-Control": "no-store" });
  res.end(await readFile(p));
}).listen(4173, "localhost");
// Host page on another origin, tall enough to scroll, with the embed in the middle (like an Obsidian note).
const host = createServer((req, res) => {
  const src = new URL(req.url, "http://x").searchParams.get("src") ?? "";
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<!doctype html><html><body style="margin:0;background:#202020;font:14px system-ui;color:#ddd">
<p style="padding:8px;height:300px">Host page on another origin (stand-in for Obsidian Publish)</p>
<iframe id="embed" src="${SITE}/${src.replace(/"/g, "")}" width="800" height="480" style="border:0;border-radius:8px;background:transparent;display:block;margin-left:40px" allow="fullscreen" title="region"></iframe>
<div style="height:2400px"></div></body></html>`);
}).listen(4180, "127.0.0.1");

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--disable-features=IsolateOrigins,site-per-process"],
});

/* ═════════════ 1. Embeds ═════════════ */

async function openEmbed(query, { touch = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 1, hasTouch: touch });
  const page = await ctx.newPage();
  const errors = [];
  const requests = [];
  const dialogs = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("dialog", (d) => (dialogs.push(d.message()), d.dismiss()));
  ctx.on("request", (r) => requests.push(r.url()));
  await page.goto(`${HOST}/?src=${encodeURIComponent(query)}`);
  const frame = page.frames().find((f) => f.url().startsWith(SITE));
  await frame.waitForFunction(() => ["hires", "fallback"].includes(document.documentElement.dataset.state), null, { timeout: 30000 });
  await page.waitForTimeout(300);
  const box = await page.locator("#embed").boundingBox();
  return { ctx, page, frame, errors, requests, dialogs, box };
}
// Mouse off the embed first, so a hovered button doesn't count as a change in the view.
// Parent page back at the top too: an element screenshot inside a scrolled-away iframe is clipped wrongly.
const canvasShot = async (e) => {
  await e.page.evaluate(() => scrollTo(0, 0));
  await e.page.mouse.move(2, 2);
  // …and no focused button: the controls brighten while focused, which isn't a change in the view.
  await e.frame.evaluate(() => document.activeElement?.blur());
  await e.page.waitForTimeout(300);
  return e.frame.locator("#globe").screenshot();
};
const same = (a, b) => Buffer.compare(a, b) === 0;
async function drag(e, dx, dy) {
  const x = e.box.x + e.box.width / 2;
  const y = e.box.y + e.box.height / 2;
  await e.page.mouse.move(x, y);
  await e.page.mouse.down();
  for (let i = 1; i <= 8; i++) await e.page.mouse.move(x + (dx * i) / 8, y + (dy * i) / 8);
  await e.page.mouse.up();
  await e.page.waitForTimeout(150);
}
async function wheel(e, dy) {
  await e.page.mouse.move(e.box.x + e.box.width / 2, e.box.y + e.box.height / 2);
  await e.page.mouse.wheel(0, dy);
  await e.page.waitForTimeout(250);
}
async function pinch(e) {
  const cdp = await e.ctx.newCDPSession(e.page);
  const cx = e.box.x + e.box.width / 2;
  const cy = e.box.y + e.box.height / 2;
  const pts = (d) => [{ x: cx - d, y: cy, id: 1 }, { x: cx + d, y: cy, id: 2 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts(30) });
  for (let d = 40; d <= 120; d += 10) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pts(d) });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await e.page.waitForTimeout(250);
  // A pinch the embed lets through zooms the host page; note it, then reset so screenshots line up.
  const pageScale = await e.page.evaluate(() => visualViewport.scale);
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
  await e.page.waitForTimeout(150);
  return pageScale;
}
const pressed = (e) => e.frame.getAttribute("#btn-lock", "aria-pressed");
const scrollY = (e) => e.page.evaluate(() => scrollY);

for (const view of want("embed") ? ["globe", "flat"] : []) {
  const G = `embed ${view}`;
  const q = `v/${SLOT.slug}/?region=landmark-disc${view === "flat" ? "&view=flat" : ""}`;

  await step(G, "renders, auto-centres, label", async () => {
    const e = await openEmbed(q);
    check(G, "loads without errors", e.errors.length === 0, e.errors.join(" | ") || "no errors");
    const lbl = await e.frame.evaluate(() => {
      const l = document.querySelector(".rlabel");
      const r = l?.getBoundingClientRect();
      return l && { hidden: l.hidden, text: l.textContent, cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: innerWidth, h: innerHeight };
    });
    check(G, "label shows the region name", lbl && !lbl.hidden && lbl.text === "Magenta Isle", JSON.stringify(lbl?.text));
    check(G, "auto-centred (label at the view centre ±4 px)", lbl && Math.abs(lbl.cx - lbl.w / 2) <= 4 && Math.abs(lbl.cy - lbl.h / 2) <= 4, lbl && `${(lbl.cx - lbl.w / 2).toFixed(1)}, ${(lbl.cy - lbl.h / 2).toFixed(1)} px`);
    await e.page.screenshot({ path: path.join(OUT, `embed-${view}.png`), clip: { x: e.box.x, y: e.box.y, width: e.box.width, height: e.box.height } });
    if (view === "flat") {
      const three = e.requests.filter((u) => /assets\/globe-/.test(u));
      check(G, "view=flat loads no Three.js chunk", three.length === 0, `${e.requests.filter((u) => u.includes("/assets/")).map((u) => u.split("/").pop()).join(", ")}`);
    } else check(G, "globe view loads the globe chunk", e.requests.some((u) => /assets\/globe-/.test(u)));
    check(G, "fetched regions/landmark-disc.json", e.requests.some((u) => u.endsWith("/regions/landmark-disc.json")));
    await e.ctx.close();
  });

  await step(G, "label off", async () => {
    const e = await openEmbed(`${q}&label=0`);
    const hidden = await e.frame.evaluate(() => document.querySelector(".rlabel")?.hidden ?? true);
    check(G, "label=0 hides the label", hidden);
    await e.ctx.close();
  });

  await step(G, "view lock", async () => {
    const e = await openEmbed(q, { touch: true });
    check(G, "fresh load is locked", (await pressed(e)) === "true");
    const ta = await e.frame.evaluate(() => getComputedStyle(document.getElementById("globe")).touchAction);
    check(G, "canvas lets touch through while locked (touch-action: auto)", ta === "auto", ta);
    const base = await canvasShot(e);
    await drag(e, 160, 60);
    check(G, "locked: drag leaves the view pixel-identical", same(base, await canvasShot(e)));
    const y0 = await scrollY(e);
    await wheel(e, 400);
    const y1 = await scrollY(e);
    check(G, "locked: wheel over the embed scrolls the parent page", y1 > y0, `scrollY ${y0} → ${y1}`);
    // Scroll back before comparing: a screenshot of a half-scrolled-away iframe would differ anyway.
    await e.page.evaluate(() => scrollTo(0, 0));
    await e.page.waitForTimeout(200);
    check(G, "locked: wheel leaves the view pixel-identical", same(base, await canvasShot(e)));
    e.box = await e.page.locator("#embed").boundingBox();
    const pageScale = await pinch(e);
    check(G, "locked: pinch leaves the view pixel-identical", same(base, await canvasShot(e)));
    check(G, "locked: pinch over the embed zooms the host page instead", pageScale > 1, `host page scale ${pageScale.toFixed(2)}`);
    await e.page.evaluate(() => scrollTo(0, 0));
    await e.page.waitForTimeout(150);
    e.box = await e.page.locator("#embed").boundingBox();

    await e.frame.click("#btn-lock");
    check(G, "padlock unlocks (aria-pressed=false, label 'Lock view')", (await pressed(e)) === "false" && (await e.frame.getAttribute("#btn-lock", "aria-label")) === "Lock view");
    const ta2 = await e.frame.evaluate(() => getComputedStyle(document.getElementById("globe")).touchAction);
    check(G, "unlocked: canvas takes touch (touch-action: none)", ta2 === "none", ta2);
    await drag(e, 160, 60);
    const afterDrag = await canvasShot(e);
    check(G, "unlocked: drag moves the view", !same(base, afterDrag));
    await e.page.waitForTimeout(1500);
    check(G, "no drift after release (1.5 s)", same(afterDrag, await canvasShot(e)));
    const y2 = await scrollY(e);
    // Zoom out: the region is already fitted close in, possibly at the zoom-in limit.
    await wheel(e, 300);
    const y3 = await scrollY(e);
    const afterWheel = await canvasShot(e);
    check(G, "unlocked: wheel zooms", !same(afterDrag, afterWheel));
    check(G, "unlocked: wheel doesn't scroll the page", y3 === y2, `scrollY ${y2} → ${y3}`);
    await e.page.waitForTimeout(1200);
    check(G, "no drift after zoom (1.2 s)", same(afterWheel, await canvasShot(e)));

    await e.frame.click("#btn-lock");
    await e.page.waitForTimeout(500);
    const relocked = await canvasShot(e);
    if (!same(base, relocked)) {
      await writeFile(path.join(OUT, `debug-${view}-relock.png`), relocked);
      await writeFile(path.join(OUT, `debug-${view}-base.png`), base);
    }
    check(G, "re-lock returns to the selected position (pixel-identical)", (await pressed(e)) === "true" && same(base, relocked));

    // Unlock, move, then a bfcache-style restore: locked on the selected position again.
    await e.frame.click("#btn-lock");
    await drag(e, -120, 40);
    await e.frame.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await e.page.waitForTimeout(300);
    check(G, "pageshow persisted → locked on the selected position", (await pressed(e)) === "true" && same(base, await canvasShot(e)));

    const stored = await e.frame.evaluate(() => ({ ls: localStorage.length, ss: sessionStorage.length, url: location.href }));
    check(G, "nothing persisted (storage empty, URL unchanged)", stored.ls === 0 && stored.ss === 0 && stored.url.endsWith(q.replace(`v/${SLOT.slug}/`, "")), JSON.stringify(stored));
    await e.frame.click("#btn-lock");
    await e.page.reload();
    e.frame = e.page.frames().find((f) => f.url().startsWith(SITE));
    await e.frame.waitForFunction(() => document.documentElement.dataset.state === "hires", null, { timeout: 30000 });
    check(G, "reload starts locked again", (await pressed(e)) === "true");
    check(G, "no errors during the lock checks", e.errors.length === 0, e.errors.join(" | "));
    await e.ctx.close();
  });

  await step(G, "lock=0", async () => {
    const e = await openEmbed(`${q}&lock=0`);
    check(G, "lock=0 starts unlocked, padlock still shown", (await pressed(e)) === "false" && (await e.frame.isVisible("#btn-lock")));
    const a = await canvasShot(e);
    await drag(e, 100, 0);
    check(G, "lock=0: drag moves the view", !same(a, await canvasShot(e)));
    await e.ctx.close();
  });

  await step(G, "controls=0 keeps the padlock", async () => {
    const e = await openEmbed(`${q}&controls=0`);
    const vis = await e.frame.evaluate(() => ["btn-lock", "btn-grid", "btn-fs", "btn-view"].map((id) => document.getElementById(id).checkVisibility()));
    check(G, "controls=0: only the padlock is visible", JSON.stringify(vis) === "[true,false,false,false]", JSON.stringify(vis));
    await e.ctx.close();
  });

  await step(G, "unknown region", async () => {
    const e = await openEmbed(`v/${SLOT.slug}/?region=no-such-region${view === "flat" ? "&view=flat" : ""}`);
    const note = await e.frame.evaluate(() => document.querySelector(".rnote")?.textContent);
    check(G, "unknown id: normal map + 'Region not found' note, no errors", note === "Region not found" && e.errors.length === 0 && !(await e.frame.isVisible("#btn-lock")), `${note}; ${e.errors.join(" | ")}`);
    await e.page.screenshot({ path: path.join(OUT, `embed-${view}-unknown.png`), clip: { x: e.box.x, y: e.box.y, width: e.box.width, height: e.box.height } });
    await e.ctx.close();
  });

  await step(G, "antimeridian region", async () => {
    const e = await openEmbed(`v/${SLOT.slug}/?region=dateline-box${view === "flat" ? "&view=flat" : ""}`);
    await e.page.screenshot({ path: path.join(OUT, `embed-${view}-dateline.png`), clip: { x: e.box.x, y: e.box.y, width: e.box.width, height: e.box.height } });
    check(G, "region across ±180° renders without errors", e.errors.length === 0, e.errors.join(" | "));
    await e.ctx.close();
  });

  await step(G, "colours and legend", async () => {
    const pq = `v/${SLOT.slug}/?region=provinces${view === "flat" ? "&view=flat" : ""}`;
    const e = await openEmbed(pq);
    const key = await e.frame.evaluate(() => {
      const k = document.querySelector(".rkey");
      return k && {
        visible: k.checkVisibility(),
        head: k.querySelector(".rkey-head").textContent,
        rows: [...k.querySelectorAll("li")].map((li) => [getComputedStyle(li.querySelector("i")).backgroundColor, li.textContent]),
        imgs: document.images.length,
      };
    });
    const rgb = (h) => `rgb(${parseInt(h.slice(1, 3), 16)}, ${parseInt(h.slice(3, 5), 16)}, ${parseInt(h.slice(5, 7), 16)})`;
    check(G, "legend shows its title and one row per legend colour", key?.visible && key.head === "Provinces" && key.rows.length === 2, JSON.stringify(key));
    check(G, "legend swatches use the legend colours", key && key.rows[0][0] === rgb(PROVINCES.colours[1]) && key.rows[1][0] === rgb(PROVINCES.colours[2]), JSON.stringify(key?.rows));
    check(G, "hostile legend label is plain text, nothing runs", key && key.rows[1][1] === "<img src=x onerror=alert(3)>" && key.imgs === 0 && e.dialogs.length === 0);
    // Each part is drawn in its own colour: count pixels close to each colour in the embed.
    const shot = await canvasShot(e);
    const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
    const counts = PROVINCES.colours.map((c) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
      let n = 0;
      for (let i = 0; i < data.length; i += info.channels) if (Math.abs(data[i] - r) + Math.abs(data[i + 1] - g) + Math.abs(data[i + 2] - b) < 90) n++;
      return n;
    });
    await e.page.screenshot({ path: path.join(OUT, `embed-${view}-legend.png`), clip: { x: e.box.x, y: e.box.y, width: e.box.width, height: e.box.height } });
    const lbls = await e.frame.evaluate(() => [...document.querySelectorAll(".rlabel")].filter((l) => !l.hidden).map((l) => l.textContent));
    check(G, "each labelled part shows its own label (and the unlabelled one none)", JSON.stringify(lbls) === '["Red Reach","Blue Coast"]', JSON.stringify(lbls));
    check(G, "every part is drawn in its own colour", counts.every((n) => n > 200), counts.join(" / ") + " px");
    await e.frame.click(".rkey-head");
    const folded = await e.frame.evaluate(() => ({ exp: document.querySelector(".rkey-head").getAttribute("aria-expanded"), list: document.querySelector(".rkey ul").checkVisibility() }));
    check(G, "legend folds away from its header", folded.exp === "false" && !folded.list, JSON.stringify(folded));
    await e.frame.click(".rkey-head");
    check(G, "and unfolds again", (await e.frame.getAttribute(".rkey-head", "aria-expanded")) === "true" && (await e.frame.isVisible(".rkey li")));
    check(G, "no errors with the legend", e.errors.length === 0, e.errors.join(" | "));
    await e.ctx.close();
    const e2 = await openEmbed(`${pq}&key=0`);
    check(G, "key=0 hides the legend", !(await e2.frame.evaluate(() => document.querySelector(".rkey")?.checkVisibility() ?? false)));
    await e2.ctx.close();
    const e3 = await openEmbed(q);
    check(G, "a region without a legend shows none", !(await e3.frame.evaluate(() => document.querySelector(".rkey")?.checkVisibility() ?? false)));
    await e3.ctx.close();
  });

  await step(G, "hostile name stays text", async () => {
    const e = await openEmbed(`v/${SLOT.slug}/?region=evil-name${view === "flat" ? "&view=flat" : ""}`);
    const t = await e.frame.evaluate(() => ({ label: document.querySelector(".rlabel")?.textContent, scripts: document.scripts.length, imgs: document.images.length }));
    check(G, "malicious name is shown as text, nothing runs", t.label === '"><script>alert(1)</script>' && e.dialogs.length === 0 && t.imgs === 0, JSON.stringify({ ...t, dialogs: e.dialogs }));
    await e.ctx.close();
  });
}

if (want("embed")) await step("embed globe", "plain slot embed unchanged (spins, no lock)", async () => {
  const e = await openEmbed("v/inara/");
  const a = await canvasShot(e);
  await e.page.waitForTimeout(600);
  const b = await canvasShot(e);
  check("embed globe", "plain slot still auto-spins and has no padlock", !same(a, b) && !(await e.frame.isVisible("#btn-lock")));
  await drag(e, 80, 0);
  const c = await canvasShot(e);
  await e.page.waitForTimeout(1200);
  check("embed globe", "plain slot: first drag stops the spin for good", same(c, await canvasShot(e)));
  await e.ctx.close();
});

/* ═════════════ 2. Admin page against a mocked GitHub API ═════════════ */

const A = "admin";
const mock = new MockGitHub({ root: dir });
const mainAtStart = mock.refs.get("main");
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: SITE });
await ctx.addInitScript(() => {
  window.__csp = [];
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
});
const leaks = [];
ctx.on("request", (r) => {
  const auth = r.headers()["authorization"];
  if (auth && !r.url().startsWith("https://api.github.com/")) leaks.push(r.url());
});
await ctx.route("https://api.github.com/**", (r) => mock.handle(r));
const page = await ctx.newPage();
const errors = [];
const dialogs = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && !/^Failed to load resource/.test(m.text()) && errors.push(m.text()));
page.on("response", (r) => r.status() >= 400 && !r.url().startsWith("https://api.github.com/") && errors.push(`${r.status()} ${r.url()}`));
page.on("dialog", (d) => (dialogs.push(d.message()), d.dismiss()));

const commitsSince = (n) => mock.log.slice(n);
const waitCommits = async (n, count = 1) => {
  const t0 = Date.now();
  while (mock.log.length < n + count && Date.now() - t0 < 15000) await page.waitForTimeout(100);
  await page.waitForTimeout(400);
};
const ed = {
  state: () => page.evaluate(() => document.querySelector("dialog.editor").wgeEditor.state()),
  id: () => page.evaluate(() => document.querySelector("dialog.editor").wgeEditor.id()),
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
const verts = (s) => s.parts.reduce((n, rings) => n + rings.reduce((m, r) => m + r.length, 0), 0);
async function mdrag(x, y, dx, dy, mods = []) {
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(x + (dx * i) / 6, y + (dy * i) / 6);
  await page.mouse.up();
  for (const m of mods) await page.keyboard.up(m);
  await page.waitForTimeout(80);
}

await step(A, "sign in and Regions tab", async () => {
  await page.goto(`${SITE}/admin/#regions`);
  await page.fill("#token", "ghp_e2etoken");
  await page.click('#signin-form button[type="submit"]');
  await page.waitForSelector("#regions .rcard", { timeout: 15000 });
  await page.waitForTimeout(800);
  check(A, "shows the target branch", (await page.textContent("#branch")) === `Writing to branch ${BRANCH} (not main)` && (await page.isVisible("#branch")), await page.textContent("#branch"));
  check(A, "Regions tab selected from #regions", (await page.isVisible("#tab-regions")) && !(await page.isVisible("#tab-maps")));
  const n = await page.locator("#regions .rcard").count();
  check(A, "lists every region", n === 6, `${n} cards`);
  check(A, "'drawn on a different map' badge", (await page.locator('[data-region="old-map-region"] .badge.warn').textContent()) === "drawn on a different map");
  const evil = await page.locator('[data-region="evil-name"] .rlabels').textContent();
  check(A, "hostile name shown as plain text", evil === '"><script>alert(1)</script>' && dialogs.length === 0);
  check(A, "cards are titled by id, with no Rename button", (await page.locator('[data-region="evil-name"] .rname').textContent()) === "evil-name" && (await page.locator('[data-action="rename"]').count()) === 0);
  await page.fill("#r-search", "dateline");
  check(A, "search filters by id/labels", (await page.locator("#regions .rcard").count()) === 1);
  await page.fill("#r-search", "");
  await page.selectOption("#r-slot", "inara");
  check(A, "slot filter", (await page.locator("#regions .rcard").count()) === 1);
  await page.selectOption("#r-slot", "");
  await page.selectOption("#r-sort", "updated");
  await page.selectOption("#r-sort", "name");
  const names = await page.locator("#regions .rname").allTextContents();
  check(A, "sort by id", JSON.stringify(names) === JSON.stringify([...names].sort((a, b) => a.localeCompare(b))), names.join(", "));
  await page.screenshot({ path: path.join(OUT, "admin-regions-tab.png"), fullPage: true });
  await page.reload();
  await page.waitForSelector("#regions .rcard", { timeout: 15000 });
  check(A, "reload stays on the Regions tab", await page.isVisible("#tab-regions"));
  await page.click("#tab-btn-maps");
  check(A, "Maps & slots tab still there, hash cleared", (await page.isVisible("#tab-maps")) && !page.url().includes("#regions"));
  await page.click("#tab-btn-regions");
});

let finalState = null;
const n0 = mock.log.length;
await step(A, "editor: draw and edit", async () => {
  await page.selectOption("#r-new-slot", SLOT.slug);
  await page.locator(".r-new-row .r-new").click();
  await page.waitForSelector("dialog.editor[open]");
  await page.waitForTimeout(500);
  check(A, "no Name field; a new region gets a free id to start with", (await page.locator('dialog.editor input[name="name"]').count()) === 0 && (await ed.id()) === "region");
  await page.fill('dialog.editor input[name="id"]', "Test Kingdom");
  await page.locator('dialog.editor input[name="id"]').dispatchEvent("change");
  check(A, "the id field turns what's typed into a valid id", (await ed.id()) === "test-kingdom", await ed.id());
  await page.click("dialog.editor canvas.ed-canvas", { position: { x: 5, y: 5 }, button: "middle" });
  await ed.setView(180, 0, 22);
  const startTool = await page.getAttribute("dialog.editor button.tool[aria-pressed=true]", "data-tool").catch(() => null);
  check(A, "a new region starts on the freehand tool", startTool === "freehand", String(startTool));
  await page.click('dialog.editor [data-tool="polygon"]');
  // Polygon across the antimeridian: 172°E → 172°W.
  const pts = [[172, -6], [188, -6], [188, 6], [172, 6]];
  for (const [lon, lat] of pts) {
    const [x, y] = await ed.xy(lon, lat);
    await page.mouse.click(x, y);
  }
  const [fx, fy] = await ed.xy(172, -6);
  await page.mouse.click(fx, fy);
  let s = await ed.state();
  check(A, "draw a polygon (click points, click the first to close)", s.parts.length === 1 && verts(s) === 4, `${s.parts.length} part, ${verts(s)} vertices`);

  let [x, y] = await ed.xy(172, -6);
  await mdrag(x, y, 30, 20);
  s = await ed.state();
  const v0 = s.parts[0][0][0];
  check(A, "drag a vertex", Math.abs(v0[0] - (172 + 30 / 22)) < 0.05 && v0[1] < -6, JSON.stringify(v0));

  const a = s.parts[0][0][0];
  const b = s.parts[0][0][1];
  [x, y] = await ed.xy((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
  await mdrag(x, y, 0, 25);
  s = await ed.state();
  check(A, "insert a vertex by dragging a midpoint", verts(s) === 5, `${verts(s)} vertices`);

  const ins = s.parts[0][0][1];
  [x, y] = await ed.xy(ins[0], ins[1]);
  await page.keyboard.down("Alt");
  await page.mouse.click(x, y);
  await page.keyboard.up("Alt");
  s = await ed.state();
  check(A, "delete a vertex (Alt+click)", verts(s) === 4, `${verts(s)} vertices`);

  const before = s.parts[0][0].map((p) => p[0]);
  // A new drawing starts locked: the drag is refused until the part is unlocked.
  [x, y] = await ed.xy(180, 0);
  await mdrag(x, y, -44, 0);
  s = await ed.state();
  check(A, "a new part starts locked: dragging inside it doesn't move it", s.locked[0] === true && s.parts[0][0].every((p, i) => p[0] === before[i]), JSON.stringify(s.locked));
  await page.click('dialog.editor [data-act="part-lock"]');
  await mdrag(x, y, -44, 0);
  s = await ed.state();
  const moved = s.parts[0][0].map((p, i) => p[0] - before[i]);
  check(A, "move the whole shape (drag inside the fill)", moved.every((d) => Math.abs(d + 2) < 0.05), moved.map((d) => d.toFixed(2)).join(", "));

  // Refused drop: drag a vertex across the opposite edge.
  const c0 = s.parts[0][0][0];
  [x, y] = await ed.xy(c0[0], c0[1]);
  // Past the far side of the right-hand edge: the left edge would then cross it.
  const r0 = s.parts[0][0];
  const [tx, ty] = await ed.xy(r0[1][0] + 3, (r0[1][1] + r0[2][1]) / 2);
  await mdrag(x, y, tx - x, ty - y);
  const s2 = await ed.state();
  check(A, "a drag that would cross the outline is refused (snaps back)", JSON.stringify(s2.parts) === JSON.stringify(s.parts) && /cross itself/.test(await ed.msg()), await ed.msg());

  await page.click('dialog.editor [data-act="smooth"]');
  await page.click('dialog.editor [data-act="smooth"]');
  s = await ed.state();
  check(A, "smooth (Chaikin, one pass per click)", verts(s) === 16, `${verts(s)} vertices`);
  await page.click('dialog.editor [data-act="simplify"]');
  await page.locator("dialog.editor .ed-simplify:not(.ed-combine) input[type=range]").fill("85");
  const info = await page.textContent("dialog.editor .ed-simplify:not(.ed-combine) span");
  await page.click('dialog.editor [data-act="simplify-apply"]');
  s = await ed.state();
  check(A, "simplify (slider preview with counts, then Apply)", verts(s) < 16 && verts(s) >= 3 && /16 → \d+ vertices/.test(info), `${info}; now ${verts(s)}`);
  await page.click('dialog.editor [data-act="smooth"]');
  await page.evaluate(() => {
    const c = document.querySelector('dialog.editor input[name="color"]');
    c.value = "#2e86de";
    c.dispatchEvent(new Event("input", { bubbles: true }));
  });
  finalState = await ed.state();

  // Undo everything (keyboard), then redo everything.
  await page.click("dialog.editor canvas.ed-canvas", { position: { x: 3, y: 3 }, button: "middle" });
  let undos = 0;
  while (!(await page.isDisabled('dialog.editor [data-act="undo"]')) && undos < 50) {
    await page.keyboard.press("Control+z");
    undos++;
  }
  s = await ed.state();
  check(A, "undo all the way back to the start", s.parts.length === 0 && s.props.color === "#c0392b", `${undos} steps; ${s.parts.length} parts`);
  let redos = 0;
  while (!(await page.isDisabled('dialog.editor [data-act="redo"]')) && redos < 50) {
    await page.keyboard.press(redos % 2 ? "Control+y" : "Control+Shift+z");
    redos++;
  }
  s = await ed.state();
  check(A, "redo all of it (Ctrl+Shift+Z / Ctrl+Y)", JSON.stringify(s) === JSON.stringify(finalState) && redos === undos, `${redos} steps`);
  await page.screenshot({ path: path.join(OUT, "editor-new-region.png") });
});

await step(A, "editor: save", async () => {
  const n = mock.log.length;
  await page.click("dialog.editor .ed-save");
  await waitCommits(n);
  const c = commitsSince(n);
  check(A, "save is exactly one commit", c.length === 1, c.map((x) => x.message).join(" | ") || `editor says: ${await ed.msg()}; last requests: ${mock.requests.slice(-4).join(", ")}`);
  check(A, "…on the configured branch", c[0]?.branch === BRANCH, c[0]?.branch);
  check(A, "…touching only content/regions/test-kingdom.json", JSON.stringify(c[0]?.changes) === JSON.stringify([{ path: "content/regions/test-kingdom.json", deleted: false }]), JSON.stringify(c[0]?.changes));
  check(A, "…with the message from the brief", c[0]?.message === "Save region test-kingdom", c[0]?.message);
  const f = JSON.parse(mock.read(BRANCH, "content/regions/test-kingdom.json"));
  const lons = f.geometry.coordinates[0].map((p) => p[0]);
  const errs = checkGeometry(f.geometry);
  check(A, "saved file is valid and crosses the antimeridian", errs.length === 0 && lons.some((l) => l > 170) && lons.some((l) => l < -170) && f.id === "test-kingdom" && f.properties.slot === SLOT.slug, `${errs.join("; ")} lons ${Math.min(...lons)}..${Math.max(...lons)}`);
  check(A, "coordinates rounded to 4 decimals", f.geometry.coordinates[0].flat().every((v) => Math.round(v * 1e4) / 1e4 === v));
  check(A, "editor says it saved", /Saved in commit/.test(await ed.msg()), await ed.msg());
  // Unsaved-changes warning, and none once undone back to the saved state.
  await page.evaluate(() => {
    const c = document.querySelector('dialog.editor input[name="color"]');
    c.value = "#00ff00";
    c.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.click("dialog.editor .pv-head button.ghost");
  const warn = await page.locator("dialog.small-dlg h2").textContent({ timeout: 3000 });
  check(A, "closing with unsaved changes asks first", warn === "Unsaved changes");
  await page.click('dialog.small-dlg button:has-text("Keep editing")');
  await page.click("dialog.editor canvas.ed-canvas", { position: { x: 3, y: 3 }, button: "middle" });
  await page.keyboard.press("Control+z");
  await page.click("dialog.editor .pv-head button.ghost");
  await page.waitForTimeout(300);
  check(A, "no prompt when nothing is unsaved; editor closes", !(await page.isVisible("dialog.editor")));
  await page.waitForSelector('[data-region="test-kingdom"]', { timeout: 10000 });
});

await step(A, "duplicate", async () => {
  const n = mock.log.length;
  await page.click('[data-region="test-kingdom"] [data-action="duplicate"]');
  await page.waitForSelector("dialog.editor[open]");
  check(A, "duplicate opens the editor with a new id", (await ed.id()) === "test-kingdom-copy", await ed.id());
  await page.click("dialog.editor .ed-save");
  await waitCommits(n);
  const c = commitsSince(n);
  const orig = JSON.parse(mock.read(BRANCH, "content/regions/test-kingdom.json"));
  const copy = JSON.parse(mock.read(BRANCH, "content/regions/test-kingdom-copy.json") ?? "null");
  check(A, "duplicate: one commit adding the copy with the same shape", c.length === 1 && copy && JSON.stringify(copy.geometry) === JSON.stringify(orig.geometry) && JSON.stringify(copy.properties.partLabels) === JSON.stringify(orig.properties.partLabels), c.map((x) => x.message).join(" | "));
  await page.click("dialog.editor .pv-head button.ghost");
  await page.waitForSelector('[data-region="test-kingdom-copy"]', { timeout: 10000 });
});

await step(A, "combine", async () => {
  const n = mock.log.length;
  const before = ["test-kingdom", "test-kingdom-copy"].map((id) => mock.read(BRANCH, `content/regions/${id}.json`));
  await page.click("#r-combine");
  await page.waitForSelector("dialog.combine-dlg[open]");
  const go = page.locator('dialog.combine-dlg [data-action="combine"]');
  check(A, "combine is disabled until two regions are ticked", await go.isDisabled());
  await page.check('dialog.combine-dlg input[value="test-kingdom"]');
  await page.check('dialog.combine-dlg input[value="test-kingdom-copy"]');
  await page.screenshot({ path: path.join(OUT, "combine-dialog.png") });
  // A region on another map: warn and offer a choice of base, then leave it out again.
  await page.check('dialog.combine-dlg input[value="old-map-region"]');
  const bases = await page.locator('dialog.combine-dlg input[name="combine-base"]').count();
  const warnText = (await page.locator("dialog.combine-dlg .combine-base p.warn").textContent().catch(() => "")) ?? "";
  check(A, "combine warns about different base maps and offers a choice", bases === 2 && /different maps/.test(warnText), `${bases} bases; ${warnText}`);
  await page.screenshot({ path: path.join(OUT, "combine-different-maps.png") });
  await page.uncheck('dialog.combine-dlg input[value="old-map-region"]');
  const id = await page.inputValue("dialog.combine-dlg input[type=text]");
  check(A, "combine suggests a free id", id === "test-kingdom-test-kingdom-copy", id);
  await go.click();
  await page.waitForSelector("dialog.editor[open]");
  check(A, "combine opens the editor on the new region", (await ed.id()) === id, await ed.id());
  await page.click("dialog.editor .ed-save");
  await waitCommits(n);
  const c = commitsSince(n);
  const after = ["test-kingdom", "test-kingdom-copy"].map((rid) => mock.read(BRANCH, `content/regions/${rid}.json`));
  const f = JSON.parse(mock.read(BRANCH, `content/regions/${id}.json`) ?? "null");
  const src = before.map((t) => JSON.parse(t));
  const parts = (g) => (g.type === "Polygon" ? 1 : g.coordinates.length);
  check(
    A,
    "combine: one commit adding the new region with every part; originals untouched",
    c.length === 1 && JSON.stringify(c[0].changes) === JSON.stringify([{ path: `content/regions/${id}.json`, deleted: false }]) && f && parts(f.geometry) === parts(src[0].geometry) + parts(src[1].geometry) && JSON.stringify(after) === JSON.stringify(before) && checkGeometry(f.geometry).length === 0,
    c.map((x) => x.message).join(" | "),
  );
  await page.click("dialog.editor .pv-head button.ghost");
  await page.waitForSelector(`[data-region="${id}"]`, { timeout: 10000 });
});

await step(A, "delete", async () => {
  const n = mock.log.length;
  await page.click('[data-region="test-kingdom-copy"] [data-action="delete"]');
  const btn = page.locator('dialog.small-dlg button:has-text("Delete region")');
  check(A, "delete is disabled until the id is typed", await btn.isDisabled());
  const warning = await page.textContent("dialog.small-dlg .dlg-body p.error");
  await page.fill("dialog.small-dlg input", "test-kingdom-copy");
  await btn.click();
  await waitCommits(n);
  const c = commitsSince(n);
  check(A, "delete: one commit removing the file", c.length === 1 && JSON.stringify(c[0].changes) === JSON.stringify([{ path: "content/regions/test-kingdom-copy.json", deleted: true }]) && mock.read(BRANCH, "content/regions/test-kingdom-copy.json") === null, c.map((x) => x.message).join(" | "));
  check(A, "delete warns that embeds stop showing it", /stop showing it/.test(warning), warning);
});

await step(A, "conflict detection", async () => {
  await page.waitForSelector('[data-region="landmark-disc"]');
  await page.click('[data-region="landmark-disc"] [data-action="edit"]');
  await page.waitForSelector("dialog.editor[open]");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, "editor-landmark.png") });
  const p = "content/regions/landmark-disc.json";
  const f = JSON.parse(mock.read(BRANCH, p));
  f.properties.name = "Changed elsewhere";
  mock.externalWrite(BRANCH, p, JSON.stringify(f, null, 2) + "\n");
  const n = mock.log.length;
  await page.click("dialog.editor canvas.ed-canvas", { position: { x: 3, y: 3 }, button: "middle" });
  await page.keyboard.press("ArrowRight");
  await page.click("dialog.editor .ed-save");
  const title = await page.locator("dialog.small-dlg h2").textContent({ timeout: 5000 });
  check(A, "save refuses to overwrite a file changed on GitHub, offers reload", title === "Changed on GitHub" && mock.log.length === n);
  await page.click('dialog.small-dlg button:has-text("Reload from GitHub")');
  await page.waitForTimeout(400);
  const s = await ed.state();
  check(A, "reload brings in the newer version (an older region's name becomes part 1's label)", s.labels[0] === "Changed elsewhere", JSON.stringify(s.labels));
  await page.click('dialog.editor [data-act="centre"]');
  await page.click("dialog.editor .pv-head button.ghost");
  await page.waitForTimeout(200);
});

await step(A, "editor: colours and legend", async () => {
  await page.click('[data-region="provinces"] [data-action="edit"]');
  await page.waitForSelector("dialog.editor[open]");
  await page.waitForTimeout(1200);
  const panel = () =>
    page.evaluate(() => {
      const d = document.querySelector("dialog.editor");
      return {
        keys: [...d.querySelectorAll(".ed-key .ed-key-row")].map((r) => [r.querySelector("input[type=color]").value, r.querySelector("input[type=text]").value]),
        parts: [...d.querySelectorAll(".ed-part-row select[data-part]")].map((s) => s.value),
        options: [...(d.querySelector(".ed-part-row select[data-part]")?.options ?? [])].map((o) => o.textContent),
        title: d.querySelector('input[name="legend-title"]').value,
      };
    });
  let pn = await panel();
  check(A, "editor lists the legend and each part's colour", pn.keys.length === 2 && JSON.stringify(pn.parts) === '["-1","0","1"]' && pn.title === "Provinces", JSON.stringify(pn));
  check(A, "part colour menu: default colour, then the legend labels as text", JSON.stringify(pn.options) === JSON.stringify(["Default colour", "Green March", "<img src=x onerror=alert(3)>"]) && dialogs.length === 0, JSON.stringify(pn.options));
  // Numbered badges: the Parts list numbers its rows, and pointing at a part on the map lights up its row.
  const badges = await page.$$eval("dialog.editor .ed-part-row .ed-badge", (els) => els.map((e) => e.textContent));
  check(A, "Parts list rows carry numbered badges", JSON.stringify(badges) === '["1","2","3"]', JSON.stringify(badges));
  const [bx, by] = await ed.xy(89, -35);
  await page.mouse.move(bx, by);
  await page.waitForTimeout(100);
  const hot = await page.$$eval("dialog.editor .ed-part-row", (els) => els.map((e) => e.classList.contains("hot")));
  check(A, "pointing at part 3 on the map highlights its row", JSON.stringify(hot) === "[false,false,true]", JSON.stringify(hot));
  await page.screenshot({ path: path.join(OUT, "editor-badges.png") });
  await page.locator("dialog.editor .ed-colours").screenshot({ path: path.join(OUT, "editor-colours-panel.png") });
  await page.mouse.move(5, 5);
  const plabels = await page.$$eval("dialog.editor .ed-part-row input[type=text]", (els) => els.map((e) => e.value));
  check(A, "each Parts row has its label", JSON.stringify(plabels) === '["Red Reach","","Blue Coast"]', JSON.stringify(plabels));
  await page.fill('dialog.editor input[data-part-label="1"]', "Green March <i>");
  await page.click('dialog.editor [data-act="key-add"]');
  await page.keyboard.type("Capital");
  pn = await panel();
  check(A, "Add colour adds a row and focuses its label", pn.keys.length === 3 && pn.keys[2][1] === "Capital", JSON.stringify(pn.keys));
  await page.selectOption('dialog.editor .ed-part-row select[data-part="0"]', "2");
  await page.click('dialog.editor .ed-key .ed-key-row:first-child [data-act="key-remove"]');
  pn = await panel();
  check(A, "removing a colour sends its parts back to the region colour and keeps the rest", pn.keys.length === 2 && JSON.stringify(pn.parts) === '["1","-1","0"]', JSON.stringify(pn));
  await page.screenshot({ path: path.join(OUT, "editor-legend.png") });
  await page.click("dialog.editor canvas.ed-canvas", { position: { x: 3, y: 3 }, button: "middle" });
  await page.keyboard.press("Control+z");
  pn = await panel();
  check(A, "undo brings the removed colour back", pn.keys.length === 3 && JSON.stringify(pn.parts) === '["2","0","1"]', JSON.stringify(pn));
  await page.keyboard.press("Control+Shift+z");
  const n = mock.log.length;
  await page.click("dialog.editor .ed-save");
  await waitCommits(n);
  const f = JSON.parse(mock.read(BRANCH, "content/regions/provinces.json"));
  check(
    A,
    "saved file has the legend and one colour per part",
    mock.log.length === n + 1 && f.properties.legendTitle === "Provinces" && JSON.stringify(f.properties.legend.map((e) => e.label)) === JSON.stringify(["<img src=x onerror=alert(3)>", "Capital"]) && JSON.stringify(f.properties.partLegend) === "[1,-1,0]" && JSON.stringify(f.properties.partLabels) === JSON.stringify(["Red Reach", "Green March <i>", "Blue Coast"]) && !("name" in f.properties),
    JSON.stringify({ legend: f.properties.legend, partLegend: f.properties.partLegend, partLabels: f.properties.partLabels }),
  );
  await page.click("dialog.editor .pv-head button.ghost");
  await page.waitForTimeout(300);
  const meta = await page.locator('[data-region="provinces"] .rinfo .muted.small', { hasText: "vertices" }).first().textContent();
  check(A, "region card counts the colours", /3 colours/.test(meta), meta);
});

await step(A, "editor speed at 2,000 vertices", async () => {
  await page.click('[data-region="big-ring"] [data-action="edit"]');
  await page.waitForSelector("dialog.editor[open]");
  await page.waitForTimeout(2500);
  const s = await ed.state();
  const v = s.parts[0][0][0];
  // A 60-step vertex drag. Measures wall time per pointer move, the editor's own work per move
  // (pointer handler + its canvas redraw), and how many region updates reached the globe preview.
  const dragOnce = async (dx) => {
    const [x, y] = await ed.xy(v[0], v[1]);
    const t0 = Date.now();
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 1; i <= 60; i++) await page.mouse.move(x + dx * i, y + i * 0.5);
    await page.mouse.up();
    const ms = Date.now() - t0;
    await page.waitForTimeout(300);
    await page.keyboard.press("Control+z");
    return ms;
  };
  const pf = page.frames().find((f) => f.url().includes("/preview/"));
  await pf.evaluate(() => {
    window.__updates = 0;
    addEventListener("message", (e) => e.data?.type === "wge-region" && window.__updates++);
  });
  const withPreview = await dragOnce(1);
  const updates = await pf.evaluate(() => window.__updates);
  // Same drag with the preview iframe emptied: the editor alone.
  await page.evaluate(() => (document.querySelector("dialog.editor iframe.ed-globe").src = "about:blank"));
  await page.waitForTimeout(500);
  // CPU profile of the main thread during the drag: busy time (everything but idle) per move.
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
  const alone = await dragOnce(-1);
  const { profile } = await cdp.send("Profiler.stop");
  const byId = new Map(profile.nodes.map((nd) => [nd.id, nd]));
  const self = new Map();
  let busy = 0;
  let native = 0;
  profile.samples.forEach((id, i) => {
    const nd = byId.get(id);
    const t = (profile.timeDeltas[i] ?? 0) / 1000;
    if (nd.callFrame.functionName === "(idle)") return;
    busy += t;
    if (nd.callFrame.functionName === "(program)") native += t;
    const k = `${nd.callFrame.functionName || "(anon)"} ${nd.callFrame.url.split("/").pop()}:${nd.callFrame.lineNumber}`;
    self.set(k, (self.get(k) ?? 0) + t);
  });
  if (process.env.E2E_PROFILE) console.log([...self].sort((x, y) => y[1] - x[1]).slice(0, 20).map(([k, v]) => `${v.toFixed(0).padStart(7)} ms  ${k}`).join("\n"));
  const busyPerMove = busy / 60;
  const jsPerMove = (busy - native) / 60;
  const n = (await ed.state()).parts[0][0].length;
  check(A, "2,000-vertex drag: globe preview kept up (≥10 updates, at most one per frame)", updates >= 10 && updates <= 61, `${n} vertices; ${updates} preview updates in 60 moves; ${(withPreview / 60).toFixed(0)} ms per move with the WebGL preview (software rendering)`);
  check(A, "2,000-vertex drag: editor's script work per move fits in a 60 Hz frame", jsPerMove < 16.7, `${jsPerMove.toFixed(1)} ms of script per move (pointer handler, crossing check, redraw of 2,000 vertices and handles); ${busyPerMove.toFixed(1)} ms including the browser's own drawing, which runs in software here; ${(alone / 60).toFixed(0)} ms wall time per move, mostly the test driver`);
  await page.click("dialog.editor .pv-head button.ghost");
  await page.waitForTimeout(300);
  if (await page.isVisible("dialog.small-dlg")) await page.click('dialog.small-dlg button:has-text("Discard changes")');
});

await step(A, "preview and embed code", async () => {
  await page.click('[data-region="landmark-disc"] [data-action="preview"]');
  await page.waitForSelector("dialog.rpreview iframe");
  const pf = () => page.frames().find((f) => f.url().includes("/preview/"));
  await page.waitForTimeout(2500);
  await pf().waitForFunction(() => document.documentElement.dataset.state === "hires", null, { timeout: 20000 });
  await page.screenshot({ path: path.join(OUT, "admin-preview-globe.png") });
  await page.click('dialog.rpreview button[data-view="flat"]');
  await page.waitForTimeout(800);
  await pf().waitForFunction(() => document.documentElement.dataset.state === "hires" && document.documentElement.classList.contains("flatview"), null, { timeout: 20000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, "admin-preview-flat.png") });
  const want = await page.textContent('[data-region="landmark-disc"] .rlabels');
  const got = await pf().evaluate(() => document.querySelector(".rlabel")?.textContent);
  check(A, "Preview: globe/flat switch shows the region embed", got === want, `${got}`);
  await page.click("dialog.rpreview .pv-head button");

  await page.click('[data-region="evil-name"] [data-action="copy-embed-code"]');
  const code = await page.inputValue("dialog.embed-dlg textarea");
  check(A, "embed snippet is titled by id and has nothing unescaped", code.includes('title="evil-name (Alignment test)"') && !code.includes("<script"), code);
  await page.click('dialog.embed-dlg input[data-opt="lock"]');
  await page.click('dialog.embed-dlg input[value="flat"]');
  const code2 = await page.inputValue("dialog.embed-dlg textarea");
  check(A, "unticking 'Start locked' adds &lock=0; view option updates live", code2.includes("region=evil-name&amp;view=flat&amp;lock=0"), code2.split("\n")[0]);
  await page.click("dialog.embed-dlg .copy-embed");
  await page.waitForTimeout(200);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check(A, "Copy puts the snippet on the clipboard and says Copied", clip === code2 && (await page.textContent("dialog.embed-dlg .dlg-foot span")) === "Copied");
  await page.click("dialog.embed-dlg .pv-head button");
});

await step(A, "security and branch", async () => {
  const csp = await page.evaluate(() => window.__csp);
  check(A, "admin CSP: no violations while using the editor", csp.length === 0 && !errors.some((e) => /Content Security Policy/i.test(e)), csp.join(" | ") || "none");
  check(A, "token only sent to api.github.com", leaks.length === 0, leaks.join(", ") || "ok");
  check(A, "no page errors in the admin page", errors.length === 0, errors.join(" | ") || "none");
  check(A, "no alert() from region data", dialogs.length === 0, dialogs.join(" | ") || "none");
  check(A, "nothing written to main", mock.refs.get("main") === mainAtStart && mock.log.every((c) => c.branch === BRANCH), `${mock.log.length} commits, all on ${BRANCH}`);
  check(A, "each action was one commit", mock.log.length === n0 + 5, mock.log.map((c) => c.message).join(" | "));
});
await ctx.close();

/* ═════════════ 3. Alignment screenshots ═════════════ */
if (want("alignment")) await step("alignment", "landmark on a padded, shifted globe", async () => {
  for (const [name, q] of [
    ["alignment-globe", `v/${SLOT.slug}/?region=landmark-disc&grid=1&label=0`],
    ["alignment-globe-dateline", `v/${SLOT.slug}/?region=dateline-box&grid=1&label=0`],
    ["alignment-flat", `v/${SLOT.slug}/?region=landmark-disc&view=flat&label=0`],
    ["alignment-flat-dateline", `v/${SLOT.slug}/?region=dateline-box&view=flat&label=0`],
  ]) {
    const e = await openEmbed(q);
    await e.page.screenshot({ path: path.join(OUT, `${name}.png`), clip: { x: e.box.x, y: e.box.y, width: e.box.width, height: e.box.height } });
    await e.ctx.close();
  }
  check("alignment", "screenshots written (inspect: outline on the landmark edges)", true, OUT);
});

await browser.close();
site.close();
host.close();
await writeFile(path.join(OUT, "report.json"), JSON.stringify({ fixture: dir, results }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots and report.json in ${OUT}/`);
if (failed.length) {
  console.log("Failed:");
  for (const f of failed) console.log(`  ✗ [${f.group}] ${f.name}: ${f.detail}`);
  process.exit(1);
}
