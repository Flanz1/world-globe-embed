/**
 * An in-memory GitHub REST API for the admin page's browser tests, installed with Playwright's
 * page.route(). Implements just what src/admin/github.ts uses: contents, the Git Data API
 * (refs, commits, blobs, trees), commit history per path and workflow runs. Blob SHAs are real
 * git blob SHA-1s, so the editor's own SHA bookkeeping can be checked against it.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const blobSha = (buf) => createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest("hex");

/** GitHub accounts the mock knows (for sign-in and the Users tab's lookup). */
export const ACCOUNTS = [
  { id: 45669787, login: "Flanz1", type: "User" },
  { id: 138310181, login: "LoopSimon", type: "User" },
  { id: 5001, login: "e2e-user", type: "User" },
  { id: 5002, login: "carto-ann", type: "User" },
  { id: 5003, login: "drafter-bo", type: "User" },
  { id: 5004, login: "new-face", type: "User" },
  { id: 9001, login: "some-org", type: "Organization" },
];

export class MockGitHub {
  constructor({ repo = "Flanz1/world-globe-embed", root, branches = ["main", "test/region-overlays"], defaultBranch = "main", maxBlobRequest = 40 * 1024 * 1024 }) {
    /** OAuth: code → account, and user token → account (the admin API's sign-in). */
    this.oauthCodes = new Map();
    this.userTokens = new Map();
    /** Content-addressed subtrees served by GET git/trees/<sha>: sha → { flat tree sha, folder prefix }. */
    this.subtrees = new Map();
    /** Like GitHub, refuse blob uploads whose request body is bigger than this ("input too large"). */
    this.maxBlobRequest = maxBlobRequest;
    this.repo = repo;
    this.defaultBranch = defaultBranch;
    this.blobs = new Map();
    this.trees = new Map();
    this.commits = new Map();
    this.refs = new Map();
    /** Every commit made through the API: { branch, sha, message, changes: [{ path, deleted }] } */
    this.log = [];
    /** Every request: { method, path, auth } */
    this.requests = [];
    const files = new Map();
    const walk = (dir) => {
      for (const f of readdirSync(dir)) {
        const p = path.join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else files.set(path.relative(root, p).split(path.sep).join("/"), readFileSync(p));
      }
    };
    walk(path.join(root, "content"));
    const tree = this.putTree(files);
    const c0 = this.putCommit({ message: "initial", tree, parent: null, author: "fixture", date: "2026-11-01T10:00:00Z", changed: [...files.keys()] });
    for (const b of branches) this.refs.set(b, c0);
  }

