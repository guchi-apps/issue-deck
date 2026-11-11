import type { MergeJudgement } from "@/lib/github/check-rollup";

/**
 * 自動マージを予約したまま、GitHubがマージを起こさずに止まったPRを見分ける（#5326）。
 *
 * `claude-review-develop.yml`の`auto-merge`は`gh pr merge --auto`で予約するが、必須チェックが
 * 成功済みでもGitHubがマージを起こさず、別のPRのマージなどで再評価されるまで放置されることが
 * あった（#5287は8時間、#5306・#5307・#5284などは15〜40分。原因はGitHub側で特定できていない）。
 * ワークフローは予約の後に直接マージで後押しするが、そこで拾えなかったものをここで拾う。
 *
 * **拾い方は`auto-merge`ジョブだけの再実行**（`rerunPullRequestAutoMerge`）。判定とマージ操作は
 * ワークフローが持ったままで、issue-deckは直接マージしない（developへのマージ操作をレビュー経路の
 * 外に持たせない。CLAUDE.md）。再実行されたジョブはラベル・保留の判定を読み直す。
 */

/** 判定（`auto-merge`ジョブ）が終わってから、止まったとみなすまでの時間 */
export const AUTO_MERGE_STUCK_AFTER_MS = 10 * 60 * 1000;

export type AutoMergeStuckInput = {
  now: Date;
  pullRequest: { draft: boolean; baseRef: string; headSha: string; autoMergeEnabled: boolean };
  /** PRのチェックの集約結果（`CheckRollup.state`） */
  rollupState: string | null;
  mergeJudgement: MergeJudgement | null | undefined;
  /** このHEADで既に再実行したか（HEADごとに1回まで） */
  alreadyAttempted: boolean;
};

export type AutoMergeStuckDecision = { action: "skip"; reason: string } | { action: "rerun" };

export function decideAutoMergeStuckRescue(input: AutoMergeStuckInput): AutoMergeStuckDecision {
  const { pullRequest: pr, mergeJudgement } = input;
  if (pr.draft || pr.baseRef !== "develop") return { action: "skip", reason: "not_target" };
  if (!pr.autoMergeEnabled) return { action: "skip", reason: "not_scheduled" };
  // 判定の途中（再実行中を含む）は、その判定が結論を出す
  if (mergeJudgement?.state !== "settled") return { action: "skip", reason: "judging" };
  // チェックがすべて通っていないものは、GitHubの予約が待っているのが正しい
  if (input.rollupState !== "success") return { action: "skip", reason: "checks_not_passed" };
  const completedAt = mergeJudgement.autoMergeRun?.completedAt;
  const completedMs = completedAt ? Date.parse(completedAt) : Number.NaN;
  if (Number.isNaN(completedMs)) return { action: "skip", reason: "no_judgement_time" };
  if (input.now.getTime() - completedMs < AUTO_MERGE_STUCK_AFTER_MS) return { action: "skip", reason: "within_grace" };
  if (input.alreadyAttempted) return { action: "skip", reason: "already_attempted" };
  return { action: "rerun" };
}
