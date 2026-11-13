/**
 * Preloaded into every suite by run.mjs (node --import). Gives each browser context a default action and
 * navigation timeout that suits the machine instead of Playwright's 30 s.
 *
 * Why: on a CI runner software GL (swiftshader) can take a minute for one screenshot, so the 30 s default
 * fails suites that are merely slow (page.screenshot / page.click "Timeout 30000ms exceeded"). A real hang still
 * fails, only later. Override with E2E_TIMEOUT (ms). A suite can still pass its own { timeout } to one call.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const timeout = Number(process.env.E2E_TIMEOUT) || (process.env.CI ? 120000 : 30000);
const { chromium } = require("playwright");

const launch = chromium.launch.bind(chromium);
chromium.launch = async (...args) => {
  const browser = await launch(...args);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...a) => {
    const ctx = await newContext(...a);
    ctx.setDefaultTimeout(timeout);
    ctx.setDefaultNavigationTimeout(timeout);
    return ctx;
  };
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async (...a) => {
    const page = await newPage(...a);
    page.setDefaultTimeout(timeout);
    page.setDefaultNavigationTimeout(timeout);
    return page;
  };
  return browser;
};
