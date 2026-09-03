import {
  fetchCheckRollup,
  fetchPullRequestRollup,
  fetchPullRequestRollups,
  type CheckRollup,
  MERGE_JUDGEMENT_UNKNOWN,
  type MergeJudgement,
  type PullRequestRollupTarget,
  type RollupCiCheck,
} from "@/lib/github/check-rollup";
import { githubFetchJsonWithEtag } from "@/lib/github/conditional-request";
import { GithubApiError } from "@/lib/github/github-api-error";
import { GITHUB_API, githubFetch } from "@/lib/github/request";
import type { BumpKind } from "@/lib/semver-bump";

/** 「develop→mainのリリースフロー」を自動化するworkflowのファイル名（release-develop-to-main.yml） */
export const RELEASE_WORKFLOW_FILE = "release-develop-to-main.yml";

/** mainへのマージを受けて本番デプロイを行うworkflowのファイル名（deploy.yml） */
export const DEPLOY_WORKFLOW_FILE = "deploy.yml";

/**
 * リポジトリに指定した名前のworkflowが置かれているかどうか。
 *
 * `workflow_dispatch`の受け口はファイルの実在で決まるため、**ファイル名だけで**
 * 「画面のボタンから起動できるか」を判定できる（`missingRepairWorkflows`と同じ考え方）。
 * リリースフローの有無（#1538）と自動修復ワークフローの配布状況（#1960）が共有する。
 */
export async function fetchWorkflowExists(
  owner: string,
  repo: string,
  workflowFile: string,
  token: string,
): Promise<boolean> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${workflowFile}`;
  const res = await githubFetch(url, token);
  if (res.status === 404) return false;
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
  return true;
}

/** リポジトリに`release-develop-to-main.yml`と同名のworkflowが存在するかどうか */
export function fetchReleaseWorkflowExists(
  owner: string,
  repo: string,
  token: string,
): Promise<boolean> {
  return fetchWorkflowExists(owner, repo, RELEASE_WORKFLOW_FILE, token);
}

/** 指定ブランチの`package.json`の`version`フィールドを取得する。ファイルが無ければnull */
export async function fetchPackageVersion(
  owner: string,
  repo: string,
  ref: string,
  token: string,
): Promise<string | null> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/package.json?ref=${encodeURIComponent(ref)}`;
  const res = await githubFetch(url, token);
  if (res.status === 404) return null;
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
  const data: { content: string; encoding: string } = await res.json();
  const raw = Buffer.from(data.content, data.encoding === "base64" ? "base64" : "utf-8").toString("utf-8");
  const parsed: { version?: string } = JSON.parse(raw);
  return parsed.version ?? null;
}

/**
 * リリース通知の本文を持つファイル（#2725）。
 *
 * `reusable-release-develop-to-main.yml`がバージョンbumpのたびに書き出し、Signalyへの
 * リリース通知（`.github/scripts/signaly-notify.sh`）が読むのと同じファイル。**更新履歴画面を
 * 持たないアプリでも変更内容が載る唯一の置き場**なので、Push通知もここを読む（#2391）。
 */
export const RELEASE_NOTES_FILE = ".github/release-notes.md";

/** GitHub Releaseのうち、リリース通知に使う項目だけ（#2725） */
export type LatestRelease = {
  /** `v4.74.0`。**「どのリリースまで鳴らしたか」の鍵**になる */
  tagName: string;
  /** リリース名。`softprops/action-gh-release`はタグ名と同じものを入れる */
  name: string | null;
  htmlUrl: string;
  /** 公開時刻（ISO8601）。古いリリースを鳴らし直さないための判定に使う */
  publishedAt: string | null;
};

/**
 * そのリポジトリの最新リリースを1件取得する。1件も無ければnull。
 *
 * **`releases/latest`はdraftとprereleaseを除く。** リリース通知で鳴らしたいのは本番へ出た版
 * だけなので、この絞り込みがそのまま欲しい条件になる（`deploy.yml`はタグに`-`が入るときだけ
 * prereleaseとして作る）。
 *
 * **ETagの条件付きGETを通す**（`fetchLatestWorkflowRun`と同じ）。リリースは月に数回しか
 * 増えないため、巡回の大半は304になり**レート制限を消費しない**。
 */
