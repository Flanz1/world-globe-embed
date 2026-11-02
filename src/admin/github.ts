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
  /** UTF-8 text, or base64 when `base64` is true. */
  content: string;
  base64?: boolean;
}

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
  branch = "main";

  constructor(
    private token: string,
    public repo: string,
  ) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    return (await this.send<T>(path, init)).data;
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
    this.branch = repo.data.default_branch;
    return {
      login: user?.data.login ?? "token",
      canPush: !!repo.data.permissions?.push,
      excessScopes: excessScopes(repo.headers.get("X-OAuth-Scopes")),
    };
  }

  async readText(path: string): Promise<string> {
    const f = await this.request<{ content: string; encoding: string }>(
      `/repos/${this.repo}/contents/${path}?ref=${encodeURIComponent(this.branch)}`,
    );
    return base64ToUtf8(f.content);
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
