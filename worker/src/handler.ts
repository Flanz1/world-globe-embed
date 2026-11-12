/**
 * The admin API: a Cloudflare Worker that is the only thing allowed to write to the repository.
 *
 * - People sign in with GitHub (the GitHub App's user authorization). The API learns their account id
 *   and login, then hands the admin page a short-lived session token, signed with SESSION_KEY.
 * - The admin page talks to /gh/..., a small allow-listed copy of the GitHub REST API it already used.
 *   Reads and the creation of blobs, trees and commits are passed on with the App's own token; nothing
 *   reaches a branch until the admin page moves the branch (PATCH /gh/repos/<repo>/git/refs/heads/<branch>).
 * - That last step is where permissions are enforced: the API diffs the new commit against the branch
 *   head and checks every changed file against content/access.json (src/shared/access.ts), and against
 *   the JSON schemas for regions and access.json. Only then does it move the branch.
 *
 * `handle` takes the upstream fetch as an argument so tests can point it at an in-memory GitHub.
 */
import { ACCESS_PATH, PERMISSIONS, checkChange, pathKind, permissionsOf, type AccessFile, type Actor, type FileDiff, type Permission } from "../../src/shared/access.ts";
import { appJwt, nonce, sign, verify } from "./crypto.ts";
import { validateAccess, validateRegion, type ValidateFn } from "./generated/validators.js";

export interface KV {
  put(key: string, value: string, opts?: { expirationTtl?: number; metadata?: unknown }): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts?: { prefix?: string; limit?: number }): Promise<{ keys: { name: string; metadata?: unknown }[] }>;
}

export interface Env {
  /** owner/name of the content repository. */
  REPO: string;
  /** Branch the admin page writes to (normally the default branch). */
  BRANCH?: string;
  /** GitHub account id of the repository owner: always has every permission. */
  OWNER_ID: string;
  /** Comma-separated URL prefixes the sign-in may return to (the admin page's address, e.g. https://flanz1.github.io/world-globe-embed/admin/). */
  ADMIN_URLS: string;
  APP_ID: string;
  APP_PRIVATE_KEY: string;
  APP_CLIENT_ID: string;
  APP_CLIENT_SECRET: string;
  /** Random secret (32+ characters) that signs sessions. Changing it signs everyone out. */
  SESSION_KEY: string;
  /** People who signed in but aren't on the list yet, shown in the Users tab. Optional. */
  WAITING?: KV;
}

export type Upstream = (url: string, init?: RequestInit) => Promise<Response>;

const API = "https://api.github.com";
const WEB = "https://github.com";
const SESSION_HOURS = 12;
/** A part of a big map upload is 8 MB, ~11 MB as base64 JSON. */
const MAX_BLOB_REQUEST = 16 * 1024 * 1024;
const MAX_CHANGED_FILES = 400;
/** Region and access files whose text a single commit may make the API read (each is a subrequest). */
const MAX_READ_FILES = 24;
const WAITING_DAYS = 30;

export interface Session {
  id: number;
  login: string;
  exp: number;
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/* ── Small caches (per Worker instance) ── */

let installToken: { key: string; token: string; until: number } | null = null;
let accessCache: { key: string; at: number; access: AccessFile | null } | null = null;
/** Forget cached tokens and access lists (tests). */
export function resetCaches(): void {
  installToken = null;
  accessCache = null;
}

/* ── Helpers ── */

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers } });

const allowedUrls = (env: Env) =>
  env.ADMIN_URLS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** Whether the sign-in may send its session to `url`: only the admin page itself, never anywhere else. */
export function returnAllowed(url: string, env: Env): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  const clean = `${u.origin}${u.pathname}`;
  return allowedUrls(env).some((p) => {
    try {
      const a = new URL(p);
      return u.origin === a.origin && clean.startsWith(`${a.origin}${a.pathname}`);
    } catch {
      return false;
    }
  });
}

