import { githubFetchJsonWithEtag } from "@/lib/github/conditional-request";
import { GithubApiError } from "@/lib/github/github-api-error";
import { fetchAllPages } from "@/lib/github/pagination";
import { GITHUB_API, githubFetch } from "@/lib/github/request";

/**
 * `GET /repos/{owner}/{repo}/pulls` のレスポンスのうち、PR一覧で使うフィールド。
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
  /** `open` / `closed` */
  state: string;
  created_at: string;
  updated_at: string;
  /**
   * マージされた時刻。マージされていなければnull。
   * 一覧取得のレスポンスには単体取得の`merged`が無いため、closedなPRのマージ済み判定はこれを使う。
   */
  merged_at: string | null;
  user: { login: string } | null;
  base: { ref: string };
  head: { ref: string; sha: string };
  /** Auto-mergeが有効なPRのみオブジェクトが入る。無効ならnull */
  auto_merge: unknown | null;
};

/** 1リポジトリあたりに取得するオープンPRの上限。これを超えるPRが滞留する運用は想定していない */
const PER_PAGE = 50;

/**
 * 1リポジトリあたりに取得するクローズ済みPRの上限（#1312）。
 *
 * 「全てのPR」ビューが求めているのは直近の完了分を振り返れることで、履歴の全件表示ではない。
 * ページングすると1リポジトリで何十回もAPIを消費しうるため、更新が新しい順の1ページで打ち切る。
 */
const CLOSED_PER_PAGE = 30;

/**
 * 指定リポジトリのオープンなPull Requestを取得する。baseブランチでは絞り込まない
 * （`release-api.ts`の`fetchOpenPullRequestsForBase`はリリースフロー判定用にbase固定で取る）。
 */
export async function fetchOpenPullRequests(
  owner: string,
  repo: string,
  token: string,
): Promise<GithubApiOpenPullRequest[]> {
  return fetchPullRequestPage(
    `${GITHUB_API}/repos/${owner}/${repo}/pulls?state=open&sort=created&direction=asc&per_page=${PER_PAGE}`,
    token,
  );
}

/**
 * 指定リポジトリのクローズ済み（マージ済み・却下）Pull Requestを、更新が新しい順に取得する（#1312）。
 *
 * openと分けて取っているのは、`state=all`の1回で済ませると`per_page`の枠を古いclosedが埋めて
 * openを取りこぼすため（このエンドポイントは作成順ソートしか安定して効かない）。
 * ページングはせず`CLOSED_PER_PAGE`件で打ち切る。
 */
export async function fetchClosedPullRequests(
  owner: string,
  repo: string,
  token: string,
): Promise<GithubApiOpenPullRequest[]> {
  return fetchPullRequestPage(
    `${GITHUB_API}/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${CLOSED_PER_PAGE}`,
    token,
  );
}

/**
 * 指定ブランチをbaseとするクローズ済みPull Requestを、更新が新しい順に取得する（#1814）。
 *
 * PR詳細の本番デプロイ表示が「どのリリースがこの変更を運んだか」を決めるのに使う
 * （`base=main`で呼ぶ）。`fetchClosedPullRequests`との違いはbaseで絞ることだけで、
 * 件数の打ち切りとETagの条件付きGETは同じ。**ページングはしない**ため、`CLOSED_PER_PAGE`件より
 * 古いリリースしか関係しないPRは「判定できない」として扱われる
 * （`lib/pull-request-deploy.ts`）。
 */
export async function fetchClosedPullRequestsForBase(
  owner: string,
  repo: string,
  base: string,
  token: string,
): Promise<GithubApiOpenPullRequest[]> {
  return fetchPullRequestPage(
    `${GITHUB_API}/repos/${owner}/${repo}/pulls?state=closed&base=${encodeURIComponent(base)}&sort=updated&direction=desc&per_page=${CLOSED_PER_PAGE}`,
    token,
  );
}

/**
 * PR一覧の1ページ分を取得する。**ETagによる条件付きGET**を通すため、変化が無い間は
 * レート制限を消費しない（#1531。「完了したPR」ビューの10秒ポーリングの前提）。
 */