export async function fetchLatestRelease(
  owner: string,
  repo: string,
  token: string,
): Promise<LatestRelease | null> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/releases/latest`;
  const result = await githubFetchJsonWithEtag<{
    tag_name?: string;
    name?: string | null;
    html_url?: string;
    published_at?: string | null;
  }>(url, token);
  if (!result.ok) {
    // 404はリリースが1件も無いリポジトリ（`vps`・`subpc`のように`tag`ジョブを持たないもの）。
    if (result.status === 404) return null;
    throw new GithubApiError(
      result.status,
      `GitHub API request failed: ${result.status} ${url} ${result.detail}`,
    );
  }
  const tagName = result.data.tag_name;
  if (!tagName) return null;
  return {
    tagName,
    name: result.data.name ?? null,
    htmlUrl: result.data.html_url ?? `https://github.com/${owner}/${repo}/releases/tag/${tagName}`,
    publishedAt: result.data.published_at ?? null,
  };
}

/** リリース履歴（#2726）の1件ぶん */
export type ReleaseHistoryItem = {
  repoFullName: string;
  /** `v4.75.0` */
  tagName: string;
  name: string | null;
  htmlUrl: string;
  /** 公開時刻（ISO8601）。取れないもの（draftの取りこぼれ等）は呼び出し側で除く */
  publishedAt: string | null;
  /**
   * リリース本文。`deploy.yml`が`generate_release_notes: true`で作るため、GitHubが
   * 自動生成した「マージ済みPRタイトルの箇条書き＋Full Changelogリンク」が入る
   * （issue-deckの`更新履歴`画面が持つような日本語の要約ではない）。
   */
  body: string | null;
};

/**
 * そのリポジトリの直近のGitHub Releaseを新しい順に最大`perPage`件取得する（#2726）。
 *
 * **`releases/latest`（`fetchLatestRelease`）と違い、draft・prereleaseも含めて返す。**
 * 呼び出し側（`selectVisibleReleaseHistory`等）でフィルタする。
 *
 * **ETagの条件付きGETを通す**（`fetchLatestRelease`と同じ）。リリースは月に数回しか増えない
 * ため、巡回の大半は304になりレート制限を消費しない。
 */
export async function fetchRecentReleases(
  owner: string,
  repo: string,
  token: string,
  perPage = 20,
): Promise<ReleaseHistoryItem[]> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/releases?per_page=${perPage}`;
  const result = await githubFetchJsonWithEtag<
    Array<{
      tag_name?: string;
      name?: string | null;
      html_url?: string;
      published_at?: string | null;
      draft?: boolean;
      body?: string | null;
    }>
  >(url, token);
  if (!result.ok) {
    // 404はリリースが1件も無いリポジトリ（`vps`・`subpc`のように`tag`ジョブを持たないもの）。
    if (result.status === 404) return [];
    throw new GithubApiError(
      result.status,
      `GitHub API request failed: ${result.status} ${url} ${result.detail}`,
    );
  }
  return result.data
    .filter((release) => !release.draft && release.tag_name)
    .map((release) => ({
      repoFullName: `${owner}/${repo}`,
      tagName: release.tag_name as string,
      name: release.name ?? null,
      htmlUrl: release.html_url ?? `https://github.com/${owner}/${repo}/releases/tag/${release.tag_name}`,
      publishedAt: release.published_at ?? null,
      body: release.body ?? null,
    }));
}

/**
 * 指定したref時点の`.github/release-notes.md`をそのまま読む。無ければnull（#2725）。
 *
 * **リリースのタグを`ref`に渡す。** そのリリースで出た版の文面が要るので、`main`の先端を
 * 読むと次のバージョンの文面を混ぜてしまう。
 */