function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get("Origin");
  if (!origin) return {};
  const ok = allowedUrls(env).some((p) => {
    try {
      return new URL(p).origin === origin;
    } catch {
      return false;
    }
  });
  return ok ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : { Vary: "Origin" };
}

const ownerId = (env: Env) => Number(env.OWNER_ID);
const repoPath = (env: Env) => `/repos/${env.REPO}`;
const branchOf = (env: Env) => env.BRANCH || "main";

async function readJson<T>(r: Response | Request): Promise<T> {
  try {
    return (await r.json()) as T;
  } catch {
    return {} as T;
  }
}

/** An installation token for the App, limited to this repository (contents write, actions read). */
async function appToken(env: Env, up: Upstream): Promise<string> {
  const key = `${env.APP_ID}:${env.REPO}`;
  if (installToken && installToken.key === key && installToken.until > Date.now()) return installToken.token;
  const jwt = await appJwt(env.APP_ID, env.APP_PRIVATE_KEY);
  const h = { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "world-globe-admin" };
  const inst = await up(`${API}${repoPath(env)}/installation`, { headers: h });
  if (!inst.ok) throw new HttpError(502, `The admin API's GitHub App isn't installed on ${env.REPO} (GitHub said ${inst.status}).`);
  const { id } = await readJson<{ id: number }>(inst);
  const r = await up(`${API}/app/installations/${id}/access_tokens`, {
    method: "POST",
    headers: { ...h, "Content-Type": "application/json" },
    body: JSON.stringify({ repositories: [env.REPO.split("/")[1]], permissions: { contents: "write", actions: "read", metadata: "read" } }),
  });
  if (!r.ok) throw new HttpError(502, `GitHub refused the admin API a token (${r.status}).`);
  const t = await readJson<{ token: string; expires_at: string }>(r);
  // Renew five minutes early.
  installToken = { key, token: t.token, until: Date.parse(t.expires_at) - 5 * 60_000 };
  return t.token;
}

