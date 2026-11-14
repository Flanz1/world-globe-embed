/**
 * Minimal GitHub REST client for the admin page. It talks to the admin API (worker/), which signs people
 * in with GitHub, checks their permissions and makes the commits as the site's GitHub App: /gh/... there
 * is an allow-listed copy of the GitHub REST endpoints this file uses. The session token is only ever
 * placed in the Authorization header of requests to the admin API.
 */
import type { Permission } from "../shared/access.ts";

/** `fn` over `items`, at most `limit` at a time; results in order, the first failure rejects. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

/** Whether a failed request is worth sending again: the network dropped it, GitHub is busy, or a rate limit. */
const transient = (e: unknown): boolean => e instanceof GitHubError ? [0, 429, 500, 502, 503, 504].includes(e.status) || (e.status === 403 && /rate limit|abuse/i.test(e.message)) : e instanceof TypeError;

/** Runs `fn`, again up to `tries` times (with a growing pause) when it fails for a passing reason. */
export async function retrying<T>(fn: () => Promise<T>, tries = 3, pause = 1000): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= tries || !transient(e)) throw e;
      await new Promise((r) => setTimeout(r, pause * attempt));
    }
  }
}

export class GitHubError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface FileChange {
  path: string;
  /** UTF-8 text, or base64 when `base64` is true. Ignored when `delete` is set. */
  content: string;
  base64?: boolean;
  /** Remove the file in this commit instead of writing it. */
  delete?: boolean;
  /** A blob already uploaded with createBlob (then `content` is ignored). */
  sha?: string;
}

/** The last commit that touched a file. */
export interface FileCommit {
  author: string;
  date: string;
}

/** A branch name that is safe to put in an API path (no "..", no spaces or odd characters). */
export const BRANCH = /^(?!.*\.\.)(?!\/)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/;

export interface WorkflowRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
  head_commit?: { message: string } | null;
}

/** Who is signed in, from the admin API. */
export interface Me {
  id: number;
  login: string;
  /** The repository owner: every permission, always. */
  owner: boolean;
  permissions: Permission[];
}

/** People who signed in but aren't on the list yet. */
export interface Waiting {
  id: number;
  login: string;
  at: string;
}

const utf8ToBase64 = (s: string): string => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const base64ToUtf8 = (b64: string): string =>
  new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

/** The admin API refused a request because the person isn't on the admin list (yet). */
export class NotListed extends GitHubError {
  constructor(
    message: string,
    public login: string,
  ) {
    super(403, message);
  }
}

export class GitHub {
  /** The branch every read and commit goes to (the admin API decides which). */
  branch = "main";
  /** The repository's default branch (what GitHub Pages deploys). */
  defaultBranch = "main";
  private readonly API: string;
  private readonly root: string;

  /**
   * @param api the admin API's address (VITE_ADMIN_API at build time).
   */
  constructor(
    private token: string,
    public repo: string,
    api: string,
  ) {
    this.API = `${api.replace(/\/+$/, "")}/gh`;
    this.root = api.replace(/\/+$/, "");
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    return (await this.send<T>(path, init)).data;
  }