export async function fetchReleaseNotesFile(
  owner: string,
  repo: string,
  ref: string,
  token: string,
): Promise<string | null> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${RELEASE_NOTES_FILE}?ref=${encodeURIComponent(ref)}`;
  const res = await githubFetch(url, token);
  if (res.status === 404) return null;
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
  const data: { content?: string; encoding?: string } = await res.json();
  if (!data.content) return null;
  return Buffer.from(data.content, data.encoding === "base64" ? "base64" : "utf-8").toString("utf-8");
}

export type GithubApiPullRequest = {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  head: { ref: string };
};

/** 指定ブランチをbaseとするopenなPull Requestの一覧を取得する */
export async function fetchOpenPullRequestsForBase(
  owner: string,
  repo: string,
  base: string,
  token: string,
): Promise<GithubApiPullRequest[]> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls?base=${encodeURIComponent(base)}&state=open&per_page=30`;
  const res = await githubFetch(url, token);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
  return res.json();
}

export type ReleaseWorkflowRun = {
  /**
   * runのid（#2236）。**同じ失敗で二重にIssueを起票しないための鍵**として使う。
   * `deploy-retry.yml`の再実行は新しいrunを作らずattemptを増やすだけなので、
   * 「1回の失敗」をこの値で数えられる。
   */
  id: number;
  /** queued | in_progress | completed など */
  status: string;
  /** success | failure | cancelled | null（未完了時） */
  conclusion: string | null;
  htmlUrl: string;
  createdAt: string;
  /**
   * この実行を起こしたイベント（`push` | `workflow_dispatch` など。#2020）。
   *
   * **`deploy.yml`の実行が「リリースの本番反映」なのか「手動の出し直し」なのかは、これでしか
   * 区別できない。** mainへのpushで走ったものだけがその版を本番へ出した実行で、
   * `workflow_dispatch`は既に出ている版を出し直しているだけ。混ぜると、出し直しが走っている間や
   * 失敗したときに、すでに本番へ出ている版まで「まだ本番に出ていない」表示に戻る。
   */
  event: string;
  /**
   * この実行が何回目の試行か（初回は1。#2134）。
   *
   * `deploy-retry.yml`は失敗を1回だけ自動で再実行するが、**再実行は新しいrunを作らず同じrunの
   * attemptを増やす**ため、`createdAt`も`event`も初回のまま変わらない。「自動で再実行された」
   * ことを画面で言える材料はこれだけになる。上限が1回であることの根拠も同じ値
   * （`reusable-deploy-retry.yml`は`run_attempt == 1`のときしか再実行しない）。
   */
  runAttempt: number;
  /**
   * この実行が最後に動いた時刻（ISO8601。#2236）。
   *
   * **失敗してからどれだけ経ったかは、これでしか分からない。** `createdAt`は最初に
   * キューされた時刻なので、`deploy-retry.yml`が再実行したぶんの経過時間が入らない。
   * デプロイ失敗の自動起票は「失敗のまま一定時間が過ぎたか」で判定するため、この値を見る。
   */
  updatedAt: string;
};

/**
 * 最新の実行を1件だけ取る。**ETagの条件付きGETを通す**（#1579）。
 *
 * この取得はリリース進捗のポーリング（`/api/repositories/release`・`release-pending-merges`）と、
 * 「ブランチとPRの流れ」画面のデプロイ状況（`/api/branch-flow/deploy`）から繰り返し呼ばれる。
 * 実行が進んでいない間は304が返り、その分は**GitHubのレート制限を消費しない**（`conditional-request.ts`）。
 *
 * 共有ワークフローの配布（`src/lib/github/workflow-tags.ts`）も同じ理由でここを使う。
 * リリースとは無関係だが、「最新のrunを1件だけ、条件付きGETで取る」という形が同じため
 * 実装を分けない（#1602）。
 */
