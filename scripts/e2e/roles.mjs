/**
 * Browser checks for contributor roles: GitHub sign-in, what each kind of person sees on the admin page,
 * the Users tab and its waiting list, region creators (filter, sort, and who saves what), and that the
 * admin API refuses what the page hides even when someone calls it directly.
 *
 *   npm run e2e:roles
 *
 * Runs the real admin API (worker/) in this process in front of the in-memory GitHub. Exits non-zero
 * if any check fails; screenshots and report.json go to .e2e/roles/.
 */
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { makeFixture } from "./fixture.mjs";
import { MockGitHub } from "./mock-github.mjs";
import { ADMIN_API, sessionFor, useAdminApi } from "./admin-api.mjs";
import { port } from "./ports.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const OUT = path.resolve(".e2e/roles");
const PORT = port(4173);
const SITE = `http://localhost:${PORT}`;
const ADMIN = `${SITE}/admin/`;
const REPO = "Flanz1/world-globe-embed";
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

/* ── Fixture: the region test content, plus a user list and one region owned by a contributor ── */
const dir = await makeFixture({ quiet: true });
const ANN = { id: 5002, login: "carto-ann" };
writeFileSync(
  path.join(dir, "content/access.json"),
  JSON.stringify(
    {
      $schema: "../schema/access.schema.json",
      users: [
        { id: 45669787, login: "Flanz1", permissions: ["maps", "regions", "editOthers", "deleteOthers", "users"] },
        { id: 138310181, login: "LoopSimon", permissions: ["maps", "regions"] },
        { ...ANN, permissions: ["regions"] },
        { id: 5003, login: "drafter-bo", permissions: ["regions", "editOthers"] },
        { id: 5001, login: "e2e-user", permissions: ["regions", "editOthers", "users"] },
      ],
    },
    null,
    2,
  ) + "\n",
);
const disc = path.join(dir, "content/regions/landmark-disc.json");
const discRegion = JSON.parse(readFileSync(disc, "utf8"));
discRegion.properties.createdBy = ANN;
discRegion.properties.created = "2026-11-10T10:00:00Z";
writeFileSync(disc, JSON.stringify(discRegion, null, 2) + "\n");
execFileSync("npm", ["run", "build"], { cwd: dir, stdio: "pipe" });
const DIST = path.join(dir, "dist");
console.log(`Fixture: ${dir}`);

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
const regionOn = (id) => JSON.parse(mock.read("main", `content/regions/${id}.json`) ?? "null");
const access = () => JSON.parse(mock.read("main", "content/access.json"));

/** A fresh browser context signed in as `as` (or signed out with as: null), with the admin API routed. */
async function open(as) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
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
const visible = (page, sel) => page.isVisible(sel);
const disabled = (page, sel) => page.locator(sel).isDisabled();

