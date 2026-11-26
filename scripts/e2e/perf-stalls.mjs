// e2e-tool: long-task finder for the embed (REGION=<id> VIEW=flat|globe STEPS=n tsx scripts/e2e/perf-stalls.mjs)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const DIST = path.resolve("dist");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".json": "application/json" };
const server = createServer(async (req, res) => {
  let p = path.join(DIST, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (existsSync(p) && statSync(p).isDirectory()) p = path.join(p, "index.html");
  if (!p.startsWith(DIST) || !existsSync(p)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] ?? "application/octet-stream" });
  res.end(await readFile(p));
}).listen(4998, "localhost");
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.addInitScript(() => {
  window.__lt = [];
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ entryTypes: ["longtask"] });
});
const q = new URLSearchParams();
if (process.env.REGION) q.set("region", process.env.REGION);
if (process.env.VIEW) q.set("view", process.env.VIEW);
await page.goto(`http://localhost:4998/v/inara/?${q}`);
await page.waitForTimeout(5000);
if (process.env.REGION) await page.click("#btn-lock");
const b = await page.locator("canvas").first().boundingBox();
const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
await page.mouse.move(cx, cy);
const log = async (label) => { const lt = await page.evaluate(() => { const r = window.__lt; window.__lt = []; return r; }); console.log(label, lt.length ? lt.map((x) => x[1] + "ms").join(" ") : "none"); };
await log("load");
const cdp = process.env.PROFILE ? await ctx.newCDPSession(page) : null;
if (cdp) { await cdp.send("Profiler.enable"); await cdp.send("Profiler.start"); }
const N = Number(process.env.STEPS ?? 14);
for (let i = 0; i < N; i++) { await page.mouse.wheel(0, -250); await page.waitForTimeout(900); await log(`zoom in ${i + 1}`); }
if (cdp) {
  const { profile } = await cdp.send("Profiler.stop");
  const byId = new Map(profile.nodes.map((n) => [n.id, n])); const self = new Map();
  profile.samples.forEach((id, i) => { const n = byId.get(id); const f = n.callFrame.functionName || "(anon)"; if (f === "(idle)") return; const k = `${f} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber}`; self.set(k, (self.get(k) ?? 0) + (profile.timeDeltas[i] ?? 0)); });
  console.log([...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `  ${(v / 1000).toFixed(0)} ms ${k}`).join("\n"));
}
for (let i = 0; i < 6; i++) { await page.mouse.down(); for (let j = 0; j < 20; j++) await page.mouse.move(cx + j * 12, cy + j * 4); await page.mouse.up(); await page.waitForTimeout(900); await log(`pan ${i + 1}`); }
await browser.close(); server.close();