export async function fetchLatestWorkflowRun(
  owner: string,
  repo: string,
  workflowFile: string,
  token: string,
  query?: string,
): Promise<ReleaseWorkflowRun | null> {
  const qs = query ? `&${query}` : "";
  const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${workflowFile}/runs?per_page=1${qs}`;
  const result = await githubFetchJsonWithEtag<{
    workflow_runs?: Array<{
      id?: number;
      status: string;
      conclusion: string | null;
      html_url: string;
      created_at: string;
      updated_at?: string;
      event: string;
      run_attempt?: number;
    }>;
  }>(url, token);
  if (!result.ok) {
    if (result.status === 404) return null;
    throw new GithubApiError(
      result.status,
      `GitHub API request failed: ${result.status} ${url} ${result.detail}`,
    );
  }
  const run = result.data.workflow_runs?.[0];
  if (!run) return null;
  return {
    id: run.id ?? 0,
    status: run.status,
    conclusion: run.conclusion ?? null,
    htmlUrl: run.html_url,
    createdAt: run.created_at,
    // 取れなかったときは`created_at`で代用する。**「まだ新しい」側へ倒す**——古い側へ
    // 倒すと、経過時間で判定するデプロイ失敗の起票（#2236）が実際より早く走ってしまう。
    updatedAt: run.updated_at ?? run.created_at,
    event: run.event,
    // 取れなかったときは初回（1）として扱う。**「自動で再実行された」と言い切れるのは
    // 2以上を実際に見たときだけ**で、欠けている値から推測して印を付けない（#2134）。
    runAttempt: run.run_attempt ?? 1,
  };
}

/** `release-develop-to-main.yml`の最新の実行（run）を1件取得する。無ければnull */
export async function fetchLatestReleaseWorkflowRun(
  owner: string,
  repo: string,
  token: string,
): Promise<ReleaseWorkflowRun | null> {
  return fetchLatestWorkflowRun(owner, repo, RELEASE_WORKFLOW_FILE, token);
}

/**
 * mainブランチ上の`deploy.yml`（本番デプロイ）の最新の実行（run）を1件取得する。無ければnull。
 * mainへのマージ後にこのrunを追うことで、デプロイまで成功したかを見届けられるようにする(#392)。
 */
export async function fetchLatestDeployWorkflowRun(
  owner: string,
  repo: string,
  token: string,
): Promise<ReleaseWorkflowRun | null> {
  return fetchLatestWorkflowRun(owner, repo, DEPLOY_WORKFLOW_FILE, token, "branch=main");
}

/**
 * `deploy.yml`の直近の実行を、どのコミットに対して走ったのかまで含めて取得する（#2703）。
 *
 * **`fetchLatestWorkflowRun`では足りない。** あちらは「最新1件が成功したか」を見るための
 * 取得で、`head_sha`も`head_branch`も落としている。こちらが答えたいのは
 * **「このマージコミットに対する実行が作られたか」**——GitHubがマージのイベントを配送し損ね、
 * 実行が1件も作られなかったことを検知するため（myroom#315）。
 *
 * **ETagの条件付きGETは通さない。** 見たいのは「増えたかどうか」そのもので、304で
 * 「変わっていない」と返ってくるのは待っている間ずっと続く（それが検知したい状態）。
 * 呼ぶのはマージ直後の見張りが残っている間だけなので、消費するのはその数回に限られる。
 *
 * `branch`で絞らないのは、手動デプロイがmain以外のrefから起動されていることがあるため。
 * どのrefで走ったかは`headBranch`で呼び出し側が判定する。
 */
export type DeployWorkflowRunRef = {
  id: number;
  htmlUrl: string;
  createdAt: string;
  /** push | workflow_dispatch など */
  event: string;
  /** この実行が対象にしたコミットのSHA */
  headSha: string;
  /** この実行が走ったブランチ。取れなければnull */
  headBranch: string | null;
  /**
   * `headSha`のコミットが指すtreeのSHA。取れなければnull。
   *
   * **別のrefから起動された手動デプロイは`headSha`が一致しない**（マージコミットではなく
   * そのrefの先端を指すため）が、中身が同じならtreeは一致する。SHAだけで照合すると、
   * 既に同じ内容が出ているのに起動し直すことになる。
   */
  headTreeSha: string | null;
};

export async function fetchRecentDeployWorkflowRuns(
  owner: string,
  repo: string,
  token: string,
  perPage = 10,
): Promise<DeployWorkflowRunRef[]> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${DEPLOY_WORKFLOW_FILE}/runs?per_page=${perPage}`;
  const res = await githubFetch(url, token);
  // ワークフローそのものが無いリポジトリは「実行が1件も無い」ではなく呼び出し側で
  // 対象外にするが、ここまで来てしまったら空で返す（起動し直しの判断は別途行う）。
  if (res.status === 404) return [];
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
  const data: {
    workflow_runs?: Array<{
      id?: number;
      html_url?: string;
      created_at?: string;
      event?: string;
      head_sha?: string;
      head_branch?: string | null;
      head_commit?: { tree_id?: string | null } | null;
    }>;
  } = await res.json().catch(() => ({}));
  return (data.workflow_runs ?? []).map((run) => ({
    id: run.id ?? 0,
    htmlUrl: run.html_url ?? "",
    createdAt: run.created_at ?? "",
    event: run.event ?? "",
    headSha: run.head_sha ?? "",
    headBranch: run.head_branch ?? null,
    headTreeSha: run.head_commit?.tree_id ?? null,
  }));
}

