import { db } from "@/lib/db";
import { readDispatchAgent, type DispatchAgent } from "@/lib/dispatch/dispatch-job";
import { resolvePrReviewGateState, type PrReviewJobLike } from "@/lib/dispatch/pr-review";

/**
 * PRのHEADに対する、エージェント別のAIレビュー（`DispatchJob` `PR_REVIEW`）の状態（#4024）。
 *
 * ブランチ画面のレビュー枠が「片方のLGTMだけで完了」と見せないための材料。Claudeのレビューは
 * check-run＋PR本文の検証結果から読む（`PullRequestSummary.reviewVerdict`）ので、ここに載るのは
 * `PR_REVIEW`ジョブを持つエージェント（主にCodex）。**現在のHEADに対するジョブだけ**を載せる
 * （古いHEADの結果・取り消されたジョブは、現在の判定に使わない）。
 */
export type PullRequestAgentReviewState =
  | "pending"
  | "lgtm"
  | "needs-check"
  | "changes-requested"
  | "failed";

export type PullRequestAgentReview = {
  agent: DispatchAgent;
  state: PullRequestAgentReviewState;
};

type AgentReviewJobRow = PrReviewJobLike & { agent: string; createdAt: Date };

/** ジョブ行（新しい順でなくてよい）をagentごとの最新1件へ畳み、現在のHEADの状態にする。純関数 */
export function summarizeAgentReviews(rows: readonly AgentReviewJobRow[]): PullRequestAgentReview[] {
  const latest = new Map<DispatchAgent, AgentReviewJobRow>();
  for (const row of rows) {
    const agent = readDispatchAgent(row.agent);
    const current = latest.get(agent);
    if (!current || row.createdAt > current.createdAt) latest.set(agent, row);
  }
  const reviews: PullRequestAgentReview[] = [];
  for (const [agent, row] of latest) {
    const gate = resolvePrReviewGateState(row);
    if (gate.state === "pending") reviews.push({ agent, state: "pending" });
    else if (gate.state === "done") {
      reviews.push({ agent, state: gate.verdict === "lgtm" ? "lgtm" : gate.verdict });
    } else if (gate.state === "failed") reviews.push({ agent, state: "failed" });
    // missing・stale（取り消し）は現在の判定に使わない
  }
  return reviews.sort((a, b) => a.agent.localeCompare(b.agent));
}

export function agentReviewKey(repositoryFullName: string, prNumber: number): string {
  return `${repositoryFullName}#${prNumber}`;
}

/** 全リポジトリぶんを1クエリで引く。取得に失敗しても一覧は返す（枠は従来の判定に戻る） */
export async function fetchPullRequestAgentReviews(
  targets: { repositoryFullName: string; pullRequestNumber: number; headSha: string }[],
): Promise<Map<string, PullRequestAgentReview[]>> {
  const result = new Map<string, PullRequestAgentReview[]>();
  if (targets.length === 0) return result;
  const rows = await db.dispatchJob
    .findMany({
      where: {
        kind: "PR_REVIEW",
        OR: targets.map((target) => ({
          repositoryFullName: target.repositoryFullName,
          prNumber: target.pullRequestNumber,
          headSha: target.headSha,
        })),
      },
      select: {
        repositoryFullName: true,
        prNumber: true,
        agent: true,
        status: true,
        reviewVerdict: true,
        message: true,
        claimedByHost: true,
        targetHost: true,
        createdAt: true,
      },
    })
    .catch((error: unknown) => {
      console.warn("[fetchPullRequestAgentReviews] 取得に失敗しました:", error);
      return [];
    });
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    if (row.prNumber === null) continue;
    const key = agentReviewKey(row.repositoryFullName, row.prNumber);
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  for (const [key, group] of grouped) {
    const reviews = summarizeAgentReviews(group as AgentReviewJobRow[]);
    if (reviews.length > 0) result.set(key, reviews);
  }
  return result;
}
