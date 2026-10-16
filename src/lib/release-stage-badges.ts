import { QUEUED_CHECK_STATUSES } from "@/lib/pull-request-health";
import { isMergeJudgementPending } from "@/lib/pull-request-list";
import { resolvePullRequestReleaseVerification } from "@/lib/release-candidate-status";
import type { PullRequestSummary } from "@/types/pull-request";

/**
 * ブランチ画面の本番リリース工程バッジ（#4602）。バンプPR・リリース候補PRの「いま実際に動いている工程」を
 * 工程名つきで返す。畳んだ行・展開した見出し・「次のリリース」カードが同じ結果を読む。
 *
 * - `running`がtrueのものだけ、画面で円が回る。起動待ち・キュー待ち・取得できていないものは回さない
 * - **工程名は取得できた根拠からだけ決める。** 根拠が無ければ工程を作らず、呼び出し側が
 *   「工程を確認できません」を出す（推測で「CI実行中」などと言わない）
 * - 全体レビュー・統合検証は`resolvePullRequestReleaseVerification`の進行中の検証から導く
 *   （検証の状態を再解釈しない）。問題（失敗・要確認・取得不能）はここでは扱わない
 * - 通常PRの集計は扱わない（#4540）。別候補・古いSHAの結果（`previous`）は混ぜない
 */
export type ReleaseStageBadge = {
  key: string;
  label: string;
  /** 実行中か。falseは開始待ち・キュー待ち・取得できていない状態 */
  running: boolean;
  /** ホバー・読み上げ用の補足 */
  title: string;
};

type StagePullRequest = Pick<
  PullRequestSummary,
  | "state"
  | "baseRef"
  | "headRef"
  | "ciState"
  | "ciChecks"
  | "mergeJudgement"
  | "releaseChecks"
  | "iosPrecheck"
>;

function ciStage(pullRequest: StagePullRequest, subject: string, key: string): ReleaseStageBadge | null {
  if (pullRequest.ciState !== "pending") return null;
  const unfinished = pullRequest.ciChecks.filter((check) => check.status !== "completed");
  if (unfinished.some((check) => check.status === "in_progress")) {
    return { key, label: `${subject}のCI実行中`, running: true, title: "実行中のチェックがあります" };
  }
  if (unfinished.length > 0 && unfinished.every((check) => QUEUED_CHECK_STATUSES.has(check.status))) {
    return { key, label: `${subject}のCI待機`, running: false, title: "チェックはまだ開始されていません" };
  }
  return {
    key,
    label: `${subject}のCI未完了`,
    running: false,
    title: "チェックが完了していません。待機か実行中かは取得できていません",
  };
}

function judgementStage(pullRequest: StagePullRequest, subject: string, key: string): ReleaseStageBadge | null {
  if (!isMergeJudgementPending(pullRequest.mergeJudgement)) return null;
  return {
    key,
    label: `${subject}のマージ判定中`,
    running: true,
    title: "自動マージ可否の判定を実行しています",
  };
}

export function resolveReleaseStageBadges({
  bumpPullRequest,
  candidatePullRequest,
}: {
  bumpPullRequest: StagePullRequest | null;
  candidatePullRequest: StagePullRequest | null;
}): ReleaseStageBadge[] {
  const badges: ReleaseStageBadge[] = [];
  const push = (badge: ReleaseStageBadge | null) => {
    if (badge) badges.push(badge);
  };

  if (bumpPullRequest && bumpPullRequest.state === "open") {
    push(ciStage(bumpPullRequest, "バージョンバンプ", "bump-ci"));
    push(judgementStage(bumpPullRequest, "バージョンバンプ", "bump-judgement"));
  }

  if (candidatePullRequest && candidatePullRequest.state === "open") {
    const pending = resolvePullRequestReleaseVerification(candidatePullRequest).progress?.checks ?? [];
    for (const check of pending) {
      const review = check.name === "全体レビュー";
      const base = review ? "全体レビュー" : "統合検証";
      push({
        key: review ? "ai-review" : "integration",
        // 段階（#4664）があればそれを出す。完了した統合検証を待つレビューを「全体レビュー中」と言わない
        label: check.stageLabel ?? (check.started ? `${base}中` : `${base}開始待ち`),
        running: check.started,
        title: check.stageLabel
          ? `${check.name}: ${check.stageLabel}`
          : `${check.name}の${check.started ? "実行中" : "開始待ち"}です`,
      });
    }
    const ios = candidatePullRequest.iosPrecheck?.head;
    if (ios && (ios.phase === "running" || ios.phase === "waiting")) {
      push({
        key: "ios-precheck",
        label: ios.phase === "running" ? "iOS検証中" : "iOS検証待ち",
        running: ios.phase === "running",
        title: ios.description ?? "iOS事前検証の状態です",
      });
    }
    push(ciStage(candidatePullRequest, "リリース候補", "candidate-ci"));
    push(judgementStage(candidatePullRequest, "リリース候補", "candidate-judgement"));
  }

  return badges;
}
