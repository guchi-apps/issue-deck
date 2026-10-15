import { db } from "@/lib/db";
import { DISPATCH_HEARTBEAT_TIMEOUT_MS, isDispatchHostOnline } from "@/lib/dispatch/dispatch-job";
import type { ReleaseVerificationKind } from "@/lib/release-merge-gate";
import { describeReleaseReviewAssignee, resolveReleaseReviewAssignee } from "@/lib/release-review-assignee";
import { listReleaseMacRows } from "@/lib/release-mac-verification";
import { loadReleaseReviewDecisionSummary } from "@/lib/release-review-decision-store";
import { reviewFindingId, type ReleaseReviewFinding } from "@/lib/release-review-result";
import { listReleaseVerificationDetails } from "@/lib/release-verification";
import { getReleaseVerificationConfig } from "@/lib/release-verification-config";
import {
  buildReleaseVerificationProgress,
  type ReleaseVerificationProgress,
} from "@/lib/release-verification-progress";
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
  const summary = summarizeReleaseVerification({
    current,
    rows: await listReleaseVerificationDetails(repoFullName, prNumber),
    macRows: await listReleaseMacRows(repoFullName, prNumber),
    macConfigured: getReleaseVerificationConfig(repoFullName).macBuildCheck === true,
    enforced: getReleaseVerificationConfig(repoFullName).enforced,
    aiReviewAssignee: describeReleaseReviewAssignee(resolveReleaseReviewAssignee(setting)),
    progress: await loadReleaseVerificationProgress(repoFullName, prNumber, current),
  });
  return attachReleaseReviewDecisions(repoFullName, prNumber, current, summary);
}

/**
 * 全体レビューの指摘に、ユーザーの判断（#4657）を添える。旧形式の指摘にはIDが無いので、判断・修正系列と
 * 同じ導出（`reviewFindingId`）で補う。判断はAIの`state`・`findings`を書き換えない
 */
async function attachReleaseReviewDecisions(
  repoFullName: string,
  prNumber: number,
  current: { baseSha: string; headSha: string },
  summary: ReleaseVerificationSummary,
): Promise<ReleaseVerificationSummary> {
  const withId = (f: ReleaseReviewFinding): ReleaseReviewFinding => (f.id ? f : { ...f, id: reviewFindingId(f) });
  const aiReview = { ...summary.aiReview, findings: summary.aiReview.findings.map(withId), suggestions: summary.aiReview.suggestions.map(withId) };
  const target = (blocking: boolean) => (f: ReleaseReviewFinding) => ({
    id: f.id as string,
    title: f.title,
    severity: f.severity,
    blocking,
    premiseChanged: f.premiseChanged ?? null,
  });
  if (aiReview.state === "needs_check" || aiReview.state === "passed") {
    aiReview.decisions = await loadReleaseReviewDecisionSummary({
      repoFullName,
      prNumber,
      current,
      findings: aiReview.findings.map(target(true)),
      suggestions: aiReview.suggestions.map(target(false)),
      state: aiReview.state,
      unverifiedScope: aiReview.unverifiedScope ?? null,
    });
  }
  return { ...summary, aiReview };
}

const JOB_KIND_TO_SECTION = { RELEASE_VERIFY: "integration", RELEASE_REVIEW: "ai_review" } as const;

/**
 * 区分ごとに、**現在の対象（base・head）の**最新ジョブから進捗を作る（#4277）。
 * 対象の違うジョブ（作り直す前のSHA）は見ない——古い実行の工程や成功を現在の進捗に見せない。
 * 実行先の生死は`DispatchHost.lastSeenAt`で読み、ホストの記録が無ければ「未取得」にする。
 */
async function loadReleaseVerificationProgress(
  repoFullName: string,
  prNumber: number,
  current: { baseSha: string; headSha: string },
  now = new Date(),
): Promise<Partial<Record<ReleaseVerificationKind, ReleaseVerificationProgress | null>>> {
  const jobs = await db.dispatchJob.findMany({
    where: {
      repositoryFullName: repoFullName,
      prNumber,
      baseSha: current.baseSha,
      headSha: current.headSha,
      kind: { in: ["RELEASE_VERIFY", "RELEASE_REVIEW"] },
    },
    orderBy: { createdAt: "desc" },
    select: {
      kind: true,
      status: true,
      targetHost: true,
      claimedByHost: true,
      createdAt: true,
      claimedAt: true,
      startedAt: true,
      heartbeatAt: true,
      finishedAt: true,
      message: true,
      progress: true,
      agent: true,
      claudeModel: true,
      codexModel: true,
    },
  });
  const latest = new Map<ReleaseVerificationKind, (typeof jobs)[number]>();
  for (const job of jobs) {
    const kind = JOB_KIND_TO_SECTION[job.kind as keyof typeof JOB_KIND_TO_SECTION];
    if (kind && !latest.has(kind)) latest.set(kind, job);
  }
  const hostNames = [...new Set([...latest.values()].map((job) => job.claimedByHost ?? job.targetHost))];
  const hosts = hostNames.length
    ? await db.dispatchHost.findMany({ where: { name: { in: hostNames } }, select: { name: true, lastSeenAt: true } })
    : [];
  const online = new Map(hosts.map((host) => [host.name, isDispatchHostOnline(host.lastSeenAt, now)]));

  const result: Partial<Record<ReleaseVerificationKind, ReleaseVerificationProgress | null>> = {};
  for (const [kind, job] of latest) {
    result[kind] = buildReleaseVerificationProgress({
      kind,
      job,
      hostOnline: online.get(job.claimedByHost ?? job.targetHost) ?? null,
      stalledAfterMs: DISPATCH_HEARTBEAT_TIMEOUT_MS,
    });
  }
  return result;
}