/**
 * コミットが指すtreeのSHAを返す。取れなければnull（#2703）。
 *
 * 起動し直す直前の最後の照合にしか使わない。**「実行が作られていない」と判断してから
 * 1回だけ**呼ぶので、平常時はまったく消費しない。
 */
export async function fetchCommitTreeSha(
  owner: string,
  repo: string,
  sha: string,
  token: string,
): Promise<string | null> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}`;
  const res = await githubFetch(url, token);
  if (!res.ok) return null;
  const data: { commit?: { tree?: { sha?: string } } } = await res.json().catch(() => ({}));
  return data.commit?.tree?.sha ?? null;
}

/**
 * 1つのrunで失敗したジョブの名前を返す（#2236）。
 *
 * デプロイ失敗のIssueに「どこで落ちたか」を書くためだけに使う。**起票する直前にしか
 * 呼ばない**——巡回のたびに呼ぶと、失敗が続いている間ずっとレート制限を消費し続けるため。
 *
 * 取れなかったとき（権限不足・`startup_failure`でジョブが1件も無い）は空配列を返す。
 * その場合はIssueの本文からジョブ名の行が消えるだけで、起票そのものは止めない
 * （**失敗を知らせることの方が、内訳より優先する**）。
 */
export async function fetchFailedJobNames(
  owner: string,
  repo: string,
  runId: number,
  token: string,
): Promise<string[]> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100&filter=latest`;
  const res = await githubFetch(url, token);
  if (!res.ok) return [];
  const data: { jobs?: Array<{ name?: unknown; conclusion?: unknown }> } = await res
    .json()
    .catch(() => ({}));
  return (data.jobs ?? [])
    .filter((job) => job.conclusion === "failure" || job.conclusion === "timed_out")
    .map((job) => job.name)
    .filter((name): name is string => typeof name === "string");
}

/** CIの集約状態。`unknown`は権限不足やチェック未検出で判定できないことを表す */
export type CiState = "pending" | "success" | "failure" | "unknown";

type CheckRun = { status: string; conclusion: string | null };

/** チェックとして「通った」とみなすconclusion */
const PASSABLE_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/**
 * check-runsの集合からCI状態を決める。**未完了が1つでもあれば`pending`が最優先**で、
 * 失敗より先に判定する（実行中に落ちているものがあっても、まだ確定していないため）。
 */
export function resolveCiStateFromCheckRuns(runs: CheckRun[]): CiState {
  if (runs.length === 0) return "unknown";
  if (runs.some((r) => r.status !== "completed")) return "pending";
  if (runs.some((r) => !r.conclusion || !PASSABLE_CONCLUSIONS.has(r.conclusion))) return "failure";
  return "success";
}

/**
 * GitHub自身の集約結果（`statusCheckRollup.state`）を`CiState`へ写す。チェックが100件を
 * 超えていて1件ずつ見られなかったときだけ使う。
 */
function ciStateFromRollupState(state: string | null): CiState {
  if (state === "success") return "success";
  if (state === "pending" || state === "expected") return "pending";
  if (state === "failure" || state === "error") return "failure";
  return "unknown";
}