  putBlob(buf) {
    const sha = blobSha(buf);
    this.blobs.set(sha, buf);
    return sha;
  }
  putTree(files) {
    const sha = `ee${this.trees.size.toString(16).padStart(38, "0")}`;
    this.trees.set(sha, new Map([...files].map(([p, b]) => [p, Buffer.isBuffer(b) ? this.putBlob(b) : b])));
    return sha;
  }
  putCommit(c) {
    const sha = createHash("sha1").update(`commit ${this.commits.size} ${c.message}`).digest("hex");
    this.commits.set(sha, c);
    return sha;
  }
  /** Files at a branch, or at a commit SHA (like GitHub's ?ref=). */
  filesAt(ref) {
    const c = this.commits.get(this.refs.get(ref) ?? ref);
    return c ? this.trees.get(c.tree) : undefined;
  }
  /** A one-time OAuth code that signs in as `login` (what github.com/login/oauth/authorize would hand back). */
  oauthCode(login) {
    const acct = ACCOUNTS.find((a) => a.login === login);
    if (!acct) throw new Error(`mock: unknown account ${login}`);
    const code = `code-${login}-${this.oauthCodes.size}`;
    this.oauthCodes.set(code, acct);
    return code;
  }
  /** One folder level of a flat tree, git-style: files are blobs, folders are content-addressed subtrees. */
  treeListing(flatSha, prefix) {
    const files = this.trees.get(flatSha);
    if (!files) return null;
    const entries = new Map();
    for (const [p, sha] of files) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const name = rest.split("/")[0];
      if (rest.includes("/")) {
        if (!entries.has(name)) entries.set(name, { path: name, mode: "040000", type: "tree", sha: null });
      } else entries.set(name, { path: name, mode: "100644", type: "blob", sha });
    }
    for (const e of entries.values()) {
      if (e.type !== "tree") continue;
      const sub = `${prefix}${e.path}/`;
      const sig = [...files].filter(([p]) => p.startsWith(sub)).map(([p, b]) => `${p.slice(sub.length)} ${b}`).sort().join("\n");
      e.sha = createHash("sha1").update(`tree ${sig}`).digest("hex");
      this.subtrees.set(e.sha, { flat: flatSha, prefix: sub });
    }
    return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
  }
  /** Text of a file on a branch, or null. */
  read(branch, p) {
    const sha = this.filesAt(branch)?.get(p);
    return sha ? this.blobs.get(sha).toString("utf8") : null;
  }
  /** Changes a file behind the admin page's back (to test conflict detection). */
  externalWrite(branch, p, text) {
    const parent = this.refs.get(branch);
    const files = new Map(this.filesAt(branch));
    files.set(p, this.putBlob(Buffer.from(text)));
    const tree = this.putTree(files);
    this.refs.set(branch, this.putCommit({ message: "external edit", tree, parent, author: "someone-else", date: new Date().toISOString(), changed: [p] }));
  }

  async handle(route) {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const auth = req.headers()["authorization"] ?? "";
    this.requests.push({ method, path: url.pathname, auth: auth ? auth.slice(0, 7) + "…" : "" });
    const json = (status, body, headers = {}) =>
      route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*", ...headers }, body: JSON.stringify(body) });
    const p = url.pathname;
    if (url.hostname === "github.com" && method === "POST" && p === "/login/oauth/access_token") {
      const b = JSON.parse(req.postData() ?? "{}");
      const acct = this.oauthCodes.get(b.code);
      if (!acct || !b.client_id || !b.client_secret) return json(200, { error: "bad_verification_code" });
      this.oauthCodes.delete(b.code);
      const token = `ghu_${acct.login}_${this.userTokens.size}`;
      this.userTokens.set(token, acct);
      return json(200, { access_token: token, token_type: "bearer" });
    }
    if (!/^Bearer \S+$/.test(auth)) return json(401, { message: "Bad credentials" });
    const base = `/repos/${this.repo}`;
    const body = req.postData() ? JSON.parse(req.postData()) : null;

    if (p === "/user") {
      const acct = this.userTokens.get(auth.slice(7));
      return json(200, acct ? { id: acct.id, login: acct.login } : { id: 5001, login: "e2e-user" });
    }
    let um;
    if (method === "GET" && (um = /^\/users\/([^/]+)$/.exec(p))) {
      const acct = ACCOUNTS.find((a) => a.login.toLowerCase() === decodeURIComponent(um[1]).toLowerCase());
      return acct ? json(200, acct) : json(404, { message: "Not Found" });
    }
    if (method === "GET" && p === `${base}/installation`) return json(200, { id: 77 });
    if (method === "POST" && p === "/app/installations/77/access_tokens") return json(201, { token: "ghs_mockinstalltoken", expires_at: new Date(Date.now() + 3600_000).toISOString() });
    if (p === base) return json(200, { default_branch: this.defaultBranch, permissions: { push: true } }, { "x-oauth-scopes": "public_repo" });
    if (p === `${base}/actions/runs`) return json(200, { workflow_runs: [] });

    let m;
    if (method === "GET" && (m = /^\/git\/ref\/heads\/(.+)$/.exec(p.slice(base.length)))) {
      const sha = this.refs.get(m[1]);
      return sha ? json(200, { object: { sha } }) : json(404, { message: "Not Found" });
    }
    if (method === "GET" && (m = /^\/git\/commits\/([0-9a-f]+)$/.exec(p.slice(base.length)))) {
      const c = this.commits.get(m[1]);
      return c ? json(200, { sha: m[1], tree: { sha: c.tree }, parents: c.parent ? [{ sha: c.parent }] : [], author: { name: c.author } }) : json(404, { message: "Not Found" });
    }
    if (method === "GET" && (m = /^\/git\/trees\/([0-9a-z]+)$/.exec(p.slice(base.length)))) {
      const sub = this.subtrees.get(m[1]);
      const tree = sub ? this.treeListing(sub.flat, sub.prefix) : this.treeListing(m[1], "");
      return tree ? json(200, { sha: m[1], tree, truncated: false }) : json(404, { message: "Not Found" });
    }
    if (method === "GET" && (m = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(p.slice(base.length)))) {
      const b = this.blobs.get(m[1]);
      return b ? json(200, { sha: m[1], encoding: "base64", content: b.toString("base64"), size: b.length }) : json(404, { message: "Not Found" });
    }
    if (method === "POST" && p === `${base}/git/blobs`) {
      if ((req.postData()?.length ?? 0) > this.maxBlobRequest) return json(422, { message: "Sorry, your input was too large to process. Consider creating the blob in a local clone of the repository and then pushing it to GitHub." });
      return json(201, { sha: this.putBlob(Buffer.from(body.content, body.encoding === "base64" ? "base64" : "utf8")) });
    }
    if (method === "POST" && p === `${base}/git/trees`) {
      const files = new Map(this.trees.get(body.base_tree));
      for (const e of body.tree) {
        if (e.sha === null) files.delete(e.path);
        else files.set(e.path, e.sha);
      }
      const sha = this.putTree(files);
      this.trees.get(sha).changes = body.tree.map((e) => ({ path: e.path, deleted: e.sha === null }));
      return json(201, { sha });
    }
    if (method === "POST" && p === `${base}/git/commits`) {
      const sha = this.putCommit({
        message: body.message,
        tree: body.tree,
        parent: body.parents[0],
        author: body.author?.name ?? "e2e-user",
        date: new Date().toISOString(),
        changed: (this.trees.get(body.tree).changes ?? []).map((c) => c.path),
        changes: this.trees.get(body.tree).changes ?? [],
      });
      return json(201, { sha });
    }
    if (method === "PATCH" && (m = /^\/git\/refs\/heads\/(.+)$/.exec(p.slice(base.length)))) {
      const branch = m[1];
      const c = this.commits.get(body.sha);
      if (!this.refs.has(branch)) return json(422, { message: "Reference does not exist" });
      if (!c || c.parent !== this.refs.get(branch)) return json(422, { message: "Update is not a fast forward" });
      this.refs.set(branch, body.sha);
      this.log.push({ branch, sha: body.sha, message: c.message, changes: c.changes });
      return json(200, { object: { sha: body.sha } });
    }
    if (method === "GET" && p.startsWith(`${base}/contents/`)) {
      const fp = decodeURIComponent(p.slice(`${base}/contents/`.length));
      const branch = url.searchParams.get("ref") ?? this.defaultBranch;
      const files = this.filesAt(branch);
      if (!files) return json(404, { message: "No commit found for the ref" });
      const sha = files.get(fp);
      if (sha) return json(200, { type: "file", path: fp, sha, encoding: "base64", content: this.blobs.get(sha).toString("base64") });
      const prefix = fp.replace(/\/$/, "") + "/";
      const names = new Map();
      for (const k of files.keys()) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        const name = rest.split("/")[0];
        names.set(name, rest.includes("/") ? "dir" : "file");
      }
      if (!names.size) return json(404, { message: "Not Found" });
      return json(200, [...names].map(([name, type]) => ({ name, path: prefix + name, type, sha: type === "file" ? files.get(prefix + name) : undefined })));
    }
    if (method === "GET" && p === `${base}/commits`) {
      const fp = url.searchParams.get("path");
      let sha = this.refs.get(url.searchParams.get("sha") ?? this.defaultBranch);
      while (sha) {
        const c = this.commits.get(sha);
        if (!fp || c.changed?.includes(fp)) return json(200, [{ sha, commit: { message: c.message, author: { name: c.author, date: c.date } }, author: { login: c.author } }]);
        sha = c.parent;
      }
      return json(200, []);
    }
    return json(404, { message: `mock: no route for ${method} ${p}` });
  }
}

/**
 * The mock as a fetch() function (for the admin API running in Node): requests to api.github.com and
 * github.com/login/oauth go to `mock`, through the same handler Playwright's page.route() uses.
 */
export function mockFetch(mock) {
  return async (url, init = {}) => {
    let result = null;
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = init.body == null ? null : typeof init.body === "string" ? init.body : await new Response(init.body).text();
    await mock.handle({
      request: () => ({ url: () => url, method: () => init.method ?? "GET", headers: () => headers, postData: () => body }),
      fulfill: async ({ status, headers: h = {}, contentType, body: b }) => {
        result = new Response(b ?? null, { status, headers: { ...(contentType ? { "content-type": contentType } : {}), ...h } });
      },
    });
    return result;
  };
}