/** What a direct call to the admin API answers, from inside the page (as a curious user might try). */
async function forceCommit(page, change) {
  return page.evaluate(
    async ({ api, repo, change }) => {
      const t = sessionStorage.getItem("wge-admin-session");
      const call = async (method, p, body) => {
        const r = await fetch(`${api}/gh/repos/${repo}${p}`, { method, headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
        return { status: r.status, body: await r.json().catch(() => ({})) };
      };
      // Stops at the first refusal and returns it.
      const steps = [];
      const go = async (method, p, body) => {
        const r = await call(method, p, body);
        steps.push(r);
        if (r.status >= 300) throw r;
        return r.body;
      };
      try {
        const head = (await go("GET", "/git/ref/heads/main")).object.sha;
        const tree = (await go("GET", `/git/commits/${head}`)).tree.sha;
        const sha = change.delete ? null : (await go("POST", "/git/blobs", { content: btoa(change.content), encoding: "base64" })).sha;
        const t2 = (await go("POST", "/git/trees", { base_tree: tree, tree: [{ path: change.path, mode: "100644", type: "blob", sha }] })).sha;
        const c = (await go("POST", "/git/commits", { message: "forced", tree: t2, parents: [head] })).sha;
        await go("PATCH", "/git/refs/heads/main", { sha: c, force: false });
        return steps.at(-1);
      } catch (r) {
        return r.status ? r : { status: 0, body: { message: String(r) } };
      }
    },
    { api: ADMIN_API, repo: REPO, change },
  );
}

/* ═════════════ 1. Signing in with GitHub ═════════════ */
const S = "sign-in";
await step(S, "sign in with GitHub", async () => {
  const { ctx, page, api, errors } = await open(null);
  api.signInAs("carto-ann");
  await page.goto(ADMIN);
  await page.waitForSelector("#signin-github", { state: "visible", timeout: 10000 });
  check(S, "signed-out page offers Sign in with GitHub, no token field", (await page.locator("#token").count()) === 0 && !(await disabled(page, "#signin-github")));
  await page.screenshot({ path: path.join(OUT, "signin.png") });
  await page.click("#signin-github");
  await page.waitForSelector("#main", { state: "visible", timeout: 15000 }).catch(async (e) => {
    throw new Error(`${e.message.split("\n")[0]} at ${page.url()}: ${await page.textContent("body").catch(() => "")}`.slice(0, 600));
  });
  check(S, "back on the admin page, signed in as the GitHub account", ((await page.textContent("#who")) ?? "").endsWith("signed in as carto-ann"), await page.textContent("#who"));
  check(S, "the session isn't left in the address", !page.url().includes("session="), page.url());
  check(S, "session kept in sessionStorage only", await page.evaluate(() => !!sessionStorage.getItem("wge-admin-session") && !localStorage.getItem("wge-admin-session")));
  const csp = await page.evaluate(() => window.__csp);
  check(S, "no CSP violations", csp.length === 0, csp.join(" | ") || "none");
  check(S, "no page errors", errors.length === 0, errors.join(" | ") || "none");
  await ctx.close();
});

await step(S, "someone not on the list waits", async () => {
  const { ctx, page } = await open("new-face");
  await page.goto(ADMIN);
  await page.waitForSelector("#waiting", { state: "visible", timeout: 10000 });
  check(S, "they see 'Waiting for access' with their name, and nothing else", (await page.textContent("#waiting-who")) === "new-face" && !(await visible(page, "#main")));
  await page.screenshot({ path: path.join(OUT, "waiting.png") });
  await ctx.close();
});

/* ═════════════ 2. A contributor ═════════════ */
const C = "contributor";
await step(C, "tabs and buttons", async () => {
  const { ctx, page, errors } = await open("carto-ann");
  await page.goto(`${ADMIN}`);
  await page.waitForSelector("#regions .rcard", { timeout: 15000 });
  check(C, "no Maps & slots tab; opens on Regions", !(await visible(page, "#tab-btn-maps")) && !(await visible(page, "#tab-maps")) && (await visible(page, "#tab-regions")));
  check(C, "no Users tab", !(await visible(page, "#tab-btn-users")));
  await page.goto(`${ADMIN}#users`);
  await page.waitForSelector("#regions .rcard", { timeout: 15000 });
  check(C, "#users in the address still shows Regions", !(await visible(page, "#tab-users")) && (await visible(page, "#tab-regions")));
  check(C, "own region: Edit and Delete enabled", !(await disabled(page, '[data-region="landmark-disc"] [data-action="edit"]')) && !(await disabled(page, '[data-region="landmark-disc"] [data-action="delete"]')));
  check(C, "someone else's region: Edit and Delete disabled", (await disabled(page, '[data-region="provinces"] [data-action="edit"]')) && (await disabled(page, '[data-region="provinces"] [data-action="delete"]')));
  check(C, "…with the reason on hover", /created this region/.test((await page.getAttribute('[data-region="provinces"] [data-action="edit"]', "title")) ?? ""));
  check(C, "creator shown on the card", (await page.textContent('[data-region="landmark-disc"] .rcreator')) === "carto-ann" && (await page.textContent('[data-region="provinces"] .rcreator')) === "the owner");
  // Filter and sort by creator.
  await page.selectOption("#r-creator", "me");
  const mine = await page.locator("#regions .rcard").evaluateAll((els) => els.map((e) => e.dataset.region));
  check(C, "Created by: Me shows only their regions", mine.length === 1 && mine[0] === "landmark-disc", mine.join(","));
  await page.selectOption("#r-creator", "45669787");
  const owners = await page.locator("#regions .rcard").evaluateAll((els) => els.map((e) => e.dataset.region));
  check(C, "Created by: the owner hides theirs", owners.length > 0 && !owners.includes("landmark-disc"), owners.join(","));
  await page.selectOption("#r-creator", "");
  await page.selectOption("#r-sort", "creator");
  const sorted = await page.locator("#regions .rcard .rcreator").allTextContents();
  check(C, "Sort: Creator groups by creator", JSON.stringify(sorted) === JSON.stringify([...sorted].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))), sorted.join(","));
  await page.screenshot({ path: path.join(OUT, "contributor.png"), fullPage: true });

  // Duplicating someone else's region makes a new region that is theirs.
  const n = mock.log.length;
  await page.click('[data-region="provinces"] [data-action="duplicate"]');
  await page.waitForSelector("dialog.editor[open]");
  await page.click("dialog.editor .ed-save");
  await waitFor(page, async () => mock.log.length > n);
  const copy = regionOn("provinces-copy");
  check(C, "a duplicate is saved with them as creator and saver", copy?.properties.createdBy?.login === "carto-ann" && copy?.properties.updatedBy?.login === "carto-ann" && !!copy?.properties.created, JSON.stringify(copy?.properties.createdBy));
  check(C, "the commit is credited to them", mock.commits.get(mock.refs.get("main")).author === "carto-ann");
  // Saving it again keeps them as creator (the second save is an edit).
  await page.click("dialog.editor .ed-save");
  await waitFor(page, async () => mock.log.length > n + 1);
  check(C, "saving again keeps the creator", regionOn("provinces-copy")?.properties.createdBy?.login === "carto-ann" && mock.log.length === n + 2);
  await page.click("dialog.editor .pv-head button.ghost");

  // The API refuses what the page hides.
  const tries = {
    "edit someone else's region": { path: "content/regions/provinces.json", content: JSON.stringify({ ...regionOn("provinces"), properties: { ...regionOn("provinces").properties, color: "#000000", updatedBy: ANN } }) },
    "delete someone else's region": { path: "content/regions/provinces.json", delete: true },
    "change a slot": { path: "content/slots.json", content: "{}" },
    "upload a map": { path: "content/incoming/sneaky.png", content: "PNG" },
    "give themselves more permissions": { path: "content/access.json", content: JSON.stringify({ users: [{ ...ANN, permissions: ["maps", "regions", "users"] }] }) },
  };
  const headBefore = mock.refs.get("main");
  for (const [what, change] of Object.entries(tries)) {
    const r = await forceCommit(page, change);
    check(C, `API refuses: ${what}`, r.status === 403, `${r.status} ${r.body.message}`);
  }
  const r = await forceCommit(page, { path: "README.md", content: "x" });
  check(C, "API refuses: files outside content/", r.status === 403, `${r.status} ${r.body.message}`);
  check(C, "nothing changed on main", mock.refs.get("main") === headBefore);
  check(C, "no page errors", errors.length === 0, errors.join(" | ") || "none");
  await ctx.close();
});