/**
 * 指定ref（ブランチ名/SHA）のチェックを集約したCI状態を返す。
 * `Checks: read`権限が無い等で取得に失敗した場合は例外を投げず`unknown`を返す（進捗表示は
 * あくまで補助情報のため、CI状態が取れなくてもマージ用URL自体は表示できるようにする）。
 *
 * **GitHubがそのコミットのChecksとして数えるものだけを見る**（`lib/github/check-rollup.ts`）。
 * RESTの`/commits/{sha}/check-runs`はSHAに紐づくジョブを分け隔てなく返すため、無人実行の
 * ワークフロー（`issues`・`issue_comment`・`workflow_dispatch`・`workflow_run`・`schedule`起動）
 * まで混ざり、GitHubの画面ではCI成功・マージ可能なのにissue-deckだけ「CI失敗」「CI実行中」に
 * なっていた（#1578）。
 */
export async function fetchRefCiState(
  owner: string,
  repo: string,
  ref: string,
  token: string,
): Promise<CiState> {
  return (await fetchRefCheckState(owner, repo, ref, token)).ciState;
}

/** ref1件ぶんのCI状態と、自動マージ可否の判定の進み具合（#1968） */
export type RefCheckState = {
  ciState: CiState;
  mergeJudgement: MergeJudgement;
};

/**
 * 指定refのCI状態と、自動マージ可否の判定の進み具合を**同じ1回のクエリで**返す（#1968）。
 *
 * 判定の進み具合（`claude-review-develop.yml`のcheck-run）はCI状態の集約から外れている
 * （#1799）ため、CI状態だけを見ていると「判定が走っている最中でもCI通過」に見える。
 * 同じ`statusCheckRollup`から取り出せるので、これを足してもGitHub APIの消費は増えない。
 */
export async function fetchRefCheckState(
  owner: string,
  repo: string,
  ref: string,
  token: string,
): Promise<RefCheckState> {
  const rollup = await fetchCheckRollup(owner, repo, ref, token);
  return {
    ciState: toCiState(rollup),
    mergeJudgement: rollup?.mergeJudgement ?? MERGE_JUDGEMENT_UNKNOWN,
  };
}

/** チェック集約から`CiState`を決める。取得できていなければ`unknown` */
function toCiState(rollup: CheckRollup | null): CiState {
  if (!rollup) return "unknown";
  // 100件を超えるrefでは1件ずつ見られないため、GitHubの集約値をそのまま使う。
  if (!rollup.checks) return ciStateFromRollupState(rollup.state);
  return resolveCiStateFromCheckRuns(rollup.checks);
}

/** PR1件ぶんのCI状態とコンフリクト有無（#1742） */
export type PullRequestCiState = {
  ciState: CiState;
  /** `true`＝マージ可能・`false`＝コンフリクトあり・`null`＝GitHubが判定中または取得できず */
  mergeable: boolean | null;
  /** 自動マージ可否の判定（`claude-review-develop.yml`）の進み具合（#1968） */
  mergeJudgement: MergeJudgement;
  /** CIの内訳を開くためのrun id（#2777）。読めなければnull */
  ciRunId: number | null;
  /** CIの内訳に並べるチェック一覧（#2777）。CI状態と同じ母集団 */
  ciChecks: RollupCiCheck[];
};

/**
 * マージ待ちPRのCI状態とコンフリクト有無を**1回のGraphQL**で取得する（#1742）。
 *
 * `mergeable`はGitHub側が非同期に計算するため、判定が終わるまでは`null`が返る。
 * 「判定前イコールコンフリクトなし」ではないので、呼び出し側は`false`のときだけ
 * コンフリクトとして扱う（`repairKindsFor`）。
 *
 * PR番号が手元にある経路（PR一覧・リリース進捗）はこちらを使い、番号を持たない経路
 * （developブランチそのもののCI状態など）は`fetchRefCiState`を使う。
 */
