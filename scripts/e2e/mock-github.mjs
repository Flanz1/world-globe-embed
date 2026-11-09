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

export class MockGitHub {
  constructor({ repo = "Flanz1/world-globe-embed", root, branches = ["main", "test/region-overlays"], defaultBranch = "main" }) {
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
    const sha = `tree${this.trees.size.toString(16).padStart(36, "0")}`;
    this.trees.set(sha, new Map([...files].map(([p, b]) => [p, Buffer.isBuffer(b) ? this.putBlob(b) : b])));
    return sha;
  }
  putCommit(c) {
    const sha = createHash("sha1").update(`commit ${this.commits.size} ${c.message}`).digest("hex");
    this.commits.set(sha, c);
    return sha;
  }
  filesAt(branch) {
    const c = this.commits.get(this.refs.get(branch));
    return this.trees.get(c.tree);
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
    if (!/^Bearer \S+$/.test(auth)) return json(401, { message: "Bad credentials" });
    const base = `/repos/${this.repo}`;
    const p = url.pathname;
    const body = req.postData() ? JSON.parse(req.postData()) : null;

    if (p === "/user") return json(200, { login: "e2e-user" });
    if (p === base) return json(200, { default_branch: this.defaultBranch, permissions: { push: true } }, { "x-oauth-scopes": "public_repo" });
    if (p === `${base}/actions/runs`) return json(200, { workflow_runs: [] });

    let m;
    if (method === "GET" && (m = /^\/git\/ref\/heads\/(.+)$/.exec(p.slice(base.length)))) {
      const sha = this.refs.get(m[1]);
      return sha ? json(200, { object: { sha } }) : json(404, { message: "Not Found" });
    }
    if (method === "GET" && (m = /^\/git\/commits\/([0-9a-f]+)$/.exec(p.slice(base.length)))) {
      const c = this.commits.get(m[1]);
      return c ? json(200, { sha: m[1], tree: { sha: c.tree } }) : json(404, { message: "Not Found" });
    }
    if (method === "POST" && p === `${base}/git/blobs`) {
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
        author: "e2e-user",
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
