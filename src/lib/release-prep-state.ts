import type { ReleaseBlockedReason } from "@/types/branch-flow";

/**
 * 「リリースする」を押す前の自動準備の状態（#4421）。
 *
 * `canTriggerRelease`（`branch-flow.ts`）はopenなリリースPR・バンプPRの有無しか見ないため、
 * 修正を取り込んだ作り直し（元のリリースPRを閉じてから、workflowがバンプPRを出すまで）の
 * PRが0件の間も押せてしまっていた。DBに残る準備の記録だけを材料に、その間を塞ぐ。
 *
 * - `failed`: 未解決のリリース準備失敗がある（`ReleasePreparationFailure`）
 * - `running`: 修正を取り込んだリリースの準備が進行中（`ReleaseFixSeries`が下の状態）
 * - `unknown`: 記録をまだ取得できていない（初回・リポジトリ切替・取得失敗。#4556）。**idleと同一視せず起動を塞ぐ**
 * - `idle`: 記録が無い。**本番マージ直後〜CI開始前の純粋な待機は記録が無いため、ここへ入る**
 *   （推測で「実行中」とは出さない）
 */
export type ReleasePrepState = "idle" | "running" | "failed" | "unknown";

/** 作り直しの空白区間（PRが0件になり得る）に当たる系列の状態 */
export const RELEASE_PREP_RUNNING_SERIES_STATUSES = ["fix_merged", "rebuilding"] as const;

export function resolveReleasePrepState(input: {
  hasOpenFailure: boolean;
  activeFixSeriesStatuses: readonly string[];
}): ReleasePrepState {
  // 失敗は待機より先に決める（失敗したまま「操作せずお待ちください」と案内しない）
  if (input.hasOpenFailure) return "failed";
  const running = input.activeFixSeriesStatuses.some((status) =>
    (RELEASE_PREP_RUNNING_SERIES_STATUSES as readonly string[]).includes(status),
  );
  return running ? "running" : "idle";
}

/**
 * 本番(main)へのリリースPRをマージしてから、自動処理（CI→バンプPR作成）が動き出すまでの待機時間の上限（#4526）。
 * バンプPRはscheduleで作られ（最大15分粒度）、その間はPRもDBの記録も無い。記録が無いので
 * 「直近のリリースのマージ時刻＋未リリースの変更あり」から推定し、余裕を見て20分で打ち切る。
 */
export const RELEASE_AUTOMATION_WAIT_MS = 20 * 60 * 1000;

/** 直近のmainマージ直後で、バンプPRがまだ出ていない待機か（#4526）。PRが開いている間は別の理由が先に決まる */
export function isAwaitingReleaseAutomation(input: {
  latestReleaseMergedAt: string | null;
  now: number;
  unreleasedCommitCount: number;
}): boolean {
  if (input.latestReleaseMergedAt === null || input.unreleasedCommitCount <= 0) return false;
  const mergedAt = Date.parse(input.latestReleaseMergedAt);
  if (Number.isNaN(mergedAt)) return false;
  const elapsed = input.now - mergedAt;
  return elapsed >= 0 && elapsed < RELEASE_AUTOMATION_WAIT_MS;
}

/**
 * ブランチ状況から決まった理由（`base`）へ準備の状態を重ねる。**押せない理由が既にあるときは
 * そちらを優先する**（リリース中・出す変更なし・デプロイ失敗のほうが、画面の事実として強い）。
 */
export function applyReleasePrepState(
  base: ReleaseBlockedReason | null,
  state: ReleasePrepState,
): ReleaseBlockedReason | null {
  // 未取得は、確認付きで起動できるdeploy-failedよりも先に塞ぐ（準備中かどうか分からないまま起動させない。#4556）
  if (state === "unknown" && (base === null || base === "deploy-failed")) return "preparation-unknown";
  if (base !== null) return base;
  if (state === "failed") return "preparation-failed";
  if (state === "running") return "release-preparing";
  return null;
}

/** 準備の状態による押せない理由か（#4421）。灰色に見せるが、確認のうえ押せるものだけ */
export function isPrepBlockedReason(reason: ReleaseBlockedReason | null | undefined): reason is "release-preparing" | "preparation-failed" {
  return reason === "release-preparing" || reason === "preparation-failed";
}

/** 準備の状態を承知のうえで起動するときの確認文（個別・スマホ・一括で共通） */
export const PREP_OVERRIDE_CONFIRM_TEXT: Record<ReleasePrepState, string> = {
  idle: "",
  unknown: "",
  running: "修正を取り込んだリリースの準備が自動で進行中です。いま起動すると二重に実行される可能性があります。それでも起動します。",
  failed: "リリース準備が失敗しています。原因を確認のうえ、帯の「再開」ではなくここから起動します。",
};
