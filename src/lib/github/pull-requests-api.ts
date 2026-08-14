import { GithubApiError } from "@/lib/github/github-api-error";
import { fetchAllPages } from "@/lib/github/pagination";
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
  /** `open` / `closed`。一覧取得は常にopenだが、単体取得ではclosedも返る */
  state: string;
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

/**
 * `GET /repos/{owner}/{repo}/pulls/{number}` のレスポンスのうち、PR詳細で使うフィールド。
 *
 * 一覧取得（`fetchOpenPullRequests`）では返らない差分統計・マージ可否を含む。逆に言えば
 * これらが要らない一覧側で単体取得を回す必要はない（PR1件につき1回APIを消費するため）。
 */
export type GithubApiPullRequestDetail = GithubApiOpenPullRequest & {
  additions: number;
  deletions: number;
  changed_files: number;
  commits: number;
  /** マージ済みか。一覧取得のレスポンスには含まれず、単体取得でのみ返る */
  merged: boolean;
  /** マージ可否。GitHub側が判定中の間はnullが返る */
  mergeable: boolean | null;
  /** `clean` / `dirty`（コンフリクト）/ `blocked` / `unstable` / `behind` / `draft` / `unknown` */
  mergeable_state: string;
};

export async function fetchPullRequest(
  owner: string,
  repo: string,
  number: number,
  token: string,
): Promise<GithubApiPullRequestDetail> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls/${number}`;
  const res = await githubFetch(url, token);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
  return res.json();
}

/**
 * レビュー（Approve・変更要求・コメントの送信単位）。issue-deckの無人実行は`gh pr comment`で
 * 会話コメントを投稿するため大半のPRでは空配列になるが、人手のレビューを取りこぼさないよう取得する。
 */
export type GithubApiPullRequestReview = {
  id: number;
  user: { login: string } | null;
  body: string | null;
  /** `APPROVED` / `CHANGES_REQUESTED` / `COMMENTED` / `DISMISSED` / `PENDING` */
  state: string;
  /** 下書き（PENDING）のレビューはnull */
  submitted_at: string | null;
};

export async function fetchPullRequestReviews(
  owner: string,
  repo: string,
  number: number,
  token: string,
): Promise<GithubApiPullRequestReview[]> {
  return fetchAllPages<GithubApiPullRequestReview>(
    `${GITHUB_API}/repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100`,
    token,
  );
}

/** 差分の行に紐づくレビューコメント。会話コメント（issueコメント）とはエンドポイントが別 */
export type GithubApiPullRequestReviewComment = {
  id: number;
  user: { login: string } | null;
  body: string | null;
  created_at: string;
  path: string;
  /** 差分が古くなり現在の行を特定できない場合はnull */
  line: number | null;
};

export async function fetchPullRequestReviewComments(
  owner: string,
  repo: string,
  number: number,
  token: string,
): Promise<GithubApiPullRequestReviewComment[]> {
  return fetchAllPages<GithubApiPullRequestReviewComment>(
    `${GITHUB_API}/repos/${owner}/${repo}/pulls/${number}/comments?per_page=100`,
    token,
  );
}
