// e2e-suite: roots=EDITOR,WORKER weight=2
/**
 * Browser checks for reviewer comments: a contributor drops a comment on someone else's region from the editor,
 * the region's owner sees a "1 comment" link on the card, opens the editor on it, and resolves it; the tool and the
 * popover at phone, tablet and desktop widths; and that the Comment and Pin tools exclude each other.
 *
 *   npm run e2e -- comments
 *
 * Runs the real admin API (worker/) in this process in front of the in-memory GitHub. Screenshots and report.json
 * go to .e2e/comments/.
 */
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { makeFixture } from "./fixture.mjs";
import { MockGitHub } from "./mock-github.mjs";
import { ADMIN_API, useAdminApi } from "./admin-api.mjs";
import { port } from "./ports.mjs";
import { pickRegion } from "./regions-ui.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const OUT = path.resolve(".e2e/comments");
const PORT = port(4173);
const ADMIN = `http://localhost:${PORT}/admin/`;
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

const dir = await makeFixture({ quiet: true });
const ANN = { id: 5002, login: "carto-ann" };
writeFileSync(
  path.join(dir, "content/access.json"),
  JSON.stringify(
    {
      $schema: "../schema/access.schema.json",
      users: [
        { id: 45669787, login: "Flanz1", permissions: ["maps", "regions", "editOthers", "deleteOthers", "users"] },
        { ...ANN, permissions: ["regions"] },
      ],
    },
    null,
    2,
  ) + "\n",
);
execFileSync("npm", ["run", "build"], { cwd: dir, stdio: "pipe" });
const DIST = path.join(dir, "dist");

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".json": "application/json", ".txt": "text/plain", ".bin": "application/octet-stream" };
const site = createServer(async (req, res) => {
  let p = path.join(DIST, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (existsSync(p) && statSync(p).isDirectory()) p = path.join(p, "index.html");
  if (!p.startsWith(DIST) || !existsSync(p)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] ?? "application/octet-stream", "Cache-Control": "no-store" });
  res.end(await readFile(p));
}).listen(PORT, "localhost");

const browser = await chromium.launch();
const mock = new MockGitHub({ root: dir, branches: ["main"] });

async function open(as, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const api = await useAdminApi(ctx, mock, { branch: "main", as, adminUrl: ADMIN });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return { ctx, page, api, errors };
}
const waitFor = async (page, fn, ms = 15000) => {
  const t0 = Date.now();
  while (!(await fn()) && Date.now() - t0 < ms) await page.waitForTimeout(100);
};
/** Polls an attribute until it has the wanted value (state is set a beat late on a busy runner); false if it never does. */
const attrIs = async (page, loc, name, want, ms = 10000) => {
  let got;
  await waitFor(page, async () => ((got = await loc.getAttribute(name, { timeout: 2000 }).catch(() => null)) === want), ms);
  return got === want;
};
const REGION = "provinces";
const card = (id) => `.rcard[data-region="${id}"]`;
const apiCalls = [];