/* ═════════════ 3. An editor ═════════════ */
const E = "editor";
await step(E, "edits other people's regions, can't delete them", async () => {
  const { ctx, page } = await open("drafter-bo");
  await page.goto(`${ADMIN}#regions`);
  await page.waitForSelector("#regions .rcard", { timeout: 15000 });
  check(E, "Edit enabled, Delete disabled on someone else's region", !(await disabled(page, '[data-region="landmark-disc"] [data-action="edit"]')) && (await disabled(page, '[data-region="landmark-disc"] [data-action="delete"]')));
  const n = mock.log.length;
  await page.click('[data-region="landmark-disc"] [data-action="edit"]');
  await page.waitForSelector("dialog.editor[open]");
  await page.click("dialog.editor .ed-save");
  await waitFor(page, async () => mock.log.length > n);
  const r = regionOn("landmark-disc");
  check(E, "saved: creator unchanged, saver is the editor", r.properties.createdBy?.login === "carto-ann" && r.properties.updatedBy?.login === "drafter-bo", `${r.properties.createdBy?.login} / ${r.properties.updatedBy?.login}`);
  await page.click("dialog.editor .pv-head button.ghost");
  await ctx.close();
});

/* ═════════════ 4. A user manager without Maps & slots ═════════════ */
const U = "users";
await step(U, "Users tab", async () => {
  const { ctx, page, errors } = await open("e2e-user");
  await page.goto(`${ADMIN}#users`);
  await page.waitForSelector('#users [data-user="carto-ann"]', { timeout: 15000 });
  check(U, "Users tab shown, Maps & slots not", (await visible(page, "#tab-users")) && !(await visible(page, "#tab-btn-maps")));
  check(U, "the owner's row and their own row can't be changed", (await page.locator('#users [data-user="Flanz1"] input, #users [data-user="Flanz1"] select').count()) === 0 && (await disabled(page, '#users [data-user="e2e-user"] [data-perm="regions"]')));
  check(U, "they can't hand out Maps & slots", await disabled(page, '#users [data-user="carto-ann"] [data-perm="maps"]'));
  check(U, "they can't take Maps & slots away either", (await disabled(page, '#users [data-user="LoopSimon"] [data-perm="maps"]')) && (await disabled(page, '#users [data-user="LoopSimon"] [data-action="remove-user"]')));
  check(U, "the presets offered are only ones they can give", JSON.stringify(await page.locator("#user-preset option").allTextContents()) === JSON.stringify(["Contributor", "Editor"]), (await page.locator("#user-preset option").allTextContents()).join(","));
  await page.screenshot({ path: path.join(OUT, "users.png"), fullPage: true });

  // Make carto-ann an Editor and add someone new, in one save.
  await page.selectOption('#users [data-user="carto-ann"] select', "Editor");
  await page.fill("#user-login", "nobody-at-all");
  await page.click('#user-add button[type="submit"]');
  await waitFor(page, async () => /no GitHub account/.test((await page.textContent("#users-note")) ?? ""));
  check(U, "an unknown username is refused", /no GitHub account/.test((await page.textContent("#users-note")) ?? ""), await page.textContent("#users-note"));
  const n = mock.log.length;
  await page.click("#users-save");
  await waitFor(page, async () => mock.log.length > n);
  const a = access();
  check(U, "saved as one commit to access.json", mock.log.length === n + 1 && mock.log.at(-1).changes.length === 1 && mock.log.at(-1).changes[0].path === "content/access.json", mock.log.at(-1)?.message);
  check(U, "carto-ann is now an Editor", JSON.stringify(a.users.find((u) => u.login === "carto-ann").permissions) === JSON.stringify(["regions", "editOthers"]));

  // Someone signed in before being added: they're waiting; approve them.
  const waiter = await open("new-face");
  await waiter.page.goto(ADMIN);
  await waiter.page.waitForSelector("#waiting", { state: "visible", timeout: 10000 });
  await page.goto(`${ADMIN}#users`);
  await page.waitForSelector('#waiting-list [data-waiting="new-face"]', { timeout: 15000 });
  check(U, "the waiting person is listed under Asked for access", true);
  const m = mock.log.length;
  await page.click('#waiting-list [data-waiting="new-face"] [data-action="approve"]');
  await waitFor(page, async () => mock.log.length > m);
  const nf = access().users.find((u) => u.login === "new-face");
  check(U, "Approve adds them as a Contributor in one commit", nf && JSON.stringify(nf.permissions) === JSON.stringify(["regions"]) && nf.id === 5004 && nf.addedBy === "e2e-user", JSON.stringify(nf));
  await waitFor(page, async () => (await page.locator('#waiting-list [data-waiting="new-face"]').count()) === 0);
  check(U, "…and they leave the waiting list", (await page.locator('#waiting-list [data-waiting="new-face"]').count()) === 0);
  await waiter.page.reload();
  await waiter.page.waitForSelector("#main", { state: "visible", timeout: 15000 });
  check(U, "after a reload they're in, on Regions", await waiter.page.isVisible("#tab-regions"));
  await waiter.ctx.close();
  check(U, "no page errors", errors.length === 0, errors.join(" | ") || "none");
  await ctx.close();
});

