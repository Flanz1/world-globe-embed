// e2e-suite: roots=ADMIN,src/admin/account-menu.ts weight=1
/**
 * Browser checks for the admin header on phones and desktop, in headless Chromium.
 *
 *   npm run e2e:header
 *
 * Phone (375 px): the header is one row of title + colour controls + an Account button, with the tabs under it; the
 * repository/user text and Sign out sit in the account menu (keyboard operable: Escape closes it and focus returns
 * to the button). The test-branch warning is a banner under the header. Desktop: the text and Sign out stay in the
 * header and there is no Account button.
 *
 * Runs against the mock GitHub and admin API (no live data). Screenshots and report.json go to .e2e/header/.
 */
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { makeFixture } from "./fixture.mjs";
import { MockGitHub } from "./mock-github.mjs";
import { useAdminApi } from "./admin-api.mjs";
import { port } from "./ports.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const OUT = path.resolve(".e2e/header");
const BRANCH = "test/header";
const SITE = `http://localhost:${port(4173)}`;
await mkdir(OUT, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` (${detail})` : ""}`);
}

const dir = await makeFixture({ quiet: true });
execFileSync("npm", ["run", "build"], { cwd: dir, env: { ...process.env, VITE_CONTENT_BRANCH: BRANCH }, stdio: "pipe" });
const DIST = path.join(dir, "dist");

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".json": "application/json" };
const site = createServer(async (req, res) => {
  let p = path.join(DIST, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (existsSync(p) && statSync(p).isDirectory()) p = path.join(p, "index.html");
  if (!p.startsWith(DIST) || !existsSync(p)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] ?? "application/octet-stream", "Cache-Control": "no-store" });
  res.end(await readFile(p));
}).listen(port(4173), "localhost");

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const mock = new MockGitHub({ root: dir, branches: ["main", BRANCH] });
async function adminPage(as, width = 1440) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 812 : 900 }, deviceScaleFactor: 1 });
  await ctx.route("https://api.github.com/**", (r) => mock.handle(r));
  await useAdminApi(ctx, mock, { branch: BRANCH, as });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && !/^Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await page.goto(`${SITE}/admin/#maps`);
  await page.waitForSelector("#slots .slot", { timeout: 15000 });
  return { ctx, page, errors };
}

try {
  const phone = await adminPage("Flanz1", 375);
  const p = phone.page;
  const vis = (sel) => p.locator(sel).isVisible();
  check("phone: the Account button shows; the repo text and Sign out are not in the header", (await vis("#account")) && !(await vis("#who")) && !(await vis("#forget")));
  check("phone: the colour controls stay in the header", (await vis("#theme-ctl .theme-mode")) && (await vis("#theme-ctl .theme-swatch")));
  const head = await p.locator("header").boundingBox();
  check("phone: the header is two rows (title + controls, tabs), under 150 px", !!head && head.height < 150, `header ${Math.round(head?.height ?? 0)} px`);
  const banner = await p.locator("#branch").boundingBox();
  check("phone: the test-branch warning is a banner under the header", !!banner && !!head && banner.y >= head.y + head.height - 1 && banner.height < 40, JSON.stringify(banner));
  await p.click("#account");
  await p.waitForSelector("#account-menu:popover-open", { timeout: 3000 });
  check("phone: the menu shows who is signed in", /signed in as Flanz1/.test((await p.textContent("#who-menu")) ?? ""), await p.textContent("#who-menu"));
  await p.waitForFunction(() => document.activeElement?.id === "forget-menu", null, { timeout: 3000 }).catch(() => {}); // focus moves after the popover opens; busy CI lags a frame
  check("phone: focus goes to Sign out and the button says it is expanded", (await p.evaluate(() => document.activeElement?.id)) === "forget-menu" && (await p.getAttribute("#account", "aria-expanded")) === "true");
  await p.screenshot({ path: path.join(OUT, "phone-menu.png") });
  await p.keyboard.press("Escape");
  await p.waitForFunction(() => !document.querySelector("#account-menu")?.matches(":popover-open"));
  check("phone: Escape closes the menu and focus returns to the button", (await p.evaluate(() => document.activeElement?.id)) === "account");
  await p.click("#account");
  await p.waitForSelector("#account-menu:popover-open");
  await p.evaluate(() => ((window).__before = 1));
  await p.click("#forget-menu");
  await p.waitForFunction(() => !(window).__before, null, { timeout: 10000 });
  check("phone: Sign out in the menu signs out (the page reloads)", true);
  check("no errors on the phone page", phone.errors.length === 0, phone.errors.join(" | "));
  await phone.ctx.close();

  const tiny = await adminPage("Flanz1", 320);
  const t = await tiny.page.evaluate(() => ({ page: document.documentElement.scrollWidth, w: document.documentElement.clientWidth, tabsScroll: document.querySelector("#tabs").scrollWidth > document.querySelector("#tabs").clientWidth, mask: getComputedStyle(document.querySelector("#tabs")).maskImage, wide: [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && e.offsetParent).slice(0, 6).map((e) => `${e.tagName}.${e.className}#${e.id}[${e.getAttribute("name") ?? e.type ?? ""}] ${Math.round(e.getBoundingClientRect().right)} w=${Math.round(e.getBoundingClientRect().width)}`) }));
  check("320 px: the page doesn't scroll sideways", t.page <= t.w, JSON.stringify(t));
  check("320 px: the tab row scrolls inside itself and fades at the right edge", t.tabsScroll && /linear-gradient/.test(t.mask), JSON.stringify(t));
  await tiny.page.screenshot({ path: path.join(OUT, "phone-320.png") });
  await tiny.ctx.close();

  const desk = await adminPage("Flanz1", 1440);
  const d = desk.page;
  check("desktop: the text and Sign out are in the header, no Account button", (await d.locator("#who").isVisible()) && (await d.locator("#forget").isVisible()) && !(await d.locator("#account").isVisible()));
  check("desktop: the test-branch warning is the banner under the header", /test\/header/.test((await d.textContent("#branch")) ?? "") && (await d.locator("#branch").isVisible()));
  await d.screenshot({ path: path.join(OUT, "desktop.png") });
  check("no errors on the desktop page", desk.errors.length === 0, desk.errors.join(" | "));
  await desk.ctx.close();
} catch (e) {
  check("ran to the end", false, `threw: ${(e && e.message) || e}`.slice(0, 400));
}

await browser.close();
site.close();
await writeFile(path.join(OUT, "report.json"), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed:\n${failed.map((f) => `  ${f.name} ${f.detail}`).join("\n")}` : ""}`);
process.exit(failed.length ? 1 : 0);
