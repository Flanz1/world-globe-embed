/**
 * Minimal GitHub REST client for the admin page.
 * The token is only ever placed in the Authorization header of requests to api.github.com.
 */
const API = "https://api.github.com";

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

/**
 * Classic-token scopes the admin page accepts. Anything broader (repo, workflow, delete_repo, admin:*, …)
 * would turn a stolen admin token into much more than "can edit public repos", so sign-in is refused.
 */
const ALLOWED_CLASSIC_SCOPES = new Set(["public_repo", "read:user", "user:email", "read:org"]);

/** Scopes in an X-OAuth-Scopes header that the admin page doesn't need. Fine-grained tokens send none. */
export function excessScopes(header: string | null): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && !ALLOWED_CLASSIC_SCOPES.has(s));
}

const utf8ToBase64 = (s: string): string => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const base64ToUtf8 = (b64: string): string =>
  new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

export class GitHub {
  /** The branch every read and commit goes to. */
  branch = "main";
  /** The repository's default branch (what GitHub Pages deploys). */
  defaultBranch = "main";

  /**
   * @param targetBranch branch to read from and commit to; empty means the repository's default branch.
   *   Set at build time with VITE_CONTENT_BRANCH so a test build never writes to main.
   */
  constructor(
    private token: string,
    public repo: string,
    private targetBranch = "",
  ) {
    if (targetBranch && !BRANCH.test(targetBranch)) throw new Error(`"${targetBranch}" isn't a valid branch name.`);
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
      x.open("POST", `${API}/repos/${this.repo}/git/blobs`);
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
        if (x.status === 401) msg = "The token was rejected (expired or mistyped?).";
        reject(new GitHubError(x.status, msg));
      };
      x.send(JSON.stringify({ content: base64, encoding: "base64" }));
    });
  }

  private async send<T>(path: string, init: RequestInit = {}): Promise<{ data: T; headers: Headers }> {
    const r = await fetch(`${API}${path}`, {
      ...init,
      cache: "no-store",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${this.token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!r.ok) {
      let msg = r.statusText;
      try {
        msg = ((await r.json()) as { message?: string }).message ?? msg;
      } catch {
        /* no JSON body */
      }
      if (r.status === 401) msg = "The token was rejected (expired or mistyped?).";
      if (r.status === 403 || r.status === 404)
        msg = `${msg}. Check that the token has access to ${this.repo} with Contents: Read and write.`;
      throw new GitHubError(r.status, msg);
    }
    return { data: (r.status === 204 ? undefined : await r.json()) as T, headers: r.headers };
  }

  /** Confirms the token works and can push, and lists any scopes it has beyond what the page needs. */
  async whoAmI(): Promise<{ login: string; canPush: boolean; excessScopes: string[] }> {
    const [user, repo] = await Promise.all([
      this.send<{ login: string }>("/user").catch(() => null),
      this.send<{ default_branch: string; permissions?: { push?: boolean } }>(`/repos/${this.repo}`),
    ]);
    this.defaultBranch = repo.data.default_branch;
    this.branch = this.targetBranch || this.defaultBranch;
    if (this.branch !== this.defaultBranch) {
      try {
        await this.request(`/repos/${this.repo}/git/ref/heads/${this.branch}`);
      } catch (e) {
        if (e instanceof GitHubError && e.status === 404)
          throw new GitHubError(404, `This admin page is set to write to the branch "${this.branch}", which doesn't exist in ${this.repo}. Create it, or rebuild without VITE_CONTENT_BRANCH.`);
        throw e;
      }
    }
    return {
      login: user?.data.login ?? "token",
      canPush: !!repo.data.permissions?.push,
      excessScopes: excessScopes(repo.headers.get("X-OAuth-Scopes")),
    };
  }

  async readText(path: string): Promise<string> {
    return (await this.readFile(path)).text;
  }

  /** A file's text and blob SHA (to notice when someone else changed it). */
  async readFile(path: string): Promise<{ text: string; sha: string }> {
    const f = await this.request<{ content: string; encoding: string; sha: string }>(
      `/repos/${this.repo}/contents/${path}?ref=${encodeURIComponent(this.branch)}`,
    );
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
      const tree = await Promise.all(
        changes.map(async (c) => {
          // A null sha removes the file from the tree.
          if (c.delete) return { path: c.path, mode: "100644", type: "blob", sha: null };
          if (c.sha) return { path: c.path, mode: "100644", type: "blob", sha: c.sha };
          const blob = await this.request<{ sha: string }>(`/repos/${this.repo}/git/blobs`, {
            method: "POST",
            body: JSON.stringify({ content: c.base64 ? c.content : utf8ToBase64(c.content), encoding: "base64" }),
          });
          return { path: c.path, mode: "100644", type: "blob", sha: blob.sha };
        }),
      );
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