export async function fetchPullRequestCiState(
  owner: string,
  repo: string,
  number: number,
  token: string,
): Promise<PullRequestCiState> {
  const { rollup, mergeable } = await fetchPullRequestRollup(owner, repo, number, token);
  return {
    ciState: toCiState(rollup),
    mergeable,
    mergeJudgement: rollup?.mergeJudgement ?? MERGE_JUDGEMENT_UNKNOWN,
    ciRunId: rollup?.ciRunId ?? null,
    ciChecks: rollup?.ciChecks ?? [],
  };
}

/** 取得できなかったPRの値。CI状態・判定の進み具合は`unknown`、コンフリクトは判定できずnull */
export const UNKNOWN_PULL_REQUEST_CI_STATE: PullRequestCiState = {
  ciState: "unknown",
  mergeable: null,
  mergeJudgement: MERGE_JUDGEMENT_UNKNOWN,
  ciRunId: null,
  ciChecks: [],
};

/**
 * 複数PRのCI状態とコンフリクト有無を、**PR件数によらず少ない回数の**GraphQLで取得する（#1962）。
 *
 * PR一覧のように対象が何件になるか分からない経路はこちらを使う。1件ずつ`fetchPullRequestCiState`を
 * 呼ぶと消費がPR件数に比例し、10秒間隔の自動更新と合わせるとレート制限に触れる。
 *
 * 返すのは`pullRequestRollupKey()`をキーにしたMapで、**取得できなかったPRはキーごと落とす**。
 * 呼び出し側は`?? UNKNOWN_PULL_REQUEST_CI_STATE`で未取得へ縮退させる。
 *
 * トークンはinstallation単位なので、渡してよいのは同じinstallationのPRだけ。
 */
export async function fetchPullRequestCiStates(
  targets: PullRequestRollupTarget[],
  token: string,
): Promise<Map<string, PullRequestCiState>> {
  const rollups = await fetchPullRequestRollups(targets, token);
  return new Map(
    [...rollups].map(([key, { rollup, mergeable }]) => [
      key,
      {
        ciState: toCiState(rollup),
        mergeable,
        mergeJudgement: rollup?.mergeJudgement ?? MERGE_JUDGEMENT_UNKNOWN,
        ciRunId: rollup?.ciRunId ?? null,
        ciChecks: rollup?.ciChecks ?? [],
      },
    ]),
  );
}

/**
 * 「Release develop to main」workflowをdevelopブランチを対象に手動起動する。
 *
 * `bumpKind`を渡すとバージョンの上げ幅を`bump_kind` inputとして指定する（#1548）。
 * **未指定のときはinputそのものを送らない。** `bump_kind`を持たない世代のcallerを置いている
 * リポジトリでも、従来どおり（自動判定での起動）動き続ける必要があるため。指定した場合に
 * そうしたリポジトリを叩くとGitHubが422（`Unexpected inputs provided`）を返し、
 * 呼び出し側がそれを`bump_kind_unsupported`として画面へ伝える。
 */
export async function dispatchReleaseWorkflow(
  owner: string,
  repo: string,
  token: string,
  bumpKind?: BumpKind,
): Promise<void> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${RELEASE_WORKFLOW_FILE}/dispatches`;
  const res = await githubFetch(url, token, {
    method: "POST",
    body: { ref: "develop", ...(bumpKind ? { inputs: { bump_kind: bumpKind } } : {}) },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
}

/**
 * 本番デプロイworkflow（`deploy.yml`）をmainブランチに対して手動起動する（#2020）。
 *
 * **inputは送らない。** 各リポジトリの`deploy.yml`は`workflow_dispatch:`をinput無しで
 * 書いており、送るとGitHubが422（`Unexpected inputs provided`）で落とす。
 * `main`をそのまま出し直すだけの操作なので、指定するものも無い。
 *
 * `workflow_dispatch`そのものを書いていないリポジトリでも422になる（`guchi-apps/portfolio`）。
 * ファイルの有無からは区別できないため、呼び出し側が422を専用の文言へ振り分ける。
 */
export async function dispatchDeployWorkflow(
  owner: string,
  repo: string,
  token: string,
): Promise<void> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${DEPLOY_WORKFLOW_FILE}/dispatches`;
  const res = await githubFetch(url, token, { method: "POST", body: { ref: "main" } });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
}
