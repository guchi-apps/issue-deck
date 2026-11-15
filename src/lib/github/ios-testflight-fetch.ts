import { recordGithubApiCall } from "@/lib/github/api-usage";
import { ImmutableMemo } from "@/lib/github/immutable-memo";
import { GITHUB_API, githubFetch } from "@/lib/github/request";
import { IOS_TESTFLIGHT_WORKFLOW_FILE } from "@/lib/ios-testflight-status";

/**
 * リリース画面・ブランチ画面のiOS配布結果（`GET /api/repositories/ios-testflight`）の取得（#5438）。
 *
 * 画面は未配布の行を60秒、内訳を開くと10秒おきに取り直す。1回の取得で素のGETを約7本（run一覧・
 * run3件のjobs・判定ジョブの注釈など）使っていたため、本番の実測でREST枠の最大の用途になっていた。
 * ここでは**変わらないものは覚え、変わりうるものは条件付きGETで304にする**（304は枠を消費しない）。
 *
 * - run一覧: ETag＋使う項目だけを覚える（`ios-release-status.ts`の`runsMemo`と同じ形。
 *   `githubFetchJsonWithEtag`は応答全体を常駐させるため使わない）
 * - jobs: 完了した実行（同じ`run_attempt`）だけを覚える。実行中は毎回取る
 * - 注釈: 完了した判定ジョブのものだけを覚える
 *
 * プロセス内にしか持たない（再起動で忘れても1回余分に取るだけ）。
 */

export type IosRunItem = {
  id: number;
  status: string;
  conclusion: string | null;
  html_url: string;
  head_sha: string;
  head_branch: string | null;
  event: string;
  created_at: string;
  updated_at?: string;
  run_attempt?: number;
};

export type IosJobItem = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  steps?: {
    name: string;
    status: string;
    conclusion: string | null;
    started_at?: string | null;
    completed_at?: string | null;
  }[];
};

export type IosAnnotation = { message?: string; annotation_level?: string };

const runsMemo = new Map<string, { etag: string; runs: IosRunItem[] }>();
/** キーは`<jobsのURL>#<run_attempt>`。再実行すると`run_attempt`が増え、jobsが変わるため */
const completedJobsMemo = new ImmutableMemo<IosJobItem[]>(200);
const completedAnnotationsMemo = new ImmutableMemo<IosAnnotation[]>(200);

/** テスト用 */
export function clearIosTestflightFetchMemo(): void {
  runsMemo.clear();
  completedJobsMemo.clear();
  completedAnnotationsMemo.clear();
}

function toRunItem(run: IosRunItem): IosRunItem {
  return {
    id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    html_url: run.html_url,
    head_sha: run.head_sha,
    head_branch: run.head_branch,
    event: run.event,
    created_at: run.created_at,
    updated_at: run.updated_at,
    run_attempt: run.run_attempt,
  };
}

function toJobItem(job: IosJobItem): IosJobItem {
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    started_at: job.started_at,
    completed_at: job.completed_at,
    steps: job.steps?.map((step) => ({
      name: step.name,
      status: step.status,
      conclusion: step.conclusion,
      started_at: step.started_at,
      completed_at: step.completed_at,
    })),
  };
}

/**
 * iOS配布workflowの直近`limit`件のrunを新しい順に返す。取れなければ`null`
 * （ワークフロー未導入の404を含む。呼び出し側は「未導入」として扱う）。
 */
export async function fetchRecentIosRuns(
  owner: string,
  repo: string,
  token: string,
  limit: number,
): Promise<IosRunItem[] | null> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${IOS_TESTFLIGHT_WORKFLOW_FILE}/runs?per_page=${limit}`;
  const memo = runsMemo.get(url);
  const res = await githubFetch(url, token, {
    record: false,
    headers: memo ? { "If-None-Match": memo.etag } : undefined,
  });
  // 304はレート制限を消費しないので計上しない（`conditional-request.ts`と同じ）
  if (res.status === 304 && memo) return memo.runs;
  recordGithubApiCall(url);
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { workflow_runs?: IosRunItem[] } | null;
  if (!body || !Array.isArray(body.workflow_runs)) return null;
  const runs = body.workflow_runs.map(toRunItem);
  const etag = res.headers.get("etag");
  if (etag) runsMemo.set(url, { etag, runs });
  else runsMemo.delete(url);
  return runs;
}

/** runのjobsを返す。取れなければ空配列。完了したrunのものだけを覚える */
export async function fetchIosRunJobs(
  owner: string,
  repo: string,
  run: Pick<IosRunItem, "id" | "status" | "run_attempt">,
  token: string,
): Promise<IosJobItem[]> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/runs/${run.id}/jobs`;
  const key = `${url}#${run.run_attempt ?? 1}`;
  const completed = run.status === "completed";
  if (completed) {
    const memoized = completedJobsMemo.get(key);
    if (memoized) return memoized;
  }
  const res = await githubFetch(url, token);
  if (!res.ok) return [];
  const body = (await res.json().catch(() => null)) as { jobs?: IosJobItem[] } | null;
  const jobs = Array.isArray(body?.jobs) ? body.jobs.map(toJobItem) : [];
  // 一覧の時点で完了していても、jobsがまだ揃っていない瞬間は覚えない
  if (completed && jobs.length > 0 && jobs.every((job) => job.status === "completed")) {
    completedJobsMemo.set(key, jobs);
  }
  return jobs;
}

/** 完了したジョブの注釈を返す。取れなければ空配列。完了したジョブの注釈は変わらないので覚える */
export async function fetchCompletedJobAnnotations(
  owner: string,
  repo: string,
  jobId: number,
  token: string,
): Promise<IosAnnotation[]> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/check-runs/${jobId}/annotations`;
  const memoized = completedAnnotationsMemo.get(url);
  if (memoized) return memoized;
  const res = await githubFetch(url, token);
  if (!res.ok) return [];
  const body = (await res.json().catch(() => null)) as IosAnnotation[] | null;
  const annotations = Array.isArray(body)
    ? body.map((annotation) => ({ message: annotation.message, annotation_level: annotation.annotation_level }))
    : [];
  completedAnnotationsMemo.set(url, annotations);
  return annotations;
}
