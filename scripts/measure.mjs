/**
 * Cold-load measurement in a headless browser, with the embed in a cross-origin iframe.
 *
 *   npm run build; and npm run measure
 *
 * Serves dist/ on http://localhost:4173 and a host page on http://127.0.0.1:4180
 * (different origin), then loads the host page in fresh browser contexts.
 * Uses the system Playwright + Chromium (not a project dependency).
 */
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const DIST = path.resolve("dist");
const SLUG = process.env.SLUG || "aerthos";
const RUNS = Number(process.env.RUNS || 3);
const OUT = path.resolve(".e2e");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".json": "application/json", ".txt": "text/plain" };

const site = createServer(async (req, res) => {
  let p = path.join(DIST, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (existsSync(p) && statSync(p).isDirectory()) p = path.join(p, "index.html");
  if (!p.startsWith(DIST) || !existsSync(p)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] ?? "application/octet-stream", "Cache-Control": "no-store" });
  res.end(await readFile(p));
}).listen(4173, "localhost");

const host = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<!doctype html><html><body style="margin:0;background:#202020;font:14px system-ui;color:#ddd">
<p style="padding:8px">Host page on another origin (stand-in for Obsidian Publish, dark theme)</p>
<iframe src="http://localhost:4173/v/${SLUG}/?grid=1" width="100%" height="480"
 style="border:0;border-radius:8px;background:transparent" allow="fullscreen" title="globe"></iframe></body></html>`);
}).listen(4180, "127.0.0.1");

const PROFILES = [
  { name: "unthrottled (localhost)", net: null },
  { name: "10 Mbps / 60 ms RTT", net: { offline: false, latency: 60, downloadThroughput: (10e6 / 8), uploadThroughput: (5e6 / 8) } },
];

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
    // Keep the cross-origin iframe in-process so network throttling applies to it as well.
    "--disable-features=IsolateOrigins,site-per-process"],
});

const results = [];
for (const prof of PROFILES) {
  for (let i = 0; i < RUNS; i++) {
    const ctx = await browser.newContext({ viewport: { width: 900, height: 560 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    if (prof.net) await cdp.send("Network.emulateNetworkConditions", prof.net);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto("http://127.0.0.1:4180/");
    const frame = page.frames().find((f) => f.url().startsWith("http://localhost:4173/"));
    await frame.waitForFunction(() => document.documentElement.dataset.state === "hires" || document.documentElement.dataset.state === "fallback", null, { timeout: 30000 });
    const m = await frame.evaluate(() => {
      const paint = (n) => performance.getEntriesByName(n)[0]?.startTime ?? null;
      return {
        crossOrigin: (() => { try { return window.parent.location.href && false; } catch { return true; } })(),
        state: document.documentElement.dataset.state,
        firstPaint: paint("first-paint"),
        fcp: paint("first-contentful-paint"),
        interactive: performance.getEntriesByName("wge-interactive")[0]?.startTime ?? null,
        hiresTexture: performance.getEntriesByType("resource").filter((r) => r.name.endsWith(".webp")).map((r) => r.name.split("-").pop()).join(", "),
        bytes: performance.getEntriesByType("resource").reduce((n, r) => n + (r.encodedBodySize || 0), 0) +
          (performance.getEntriesByType("navigation")[0]?.encodedBodySize ?? 0),
      };
    });
    if (i === 0) {
      await page.waitForTimeout(800);
      await page.screenshot({ path: path.join(OUT, `host-${prof.net ? "throttled" : "fast"}.png`) });
    }
    results.push({ profile: prof.name, run: i + 1, ...m, errors: errors.join(" | ") || "none" });
    await ctx.close();
  }
}

// A poster-only screenshot: block the viewer module so only the inline LQIP poster shows.
{
  const ctx = await browser.newContext({ viewport: { width: 900, height: 560 } });
  await ctx.route(/assets\/globe-.*\.js$/, () => {});
  const page = await ctx.newPage();
  await page.goto("http://127.0.0.1:4180/");
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, "poster.png") });
  await ctx.close();
}

await browser.close();
site.close();
host.close();

const fmt = (v) => (v == null ? "n/a" : `${Math.round(v)} ms`);
console.log("\n| Profile | Run | Cross-origin | First paint | FCP | Interactive | Textures loaded | Bytes | Errors |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const r of results)
  console.log(`| ${r.profile} | ${r.run} | ${r.crossOrigin} | ${fmt(r.firstPaint)} | ${fmt(r.fcp)} | ${fmt(r.interactive)} | ${r.hiresTexture} | ${(r.bytes / 1024).toFixed(0)} KB | ${r.errors} |`);
console.log(`\nScreenshots in ${OUT}/`);