/** Calls the GitHub API as the App. */
async function gh(env: Env, up: Upstream, path: string, init: RequestInit = {}): Promise<Response> {
  const token = await appToken(env, up);
  return up(`${API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "world-globe-admin",
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
}

async function ghJson<T>(env: Env, up: Upstream, path: string, init: RequestInit = {}): Promise<T> {
  const r = await gh(env, up, path, init);
  if (!r.ok) {
    const b = await readJson<{ message?: string }>(r);
    throw new HttpError(r.status, b.message ?? `GitHub answered ${r.status}.`);
  }
  return readJson<T>(r);
}

const utf8 = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

async function blobText(env: Env, up: Upstream, sha: string): Promise<string> {
  const b = await ghJson<{ content: string; encoding: string }>(env, up, `${repoPath(env)}/git/blobs/${sha}`);
  return b.encoding === "base64" ? utf8(b.content) : b.content;
}

/** content/access.json at a commit (or the branch), or null when there is none. */
async function loadAccess(env: Env, up: Upstream, ref: string): Promise<AccessFile | null> {
  const r = await gh(env, up, `${repoPath(env)}/contents/${ACCESS_PATH}?ref=${encodeURIComponent(ref)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new HttpError(502, `Couldn't read ${ACCESS_PATH} (${r.status}).`);
  const f = await readJson<{ content: string }>(r);
  try {
    const a = JSON.parse(utf8(f.content)) as AccessFile;
    return Array.isArray(a?.users) ? a : null;
  } catch {
    return null;
  }
}

/** The access list, cached for 30 s (writes always read it fresh at the commit they build on). */
async function cachedAccess(env: Env, up: Upstream): Promise<AccessFile | null> {
  const key = `${env.REPO}@${branchOf(env)}`;
  if (accessCache && accessCache.key === key && Date.now() - accessCache.at < 30_000) return accessCache.access;
  const access = await loadAccess(env, up, branchOf(env));
  accessCache = { key, at: Date.now(), access };
  return access;
}

function actorOf(s: Session, access: AccessFile | null, env: Env): Actor | null {
  const perms = permissionsOf(access, s.id, ownerId(env));
  return perms ? { id: s.id, login: s.login, permissions: perms, owner: s.id === ownerId(env) } : null;
}

async function session(req: Request, env: Env): Promise<Session> {
  const m = /^Bearer (\S+)$/.exec(req.headers.get("Authorization") ?? "");
  const s = m ? await verify<Session>(m[1], env.SESSION_KEY) : null;
  if (!s || !Number.isSafeInteger(s.id) || typeof s.login !== "string") throw new HttpError(401, "You're signed out (the session expired). Sign in again.");
  return s;
}

async function noteWaiting(env: Env, s: { id: number; login: string }): Promise<void> {
  if (!env.WAITING) return;
  try {
    await env.WAITING.put(`w:${s.id}`, "", { expirationTtl: WAITING_DAYS * 86400, metadata: { id: s.id, login: s.login, at: new Date().toISOString() } });
  } catch {
    /* The waiting list is a convenience; never fail sign-in over it. */
  }
}

/** A signed-in person who is on the list (or the owner). */
async function listedActor(req: Request, env: Env, up: Upstream): Promise<Actor> {
  const s = await session(req, env);
  const actor = actorOf(s, await cachedAccess(env, up), env);
  if (!actor) {
    await noteWaiting(env, s);
    throw new HttpError(403, `${s.login} isn't on the admin list yet. Ask the site's owner to add you in the Users tab.`, { notListed: true, login: s.login });
  }
  return actor;
}

const WRITE_PERMS: Permission[] = ["maps", "regions", "editOthers", "deleteOthers", "users"];
const canWriteAnything = (a: Actor) => a.owner || WRITE_PERMS.some((p) => a.permissions.has(p));

/* ── Sign-in ── */

async function authLogin(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const ret = url.searchParams.get("return") ?? "";
  if (!returnAllowed(ret, env)) return new Response("This sign-in link doesn't come from the admin page.", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  const state = await sign({ r: ret, n: nonce(), exp: Math.floor(Date.now() / 1000) + 600 }, env.SESSION_KEY);
  const to = new URL(`${WEB}/login/oauth/authorize`);
  to.searchParams.set("client_id", env.APP_CLIENT_ID);
  to.searchParams.set("redirect_uri", new URL("/auth/callback", url).href);
  to.searchParams.set("state", state);
  to.searchParams.set("allow_signup", "false");
  return new Response(null, { status: 302, headers: { Location: to.href, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

async function authCallback(req: Request, env: Env, up: Upstream): Promise<Response> {
  const url = new URL(req.url);
  const st = await verify<{ r: string; exp: number }>(url.searchParams.get("state") ?? "", env.SESSION_KEY);
  if (!st || !returnAllowed(st.r, env)) return new Response("This sign-in link has expired. Go back to the admin page and sign in again.", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  const back = (fragment: string) => new Response(null, { status: 302, headers: { Location: `${st.r.split("#")[0]}#${fragment}`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  const code = url.searchParams.get("code");
  if (!code) return back(`signin-error=${encodeURIComponent("GitHub sign-in was cancelled.")}`);
  const tok = await up(`${WEB}/login/oauth/access_token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "world-globe-admin" },
    body: JSON.stringify({ client_id: env.APP_CLIENT_ID, client_secret: env.APP_CLIENT_SECRET, code, redirect_uri: new URL("/auth/callback", url).href }),
  });
  const t = await readJson<{ access_token?: string }>(tok);
  if (!tok.ok || !t.access_token) return back(`signin-error=${encodeURIComponent("GitHub didn't confirm the sign-in. Try again.")}`);
  const me = await up(`${API}/user`, { headers: { Authorization: `Bearer ${t.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "world-globe-admin" } });
  const u = await readJson<{ id?: number; login?: string }>(me);
  if (!me.ok || !Number.isSafeInteger(u.id) || typeof u.login !== "string") return back(`signin-error=${encodeURIComponent("Couldn't read your GitHub account. Try again.")}`);
  // The user's GitHub token isn't kept: the API only needed to learn who they are.
  const s: Session = { id: u.id!, login: u.login, exp: Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600 };
  return back(`session=${await sign(s, env.SESSION_KEY)}`);
}

/* ── Session info, users, waiting list ── */

async function sessionInfo(req: Request, env: Env, up: Upstream): Promise<Response> {
  const a = await listedActor(req, env, up);
  return json(200, { id: a.id, login: a.login, owner: a.owner, permissions: PERMISSIONS.filter((p) => a.owner || a.permissions.has(p)), repo: env.REPO, branch: branchOf(env) });
}

function needUsers(a: Actor): void {
  if (!a.owner && !a.permissions.has("users")) throw new HttpError(403, "You don't have permission to manage users.");
}

async function lookupUser(req: Request, env: Env, up: Upstream, login: string): Promise<Response> {
  needUsers(await listedActor(req, env, up));
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) throw new HttpError(400, "That isn't a GitHub username.");
  const r = await gh(env, up, `/users/${encodeURIComponent(login)}`);
  if (r.status === 404) throw new HttpError(404, `There's no GitHub account called "${login}".`);
  const u = await readJson<{ id: number; login: string; type: string }>(r);
  if (!r.ok) throw new HttpError(502, "Couldn't look the account up on GitHub.");
  if (u.type !== "User") throw new HttpError(400, `"${u.login}" is an organization or bot, not a person.`);
  return json(200, { id: u.id, login: u.login });
}

async function waitingList(req: Request, env: Env, up: Upstream): Promise<Response> {
  needUsers(await listedActor(req, env, up));
  if (!env.WAITING) return json(200, []);
  const { keys } = await env.WAITING.list({ prefix: "w:", limit: 100 });
  return json(200, keys.map((k) => k.metadata).filter(Boolean));
}

async function dismissWaiting(req: Request, env: Env, up: Upstream, id: string): Promise<Response> {
  needUsers(await listedActor(req, env, up));
  if (!/^\d{1,15}$/.test(id)) throw new HttpError(400, "Bad account id.");
  await env.WAITING?.delete(`w:${id}`);
  return new Response(null, { status: 204 });
}

/* ── The GitHub proxy ── */

interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
}
interface Changed {
  path: string;
  before: string | null;
  after: string | null;
  mode?: string;
  type?: string;
}

async function treeEntries(env: Env, up: Upstream, sha: string | null): Promise<Map<string, TreeEntry>> {
  if (!sha) return new Map();
  const t = await ghJson<{ tree: TreeEntry[]; truncated?: boolean }>(env, up, `${repoPath(env)}/git/trees/${sha}`);
  if (t.truncated) throw new HttpError(422, "That folder is too big for the admin API to check.");
  return new Map(t.tree.map((e) => [e.path, e]));
}

/**
 * Every file that differs between two trees, descending only into folders that changed. Anything that
 * changes outside content/ is reported as the folder itself (it's refused anyway).
 */
export async function diffTrees(env: Env, up: Upstream, a: string | null, b: string | null, prefix = "", out: Changed[] = []): Promise<Changed[]> {
  const [ea, eb] = await Promise.all([treeEntries(env, up, a), treeEntries(env, up, b)]);
  for (const name of new Set([...ea.keys(), ...eb.keys()])) {
    const x = ea.get(name);
    const y = eb.get(name);
    if (x && y && x.sha === y.sha && x.type === y.type && x.mode === y.mode) continue;
    const full = prefix + name;
    if (out.length > MAX_CHANGED_FILES) throw new HttpError(422, `That commit changes more than ${MAX_CHANGED_FILES} files.`);
    const xt = x?.type === "tree";
    const yt = y?.type === "tree";
    if (xt || yt) {
      if (!full.startsWith("content")) {
        out.push({ path: `${full}/`, before: x?.sha ?? null, after: y?.sha ?? null, type: "tree" });
        continue;
      }
      if (x && !xt) out.push({ path: full, before: x.sha, after: null, mode: x.mode, type: x.type });
      if (y && !yt) out.push({ path: full, before: null, after: y.sha, mode: y.mode, type: y.type });
      await diffTrees(env, up, xt ? x!.sha : null, yt ? y!.sha : null, `${full}/`, out);
    } else out.push({ path: full, before: x?.sha ?? null, after: y?.sha ?? null, mode: y?.mode, type: y?.type });
  }
  return out;
}

function schemaError(v: ValidateFn, data: unknown, file: string): string | null {
  if (v(data)) return null;
  const e = v.errors?.[0];
  return `${file} doesn't match its schema${e ? `: ${e.instancePath || "(top level)"} ${e.message ?? ""}` : ""}.`;
}

/** Checks a commit the admin page wants to put on the branch; returns the reasons it's refused (empty = fine). */
export async function reviewCommit(env: Env, up: Upstream, actor: Actor, parentSha: string, commitSha: string): Promise<string[]> {
  const [parent, next] = await Promise.all([
    ghJson<{ tree: { sha: string } }>(env, up, `${repoPath(env)}/git/commits/${parentSha}`),
    ghJson<{ tree: { sha: string } }>(env, up, `${repoPath(env)}/git/commits/${commitSha}`),
  ]);
  const changes = await diffTrees(env, up, parent.tree.sha, next.tree.sha);
  const problems: string[] = [];
  const reads = changes.filter((c) => {
    const k = pathKind(c.path);
    return k === "region" || k === "access";
  });
  if (reads.length > MAX_READ_FILES) return [`That commit changes ${reads.length} regions; the admin page saves at most ${MAX_READ_FILES} at a time.`];
  for (const c of changes) {
    if (c.type === "tree") {
      problems.push(checkChange({ path: c.path, before: null, after: null }, actor, ownerId(env)) ?? `${c.path} can't be changed here.`);
      continue;
    }
    if (c.after && (c.type !== "blob" || c.mode !== "100644")) {
      problems.push(`${c.path} must be a plain file.`);
      continue;
    }
    const kind = pathKind(c.path);
    const d: FileDiff = { path: c.path, before: null, after: null };
    if (kind === "region" || kind === "access") {
      [d.before, d.after] = await Promise.all([c.before ? blobText(env, up, c.before) : null, c.after ? blobText(env, up, c.after) : null]);
    } else {
      // Only whether the file exists matters for these.
      d.before = c.before ? "" : null;
      d.after = c.after ? "" : null;
    }
    const why = checkChange(d, actor, ownerId(env));
    if (why) {
      problems.push(why);
      continue;
    }
    if (d.after !== null && (kind === "region" || kind === "access")) {
      let data: unknown;
      try {
        data = JSON.parse(d.after);
      } catch {
        problems.push(`${c.path} isn't valid JSON.`);
        continue;
      }
      const err = schemaError(kind === "region" ? validateRegion : validateAccess, data, c.path);
      if (err) problems.push(err);
    }
  }
  return problems;
}

/** The admin page's whole GitHub vocabulary, and nothing more. */
async function proxy(req: Request, env: Env, up: Upstream, path: string, url: URL): Promise<Response> {
  const method = req.method;
  const base = repoPath(env);
  // GitHub treats owner/name case-insensitively; so does this check.
  if (path.toLowerCase() !== base.toLowerCase() && !path.toLowerCase().startsWith(`${base.toLowerCase()}/`))
    throw new HttpError(404, `The admin API only works on ${env.REPO}.`);
  const rest = path.slice(base.length);
  const actor = await listedActor(req, env, up);
  const pass = async (r: Response) => new Response(r.body, { status: r.status, headers: { "Content-Type": r.headers.get("Content-Type") ?? "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  const q = (keys: string[]) => {
    const out = new URLSearchParams();
    for (const k of keys) {
      const v = url.searchParams.get(k);
      if (v !== null) out.set(k, v);
    }
    const s = out.toString();
    return s ? `?${s}` : "";
  };
  let m: RegExpExecArray | null;

  if (method === "GET") {
    if (rest === "") {
      const r = await ghJson<{ default_branch: string }>(env, up, base);
      return json(200, { default_branch: r.default_branch, permissions: { push: canWriteAnything(actor) } });
    }
    if ((m = /^\/contents\/([A-Za-z0-9._/-]{1,300})$/.exec(rest)) && !m[1].includes("..")) return pass(await gh(env, up, `${base}/contents/${m[1]}${q(["ref"])}`));
    if (/^\/git\/ref\/heads\/[A-Za-z0-9._/-]{1,200}$/.test(rest) && !rest.includes("..")) return pass(await gh(env, up, `${base}${rest}`));
    if (/^\/git\/commits\/[0-9a-f]{40}$/.test(rest)) return pass(await gh(env, up, `${base}${rest}`));
    if (rest === "/commits") return pass(await gh(env, up, `${base}/commits${q(["path", "sha", "per_page"])}`));
    if (rest === "/actions/runs") return pass(await gh(env, up, `${base}/actions/runs${q(["per_page", "branch"])}`));
  }
  if (method === "POST" && ["/git/blobs", "/git/trees", "/git/commits"].includes(rest)) {
    if (!canWriteAnything(actor)) throw new HttpError(403, "You can look around, but you don't have permission to change anything.");
    if (rest === "/git/blobs") {
      const len = Number(req.headers.get("Content-Length") ?? NaN);
      if (len > MAX_BLOB_REQUEST) throw new HttpError(413, "That upload part is too big.");
      const body = await req.text();
      if (body.length > MAX_BLOB_REQUEST) throw new HttpError(413, "That upload part is too big.");
      return pass(await gh(env, up, `${base}/git/blobs`, { method: "POST", body }));
    }
    const body = await readJson<Record<string, unknown>>(req);
    if (rest === "/git/trees") {
      const tree = body.tree;
      if (typeof body.base_tree !== "string" || !Array.isArray(tree) || tree.length > MAX_CHANGED_FILES) throw new HttpError(422, "Bad tree.");
      for (const e of tree as Record<string, unknown>[]) {
        if (typeof e?.path !== "string" || e.mode !== "100644" || e.type !== "blob" || !(e.sha === null || typeof e.sha === "string") || "content" in e)
          throw new HttpError(422, "Bad tree entry.");
        const why = pathKind(e.path) === "outside" ? `Only files in content/ can be changed from the admin page (not ${e.path}).` : null;
        if (why) throw new HttpError(403, why);
      }
      return pass(await gh(env, up, `${base}/git/trees`, { method: "POST", body: JSON.stringify({ base_tree: body.base_tree, tree }) }));
    }
    // A commit always has exactly one parent, and is credited to the person signed in (GitHub links the noreply address to their account).
    const parents = body.parents;
    if (typeof body.message !== "string" || typeof body.tree !== "string" || !Array.isArray(parents) || parents.length !== 1 || typeof parents[0] !== "string")
      throw new HttpError(422, "Bad commit.");
    const author = { name: actor.login, email: `${actor.id}+${actor.login}@users.noreply.github.com` };
    return pass(await gh(env, up, `${base}/git/commits`, { method: "POST", body: JSON.stringify({ message: body.message.slice(0, 2000), tree: body.tree, parents, author }) }));
  }
  if (method === "PATCH" && (m = /^\/git\/refs\/heads\/([A-Za-z0-9._/-]{1,200})$/.exec(rest))) {
    const branch = m[1];
    if (branch !== branchOf(env)) throw new HttpError(403, `The admin API only writes to the branch ${branchOf(env)}.`);
    const body = await readJson<{ sha?: unknown; force?: unknown }>(req);
    if (typeof body.sha !== "string" || !/^[0-9a-f]{40}$/.test(body.sha) || body.force) throw new HttpError(422, "Bad branch update.");
    const head = (await ghJson<{ object: { sha: string } }>(env, up, `${base}/git/ref/heads/${branch}`)).object.sha;
    const commit = await ghJson<{ parents?: { sha: string }[] }>(env, up, `${base}/git/commits/${body.sha}`);
    // Same answer GitHub gives, so the admin page rebuilds its commit on the new head and tries again.
    if (commit.parents?.length !== 1 || commit.parents[0].sha !== head) throw new HttpError(422, "Update is not a fast forward");
    // Permissions as of the commit being built on, read fresh (not from the cache).
    const fresh = actorOf({ id: actor.id, login: actor.login, exp: 0 }, await loadAccess(env, up, head), env);
    if (!fresh) throw new HttpError(403, `${actor.login} isn't on the admin list any more.`);
    const problems = await reviewCommit(env, up, fresh, head, body.sha);
    if (problems.length) throw new HttpError(403, problems.length === 1 ? problems[0] : `${problems[0]} (and ${problems.length - 1} more)`, { errors: problems });
    const r = await gh(env, up, `${base}/git/refs/heads/${branch}`, { method: "PATCH", body: JSON.stringify({ sha: body.sha, force: false }) });
    if (r.ok) accessCache = null;
    return pass(r);
  }
  throw new HttpError(404, `The admin API doesn't do ${method} ${rest || "/"}.`);
}

/* ── Entry ── */

export async function handle(req: Request, env: Env, up: Upstream): Promise<Response> {
  const cors = corsHeaders(req, env);
  const withCors = (r: Response) => {
    const out = new Response(r.body, r);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  };
  if (req.method === "OPTIONS")
    return new Response(null, {
      status: 204,
      headers: { ...cors, "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE", "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, X-GitHub-Api-Version", "Access-Control-Max-Age": "600" },
    });
  const url = new URL(req.url);
  const p = url.pathname;
  try {
    if (!env.SESSION_KEY || env.SESSION_KEY.length < 32) throw new HttpError(500, "The admin API isn't set up yet (SESSION_KEY is missing or too short).");
    if (req.method === "GET" && p === "/auth/login") return await authLogin(req, env);
    if (req.method === "GET" && p === "/auth/callback") return await authCallback(req, env, up);
    let m: RegExpExecArray | null;
    if (req.method === "GET" && p === "/session") return withCors(await sessionInfo(req, env, up));
    if (req.method === "GET" && (m = /^\/users\/([^/]+)$/.exec(p))) return withCors(await lookupUser(req, env, up, decodeURIComponent(m[1])));
    if (req.method === "GET" && p === "/waiting") return withCors(await waitingList(req, env, up));
    if (req.method === "DELETE" && (m = /^\/waiting\/([^/]+)$/.exec(p))) return withCors(await dismissWaiting(req, env, up, m[1]));
    if (p.startsWith("/gh/")) return withCors(await proxy(req, env, up, p.slice(3), url));
    if (p === "/") return new Response("World globe admin API. Sign in from the admin page.", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    throw new HttpError(404, "Not found.");
  } catch (e) {
    if (e instanceof HttpError) return withCors(json(e.status, { message: e.message, ...e.extra }));
    if (globalThis.process?.env?.ADMIN_API_DEBUG) console.error(e);
    return withCors(json(500, { message: "The admin API hit an unexpected error." }));
  }
}
