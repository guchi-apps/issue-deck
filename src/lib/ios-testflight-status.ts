import type { GithubApiWorkflowJob } from "@/lib/github/actions-api";

/**
 * kurashioの`ios-testflight.yml`（ワークフロー名`iOS TestFlight`）の結果を、リリース画面向けの
 * 段階別の状態へ畳む純粋関数（#3626）。
 *
 * 連携元（kurashio#591）の契約は、ジョブ・ステップの**名前で段階を推定する**形にしてある。
 * ワークフローの内部構成（ジョブ分割・ステップ名）は向こうが決めるため、ここでは名前に含まれる
 * 語（日英）で段階へ振り分け、**どの段階にも当たらない場合は「不明」を出す**（成功と偽らない）。
 * **Webのデプロイ（`deploy.yml`）とは別に成否を出す**のが目的で、iOSの失敗をWeb成功に混ぜない。
 */

export const IOS_TESTFLIGHT_WORKFLOW_FILE = "ios-testflight.yml";
/** 配布済みの印のタグ（`ios-testflight/<ビルド番号>`） */
export const IOS_TESTFLIGHT_TAG_PREFIX = "ios-testflight/";

export type IosStageKey = "detect" | "sign" | "build" | "upload" | "processing" | "distribute";

export const IOS_STAGES: readonly { key: IosStageKey; label: string; pattern: RegExp }[] = [
  { key: "detect", label: "変更判定", pattern: /detect|judge|decide|change|判定|変更/i },
  { key: "sign", label: "署名", pattern: /sign|certificate|provision|署名|証明書/i },
  { key: "build", label: "ビルド", pattern: /build|archive|ビルド|アーカイブ/i },
  { key: "upload", label: "アップロード", pattern: /upload|アップロード/i },
  { key: "processing", label: "処理待ち", pattern: /process|wait|処理/i },
  { key: "distribute", label: "内部グループ配布", pattern: /distribut|group|assign|配布|グループ/i },
];

export type IosStageState = "success" | "failure" | "running" | "skipped" | "pending" | "unknown";

export type IosStageStatus = {
  key: IosStageKey;
  label: string;
  state: IosStageState;
  /** 段階の開始・終了時刻（ISO8601）。内訳の所要時間用。ジョブ・ステップが時刻を持たなければnull */
  startedAt: string | null;
  completedAt: string | null;
};

/** ジョブ・ステップ1件の状態を段階の状態へ寄せる */
export function toStageState(status: string, conclusion: string | null): IosStageState {
  if (status !== "completed") return status === "queued" ? "pending" : "running";
  switch (conclusion) {
    case "success":
      return "success";
    case "skipped":
    case "neutral":
      return "skipped";
    case "cancelled":
    case "failure":
    case "timed_out":
    case "startup_failure":
    case "action_required":
      return "failure";
    default:
      return "unknown";
  }
}

// 悪い状態ほど大きい。同じ段階に複数のジョブ・ステップが当たったときは悪い方を採る
const SEVERITY: Record<IosStageState, number> = {
  failure: 5,
  running: 4,
  pending: 3,
  unknown: 2,
  success: 1,
  skipped: 0,
};

/** 名前で段階を決める。先に書いた段階を優先する（`build`が`upload`より先、など） */
function stageOf(name: string): IosStageKey | null {
  // 「Upload build」は`build`ではなく`upload`として扱うため、後ろの段階から当てる
  for (const stage of [...IOS_STAGES].reverse()) {
    if (stage.pattern.test(name)) return stage.key;
  }
  return null;
}

