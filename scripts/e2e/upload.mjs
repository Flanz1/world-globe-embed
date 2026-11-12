/**
 * Browser check for big admin uploads, in headless Chromium against the in-memory GitHub API, which
 * (like GitHub) refuses blob uploads over ~40 MB.
 *
 *   npm run e2e:upload                                   synthetic 20000 px JPEG (~20 MB)
 *   env UPLOAD_FILE=path/to/map.jpg npm run e2e:upload   your own file
 *
 * Checks that a file wider than 16384 px goes up in 8 MB parts plus a manifest, in one commit, with a
 * progress bar that moves; that its metadata is stripped; and that process-maps' joinParts puts the
 * parts back together into exactly the bytes that were sent. Nothing touches GitHub.
 */
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { MockGitHub } from "./mock-github.mjs";
import { useAdminApi } from "./admin-api.mjs";
import { joinParts } from "../lib/process.ts";
import { contentPaths } from "../lib/paths.ts";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
import { port } from "./ports.mjs";
import { copyRepo } from "./fixture.mjs";
const require = createRequire(path.join(ROOT, "package.json"));
const sharp = require("sharp");
const { chromium } = require("playwright");
const SITE = `http://localhost:${port(4177)}`;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` (${detail})` : ""}`);
}

const dir = mkdtempSync(path.join(tmpdir(), "wge-upload-"));
copyRepo(dir);
execFileSync("npm", ["run", "build"], { cwd: dir, stdio: "pipe" });
const DIST = path.join(dir, "dist");

let file = process.env.UPLOAD_FILE;
if (!file) {
  // Noise doesn't compress, so a 20000 × 10000 JPEG comes out around 20–30 MB: three or four parts.
  file = path.join(dir, "big-upload.jpg");
  const W = 20000;
  const H = 10000;
  await sharp({ create: { width: W, height: H, channels: 3, noise: { type: "gaussian", mean: 128, sigma: 40 } }, limitInputPixels: false })
    .jpeg({ quality: 80 })
    .withExif({ IFD0: { Copyright: "secret-gps-like-data" } })
    .toFile(file);
}
const size = statSync(file).size;
console.log(`Uploading ${path.basename(file)}, ${(size / 1048576).toFixed(1)} MB`);

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".json": "application/json" };
const site = createServer(async (req, res) => {
  let p = path.join(DIST, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (existsSync(p) && statSync(p).isDirectory()) p = path.join(p, "index.html");
  if (!p.startsWith(DIST) || !existsSync(p)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] ?? "application/octet-stream", "Cache-Control": "no-store" });
  res.end(await readFile(p));
}).listen(port(4177), "localhost");

const mock = new MockGitHub({ root: dir });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.route("https://api.github.com/**", (r) => mock.handle(r));
await useAdminApi(ctx, mock);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`${SITE}/admin/`);
await page.waitForSelector("#upload input[type=file]", { state: "visible", timeout: 15000 });
await page.setInputFiles("#upload input[type=file]", file);
await page.fill("#upload input[name=id]", "big-upload");
const progress = [];
const poll = setInterval(async () => {
  try {
    const v = await page.evaluate(() => {
      const b = document.getElementById("upload-progress");
      return b && !b.hidden ? [b.hasAttribute("value") ? b.value : null, document.getElementById("upload-info").textContent] : null;
    });
    if (v) progress.push(v);
  } catch {
    /* page busy */
  }
}, 100);
const n0 = mock.log.length;
await page.click('#upload button[type="submit"]');
const t0 = Date.now();
while (mock.log.length === n0 && Date.now() - t0 < 300000) await page.waitForTimeout(250);
await page.waitForTimeout(500);
clearInterval(poll);

const commit = mock.log.slice(n0);
check("exactly one commit", commit.length === 1, commit.map((c) => c.message).join("; "));
const files = mock.filesAt("main");
const parts = [...files.keys()].filter((p) => /^content\/incoming\/big-upload\.jpg\.part\d{3}$/.test(p)).sort();
const expected = Math.ceil(size / (8 * 1024 * 1024));
check("sent in 8 MB parts plus a manifest", parts.length >= expected && files.has("content/incoming/big-upload.jpg.parts.json"), `${parts.length} parts`);
const fractions = progress.map(([v]) => v).filter((v) => v !== null);
check("the progress bar moved through the upload", new Set(fractions.map((v) => Math.round(v * 10))).size >= 3, `${fractions.length} samples, ${[...new Set(progress.map(([, t]) => t.replace(/[\d.]+ MB of/, "… of")))].slice(0, 4).join(" | ")}`);
check("status says it's done", /^Uploaded /.test(await page.textContent("#upload-info")), await page.textContent("#upload-info"));
check("no page errors", errors.length === 0, errors.join("; "));

// Hand the committed files to process-maps' joiner, like the workflow would see them.
const work = mkdtempSync(path.join(tmpdir(), "wge-join-"));
const paths = contentPaths(work);
mkdirSync(paths.incomingDir, { recursive: true });
for (const p of [...parts, "content/incoming/big-upload.jpg.parts.json"]) writeFileSync(path.join(work, p), mock.blobs.get(files.get(p)));
const { joined, errors: joinErrors } = joinParts(paths);
const out = path.join(paths.incomingDir, "big-upload.jpg");
check("joinParts puts it back together", joinErrors.length === 0 && joined.has(out) && readdirSync(paths.incomingDir).join() === "big-upload.jpg", joinErrors.join("; "));
const back = readFileSync(out);
const meta = await sharp(back, { limitInputPixels: false }).metadata();
const src = await sharp(file, { limitInputPixels: false }).metadata();
check("same image, same size", meta.width === src.width && meta.height === src.height && Math.abs(back.length - size) < 64 * 1024, `${meta.width}×${meta.height}, ${back.length} of ${size} bytes`);
check("metadata stripped", meta.exif === undefined && !back.includes("secret-gps-like-data"));

await browser.close();
site.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed.`);
process.exit(failed.length ? 1 : 0);
