import { fetchRecentSuccessfulRuns, fetchWorkflowRunJobs } from "@/lib/github/actions-api";
import { medianMs } from "@/lib/workflow-run-progress";

/**
 * 「このワークフローは普段どれくらいかかるか」をプロセス内に持つ（#2777）。
 *
 * **見込み時間の材料は、実行ごとには変わらない。** 内訳パネルを開いている間、実行の状態は
 * 10数秒ごとに取り直すが、過去の実績まで毎回引くとGitHub APIの消費が数倍になる。ここで
 * 10分持たせ、同じワークフローを見ている複数のパネルで使い回す（`workflow-exists-cache.ts`と
 * 同じ作り）。本番はPM2のfork（単一プロセス）なので、プロセスが入れ替われば空になる。
 *
 * 取得に失敗しても**例外にしない**。見込みが出ないだけで、経過時間とジョブの内訳は出せる。
 */
const BASELINE_TTL_MS = 10 * 60_000;

/** 過去の実績。実績が足りないときは`estimateMs`がnull、`jobDurationsMs`が空になる */
export type WorkflowRunBaseline = {
  /** 全体の見込み所要時間（ミリ秒）。直近の成功した実行の中央値 */
  estimateMs: number | null;
  /**
   * 直近の成功した実行での、ジョブ名ごとの所要時間（ミリ秒）。
   *
   * **中央値ではなく直近1回ぶん。** ジョブ単位の実績まで中央値にすると、過去の実行の数だけ
   * `/actions/runs/{id}/jobs`を引くことになる（1回の表示でリクエストが20回増える）。
   * ここは待ちのジョブへ「通常このくらい」と添えるための目安なので、直近1回で足りる。
   */
  jobDurationsMs: Record<string, number>;
};

const EMPTY_BASELINE: WorkflowRunBaseline = { estimateMs: null, jobDurationsMs: {} };

const cache = new Map<string, { baseline: WorkflowRunBaseline; cachedAt: number }>();
const inFlight = new Map<string, Promise<WorkflowRunBaseline>>();

async function loadBaseline(
  owner: string,
  repo: string,
  workflowId: number,
  token: string,
): Promise<WorkflowRunBaseline> {
  const runs = await fetchRecentSuccessfulRuns(owner, repo, workflowId, token);
  const estimateMs = medianMs(runs.map((run) => run.durationMs));

  const latest = runs[0];
  if (!latest) return { estimateMs, jobDurationsMs: {} };

  const jobs = await fetchWorkflowRunJobs(owner, repo, latest.id, token);
  const jobDurationsMs: Record<string, number> = {};
  for (const job of jobs) {
    if (!job.name || !job.started_at || !job.completed_at) continue;
    const durationMs = Date.parse(job.completed_at) - Date.parse(job.started_at);
    if (Number.isFinite(durationMs) && durationMs > 0) jobDurationsMs[job.name] = durationMs;
  }
  return { estimateMs, jobDurationsMs };
}

export function getWorkflowRunBaseline(
  owner: string,
  repo: string,
  workflowId: number,
  token: string,
): Promise<WorkflowRunBaseline> {
  const key = `${owner}/${repo}/${workflowId}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.cachedAt < BASELINE_TTL_MS) {
    return Promise.resolve(cached.baseline);
  }

  const running = inFlight.get(key);
  if (running) return running;

  const request = loadBaseline(owner, repo, workflowId, token)
    .then((baseline) => {
      cache.set(key, { baseline, cachedAt: Date.now() });
      return baseline;
    })
    .catch((error) => {
      // 実績が引けないのは異常ではない（権限・履歴が無い）。見込みを伏せて続ける。
      console.error(`[workflow-run-baseline] ${key}:`, error);
      return EMPTY_BASELINE;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, request);
  return request;
}

/** テスト用にキャッシュを空にする（プロセスをまたがないので本番では呼ばない） */
export function clearWorkflowRunBaselineCacheForTest(): void {
  cache.clear();
  inFlight.clear();
}