async function fetchPullRequestPage(
  url: string,
  token: string,
): Promise<GithubApiOpenPullRequest[]> {
  const result = await githubFetchJsonWithEtag<GithubApiOpenPullRequest[]>(url, token);
  if (!result.ok) {
    throw new GithubApiError(
      result.status,
      `GitHub API request failed: ${result.status} ${url} ${result.detail}`,
    );
  }
  return result.data;
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

/**
 * `GET /repos/{owner}/{repo}/pulls/{number}/files` のレスポンスのうち、変更ファイル一覧で使う
 * フィールド（#1987）。
 *
 * `patch`（差分そのもの）は受け取らない——画面では行単位の差分を出さず、内容を見たい場合は
 * GitHubへ飛ばす方針のため。1ファイルあたり数十KBになりうるので、応答をそのまま画面へ
 * 渡さないという意味でもある。
 */
export type GithubApiPullRequestFile = {
  filename: string;
  /** `added` / `modified` / `removed` / `renamed` / `copied` / `changed` / `unchanged` */
  status: string;
  additions: number;
  deletions: number;
  /** そのコミット時点のファイルを開くURL。削除されたファイルでも（削除前の内容として）返る */
  blob_url: string;
  /** `renamed`のときのみ、変更前のパス */
  previous_filename?: string;
};

/**
 * 1回のリクエストで取得する変更ファイルの上限（GitHubの`per_page`の最大値）。
 *
 * **ページングはしない。** 1つのPRで100ファイルを超えるのは巨大な依存更新やリネームの一括適用
 * くらいで、そこまで並べても画面では読めない。ページングすると1PRを開くだけで何十リクエストも
 * 消費するため、超えたぶんは「GitHubで見る」へ誘導する（`fetchClosedPullRequests`と同じ方針）。
 */
export const PULL_REQUEST_FILES_PER_PAGE = 100;

/**
 * PRの変更ファイル一覧を1ページぶん取得する（#1987）。
 *
 * PR詳細の「変更ファイル」を**開いたときだけ**呼ぶ。畳んでいる間は呼ばないので、畳んだまま
 * PRを見て回るぶんにはGitHub APIの消費は増えない。ただし開閉はセクション単位で覚えるため、
 * 開いたままにしていれば別のPRを開くたびに1回消費する（PR一覧と同じくETagの条件付きGETを
 * 通すので、**同じPRを開き直すぶんは304になりレート制限を消費しない**）。
 *
 * **返り値はETagキャッシュと同じ実体になりうるので、呼び出し側で書き換えない**
 * （`toPullRequestFiles`は新しい配列・新しいオブジェクトを作る）。
 */
export async function fetchPullRequestFiles(
  owner: string,
  repo: string,
  number: number,
  token: string,
): Promise<GithubApiPullRequestFile[]> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls/${number}/files?per_page=${PULL_REQUEST_FILES_PER_PAGE}`;
  const result = await githubFetchJsonWithEtag<GithubApiPullRequestFile[]>(url, token);
  if (!result.ok) {
    throw new GithubApiError(
      result.status,
      `GitHub API request failed: ${result.status} ${url} ${result.detail}`,
    );
  }
  return result.data;
}

/**
 * PRに含まれるコミット1件（#2080）。マージ確認ダイアログの「含まれる変更」を組み立てるのに
 * 使うのは件名（`commit.message`の1行目）だけなので、差分もツリーも受け取らない。
 */
export type GithubApiPullRequestCommit = {
  sha: string;
  commit: { message: string };
};

/**
 * 1回のリクエストで取得するコミットの上限（GitHubの`per_page`の最大値）。
 *
 * **ページングはしない**（`PULL_REQUEST_FILES_PER_PAGE`と同じ方針）。develop→mainのリリースPRで
 * 100コミットを超えるのは数週間ぶんを溜めた場合くらいで、そこまで並べてもダイアログでは読めない。
 * 超えたぶんは打ち切ったことだけを画面に出してGitHubへ誘導する。
 */
export const PULL_REQUEST_COMMITS_PER_PAGE = 100;

/**
 * PRのコミットを1ページぶん取得する（#2080）。マージ確認ダイアログを**開いたときだけ**呼ぶ。
 *
 * **返り値はETagキャッシュと同じ実体になりうるので、呼び出し側で書き換えない**
 * （`toPullRequestChanges`は新しい配列・新しいオブジェクトを作る）。同じPRのダイアログを
 * 開き直すぶんは304になり、レート制限を消費しない。
 */
export async function fetchPullRequestCommits(
  owner: string,
  repo: string,
  number: number,
  token: string,
): Promise<GithubApiPullRequestCommit[]> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls/${number}/commits?per_page=${PULL_REQUEST_COMMITS_PER_PAGE}`;
  const result = await githubFetchJsonWithEtag<GithubApiPullRequestCommit[]>(url, token);
  if (!result.ok) {
    throw new GithubApiError(
      result.status,
      `GitHub API request failed: ${result.status} ${url} ${result.detail}`,
    );
  }
  return result.data;
}