/** A comment made by Ann on the owner's region, from the suggestion editor. */
const G = "comments";
await step(G, "a contributor comments on someone else's region", async () => {
  const ann = await open("carto-ann");
  ann.page.on("request", (r) => /\/comments/.test(r.url()) && apiCalls.push(`${r.method()} ${new URL(r.url()).pathname}`));
  await ann.page.goto(ADMIN);
  await pickRegion(ann.page, REGION);
  check(G, "no comment link on a card without comments", (await ann.page.locator(`${card(REGION)} [data-action="comments"]`).count()) === 0);
  await ann.page.waitForLoadState("networkidle"); // the cards are drawn again once the comment list has arrived
  await ann.page.click(`${card(REGION)} [data-action="suggest-changes"]`);
  await ann.page.waitForSelector("dialog.editor", { timeout: 15000 });
  const tool = ann.page.locator('dialog.editor [data-act="comment-tool"]');
  check(G, "the toolbar has a Comments button (no count yet)", ((await tool.textContent()) ?? "").trim() === "Comments" && (await attrIs(ann.page, tool, "aria-label", "Comments")));
  await tool.click();
  check(G, "pressing it turns the tool on", await attrIs(ann.page, tool, "aria-pressed", "true"));
  // Pin and Comment exclude each other.
  await ann.page.click('dialog.editor [data-act="pin-tool"]');
  const pinBtn = ann.page.locator('dialog.editor [data-act="pin-tool"]');
  check(G, "the Pin tool switches the Comment tool off, and back", (await attrIs(ann.page, tool, "aria-pressed", "false")) && (await attrIs(ann.page, pinBtn, "aria-pressed", "true")));
  await tool.click();
  check(G, "…and the other way round", (await attrIs(ann.page, pinBtn, "aria-pressed", "false")) && (await attrIs(ann.page, tool, "aria-pressed", "true")));
  const cv = await ann.page.locator("dialog.editor canvas.ed-canvas").boundingBox();
  await ann.page.mouse.click(cv.x + cv.width * 0.4, cv.y + cv.height * 0.5);
  await ann.page.waitForSelector("dialog.editor .ed-cm-pop textarea", { timeout: 5000 });
  const post = ann.page.locator('dialog.editor [data-act="comment-post"]');
  check(G, "clicking the map opens a new comment form; Post is off until there's text", await post.isDisabled());
  await ann.page.fill("dialog.editor .ed-cm-pop textarea", "The border looks off here");
  await ann.page.screenshot({ path: path.join(OUT, "1440-new.png") });
  await post.click();
  await ann.page.waitForSelector('dialog.editor .ed-cm-mark[data-comment]:not([data-comment="new"])', { timeout: 10000 });
  check(G, "posting leaves a numbered marker, and the button counts it", (await ann.page.textContent('dialog.editor .ed-cm-mark[data-comment]:not([data-comment="new"])')) === "1" && (await attrIs(ann.page, tool, "aria-label", "Comments, 1 open")));
  await ann.page.waitForSelector('dialog.editor [data-act="comment-delete"]', { timeout: 10000 }); // the popover shows the posted comment a beat after the marker
  check(G, "the author can delete but not resolve their comment on another's region", (await ann.page.locator('dialog.editor [data-act="comment-delete"]').count()) === 1 && (await ann.page.locator('dialog.editor [data-act="comment-resolve"]').count()) === 0);
  await ann.page.screenshot({ path: path.join(OUT, "1440-posted.png") });
  await waitFor(ann.page, () => ann.page.evaluate(() => document.activeElement?.matches('dialog.editor [data-act="comment-close"]'))); // the popover takes focus once it shows the posted comment; keys only reach the editor while focus is inside it
  await ann.page.keyboard.press("Escape");
  await waitFor(ann.page, async () => (await ann.page.locator("dialog.editor .ed-cm-pop").isHidden()));
  await ann.page.keyboard.press("Escape");
  check(G, "Esc closes the form, then leaves the tool", await attrIs(ann.page, tool, "aria-pressed", "false"), await ann.page.evaluate(() => `pop hidden=${document.querySelector("dialog.editor .ed-cm-pop")?.hidden} focus=${document.activeElement?.tagName}.${document.activeElement?.className} dialogOpen=${!!document.querySelector("dialog.editor[open]")}`));
  check(G, "no page errors", ann.errors.length === 0, ann.errors.join(" | ") || "none");
  await ann.ctx.close();
});

