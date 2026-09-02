import type { GithubApiWorkflowJob } from "@/lib/github/actions-api";

/**
 * GitHub Actionsの実行を「どこまで進んだか」「あと何分か」として読める形に整える（#2777）。
 *
 * 画面が出していたのは「デプロイ中」「CI実行中」の1語だけで、そこから進み具合も残り時間も
 * 読めなかった。ここはGitHubの応答（run・jobs・過去の成功した実行）を受けて、**描画に必要な
 * 値だけを持つ純粋関数**として置く。経過時間は1秒ごとに変わるため、APIでは確定させず
 * `now`を受け取って毎回求め直す（`WorkflowRunStatus`と同じやり方）。
 */

/** ジョブ1件の状態。GitHubのstatus・conclusionを画面が使う語彙へ畳んだもの */
export type WorkflowRunJobState =
  | "queued"
  | "running"
  | "success"
  | "failure"
  | "cancelled"
  | "skipped";

export type WorkflowRunJobView = {
  name: string;
  state: WorkflowRunJobState;
  /** 実行中のステップ名。実行中でない・取れない場合はnull */
  currentStep: string | null;
  /** 開始時刻（ISO8601）。まだ始まっていなければnull */
  startedAt: string | null;
  /** 完了時刻（ISO8601）。未完了ならnull */
  completedAt: string | null;
  /**
   * 直近の成功した実行での、同じ名前のジョブの所要時間（ミリ秒）。取れなければnull。
   *
   * **待ちのジョブに「通常どれくらいか」を添えるためだけの値。** 全体の見込みには使わない
   * ——CIのようにジョブが並列に走るワークフローでは、足し合わせると実際の倍以上になる。
   */
  baselineMs: number | null;
  htmlUrl: string | null;
};

/** `GET /api/workflow-runs`が返す、実行1件ぶんの内訳 */
export type WorkflowRunProgress = {
  runId: number;
  htmlUrl: string | null;
  /** ワークフロー名（`CI`・`Deploy`など）。取れなければnull */
  workflowName: string | null;
  /** queued | in_progress | completed */
  status: string;
  /** success | failure | cancelled | null（未完了時） */
  conclusion: string | null;
  startedAt: string;
  updatedAt: string;
  /** 何回目の試行か（初回は1） */
  runAttempt: number;
  jobs: WorkflowRunJobView[];
  /**
   * 全体の見込み所要時間（ミリ秒）。実績が足りなければnull。
   *
   * **中央値を使う。** 平均だと、たまに混ざる極端に遅い実行（ランナーの待ちが長かった回）に
   * 引きずられて、いつまで待っても「あと少し」にならない見込みになる。
   */
  estimateMs: number | null;
};

/**
 * 見込みを出すのに要る実績の件数（#2777）。
 *
 * **1〜2件では出さない。** ワークフローを変えた直後や作ったばかりのリポジトリで、
 * たまたま速かった1回を「見込み」として出すと、外れたときに数字ごと信用されなくなる。
 * 足りないときは見込みを伏せ、経過時間だけを出す。
 */
export const MIN_ESTIMATE_SAMPLES = 3;

/** 実行中のバーが端まで行ききらないようにする上限。終わっていないことを形で残す */
const RUNNING_RATIO_CAP = 0.97;

/** ジョブのstatus・conclusionを画面の語彙へ畳む */
export function resolveJobState(job: GithubApiWorkflowJob): WorkflowRunJobState {
  if (job.status === "queued" || job.status === "waiting" || job.status === "pending") {
    return "queued";
  }
  if (job.status !== "completed") return "running";
  if (job.conclusion === "success") return "success";
  if (job.conclusion === "skipped") return "skipped";
  if (job.conclusion === "cancelled") return "cancelled";
  return "failure";
}

/**
 * 実行中のジョブの現在ステップ名を返す。実行中のステップが無ければ、
 * 最後に完了したステップの名前を返す（起動直後・ステップの切り替わりで空にしないため）。
 */
function currentStepName(job: GithubApiWorkflowJob): string | null {
  const steps = job.steps ?? [];
  const running = steps.find((step) => step.status === "in_progress");
  if (running) return running.name;
  if (job.status === "completed") {
    // 失敗したジョブは、どのステップで落ちたのかが分かる方が役に立つ
    const failed = steps.find(
      (step) => step.conclusion !== null && step.conclusion !== "success" && step.conclusion !== "skipped",
    );
    if (failed) return failed.name;
  }
  return null;
}

