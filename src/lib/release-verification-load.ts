import { db } from "@/lib/db";
import { describeReleaseReviewAssignee, resolveReleaseReviewAssignee } from "@/lib/release-review-assignee";
import { listReleaseVerificationDetails } from "@/lib/release-verification";
import { getReleaseVerificationConfig } from "@/lib/release-verification-config";
import {
  summarizeReleaseVerification,
  type ReleaseVerificationSummary,
} from "@/lib/release-verification-summary";

/**
 * リリースPRの統合検証・全体AIレビューの要約を、DBの記録から組み立てる（#4238）。
 * `GET /api/repositories/release`（スマホのシート）と`GET /api/repositories/release/verification`
 * （PCのPR詳細）が共有する。対象のSHAは呼び出し側がGitHubから取った現在値を渡す。
 */
export async function loadReleaseVerificationSummary(
  repoFullName: string,
  prNumber: number,
  current: { baseSha: string; headSha: string },
): Promise<ReleaseVerificationSummary> {
  const setting = await db.appSetting.findUnique({
    where: { id: 1 },
    select: { appAiModelReasoning: true, aiExecutionProvider: true },
  });
  return summarizeReleaseVerification({
    current,
    rows: await listReleaseVerificationDetails(repoFullName, prNumber),
    enforced: getReleaseVerificationConfig(repoFullName).enforced,
    aiReviewAssignee: describeReleaseReviewAssignee(resolveReleaseReviewAssignee(setting)),
  });
}
