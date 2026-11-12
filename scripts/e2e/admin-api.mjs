/**
 * The admin API (worker/) for the browser checks: the real Worker handler, run in this Node process in
 * front of the in-memory GitHub (mock-github.mjs), reached by the admin page through Playwright routing.
 *
 * Importing this module sets VITE_ADMIN_API, so fixture builds started afterwards point the admin page
 * (and its Content-Security-Policy) at ADMIN_API.
 *
 *   const api = await useAdminApi(ctx, mock, { branch: BRANCH });   // signed in as the owner
 *   await page.goto(`${SITE}/admin/#regions`);
 */
import { generateKeyPairSync } from "node:crypto";
import { handle, resetCaches } from "../../worker/src/handler.ts";
import { sign } from "../../worker/src/crypto.ts";
import { ACCOUNTS, mockFetch } from "./mock-github.mjs";

export const ADMIN_API = "https://admin-api.test";
process.env.VITE_ADMIN_API = ADMIN_API;

const SESSION_KEY = "e2e-session-key-".padEnd(48, "x");
let pem = null;
const appKey = () => (pem ??= generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString());

/** A session token for a mock account (what the sign-in would hand out). */
export async function sessionFor(login, hours = 1) {
  const a = ACCOUNTS.find((x) => x.login === login);
  if (!a) throw new Error(`e2e: unknown account ${login}`);
  return sign({ id: a.id, login: a.login, exp: Math.floor(Date.now() / 1000) + hours * 3600 }, SESSION_KEY);
}

class MemoryKV {
  data = new Map();
  async put(k, _v, o) {
    this.data.set(k, o?.metadata);
  }
  async delete(k) {
    this.data.delete(k);
  }
  async list(o) {
    return { keys: [...this.data].filter(([k]) => k.startsWith(o?.prefix ?? "")).map(([name, metadata]) => ({ name, metadata })) };
  }
}

/**
 * Routes ADMIN_API for `ctx` to the Worker (backed by `mock`), and signs the context in as `as`
 * (a session in sessionStorage before any page script runs). Pass as: null to stay signed out.
 * Returns { env, kv, requests, signInAs(login) }.
 */
export async function useAdminApi(ctx, mock, { branch = "main", as = "Flanz1", adminUrl = "http://localhost:4173/admin/" } = {}) {
  resetCaches();
  const kv = new MemoryKV();
  const env = {
    REPO: mock.repo,
    BRANCH: branch,
    OWNER_ID: "45669787",
    ADMIN_URLS: adminUrl,
    APP_ID: "123",
    APP_PRIVATE_KEY: appKey(),
    APP_CLIENT_ID: "Iv1.e2e",
    APP_CLIENT_SECRET: "e2e-secret",
    SESSION_KEY,
    WAITING: kv,
  };
  const up = mockFetch(mock);
  const requests = [];
  await ctx.route(`${ADMIN_API}/**`, async (route) => {
    const r = route.request();
    const body = r.postDataBuffer();
    requests.push({ method: r.method(), url: r.url() });
    const res = await handle(new Request(r.url(), { method: r.method(), headers: r.headers(), body: body && r.method() !== "GET" ? body : undefined }), env, up);
    await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
  });
  // GitHub's own sign-in page: hands straight back to the callback with a code for the mock account.
  let next = as;
  await ctx.route("https://github.com/login/oauth/authorize**", (route) => {
    const u = new URL(route.request().url());
    const back = new URL(u.searchParams.get("redirect_uri"));
    back.searchParams.set("code", mock.oauthCode(next ?? "Flanz1"));
    back.searchParams.set("state", u.searchParams.get("state"));
    return route.fulfill({ status: 302, headers: { Location: back.href } });
  });
  if (as) {
    const token = await sessionFor(as);
    await ctx.addInitScript((t) => {
      try {
        if (!sessionStorage.getItem("wge-admin-session")) sessionStorage.setItem("wge-admin-session", t);
      } catch {
        /* sandboxed frames */
      }
    }, token);
  }
  return { env, kv, requests, signInAs: (login) => (next = login) };
}