/* ═════════════ 5. The owner, and removal ═════════════ */
/* ═════════════ Region categories (folders in the Regions tab) ═════════════ */
const K = "categories";
const cats = () => JSON.parse(mock.read("main", "content/categories.json") ?? '{"categories":[]}').categories;
const folders = (page) => page.locator("#regions .rfolder").evaluateAll((els) => els.map((e) => e.dataset.category));
const inFolder = (page, id) => page.locator(`#regions .rfolder[data-category="${id}"] .rcard`).evaluateAll((els) => els.map((e) => e.dataset.region));
/** Runs `fn` (a click) and waits until it has made a commit and the page has reloaded the list. */
async function commits(page, fn) {
  const n = mock.log.length;
  await fn();
  await waitFor(page, async () => mock.log.length > n);
  // The page shows the change at once; wait until the save has landed and the list has been reloaded.
  await waitFor(page, async () => !/saving/.test((await page.textContent("#status")) ?? ""));
  await page.waitForSelector("#regions .rcard", { timeout: 15000 });
}
async function addCategory(page, name) {
  await commits(page, async () => {
    await page.click("#r-new-category");
    await page.fill('dialog [data-field="category-name"]', name);
    await page.click('dialog [data-action="confirm-category"]');
  });
}

// The real content has categories by now; this group starts from none.
mock.externalWrite("main", "content/categories.json", '{"categories":[]}\n');