export function toWorkflowRunJobView(
  job: GithubApiWorkflowJob,
  baselineMsByJobName: ReadonlyMap<string, number>,
): WorkflowRunJobView {
  const name = job.name ?? "(名前なし)";
  return {
    name,
    state: resolveJobState(job),
    currentStep: currentStepName(job),
    startedAt: job.started_at ?? null,
    completedAt: job.completed_at ?? null,
    baselineMs: baselineMsByJobName.get(name) ?? null,
    htmlUrl: job.html_url ?? null,
  };
}

/**
 * ジョブの所要時間（完了済み）または経過時間（実行中）。始まっていなければnull。
 *
 * **キューに入っただけのジョブの`started_at`は開始前の時刻**（GitHubがキュー投入時刻を入れる）
 * なので、`queued`のジョブでは時間を出さない。出すと、待っているだけのジョブが
 * 何分も走っているように見える。
 */
export function jobElapsedMs(job: WorkflowRunJobView, now: number): number | null {
  if (job.state === "queued" || !job.startedAt) return null;
  const startedAt = Date.parse(job.startedAt);
  if (Number.isNaN(startedAt)) return null;
  const endedAt = job.completedAt ? Date.parse(job.completedAt) : now;
  if (Number.isNaN(endedAt)) return null;
  return Math.max(0, endedAt - startedAt);
}

/** 中央値。実績が`MIN_ESTIMATE_SAMPLES`件に満たなければnull */
export function medianMs(values: readonly number[]): number | null {
  if (values.length < MIN_ESTIMATE_SAMPLES) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle];
}

export type WorkflowRunProgressSummary = {
  isRunning: boolean;
  /** 完了していて、結論が成功でない（失敗・キャンセル） */
  failed: boolean;
  /** 実行中なら経過時間、完了済みなら所要時間（ミリ秒） */
  elapsedMs: number;
  /** 残りの見込み（ミリ秒）。見込みが無い・すでに超過している場合はnull */
  remainingMs: number | null;
  /** 実行中で、見込みを超えている */
  overEstimate: boolean;
  /** 進捗バーの割合（0〜1） */
  ratio: number;
  /** 完了したジョブ数（スキップ・キャンセルを含む） */
  doneJobCount: number;
  jobCount: number;
};

export function summarizeWorkflowRunProgress(
  progress: WorkflowRunProgress,
  now: number,
): WorkflowRunProgressSummary {
  const isRunning = progress.status !== "completed";
  const startedAt = Date.parse(progress.startedAt);
  const endedAt = isRunning ? now : Date.parse(progress.updatedAt);
  const elapsedMs = Math.max(
    0,
    (Number.isNaN(endedAt) ? now : endedAt) - (Number.isNaN(startedAt) ? now : startedAt),
  );

  const doneJobCount = progress.jobs.filter((job) => job.state !== "queued" && job.state !== "running")
    .length;
  const jobCount = progress.jobs.length;

  const estimateMs = progress.estimateMs;
  const overEstimate = isRunning && estimateMs !== null && elapsedMs > estimateMs;
  const remainingMs =
    isRunning && estimateMs !== null && !overEstimate ? Math.max(0, estimateMs - elapsedMs) : null;

  let ratio: number;
  if (!isRunning) {
    ratio = 1;
  } else if (estimateMs !== null && estimateMs > 0) {
    ratio = Math.min(elapsedMs / estimateMs, RUNNING_RATIO_CAP);
  } else {
    // 見込みが無いときは、終わったジョブの割合で代用する（時間では何も言えない）
    ratio = jobCount > 0 ? Math.min(doneJobCount / jobCount, RUNNING_RATIO_CAP) : 0;
  }

  return {
    isRunning,
    failed: !isRunning && progress.conclusion !== null && progress.conclusion !== "success",
    elapsedMs,
    remainingMs,
    overEstimate,
    ratio,
    doneJobCount,
    jobCount,
  };
}

/**
 * GitHubの実行ログURL（`https://github.com/o/r/actions/runs/123` や
 * `.../runs/123/job/456`）からrun idを取り出す（#2777）。
 *
 * **CIの内訳を開くための鍵。** PRのCI状態は`statusCheckRollup`で取っており、そこに含まれる
 * `detailsUrl`がこの形をしている。ここから読めればGitHub APIを増やさずに内訳へ辿れる。
 * 形が変わって読めなくなったらnullを返し、**内訳を出さない側へ倒す**（誤ったrunを開くより、
 * 従来どおりバッジだけの表示に留まる方が害が小さい）。
 */
export function extractRunIdFromDetailsUrl(detailsUrl: string | null | undefined): number | null {
  if (!detailsUrl) return null;
  const matched = /\/actions\/runs\/(\d+)(?:[/?#]|$)/.exec(detailsUrl);
  if (!matched) return null;
  const runId = Number(matched[1]);
  return Number.isSafeInteger(runId) && runId > 0 ? runId : null;
}
