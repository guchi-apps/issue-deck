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

export type IosStageStatus = { key: IosStageKey; label: string; state: IosStageState };

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
  const record = (key: IosStageKey, state: IosStageState) => {
    const prev = found.get(key);
    if (prev === undefined || SEVERITY[state] > SEVERITY[prev]) found.set(key, state);
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
        record(key, toStageState(step.status, step.conclusion));
      }
    }
    const jobKey = job.name ? stageOf(job.name) : null;
    if (jobKey && (!matchedStep || !found.has(jobKey))) {
      record(jobKey, toStageState(job.status, job.conclusion));
    }
    if (!jobKey && !matchedStep && toStageState(job.status, job.conclusion) === "skipped") {
      unmatchedJobSkipped = true;
    }
  }
  return IOS_STAGES.map(({ key, label }) => ({
    key,
    label,
    state: found.get(key) ?? (unmatchedJobSkipped && key !== "detect" ? "skipped" : "unknown"),
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
