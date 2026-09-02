import { GithubApiError } from "@/lib/github/github-api-error";
import { GITHUB_API, githubFetch } from "@/lib/github/request";

export type GithubApiWorkflowRun = {
  status: "queued" | "in_progress" | "completed" | string;
  conclusion: string | null;
  run_started_at: string;
  updated_at: string;
  /**
   * このrunを作ったワークフローの定義ID（#2777）。**見込み時間の材料を引くための鍵。**
   * 同じワークフローの過去の実行を`/actions/workflows/{id}/runs`で引くのに使う
   * （ファイル名でも引けるが、runからはIDしか取れない）。
   */
  workflow_id?: number;
  name?: string | null;
  html_url?: string;
  run_attempt?: number;
};

export async function fetchWorkflowRun(
  owner: string,
  repo: string,
  runId: number,
  token: string,
): Promise<GithubApiWorkflowRun> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/runs/${runId}`;
  const res = await githubFetch(url, token);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
  return res.json();
}

export type GithubApiWorkflowJobStep = {
  name: string;
  status: "queued" | "in_progress" | "completed" | string;
  conclusion: string | null;
};

export type GithubApiWorkflowJob = {
  /** ジョブ名（`build`・`lint-and-build`など）。#2777で内訳を出すために使う */
  name?: string;
  status: "queued" | "in_progress" | "completed" | string;
  conclusion: string | null;
  /** 実行開始時刻（ISO8601）。キューに入っただけのジョブでは開始前の時刻が入ることがある */
  started_at?: string | null;
  /** 完了時刻（ISO8601）。未完了ならnull */
  completed_at?: string | null;
  html_url?: string | null;
  /**
   * ステップ。**キューに入っただけのジョブでは配列ごと返らないことがある**ため任意にしている
   * （#2777。`getCurrentStepName`は空配列として扱う）。
   */
  steps?: GithubApiWorkflowJobStep[];
};

export async function fetchWorkflowRunJobs(
  owner: string,
  repo: string,
  runId: number,
  token: string,
): Promise<GithubApiWorkflowJob[]> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/runs/${runId}/jobs`;
  const res = await githubFetch(url, token);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
  const data: { jobs: GithubApiWorkflowJob[] } = await res.json();
  return data.jobs;
}

export async function cancelWorkflowRun(
  owner: string,
  repo: string,
  runId: number,
  token: string,
): Promise<void> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/runs/${runId}/cancel`;
  const res = await githubFetch(url, token, { method: "POST" });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
}

export async function forceCancelWorkflowRun(
  owner: string,
  repo: string,
  runId: number,
  token: string,
): Promise<void> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/runs/${runId}/force-cancel`;
  const res = await githubFetch(url, token, { method: "POST" });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
}

export type GithubApiPullRequest = {
  head: { sha: string };
};

export async function fetchPullRequest(
  owner: string,
  repo: string,
  number: number,
  token: string,
): Promise<GithubApiPullRequest> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls/${number}`;
  const res = await githubFetch(url, token);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
  return res.json();
}

/**
 * マージの結果。**`sha`（マージコミットのSHA）を捨てない**（#2703）。
 *
 * mainへのマージでは、この値が「GitHubが本当にこのマージのイベントを配送したか」を
 * 後から照合するための唯一の鍵になる（`deploy.yml`の実行の`head_sha`と突き合わせる）。
 * 取れなかったときはnull——照合できないだけで、マージ自体は成功している。
 */
export type MergePullRequestResult = {
  /** マージコミットのSHA。レスポンスから読めなければnull */
  sha: string | null;
};

export async function mergePullRequest(
  owner: string,
  repo: string,
  number: number,
  token: string,
): Promise<MergePullRequestResult> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls/${number}/merge`;
  const res = await githubFetch(url, token, { method: "PUT", body: { merge_method: "merge" } });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
  const data: { sha?: unknown } = await res.json().catch(() => ({}));
  return { sha: typeof data.sha === "string" ? data.sha : null };
}

/** 過去の成功した実行1件。見込み時間の材料（#2777） */
export type SuccessfulWorkflowRunRef = {
  id: number;
  /** 所要時間（ミリ秒） */
  durationMs: number;
};

/**
 * 同じワークフローの、直近の成功した実行を新しい順に返す（#2777）。
 *
 * **「あと何分待てばよいか」の材料。** GitHubは見込み時間を返してくれないため、過去の実測から
 * 自前で見積もる。所要時間は`updated_at - run_started_at`で求める——runには完了時刻の
 * フィールドが無く、`updated_at`が完了で止まるのが実質の終了時刻（`WorkflowRunStatus`が
 * 既に同じ求め方をしている）。
 *
 * **成功した実行だけを見る。** 失敗・キャンセルは途中で打ち切られた時間なので、混ぜると
 * 見込みが実際より短くなる。
 *
 * `workflowId`はrun側から取れる定義ID（`fetchWorkflowRun`の`workflow_id`）。ファイル名を
 * 使わないのは、runから分かるのがIDだけで、CI・デプロイのどちらからも同じ手順で引けるため。
 */
export async function fetchRecentSuccessfulRuns(
  owner: string,
  repo: string,
  workflowId: number,
  token: string,
  perPage = 20,
): Promise<SuccessfulWorkflowRunRef[]> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${workflowId}/runs?status=success&per_page=${perPage}`;
  const res = await githubFetch(url, token);
  // 実行履歴が引けないこと自体は異常ではない（権限・ワークフローの削除）。見込みを出さない側へ倒す。
  if (res.status === 404) return [];
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GithubApiError(res.status, `GitHub API request failed: ${res.status} ${url} ${detail}`);
  }
  const data: {
    workflow_runs?: Array<{
      id?: number;
      run_started_at?: string;
      created_at?: string;
      updated_at?: string;
    }>;
  } = await res.json();
  const runs: SuccessfulWorkflowRunRef[] = [];
  for (const run of data.workflow_runs ?? []) {
    const startedAt = run.run_started_at ?? run.created_at;
    if (!run.id || !startedAt || !run.updated_at) continue;
    const durationMs = Date.parse(run.updated_at) - Date.parse(startedAt);
    if (Number.isFinite(durationMs) && durationMs > 0) runs.push({ id: run.id, durationMs });
  }
  return runs;
}