  /**
   * Uploads one blob (base64) and returns its sha, reporting upload progress. Uses XHR because fetch
   * can't report upload progress. Big files go up as several of these (see the admin upload).
   */
  createBlob(base64: string, onProgress?: (loaded: number, total: number) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open("POST", `${this.API}/repos/${this.repo}/git/blobs`);
      x.setRequestHeader("Accept", "application/vnd.github+json");
      x.setRequestHeader("X-GitHub-Api-Version", "2022-11-28");
      x.setRequestHeader("Authorization", `Bearer ${this.token}`);
      x.setRequestHeader("Content-Type", "application/json");
      if (onProgress) x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded, e.total);
      x.onerror = () => reject(new GitHubError(0, "The upload was cut off (network error). Try again."));
      x.onload = () => {
        let body: { sha?: string; message?: string } = {};
        try {
          body = JSON.parse(x.responseText) as typeof body;
        } catch {
          /* no JSON body */
        }
        if (x.status >= 200 && x.status < 300 && body.sha) return resolve(body.sha);
        let msg = body.message ?? x.statusText;
        if (x.status === 401) msg = "You're signed out (the session expired). Sign in again.";
        reject(new GitHubError(x.status, msg));
      };
      x.send(JSON.stringify({ content: base64, encoding: "base64" }));
    });
  }

  private async send<T>(path: string, init: RequestInit = {}, base = this.API): Promise<{ data: T; headers: Headers }> {
    const r = await fetch(`${base}${path}`, {
      cache: "no-store",
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${this.token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!r.ok) {
      let body: { message?: string; notListed?: boolean; login?: string } = {};
      try {
        body = (await r.json()) as typeof body;
      } catch {
        /* no JSON body */
      }
      const msg = r.status === 401 ? "You're signed out (the session expired). Sign in again." : (body.message ?? r.statusText);
      if (r.status === 403 && body.notListed) throw new NotListed(msg, body.login ?? "");
      throw new GitHubError(r.status, msg);
    }
    return { data: (r.status === 204 ? undefined : await r.json()) as T, headers: r.headers };
  }

  /** Who is signed in and what they may do; also learns the branch to work on. Throws NotListed for someone not on the list. */
  async whoAmI(): Promise<Me> {
    const [me, repo] = await Promise.all([
      this.send<Me & { branch: string }>("/session", {}, this.root),
      this.send<{ default_branch: string }>(`/repos/${this.repo}`),
    ]);
    this.defaultBranch = repo.data.default_branch;
    if (!BRANCH.test(me.data.branch)) throw new Error("The admin API named an odd branch.");
    this.branch = me.data.branch;
    const { id, login, owner, permissions } = me.data;
    return { id, login, owner, permissions };
  }

  /** A GitHub account by username (Users tab). */
  async lookupUser(login: string): Promise<{ id: number; login: string }> {
    return (await this.send<{ id: number; login: string }>(`/users/${encodeURIComponent(login)}`, {}, this.root)).data;
  }

  async waiting(): Promise<Waiting[]> {
    return (await this.send<Waiting[]>("/waiting", {}, this.root)).data;
  }

  async dismissWaiting(id: number): Promise<void> {
    await this.send(`/waiting/${id}`, { method: "DELETE" }, this.root);
  }

  async readText(path: string): Promise<string> {
    return (await this.readFile(path)).text;
  }

  /** A file's text and blob SHA (to notice when someone else changed it). */
  async readFile(path: string): Promise<{ text: string; sha: string }> {
    const f = await this.request<{ content: string; encoding: string; sha: string; size?: number }>(
      `/repos/${this.repo}/contents/${path}?ref=${encodeURIComponent(this.branch)}`,
    );
    // The contents API leaves the content out of files over 1 MB (a big region is a few MB): read the blob instead.
    if (f.encoding === "none" || (!f.content && (f.size ?? 0) > 0)) {
      const b = await this.request<{ content: string; encoding: string }>(`/repos/${this.repo}/git/blobs/${f.sha}`);
      return { text: b.encoding === "base64" ? base64ToUtf8(b.content) : b.content, sha: f.sha };
    }
    return { text: base64ToUtf8(f.content), sha: f.sha };
  }

  /** Blob SHA of a file on the branch, or null if it doesn't exist. */
  async fileSha(path: string): Promise<string | null> {
    try {
      return (await this.request<{ sha: string }>(`/repos/${this.repo}/contents/${path}?ref=${encodeURIComponent(this.branch)}`)).sha;
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) return null;
      throw e;
    }
  }

  /** Author and date of the last commit on the branch that touched `path`. */
  async lastCommit(path: string): Promise<FileCommit | null> {
    const list = await this.request<{ commit: { author?: { name?: string; date?: string } }; author?: { login?: string } | null }[]>(
      `/repos/${this.repo}/commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(this.branch)}&per_page=1`,
    );
    const c = list[0];
    if (!c) return null;
    return { author: c.author?.login ?? c.commit.author?.name ?? "unknown", date: c.commit.author?.date ?? "" };
  }

  /**
   * Every file in a folder of the branch with its blob SHA, listed through the git trees API: unlike the
   * contents API it isn't cut off at 1,000 files, and one request per folder level is all it takes (no
   * request per file). A missing folder is empty.
   */
  async listTree(path: string): Promise<{ name: string; path: string; sha: string; type: string }[]> {
    const ref = await this.request<{ object: { sha: string } }>(`/repos/${this.repo}/git/ref/heads/${this.branch}`);
    const commit = await this.request<{ tree: { sha: string } }>(`/repos/${this.repo}/git/commits/${ref.object.sha}`);
    let sha = commit.tree.sha;
    for (const part of path.split("/").filter(Boolean)) {
      const t = await this.request<{ tree: { path: string; type: string; sha: string }[] }>(`/repos/${this.repo}/git/trees/${sha}`, { cache: "default" });
      const next = t.tree.find((e) => e.path === part && e.type === "tree");
      if (!next) return [];
      sha = next.sha;
    }
    const t = await this.request<{ tree: { path: string; type: string; sha: string }[]; truncated?: boolean }>(`/repos/${this.repo}/git/trees/${sha}`, { cache: "default" });
    if (t.truncated) throw new GitHubError(422, `The folder ${path} is too big to list.`);
    return t.tree.map((e) => ({ name: e.path, path: `${path.replace(/\/$/, "")}/${e.path}`, sha: e.sha, type: e.type === "blob" ? "file" : "dir" }));
  }

  /** A file's text by blob SHA. A blob never changes, so the browser caches it and the next listing only fetches new ones. */
  async readBlob(sha: string): Promise<string> {
    const b = await this.request<{ content: string; encoding: string }>(`/repos/${this.repo}/git/blobs/${sha}`, { cache: "default" });
    return b.encoding === "base64" ? base64ToUtf8(b.content) : b.content;
  }

  async listDir(path: string): Promise<{ name: string; path: string; type: string }[]> {
    try {
      return await this.request(`/repos/${this.repo}/contents/${path}?ref=${encodeURIComponent(this.branch)}`);
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) return [];
      throw e;
    }
  }

  /**
   * Makes exactly one commit containing all `changes`, via the Git Data API.
   * `build` is called with fresh state on each attempt, so a concurrent push just causes a retry.
   */
  async commit(message: string, build: () => Promise<FileChange[]>): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      const ref = await this.request<{ object: { sha: string } }>(`/repos/${this.repo}/git/ref/heads/${this.branch}`);
      const parent = await this.request<{ tree: { sha: string } }>(`/repos/${this.repo}/git/commits/${ref.object.sha}`);
      const changes = await build();
      // A few uploads at a time, each retried when GitHub or the network hiccups: a save of dozens of big files
      // sent all at once trips GitHub's rate limits and the Worker's limits, and one failure loses the whole save.
      const tree = await mapLimit(changes, 4, async (c) => {
        // A null sha removes the file from the tree.
        if (c.delete) return { path: c.path, mode: "100644", type: "blob", sha: null };
        if (c.sha) return { path: c.path, mode: "100644", type: "blob", sha: c.sha };
        const body = JSON.stringify({ content: c.base64 ? c.content : utf8ToBase64(c.content), encoding: "base64" });
        const blob = await retrying(() => this.request<{ sha: string }>(`/repos/${this.repo}/git/blobs`, { method: "POST", body }));
        return { path: c.path, mode: "100644", type: "blob", sha: blob.sha };
      });
      const newTree = await this.request<{ sha: string }>(`/repos/${this.repo}/git/trees`, {
        method: "POST",
        body: JSON.stringify({ base_tree: parent.tree.sha, tree }),
      });
      const commit = await this.request<{ sha: string }>(`/repos/${this.repo}/git/commits`, {
        method: "POST",
        body: JSON.stringify({ message, tree: newTree.sha, parents: [ref.object.sha] }),
      });
      try {
        await this.request(`/repos/${this.repo}/git/refs/heads/${this.branch}`, {
          method: "PATCH",
          body: JSON.stringify({ sha: commit.sha, force: false }),
        });
        return commit.sha;
      } catch (e) {
        // 422 = not a fast-forward: someone else pushed in between. Rebuild on the new head.
        if (e instanceof GitHubError && e.status === 422 && attempt < 3) continue;
        throw e;
      }
    }
  }

  async latestRuns(): Promise<WorkflowRun[]> {
    const r = await this.request<{ workflow_runs: WorkflowRun[] }>(
      `/repos/${this.repo}/actions/runs?per_page=4&branch=${encodeURIComponent(this.branch)}`,
    );
    return r.workflow_runs;
  }
}