await step(K, "the owner adds, renames, reorders, fills and deletes categories", async () => {
  const { ctx, page, errors } = await open("Flanz1");
  await page.goto(`${ADMIN}#regions`);
  await page.waitForSelector("#regions .rcard", { timeout: 15000 });
  check(K, "with no categories the list is flat, as before", (await folders(page)).length === 0 && (await page.locator("#regions .rcard").count()) > 2);
  check(K, "no Category menu on cards yet", (await page.locator(".rcat").count()) === 0);
  await addCategory(page, "Kingdoms");
  await addCategory(page, "Seas");
  check(K, "two folders saved with the owner as creator", JSON.stringify(cats().map((k) => [k.id, k.name, k.createdBy?.login])) === JSON.stringify([["kingdoms", "Kingdoms", "Flanz1"], ["seas", "Seas", "Flanz1"]]), JSON.stringify(cats()));
  const f1 = await folders(page);
  check(K, "folders show in order, then Uncategorized with every region", f1.join() === "kingdoms,seas,~uncategorized" && (await inFolder(page, "~uncategorized")).length > 2, f1.join());
  // Duplicate names are refused in the dialog.
  await page.click("#r-new-category");
  await page.fill('dialog [data-field="category-name"]', "seas");
  await page.click('dialog [data-action="confirm-category"]');
  check(K, "a duplicate name is refused", /already a category/.test((await page.textContent("dialog .error")) ?? ""));
  await page.click("dialog.small-dlg .pv-head button");
  // Move a region into Kingdoms with its Category menu.
  await commits(page, () => page.selectOption('[data-region="provinces"] [data-action="category"]', "kingdoms"));
  check(K, "the region moved into the folder", (await inFolder(page, "kingdoms")).join() === "provinces" && !(await inFolder(page, "~uncategorized")).includes("provinces"), (await inFolder(page, "kingdoms")).join());
  check(K, "…and is saved in categories.json", JSON.stringify(cats()[0].regions) === '["provinces"]');
  // Collapse and reopen.
  await page.click('.rfolder[data-category="kingdoms"] .rfolder-toggle');
  check(K, "a folder collapses", (await page.locator('.rfolder[data-category="kingdoms"] .rcard').first().isHidden()) && (await page.getAttribute('.rfolder[data-category="kingdoms"] .rfolder-toggle', "aria-expanded")) === "false");
  await page.screenshot({ path: path.join(OUT, "categories-owner.png"), fullPage: true });
  await page.click('.rfolder[data-category="kingdoms"] .rfolder-toggle');
  // Searching opens folders and hides the empty ones.
  await page.fill("#r-search", "provinces");
  check(K, "searching hides folders with nothing to show, and opens the others", !(await folders(page)).includes("seas") && (await folders(page)).includes("kingdoms") && (await page.locator('.rfolder[data-category="kingdoms"] .rcard').first().isVisible()), (await folders(page)).join());
  await page.fill("#r-search", "");
  // Reorder.
  await commits(page, () => page.click('.rfolder[data-category="seas"] .rfolder-head [data-action="up"]'));
  check(K, "↑ moves a folder up", (await folders(page)).join() === "seas,kingdoms,~uncategorized" && cats()[0].id === "seas", (await folders(page)).join());
  check(K, "first folder can't go further up, last can't go down", (await disabled(page, '.rfolder[data-category="seas"] .rfolder-head [data-action="up"]')) && (await disabled(page, '.rfolder[data-category="kingdoms"] .rfolder-head [data-action="down"]')));
  // Rename.
  await commits(page, async () => {
    await page.click('.rfolder[data-category="seas"] .rfolder-head [data-action="rename"]');
    await page.fill('dialog [data-field="category-name"]', "Oceans");
    await page.click('dialog [data-action="confirm-category"]');
  });
  check(K, "rename keeps the id", cats().some((k) => k.id === "seas" && k.name === "Oceans") && (await page.textContent('.rfolder[data-category="seas"] .rfolder-name')) === "Oceans");
  // Delete a category that has a region: the region isn't deleted.
  await commits(page, async () => {
    await page.click('.rfolder[data-category="kingdoms"] .rfolder-head [data-action="delete"]');
    await page.click('dialog button:has-text("Delete category")');
  });
  check(K, "deleting a category keeps its regions, now uncategorized", cats().length === 1 && !!regionOn("provinces") && (await inFolder(page, "~uncategorized")).includes("provinces"));
  check(K, "no page errors", errors.length === 0, errors.join(" | ") || "none");
  await ctx.close();
});

