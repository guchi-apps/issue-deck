import { computeFixProgress } from "@/lib/chat/fix-progress";
import type { ChatActionRecord, ChatFixProgressCard } from "@/lib/chat/types";
import { getInstallationToken } from "@/lib/github/app-auth";
import { findRepositoryByFullName } from "@/lib/github/issue-create-service";
import { fetchCommentsForIssue } from "@/lib/github/issues-api";
import { parsePullRequestReviewVerdict } from "@/lib/github/pull-request-review-verdict";
import { fetchPullRequest } from "@/lib/github/pull-requests-api";
import { fetchActivePullRequestRepairRun } from "@/lib/github/pull-request-repair-run";
import { fetchPullRequestCiState } from "@/lib/github/release-api";

/** 実行系（実装エージェント）が完了・停止の報告に付ける印 */
const AGENT_REPORT_MARKER = "issue-deck-agent:implementer";

export function latestFixRequest(
  actions: ChatActionRecord[],
  repo: string,
  number: number,
): ChatActionRecord | null {
  for (let i = actions.length - 1; i >= 0; i--) {
    const a = actions[i];
    if (a.type === "fix_request" && a.status === "started" && a.repo === repo && a.number === number && a.fixRequest) {
      return a;
    }
  }
  return null;
}

/**
 * 保存済みの修正依頼について、いまのPRの状態から進み具合を導く（#4045）。
 * 取得に失敗したら`null`（**失敗を「完了」「問題なし」として返さない**。呼び出し側が未確認と書く）。
 */
export async function loadFixProgress(
  userId: string,
  action: ChatActionRecord,
): Promise<ChatFixProgressCard | null> {
  if (!action.fixRequest || action.number === null) return null;
  const [owner, repo] = action.repo.split("/");
  try {
    const repository = await findRepositoryByFullName(userId, action.repo);
    if (!repository || !owner || !repo) return null;
    const token = await getInstallationToken(repository.installation.installationId);
    const pr = await fetchPullRequest(owner, repo, action.number, token);
    const [ci, activeRepair, comments] = await Promise.all([
      fetchPullRequestCiState(owner, repo, action.number, token),
      fetchActivePullRequestRepairRun(action.repo, action.number),
      fetchCommentsForIssue(owner, repo, action.fixRequest.issueNumber, token).catch(() => []),
    ]);
    const requestedAt = Date.parse(action.at);
    const agentReported = comments.some(
      (c) => Date.parse(c.created_at) > requestedAt && (c.body ?? "").includes(AGENT_REPORT_MARKER),
    );
    const verdict = parsePullRequestReviewVerdict(pr.body);
    return computeFixProgress({
      repo: action.repo,
      number: action.number,
      requestedHeadSha: action.fixRequest.headSha,
      pr: {
        state: pr.state === "closed" ? "closed" : "open",
        merged: pr.merged,
        headSha: pr.head.sha,
        htmlUrl: pr.html_url,
      },
      ciState: ci.ciState,
      activeRepair: activeRepair !== null,
      agentReported,
      verdict: verdict ? { reviewKind: verdict.reviewKind, reviewedSha: verdict.reviewedSha } : null,
      fetchedAt: new Date().toISOString(),
    });
  } catch {
    return null;
  }
}
