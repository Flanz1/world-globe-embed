// e2e-tool: embed pan timings (REGION=<id> VIEW=flat|globe ZOOM=<k scale> node/tsx scripts/e2e/perf-embed.mjs)
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
}).listen(4999, "localhost");
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror", String(e).slice(0, 200)));
const q = new URLSearchParams();
if (process.env.REGION) q.set("region", process.env.REGION);
if (process.env.VIEW) q.set("view", process.env.VIEW);
await page.goto(`http://localhost:4999/v/inara/?${q}`);
await page.waitForTimeout(6000);
if (process.env.REGION) await page.click("#btn-lock");
const cv = page.locator("canvas").first();
const b = await cv.boundingBox();
const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
// zoom out with the wheel
for (let i = 0; i < Number(process.env.OUT ?? 10); i++) { await page.mouse.move(cx, cy); await page.mouse.wheel(0, 300); await page.waitForTimeout(60); }
await page.waitForTimeout(2500);
const cdp = await ctx.newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.start");
await page.mouse.move(cx, cy);
await page.mouse.down();
const t0 = Date.now();
for (let i = 0; i < 60; i++) { await page.mouse.move(cx + i * 6, cy + i * 2); await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); }
const wall = Date.now() - t0;
await page.mouse.up();
const { profile } = await cdp.send("Profiler.stop");
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map(); let busy = 0;
profile.samples.forEach((id, i) => { const n = byId.get(id); const f = n.callFrame.functionName; if (f === "(idle)") return; const k = `${f || "(anon)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber}`; const t = profile.timeDeltas[i] ?? 0; busy += t; self.set(k, (self.get(k) ?? 0) + t); });
console.log([...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `  ${(v / 1000).toFixed(0)} ms ${k}`).join("\n"));
console.log(`${process.env.VIEW ?? "default"} ${process.env.REGION ?? "no region"}: busy ${(busy / 60000).toFixed(1)} ms/move, wall ${(wall / 60).toFixed(0)} ms/move`);
await browser.close(); server.close();