await step(K, "a category change shows at once, and is undone with the reason if the save fails", async () => {
  mock.externalWrite("main", "content/categories.json", JSON.stringify({ categories: [{ id: "kingdoms", name: "Kingdoms", regions: [], createdBy: { id: 45669787, login: "Flanz1" } }] }, null, 2) + "\n");
  const { ctx, page, errors } = await open("Flanz1");
  await page.goto(`${ADMIN}#regions`);
  await page.waitForSelector("#regions .rfolder", { timeout: 15000 });
  // Hold the final step of every commit, then refuse it.
  let release;
  const held = new Promise((r) => (release = r));
  await ctx.route(/\/git\/refs\/heads\//, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    await held;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "GitHub is having a bad day." }) });
  });
  const before = cats()[0].regions.join();
  await page.selectOption('[data-region="provinces"] [data-action="category"]', "kingdoms");
  await waitFor(page, async () => (await inFolder(page, "kingdoms")).includes("provinces"), 3000);
  check(K, "the region is in its new folder while the save is still pending", (await inFolder(page, "kingdoms")).includes("provinces") && cats()[0].regions.join() === before, (await inFolder(page, "kingdoms")).join());
  check(K, "the status says it's saving", /saving/.test((await page.textContent("#status")) ?? ""));
  release();
  await waitFor(page, async () => /undone/.test((await page.textContent("#status")) ?? ""));
  const msg = (await page.textContent("#status")) ?? "";
  check(K, "a failed save is undone with the reason", /GitHub is having a bad day/.test(msg) && /undone/.test(msg), msg);
  await waitFor(page, async () => !(await inFolder(page, "kingdoms")).includes("provinces"));
  check(K, "…and the region is back where it was", !(await inFolder(page, "kingdoms")).includes("provinces") && (await inFolder(page, "~uncategorized")).includes("provinces"));
  check(K, "no page errors", errors.length === 0, errors.join(" | ") || "none");
  await ctx.close();
});

