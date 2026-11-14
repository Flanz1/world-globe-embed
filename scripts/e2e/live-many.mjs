/**
 * Browser checks for saving lots of regions at once from "Edit together" / a linked combined region, in
 * headless Chromium, signed in as an editor (not the owner), against the real admin API in front of the
 * mocked GitHub.
 *
 *   npm run e2e:live-many
 *
 * 22 small regions. A save that changes 20 of them is split into commits the admin API accepts (16 files
 * each for an editor), nothing is lost, and the linked region goes in the last one. Exits non-zero if any check fails.
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
import { port } from "./ports.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const OUT = path.resolve(".e2e/live-many");
const BRANCH = "test/live-many";
const SITE = `http://localhost:${port(4173)}`;
const E = "many";
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

const ME = { id: 5001, login: "e2e-user" };
const dir = await makeFixture({ quiet: true });
writeFileSync(
  path.join(dir, "content/access.json"),
  JSON.stringify({ $schema: "../schema/access.schema.json", users: [{ id: 45669787, login: "Flanz1", permissions: ["maps", "regions", "editOthers", "deleteOthers", "users"] }, { ...ME, permissions: ["regions"] }] }, null, 2) + "\n",
);
const N = 22;
const ids = Array.from({ length: N }, (_, i) => `many-${String(i).padStart(2, "0")}`);
const box = (w, s, e, n) => [[w, s], [e, s], [e, n], [w, n], [w, s]];
ids.forEach((id, i) => {
  const w = 20 + (i % 11) * 12;
  const s = -60 + Math.floor(i / 11) * 14;
  writeFileSync(
    path.join(dir, `content/regions/${id}.json`),
    JSON.stringify({ $schema: "../../schema/region.schema.json", type: "Feature", id, properties: { slot: SLOT.slug, map: MAP.id, color: "#c0392b", fillOpacity: 0.3, label: true, partLabels: [`P ${i}`], created: "2026-11-12T12:00:00Z", createdBy: ME, updated: "2026-11-12T12:00:00Z", updatedBy: ME }, geometry: { type: "Polygon", coordinates: [box(w, s, w + 8, s + 10)] } }, null, 2) + "\n",
  );
});
execFileSync("npm", ["run", "build"], { cwd: dir, env: { ...process.env, VITE_CONTENT_BRANCH: BRANCH }, stdio: "pipe" });

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
await useAdminApi(ctx, mock, { branch: BRANCH, as: ME.login });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && !/^Failed to load resource/.test(m.text()) && errors.push(m.text()));
page.on("dialog", (d) => d.dismiss());

const read = (id) => JSON.parse(mock.read(BRANCH, `content/regions/${id}.json`) ?? "null");
const state = () => page.evaluate(() => document.querySelector("dialog.editor").wgeEditor.state());
const msg = () => page.textContent("dialog.editor .ed-msg");
async function saveAll(commits) {
  const n0 = mock.log.length;
  await page.click("dialog.editor .ed-save");
  const t0 = Date.now();
  while (mock.log.length < n0 + commits && Date.now() - t0 < 60000) await page.waitForTimeout(150);
  await page.waitForTimeout(600);
  return mock.log.slice(n0);
}
async function openTogether(picked, link) {
  await page.goto(`${SITE}/admin/#regions`);
  await page.waitForSelector(`#regions .rcard[data-region="${ids[0]}"]`, { timeout: 20000 });
  await page.click("#r-combine");
  await page.waitForSelector("dialog.combine-dlg[open]");
  for (const id of picked) await page.check(`dialog.combine-dlg input[value="${id}"]`);
  if (link) {
    await page.check('dialog.combine-dlg input[name="keep-linked"]');
    await page.fill("dialog.combine-dlg input[type=text]", link);
    await page.click('dialog.combine-dlg [data-action="combine"]');
  } else {
    await page.uncheck('dialog.combine-dlg input[name="keep-linked"]').catch(() => {});
    await page.click('dialog.combine-dlg [data-action="edit-together"]');
  }
  await page.waitForSelector("dialog.editor[open]");
  await page.waitForTimeout(1200);
}
async function relabelAll(tag) {
  const s = await state();
  for (let p = 0; p < s.parts.length; p++) await page.fill(`dialog.editor input[data-part-label="${p}"]`, `${tag} ${s.owners[p]}`);
}

const twenty = ids.slice(0, 20);
await step(E, "edit together: 20 changed regions", async () => {
  await openTogether(twenty, null);
  await relabelAll("T");
  const c = await saveAll(2);
  const paths = c.flatMap((x) => x.changes.map((ch) => ch.path));
  check(E, "saved as commits of at most 16 files each", c.length === 2 && c.every((x) => x.changes.length <= 16), c.map((x) => x.changes.length).join("+") + " " + (await msg()));
  check(E, "all 20 regions are in them, once", new Set(paths).size === 20 && paths.length === 20);
  check(E, "every region has its new label", twenty.every((id) => read(id).properties.partLabels[0] === `T ${id}`));
  check(E, "the other two are untouched", ids.slice(20).every((id) => read(id).properties.partLabels[0].startsWith("P ")));
  check(E, "the editor says it's saved", /Saved 20 regions in 2 commits/.test(await msg()), await msg());
  await page.click("dialog.editor .pv-head button.ghost");
});

await step(E, "linked region over 20 regions", async () => {
  await openTogether(twenty, "many-link");
  let c = await saveAll(1);
  check(E, "a new linked region is written on its own", c.length === 1 && c[0].changes.length === 1 && read("many-link")?.properties.linked.length === 20, JSON.stringify(c.map((x) => x.changes.map((y) => y.path))));
  await page.click("dialog.editor .pv-head button.ghost");
  await page.waitForSelector('#regions .rcard[data-region="many-link"] [data-action="edit"]', { timeout: 20000 });
  await page.click('#regions .rcard[data-region="many-link"] [data-action="edit"]');
  await page.waitForSelector("dialog.editor[open]");
  await page.waitForTimeout(1200);
  await relabelAll("L");
  c = await saveAll(2);
  const last = c.at(-1)?.changes.map((x) => x.path) ?? [];
  check(E, "20 regions + the linked region: 2 commits, the linked region in the last", c.length === 2 && c.every((x) => x.changes.length <= 16) && last.includes("content/regions/many-link.json"), c.map((x) => x.changes.length).join("+"));
  check(E, "every region and the snapshot have the new labels", twenty.every((id) => read(id).properties.partLabels[0] === `L ${id}`) && read("many-link").properties.partLabels.every((l) => l.startsWith("L ")));
  check(E, "saving again finds nothing to do", (await saveAll(1)).length === 0 && /Nothing to save/.test(await msg()), await msg());
  await page.click("dialog.editor .pv-head button.ghost");
});

check(E, "main untouched", mock.refs.get("main") === mainAtStart);
check(E, "no errors in the admin page", errors.length === 0, errors.join(" | ") || "none");

await browser.close();
server.close();
await writeFile(path.join(OUT, "report.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed:\n${failed.map((f) => `  [${f.group}] ${f.name} ${f.detail}`).join("\n")}` : ""}`);
process.exit(failed.length ? 1 : 0);