export function summarizeIosStages(jobs: readonly GithubApiWorkflowJob[]): IosStageStatus[] {
  const found = new Map<IosStageKey, IosStageState>();
  // 同じ段階に当たったジョブ・ステップの時刻は、最も早い開始と最も遅い終了へ畳む
  const times = new Map<IosStageKey, { startedAt: string | null; completedAt: string | null }>();
  const record = (
    key: IosStageKey,
    state: IosStageState,
    startedAt?: string | null,
    completedAt?: string | null,
  ) => {
    const prev = found.get(key);
    if (prev === undefined || SEVERITY[state] > SEVERITY[prev]) found.set(key, state);
    const t = times.get(key) ?? { startedAt: null, completedAt: null };
    if (startedAt && (t.startedAt === null || startedAt < t.startedAt)) t.startedAt = startedAt;
    if (completedAt && (t.completedAt === null || completedAt > t.completedAt)) t.completedAt = completedAt;
    times.set(key, t);
  };
  // 段階名に当たらない名前のジョブが丸ごとスキップされたら、配布側の段階をまとめて飛ばした形とみなす
  let unmatchedJobSkipped = false;
  for (const job of jobs) {
    const steps = job.steps ?? [];
    // ステップの名前で当たるものがあればそちらを優先し、無ければジョブ名で当てる
    let matchedStep = false;
    for (const step of steps) {
      const key = stageOf(step.name);
      if (key) {
        matchedStep = true;
        record(key, toStageState(step.status, step.conclusion), step.started_at, step.completed_at);
      }
    }
    const jobKey = job.name ? stageOf(job.name) : null;
    if (jobKey && (!matchedStep || !found.has(jobKey))) {
      record(jobKey, toStageState(job.status, job.conclusion), job.started_at, job.completed_at);
    }
    if (!jobKey && !matchedStep && toStageState(job.status, job.conclusion) === "skipped") {
      unmatchedJobSkipped = true;
    }
  }
  return IOS_STAGES.map(({ key, label }) => ({
    key,
    label,
    state: found.get(key) ?? (unmatchedJobSkipped && key !== "detect" ? "skipped" : "unknown"),
    startedAt: times.get(key)?.startedAt ?? null,
    completedAt: times.get(key)?.completedAt ?? null,
  }));
}

export type IosRunVerdict =
  | { kind: "delivered" }
  | { kind: "skipped" }
  | { kind: "failed"; failedStage: string | null }
  | { kind: "running" }
  | { kind: "unknown" };

/**
 * 実行1件の総合判定。`skipped`は「更新不要と判定してビルドを作らなかった」正常終了で、
 * 失敗と区別して出す（判定ジョブは成功し、以降の段階がすべてスキップされた形）。
 */
export function judgeIosRun(
  run: { status: string; conclusion: string | null },
  stages: readonly IosStageStatus[],
): IosRunVerdict {
  if (run.status !== "completed") return { kind: "running" };
  if (run.conclusion === "success") {
    const later = stages.filter((s) => s.key !== "detect");
    if (later.length > 0 && later.every((s) => s.state === "skipped" || s.state === "unknown")) {
      return later.some((s) => s.state === "skipped") ? { kind: "skipped" } : { kind: "unknown" };
    }
    return { kind: "delivered" };
  }
  if (run.conclusion === "skipped") return { kind: "skipped" };
  if (run.conclusion === null) return { kind: "unknown" };
  const failed = stages.find((s) => s.state === "failure");
  return { kind: "failed", failedStage: failed?.label ?? null };
}

/** タグ名（`ios-testflight/123`）からビルド番号を取り出す。形が違えばnull */
export function buildNumberFromTag(tag: string): number | null {
  if (!tag.startsWith(IOS_TESTFLIGHT_TAG_PREFIX)) return null;
  const rest = tag.slice(IOS_TESTFLIGHT_TAG_PREFIX.length);
  return /^\d+$/.test(rest) ? Number(rest) : null;
}