await step(K, "contributors and editors follow the region rules", async () => {
  // Earlier checks made carto-ann an Editor: put the plain contributor back.
  const people = access();
  people.users.find((u) => u.login === "carto-ann").permissions = ["regions"];
  mock.externalWrite("main", "content/access.json", JSON.stringify(people, null, 2) + "\n");
  await (async () => {
    // Start from a known file: the owner's Kingdoms (with provinces, which isn't Ann's) and a category of Bo's.
    mock.externalWrite(
      "main",
      "content/categories.json",
      JSON.stringify({ categories: [{ id: "kingdoms", name: "Kingdoms", regions: ["provinces"], createdBy: { id: 45669787, login: "Flanz1" } }, { id: "oceans", name: "Oceans", regions: [], createdBy: { id: 5003, login: "drafter-bo" } }] }, null, 2) + "\n",
    );
  })();
  const ann = await open("carto-ann");
  await ann.page.goto(`${ADMIN}#regions`);
  await ann.page.waitForSelector("#regions .rfolder", { timeout: 15000 });
  check(K, "a contributor can add a category", !(await disabled(ann.page, "#r-new-category")));
  check(K, "…but not rename or delete other people's", (await disabled(ann.page, '.rfolder[data-category="kingdoms"] .rfolder-head [data-action="rename"]')) && (await disabled(ann.page, '.rfolder[data-category="kingdoms"] .rfolder-head [data-action="delete"]')));
  check(K, "…with the reason on hover", /created this category/.test((await ann.page.getAttribute('.rfolder[data-category="kingdoms"] .rfolder-head [data-action="rename"]', "title")) ?? ""));
  check(K, "can move her own region, not someone else's", !(await disabled(ann.page, '[data-region="landmark-disc"] [data-action="category"]')) && (await disabled(ann.page, '[data-region="provinces"] [data-action="category"]')));
  await commits(ann.page, () => ann.page.selectOption('[data-region="landmark-disc"] [data-action="category"]', "kingdoms"));
  check(K, "her region goes into the owner's folder", (await inFolder(ann.page, "kingdoms")).includes("landmark-disc"), (await inFolder(ann.page, "kingdoms")).join());
  await addCategory(ann.page, "Ann's places");
  const mineCat = cats().find((k) => k.name === "Ann's places");
  check(K, "her new category is stamped with her", mineCat?.createdBy?.login === "carto-ann", JSON.stringify(mineCat));
  check(K, "she can rename and delete her own", !(await disabled(ann.page, `.rfolder[data-category="${mineCat.id}"] .rfolder-head [data-action="rename"]`)) && !(await disabled(ann.page, `.rfolder[data-category="${mineCat.id}"] .rfolder-head [data-action="delete"]`)));
  await ann.page.screenshot({ path: path.join(OUT, "categories-contributor.png"), fullPage: true });
  // The API refuses what the page hides.
  const cur = JSON.parse(mock.read("main", "content/categories.json"));
  cur.categories.find((k) => k.id === "kingdoms").name = "Mine now";
  const r = await forceCommit(ann.page, { path: "content/categories.json", content: JSON.stringify(cur, null, 2) + "\n" });
  check(K, "renaming someone else's category directly is refused", r.status === 403 && /can't rename the category/.test(r.body.message), `${r.status} ${r.body.message}`);
  await ann.ctx.close();

  const bo = await open("drafter-bo");
  await bo.page.goto(`${ADMIN}#regions`);
  await bo.page.waitForSelector("#regions .rfolder", { timeout: 15000 });
  check(K, "an editor of others' regions can rename and delete anyone's category", !(await disabled(bo.page, '.rfolder[data-category="kingdoms"] .rfolder-head [data-action="rename"]')) && !(await disabled(bo.page, '.rfolder[data-category="kingdoms"] .rfolder-head [data-action="delete"]')));
  check(K, "…and move anyone's region", !(await disabled(bo.page, '[data-region="provinces"] [data-action="category"]')));
  await commits(bo.page, async () => {
    await bo.page.click('.rfolder[data-category="kingdoms"] .rfolder-head [data-action="rename"]');
    await bo.page.fill('dialog [data-field="category-name"]', "Realms");
    await bo.page.click('dialog [data-action="confirm-category"]');
  });
  check(K, "the editor renamed the owner's category", cats().some((k) => k.id === "kingdoms" && k.name === "Realms"));
  await bo.ctx.close();
});

const O = "owner";
await step(O, "owner sees everything; a removed person is locked out", async () => {
  const { ctx, page } = await open("Flanz1");
  await page.goto(ADMIN);
  await page.waitForSelector("#tab-maps", { state: "visible", timeout: 15000 });
  check(O, "owner gets all three tabs", (await visible(page, "#tab-btn-maps")) && (await visible(page, "#tab-btn-regions")) && (await visible(page, "#tab-btn-users")));
  // Remove drafter-bo; their open session can't save any more.
  const bo = await open("drafter-bo");
  await bo.page.goto(`${ADMIN}#regions`);
  await bo.page.waitForSelector("#regions .rcard", { timeout: 15000 });
  await page.goto(`${ADMIN}#users`);
  await page.waitForSelector('#users [data-user="drafter-bo"]', { timeout: 15000 });
  await page.click('#users [data-user="drafter-bo"] [data-action="remove-user"]');
  const n = mock.log.length;
  await page.click("#users-save");
  await waitFor(page, async () => mock.log.length > n);
  check(O, "removed from access.json", !access().users.some((u) => u.login === "drafter-bo"));
  const r = await forceCommit(bo.page, { path: "content/regions/landmark-disc.json", delete: true });
  check(O, "a removed person's save is refused at once", r.status === 403, `${r.status} ${r.body.message}`);
  await bo.ctx.close();
  await ctx.close();
});

await browser.close();
site.close();
const failed = results.filter((r) => !r.ok);
await writeFile(path.join(OUT, "report.json"), JSON.stringify({ results, sessionCheck: !!(await sessionFor("Flanz1")) }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots and report.json in ${OUT}`);
for (const f of failed) console.log(`  ✗ [${f.group}] ${f.name}: ${f.detail}`);
process.exit(failed.length ? 1 : 0);
