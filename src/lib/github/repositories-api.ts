/**
 * リポジトリそのものを作る操作（#2188）。**サーバー専用。**
 *
 * 既存の`lib/github/`の作りに合わせ、呼び出しは`githubFetch`を通す（使用量の計測のため）。
 * 認証はユーザー本人のトークン（`repo`スコープ）で、GitHub Appのインストールトークンでは
 * organizationへのリポジトリ作成ができない。
 *
 * **作った後の後始末はしない。** 途中で失敗しても作成済みのリポジトリは残し、呼び出し元が
 * リンクとして返す。自動で消すと、名前を取り直せないまま「作られたのか分からない」状態になる。
 */

import { GithubApiError } from "@/lib/github/github-api-error";
import { fetchAllPages } from "@/lib/github/pagination";
import { GITHUB_API, githubFetch } from "@/lib/github/request";

export type CreatedRepository = {
  fullName: string;
  htmlUrl: string;
  defaultBranch: string;
};

type GithubRepositoryResponse = {
  full_name: string;
  html_url: string;
  default_branch: string;
};

async function requestJson<T>(
  url: string,
  token: string,
  method: "POST" | "PATCH" | "DELETE" | "GET",
  body?: unknown,
): Promise<T> {
  const res = await githubFetch(url, token, { method, body });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * その名前のリポジトリが既にあるか。
 *
 * **404以外の失敗は「無い」と答えない。** 権限や通信の問題を空きと読み替えると、
 * 作成の段になって初めて失敗する。
 */
export async function repositoryExists(
  owner: string,
  repo: string,
  token: string,
): Promise<boolean> {
  const res = await githubFetch(`${GITHUB_API}/repos/${owner}/${repo}`, token);
  if (res.status === 404) return false;
  if (res.ok) return true;
  const detail = await res.text().catch(() => "");
  throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${owner}/${repo} ${detail}`);
}

export type CreateRepositoryInput = {
  name: string;
  description: string;
  private: boolean;
};

/** organization配下にリポジトリを作る。READMEを1つ入れて初期化する（ブランチを切るため）。 */
export async function createOrgRepository(
  org: string,
  token: string,
  input: CreateRepositoryInput,
): Promise<CreatedRepository> {
  const created = await requestJson<GithubRepositoryResponse>(
    `${GITHUB_API}/orgs/${org}/repos`,
    token,
    "POST",
    {
      name: input.name,
      description: input.description || undefined,
      private: input.private,
      // `develop`を切るには最初のコミットが要る
      auto_init: true,
      has_wiki: false,
      has_projects: false,
    },
  );
  return {
    fullName: created.full_name,
    htmlUrl: created.html_url,
    defaultBranch: created.default_branch,
  };
}

/**
 * `develop`ブランチを作り、デフォルトブランチにする。
 *
 * **デフォルトブランチが`develop`でないと、Issue起点の無人実行はそもそも起動しない**
 * （`issues`・`issue_comment`はデフォルトブランチのワークフローしか動かさない。
 * `docs/cross-repo-setup-guide.md`）。作成時にここまで済ませておく。
 */
export async function setupDevelopBranch(
  owner: string,
  repo: string,
  token: string,
  baseBranch: string,
): Promise<void> {
  if (baseBranch === "develop") return;

  const base = await requestJson<{ object: { sha: string } }>(
    `${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${baseBranch}`,
    token,
    "GET",
  );
  await requestJson(`${GITHUB_API}/repos/${owner}/${repo}/git/refs`, token, "POST", {
    ref: "refs/heads/develop",
    sha: base.object.sha,
  });
  await requestJson(`${GITHUB_API}/repos/${owner}/${repo}`, token, "PATCH", {
    default_branch: "develop",
  });
}

type GithubLabel = { name: string; color: string; description: string | null };

export type LabelCloneResult = {
  copied: number;
  /** 作成先に元からあり、元リポジトリに無かったため消したラベル */
  removed: number;
};

/**
 * ラベル一式を写す（`gh label clone --force`と同じことをAPIで行う）。
 *
 * **GitHubが最初から入れる既定ラベルは消す。** 役割がマルチエージェント運用のラベル体系と
 * 重複し、新しいリポジトリにはまだIssueが1件も無いので、消しても失われるものがない。
 */
export async function cloneRepositoryLabels(
  source: { owner: string; repo: string },
  target: { owner: string; repo: string },
  token: string,
): Promise<LabelCloneResult> {
  const sourceLabels = await fetchAllPages<GithubLabel>(
    `${GITHUB_API}/repos/${source.owner}/${source.repo}/labels?per_page=100`,
    token,
  );
  const targetLabels = await fetchAllPages<GithubLabel>(
    `${GITHUB_API}/repos/${target.owner}/${target.repo}/labels?per_page=100`,
    token,
  );
  const existing = new Set(targetLabels.map((label) => label.name));
  const base = `${GITHUB_API}/repos/${target.owner}/${target.repo}/labels`;

  let copied = 0;
  for (const label of sourceLabels) {
    const body = { name: label.name, color: label.color, description: label.description ?? "" };
    if (existing.has(label.name)) {
      await requestJson(`${base}/${encodeURIComponent(label.name)}`, token, "PATCH", body);
    } else {
      await requestJson(base, token, "POST", body);
    }
    copied += 1;
  }

  const sourceNames = new Set(sourceLabels.map((label) => label.name));
  let removed = 0;
  for (const label of targetLabels) {
    if (sourceNames.has(label.name)) continue;
    await requestJson(`${base}/${encodeURIComponent(label.name)}`, token, "DELETE");
    removed += 1;
  }

  return { copied, removed };
}
