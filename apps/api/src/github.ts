import { DomainError } from "../../../packages/db/src/index.js";
import type { Config } from "./config.js";
export interface Repo {
  id: string;
  repository: string;
  url: string;
  forkParent: string | null;
}
export interface GitHub {
  identity(
    code: string,
    verifier: string,
  ): Promise<{ id: string; login: string }>;
  repository(name: string): Promise<Repo>;
  commit(name: string, sha: string): Promise<void>;
  requestTree?(name: string, sha: string): Promise<TreeEntry[]>;
  // Top-level entries only (tree layout): the branch holds a whole project, so a
  // recursive read would truncate; the server registers just the two documents.
  requestRoot?(name: string, sha: string): Promise<TreeEntry[]>;
}
export interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
}
export function githubClient(config: Config): GitHub {
  async function get(url: string, token?: string) {
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Tokenisgold",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    if (!response.ok)
      throw new DomainError(
        "GITHUB_UNAVAILABLE",
        "GitHub could not verify this request. Try again.",
        503,
      );
    return response.json() as Promise<Record<string, any>>;
  }
  async function snapshotCommit(name: string, sha: string) {
    const commit = await get(
      `https://api.github.com/repos/${name}/git/commits/${sha}`,
    );
    if (
      commit.sha !== sha ||
      !Array.isArray(commit.parents) ||
      commit.parents.length !== 0 ||
      !/^[a-f0-9]{40}$/.test(commit.tree?.sha ?? "")
    )
      throw new DomainError(
        "INVALID_REQUEST_COMMIT",
        "A request must use an isolated snapshot commit without source history.",
      );
    return commit.tree.sha as string;
  }
  return {
    async identity(code, verifier) {
      const response = await fetch(
        "https://github.com/login/oauth/access_token",
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            client_id: config.githubClientId,
            client_secret: config.githubClientSecret,
            code,
            code_verifier: verifier,
            redirect_uri: `${config.origin}/auth/github/callback`,
          }),
          signal: AbortSignal.timeout(10000),
          redirect: "error",
        },
      );
      const body = (await response.json()) as { access_token?: string };
      if (!response.ok || !body.access_token)
        throw new DomainError(
          "OAUTH_FAILED",
          "GitHub sign-in failed. Start again.",
          401,
        );
      const user = await get("https://api.github.com/user", body.access_token);
      // Token is used for sign-in only and never persisted/logged.
      if (!Number.isSafeInteger(user.id) || typeof user.login !== "string")
        throw new DomainError(
          "OAUTH_FAILED",
          "GitHub identity was not available.",
          401,
        );
      return { id: String(user.id), login: user.login };
    },
    async repository(name) {
      const repo = await get(`https://api.github.com/repos/${name}`);
      if (
        repo.private ||
        repo.visibility !== "public" ||
        !Number.isSafeInteger(repo.id)
      )
        throw new DomainError(
          "PUBLIC_REPO_REQUIRED",
          "The beta supports public GitHub repositories.",
        );
      return {
        id: String(repo.id),
        repository: repo.full_name,
        url: repo.html_url,
        forkParent: repo.parent ? String(repo.parent.id) : null,
      };
    },
    async requestTree(name, sha) {
      const treeSha = await snapshotCommit(name, sha);
      const tree = await get(
        `https://api.github.com/repos/${name}/git/trees/${treeSha}?recursive=1`,
      );
      if (tree.truncated !== false || !Array.isArray(tree.tree))
        throw new DomainError(
          "INCOMPLETE_REQUEST_TREE",
          "GitHub could not provide the complete request tree.",
        );
      return tree.tree;
    },
    async requestRoot(name, sha) {
      const treeSha = await snapshotCommit(name, sha);
      // Non-recursive: GitHub never truncates a single directory listing.
      const tree = await get(
        `https://api.github.com/repos/${name}/git/trees/${treeSha}`,
      );
      if (!Array.isArray(tree.tree))
        throw new DomainError(
          "INCOMPLETE_REQUEST_TREE",
          "GitHub could not provide the request branch root.",
        );
      return tree.tree;
    },
    async commit(name, sha) {
      const commit = await get(
        `https://api.github.com/repos/${name}/commits/${sha}`,
      );
      if (commit.sha !== sha)
        throw new DomainError(
          "COMMIT_NOT_FOUND",
          "The base commit is not available in this repository.",
        );
    },
  };
}
