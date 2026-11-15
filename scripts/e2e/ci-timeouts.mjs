/**
 * Preloaded into every suite by run.mjs (node --import). Gives each browser context a default action and
 * navigation timeout that suits the machine instead of Playwright's 30 s.
 *
 * Why: on a CI runner software GL (swiftshader) can take a minute for one screenshot, so the 30 s default
 * fails suites that are merely slow (page.screenshot / page.click "Timeout 30000ms exceeded"). A real hang still
 * fails, only later. Override with E2E_TIMEOUT (ms). A suite can still pass its own { timeout } to one call.
 *
 * Two more things that only matter under load (many suites sharing a few CPUs):
 *  - waitForFunction calls that pass a 15 s+ { timeout } of their own (waits for the embed to reach "hires", etc.)
 *    are raised to the default above, because the default does not apply to a call that sets its own. Shorter
 *    explicit timeouts are left alone: those are deliberate "this must NOT happen" waits.
 *  - screenshots that fail with CDP's "Unable to capture screenshot" (a software-GL frame that wasn't ready) are
 *    retried a few times; any other error, and a real timeout, still fails at once.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const timeout = Number(process.env.E2E_TIMEOUT) || (process.env.CI ? 120000 : 30000);
const { chromium } = require("playwright");

const MIN_OWN_TIMEOUT = 15000;
const patched = new Set();
function patchProto(obj, name, wrap) {
  const proto = Object.getPrototypeOf(obj);
  const key = `${proto.constructor.name}.${name}`;
  if (patched.has(key) || typeof proto[name] !== "function") return;
  patched.add(key);
  const orig = proto[name];
  proto[name] = wrap(orig);
}
const raiseWait = (orig) => function (fn, arg, opts) {
  if (opts && typeof opts.timeout === "number" && opts.timeout >= MIN_OWN_TIMEOUT && opts.timeout < timeout) opts = { ...opts, timeout };
  return orig.call(this, fn, arg, opts);
};
const retryShot = (orig) => async function (...a) {
  for (let i = 0; ; i++) {
    try { return await orig.apply(this, a); }
    catch (e) {
      if (i >= 3 || !/Unable to capture screenshot/.test(String(e?.message))) throw e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
};
// Playwright's classes aren't exported, so patch them through the first instance of each.
function patchPage(page) {
  patchProto(page, "waitForFunction", raiseWait);
  patchProto(page, "screenshot", retryShot);
  patchProto(page.mainFrame(), "waitForFunction", raiseWait);
  const loc = page.locator("html");
  patchProto(loc, "screenshot", retryShot);
  return page;
}

const launch = chromium.launch.bind(chromium);
chromium.launch = async (...args) => {
  const browser = await launch(...args);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...a) => {
    const ctx = await newContext(...a);
    ctx.setDefaultTimeout(timeout);
    ctx.setDefaultNavigationTimeout(timeout);
    const ctxNewPage = ctx.newPage.bind(ctx);
    ctx.newPage = async (...p) => patchPage(await ctxNewPage(...p));
    return ctx;
  };
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async (...a) => {
    const page = await newPage(...a);
    page.setDefaultTimeout(timeout);
    page.setDefaultNavigationTimeout(timeout);
    return patchPage(page);
  };
  return browser;
};
