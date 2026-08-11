import { GithubApiError } from "@/lib/github/github-api-error";
import { GITHUB_API, githubFetch } from "@/lib/github/request";

/**
 * `GET /repos/{owner}/{repo}/pulls` のレスポンスのうち、マージ待ちPR一覧で使うフィールド。
 *
 * `release-api.ts`の`GithubApiPullRequest`はリリースフロー判定に必要な最小限（番号・タイトル・
 * head.ref）だけを持つ別物で、こちらは一覧表示に必要なdraft・base・作者・Auto-merge・
 * head.shaまで含む。用途が異なるため型を分けている。
 */
export type GithubApiOpenPullRequest = {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  draft: boolean;
  created_at: string;
  updated_at: string;
  user: { login: string } | null;
  base: { ref: string };
  head: { ref: string; sha: string };
  /** Auto-mergeが有効なPRのみオブジェクトが入る。無効ならnull */
  auto_merge: unknown | null;
};

/** 1リポジトリあたりに取得するオープンPRの上限。これを超えるPRが滞留する運用は想定していない */
const PER_PAGE = 50;

/**
 * 指定リポジトリのオープンなPull Requestを取得する。baseブランチでは絞り込まない
 * （`release-api.ts`の`fetchOpenPullRequestsForBase`はリリースフロー判定用にbase固定で取る）。
 */
export async function fetchOpenPullRequests(
  owner: string,
  repo: string,
  token: string,
): Promise<GithubApiOpenPullRequest[]> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls?state=open&sort=created&direction=asc&per_page=${PER_PAGE}`;
  const res = await githubFetch(url, token);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
  return res.json();
}