/** 配布済みタグの一覧から最新（ビルド番号が最大）のものを返す */
export function latestDeliveredBuild(refs: readonly string[]): { tag: string; buildNumber: number } | null {
  let best: { tag: string; buildNumber: number } | null = null;
  for (const ref of refs) {
    const tag = ref.replace(/^refs\/tags\//, "");
    const buildNumber = buildNumberFromTag(tag);
    if (buildNumber !== null && (best === null || buildNumber > best.buildNumber)) {
      best = { tag, buildNumber };
    }
  }
  return best;
}

/**
 * `matching-refs`の結果（タグ名とそのタグが指すコミット）から、指定コミットへ配布済みのビルド番号を返す（#3644）。
 * 配布のworkflowは配布し終えたときだけ、対象コミットへ軽量タグ`ios-testflight/<ビルド番号>`を付ける。
 * run の`head_sha`は起動時のmain先端で束のコミットとは限らないため、配布済みの判定はrunではなくタグから引く。
 */
export function deliveredBuildForSha(
  refs: readonly { ref: string; sha: string }[],
  sha: string,
): number | null {
  let best: number | null = null;
  for (const item of refs) {
    if (item.sha !== sha) continue;
    const buildNumber = buildNumberFromTag(item.ref.replace(/^refs\/tags\//, ""));
    if (buildNumber !== null && (best === null || buildNumber > best)) best = buildNumber;
  }
  return best;
}

/** その版のWebの本番デプロイの状態（iOS配布欄の前提。Webの成否とは混ぜない） */
export type IosWebDeployState = "success" | "pending" | "failed";

/** デプロイのrun（無ければnull）から、iOS配布欄が使う3値へ寄せる */
export function toWebDeployState(run: { status: string; conclusion: string | null } | null): IosWebDeployState {
  if (!run || run.status !== "completed") return "pending";
  return run.conclusion === "success" ? "success" : "failed";
}

export type IosReleasePanelInput = {
  webDeploy: IosWebDeployState;
  /** 束のmergeコミットが、いまのmainの先端か */
  isMainTip: boolean;
  /** 束のコミットへ配布済みのビルド番号（タグから） */
  deliveredBuild: number | null;
  /** 直近のrun（新しい順）。`headSha`は起動時のmain先端 */
  runs: readonly { status: string; headSha: string; verdict: IosRunVerdict; stages: readonly IosStageStatus[] }[];
  /** 束のmergeコミット */
  sha: string;
};

export type IosReleasePanelState =
  | { kind: "delivered"; buildNumber: number | null }
  | { kind: "running"; stages: readonly IosStageStatus[] }
  | { kind: "awaiting-web"; failed: boolean }
  | { kind: "stale" }
  | { kind: "not-needed" }
  | { kind: "failed"; failedStage: string | null }
  | { kind: "ready" };

/**
 * 束のiOS配布欄の表示状態（#3644）。
 *
 * - 配布済みはタグで決まる（古い束にも効く）
 * - 実行中のrunがあれば、どの束のrunかを問わず「配布中」（concurrencyで直列化され二重起動もできない）
 * - mainの先端でない束は、runと束を対応づけられない（`head_sha`が起動時のmain先端になる）ため操作しない
 * - Webの本番デプロイが済むまでは操作できない。iOSの失敗とは別に扱う
 * - 更新不要はrunの判定（skipped）から。失敗ではない
 */
export function judgeIosReleasePanel(input: IosReleasePanelInput): IosReleasePanelState {
  if (input.deliveredBuild !== null) return { kind: "delivered", buildNumber: input.deliveredBuild };
  const active = input.runs.find((run) => run.status !== "completed");
  if (active) return { kind: "running", stages: active.stages };
  if (!input.isMainTip) return { kind: "stale" };
  if (input.webDeploy !== "success") return { kind: "awaiting-web", failed: input.webDeploy === "failed" };
  const latest = input.runs.find((run) => run.headSha === input.sha);
  if (latest?.verdict.kind === "skipped") return { kind: "not-needed" };
  if (latest?.verdict.kind === "failed") return { kind: "failed", failedStage: latest.verdict.failedStage };
  if (latest?.verdict.kind === "delivered") return { kind: "delivered", buildNumber: null };
  return { kind: "ready" };
}

export type IosDispatchBlock =
  | "not_merged"
  | "not_main_tip"
  | "deploy_not_succeeded"
  | "already_delivered"
  | "run_in_progress";

/** 起動してよいかをサーバー側で確かめる（画面の非活性だけに頼らない）。起動できるならnull */
export function checkIosDispatchable(input: {
  merged: boolean;
  isMainTip: boolean;
  webDeploy: IosWebDeployState;
  deliveredBuild: number | null;
  hasActiveRun: boolean;
}): IosDispatchBlock | null {
  if (!input.merged) return "not_merged";
  if (!input.isMainTip) return "not_main_tip";
  if (input.webDeploy !== "success") return "deploy_not_succeeded";
  if (input.deliveredBuild !== null) return "already_delivered";
  if (input.hasActiveRun) return "run_in_progress";
  return null;
}

/**
 * 畳んだ行のスマホアイコンに斜線を引くか（#3799）。最新リリースがまだTestFlightへ配布できていない
 * 状態（配布中・Webデプロイ待ち・失敗・未起動）だけtrue。配布済み・更新不要・過去の版（判定できない）・
 * 読み込み前（null）は、誤って警告しないようfalse。
 */
export function isIosDistributionPending(state: IosReleasePanelState | null): boolean {
  if (state === null) return false;
  return state.kind === "running" || state.kind === "awaiting-web" || state.kind === "failed" || state.kind === "ready";
}