await step(G, "the owner sees it on the card, opens it and resolves it", async () => {
  const owner = await open("Flanz1");
  owner.page.on("request", (r) => /\/comments/.test(r.url()) && apiCalls.push(`${r.method()} ${new URL(r.url()).pathname}`));
  await owner.page.goto(`${ADMIN}#regions`);
  await owner.page.click("#tab-btn-regions").catch(() => {});
  await pickRegion(owner.page, REGION);
  const link = owner.page.locator(`${card(REGION)} [data-action="comments"]`);
  await link.waitFor({ timeout: 10000 });
  check(G, "the region card shows '1 comment'", ((await link.textContent()) ?? "") === "1 comment");
  check(G, "other regions' cards show none", (await owner.page.locator('[data-action="comments"]').count()) === 1);
  await link.click();
  await owner.page.waitForSelector("dialog.editor", { timeout: 15000 });
  const tool = owner.page.locator('dialog.editor [data-act="comment-tool"]');
  await owner.page.waitForSelector("dialog.editor .ed-cm-mark.resolved, dialog.editor .ed-cm-mark[data-comment]", { timeout: 10000 });
  check(G, "the editor opens with the Comment tool on and the marker showing", (await attrIs(owner.page, tool, "aria-pressed", "true")) && (await attrIs(owner.page, tool, "aria-label", "Comments, 1 open")));
  await owner.page.click("dialog.editor .ed-cm-mark[data-comment]");
  await owner.page.waitForSelector('dialog.editor [data-act="comment-resolve"]');
  check(G, "the popover shows who wrote it and what", /carto-ann/.test((await owner.page.textContent("dialog.editor .ed-cm-pop")) ?? "") && /border looks off/.test((await owner.page.textContent("dialog.editor .ed-cm-pop")) ?? ""));
  await owner.page.screenshot({ path: path.join(OUT, "1440-light-owner.png") });
  await owner.page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await owner.page.screenshot({ path: path.join(OUT, "1440-dark-owner.png") });
  await owner.page.evaluate(() => (document.documentElement.dataset.theme = "light"));
  await owner.page.click('dialog.editor [data-act="comment-resolve"]');
  check(G, "Resolve takes it off the open count and the markers", (await attrIs(owner.page, tool, "aria-label", "Comments")) && (await owner.page.locator("dialog.editor .ed-cm-mark[data-comment]:not(.resolved)").count()) === 0);
  await owner.page.check('dialog.editor [name="ed-comments-resolved"]', { force: true }).catch(() => {});
  check(G, "no page errors", owner.errors.length === 0, owner.errors.join(" | ") || "none");
  await owner.ctx.close();
});

await step(G, "it works as a phone bottom sheet and on a tablet", async () => {
  for (const [name, viewport] of [["375", { width: 375, height: 800 }], ["768", { width: 768, height: 900 }]]) {
    const o = await open("Flanz1", viewport);
    await o.page.goto(`${ADMIN}#regions`);
    await o.page.click("#tab-btn-regions").catch(() => {});
    await pickRegion(o.page, REGION);
    await o.page.waitForLoadState("networkidle");
    await o.page.click(`${card(REGION)} [data-action="edit"]`);
    await o.page.waitForSelector("dialog.editor", { timeout: 15000 });
    await o.page.click('dialog.editor [data-act="comment-tool"]');
    const cv = await o.page.locator("dialog.editor canvas.ed-canvas").boundingBox();
    await o.page.mouse.click(cv.x + cv.width * 0.5, cv.y + cv.height * 0.4);
    await o.page.waitForSelector("dialog.editor .ed-cm-pop textarea");
    const pop = await o.page.locator("dialog.editor .ed-cm-pop").boundingBox();
    check(G, `${name}px: the form is on screen`, pop && pop.x >= 0 && pop.x + pop.width <= viewport.width + 1 && pop.y >= 0 && pop.y + pop.height <= viewport.height + 1, JSON.stringify(pop));
    await o.page.screenshot({ path: path.join(OUT, `${name}-light-new.png`) });
    await o.page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
    await o.page.screenshot({ path: path.join(OUT, `${name}-dark-new.png`) });
    await o.ctx.close();
  }
});

check(G, "no comment request on opening the editor beyond the list read and the user's own actions", apiCalls.filter((c) => c.startsWith("GET")).length <= 6 && !apiCalls.some((c) => c.startsWith("GET /comments/")), apiCalls.join(" ; "));

await browser.close();
site.close();
const failed = results.filter((r) => !r.ok);
await writeFile(path.join(OUT, "report.json"), JSON.stringify({ results, apiCalls, api: ADMIN_API }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots and report.json in ${OUT}`);
for (const f of failed) console.log(`  ✗ [${f.group}] ${f.name}: ${f.detail}`);
process.exit(failed.length ? 1 : 0);
