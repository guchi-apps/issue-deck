import type { BackupCiRun } from "@prisma/client";

import {
  fetchPullRequestMergeInfo,
  installationTokenFor,
  pullRequestTouchesPath,
} from "@/lib/backup-ci/github";
import {
  BACKUP_CI_MERGE_MAX_ATTEMPTS,
  type BackupCiMergeDecision,
  type BackupCiMergeStatus,
  buildBackupCiHoldComment,
  buildBackupCiMergedComment,
  decideBackupCiMerge,
  issueNumberFromHeadRef,
  precheckBackupCiMerge,
} from "@/lib/backup-ci/merge";
import { db } from "@/lib/db";
import { addCheckUserWithReason } from "@/lib/dispatch/check-user-labels";
import { getPrReviewGate, requestPrReviewJob } from "@/lib/dispatch/pr-review-jobs";
import { mergePullRequest } from "@/lib/github/actions-api";
import { GithubApiError } from "@/lib/github/github-api-error";
import { createComment, fetchIssueLabelNames } from "@/lib/github/issues-api";

/**
 * バックアップCIが合格したPRを、サブPCのレビューを経てdevelopへマージする（#4114）。判定は`merge.ts`。
 *
 * pollerの巡回（`POST /api/dispatch/claim`）から呼ぶ。**GitHub Actionsが止まっていても回る経路**で、
 * レビューは既存の`requestPrReviewJob`で`PR_REVIEW`を積み（同じPR・HEADのジョブがあれば相乗り）、
 * 結果はDispatchJobの状態を読む。Actionsの`auto-merge`ジョブは待たない。
 */

/** レビュー待ちを見張る期間。合格からこれを過ぎたら巡回しない（バックアップCIの合格の見張りと同じ） */
const MERGE_WATCH_MS = 3 * 24 * 60 * 60 * 1000;
const SWEEP_MAX_RUNS = 10;
const REVIEW_AGENT = "codex" as const;
const SHARED_CONTEXT_PREFIX = ".shared-context/";

export type BackupCiMergeOutcome = BackupCiMergeDecision["kind"] | "merged" | "merge_failed";

/** 1件の合格について、今できることを1歩だけ進める */
export async function advanceBackupCiMerge(run: BackupCiRun, now = new Date()): Promise<BackupCiMergeOutcome> {
  const { repositoryFullName, prNumber } = run;
  const [owner, repo] = repositoryFullName.split("/");
  const token = await installationTokenFor(repositoryFullName);
  const pr = await fetchPullRequestMergeInfo(repositoryFullName, prNumber, token);
  const gate = await db.ciGateState.findUnique({
    where: { repositoryFullName_prNumber: { repositoryFullName, prNumber } },
  });
  const issueNumber = issueNumberFromHeadRef(pr.headRef);
  const target = { repositoryFullName, prNumber, headSha: run.headSha, agent: REVIEW_AGENT };

  const pre = precheckBackupCiMerge({ run, gate, pr });
  if (pre && (pre.kind === "ignore" || pre.kind === "wait")) return record(run, pre, now);
  const issueLabels = issueNumber === null ? null : await fetchIssueLabelNames(owner, repo, issueNumber, token);
  const sharedContextChanged = await pullRequestTouchesPath(repositoryFullName, prNumber, SHARED_CONTEXT_PREFIX, token);
  const { job, gate: review } = await getPrReviewGate(target, now);
  const decision = decideBackupCiMerge({ run, gate, pr, issueNumber, issueLabels, sharedContextChanged, review });

  switch (decision.kind) {
    case "ignore":
    case "wait":
      return record(run, decision, now, job?.id);
    case "request_review": {
      const requested = await requestPrReviewJob({ target, baseSha: run.baseSha, workflowRunId: null, now });
      if (!requested.ok) {
        return hold(run, { owner, repo, token, issueNumber }, {
          kind: "hold",
          reason: `サブPCのCodexレビューを依頼できなかったため（${requested.message}）。`,
          checkReason: issueNumber === null ? null : "blocked",
          notify: true,
        }, now);
      }
      await db.backupCiRun.update({
        where: { id: run.id },
        data: { mergeStatus: "reviewing", mergeReason: "サブPCのレビューを待っています。", reviewJobId: requested.job.id },
      });
      return "request_review";
    }
    case "hold":
      return hold(run, { owner, repo, token, issueNumber }, decision, now);
    case "merge":
      return merge(run, { owner, repo, token }, decision.expectedHeadSha, now);
  }
}

async function record(
  run: BackupCiRun,
  decision: Extract<BackupCiMergeDecision, { kind: "ignore" | "wait" }>,
  now: Date,
  reviewJobId?: string,
): Promise<BackupCiMergeOutcome> {
  if (decision.kind === "ignore" && decision.finalStatus) {
    await finishMerge(run, decision.finalStatus, decision.reason, now);
  } else if (decision.kind === "wait") {
    // 理由を画面へ出し、更新時刻を進めて巡回の順番を後ろへ回す
    await db.backupCiRun.update({
      where: { id: run.id },
      data: { mergeReason: decision.reason, ...(reviewJobId ? { reviewJobId } : {}) },
    });
  }
  return decision.kind;
}

function finishMerge(
  run: BackupCiRun,
  status: BackupCiMergeStatus,
  reason: string,
  now: Date,
  extra: Partial<BackupCiRun> = {},
): Promise<BackupCiRun> {
  return db.backupCiRun.update({
    where: { id: run.id },
    data: { ...extra, mergeStatus: status, mergeReason: reason, mergeDecidedAt: now },
  });
}

async function hold(
  run: BackupCiRun,
  ctx: { owner: string; repo: string; token: string; issueNumber: number | null },
  decision: Extract<BackupCiMergeDecision, { kind: "hold" }>,
  now: Date,
  status: BackupCiMergeStatus = "held",
): Promise<BackupCiMergeOutcome> {
  // 先に記録する（通知に失敗しても、同じ理由で何度も止め直さない）
  await finishMerge(run, status, decision.reason, now);
  if (decision.checkReason && ctx.issueNumber !== null) {
    await addCheckUserWithReason(ctx.owner, ctx.repo, ctx.issueNumber, ctx.token, decision.checkReason).catch(
      (error: unknown) => console.error(`[backup-ci-merge] 00.check-userを付けられませんでした ${run.id}:`, error),
    );
  }
  if (decision.notify) {
    await createComment(ctx.owner, ctx.repo, ctx.issueNumber ?? run.prNumber, ctx.token, {
      body: buildBackupCiHoldComment({ prNumber: run.prNumber, headSha: run.headSha, reason: decision.reason }),
    }).catch((error: unknown) => console.error(`[backup-ci-merge] 止めた理由を投稿できませんでした ${run.id}:`, error));
  }
  return "hold";
}

async function merge(
  run: BackupCiRun,
  ctx: { owner: string; repo: string; token: string },
  expectedHeadSha: string,
  now: Date,
): Promise<BackupCiMergeOutcome> {
  try {
    const result = await mergePullRequest(ctx.owner, ctx.repo, run.prNumber, ctx.token, expectedHeadSha);
    await finishMerge(run, "merged", "バックアップCIの合格とサブPCのレビュー（LGTM）を確認してマージしました。", now, {
      mergeCommitSha: result.sha,
    });
    await createComment(ctx.owner, ctx.repo, run.prNumber, ctx.token, {
      body: buildBackupCiMergedComment({ headSha: run.headSha, baseSha: run.baseSha, mergeCommitSha: result.sha }),
    }).catch((error: unknown) => console.error(`[backup-ci-merge] マージの記録を投稿できませんでした ${run.id}:`, error));
    return "merged";
  } catch (error) {
    // 409はその間にheadが動いた。次の巡回でhead/baseの更新として扱われる（数えない）
    if (error instanceof GithubApiError && error.status === 409) return "wait";
    const attempts = run.mergeAttempts + 1;
    const detail = error instanceof GithubApiError ? `HTTP ${error.status}` : String(error);
    await db.backupCiRun.update({
      where: { id: run.id },
      data: { mergeAttempts: attempts, mergeReason: `マージに失敗しました（${detail}）。再試行します。` },
    });
    console.error(`[backup-ci-merge] マージに失敗しました ${run.repositoryFullName}#${run.prNumber}:`, error);
    if (attempts < BACKUP_CI_MERGE_MAX_ATTEMPTS) return "merge_failed";
    const issueNumber = issueNumberFromHeadRef(run.headRef);
    await hold(
      run,
      { ...ctx, issueNumber },
      {
        kind: "hold",
        // 405はブランチ保護の必須チェック（共通チェックへの移行前ならlint-and-build）を満たしていないことが多い
        reason: `developへのマージを${attempts}回試みましたが失敗しました（${detail}）。必須チェックが\`issue-deck/ci-gate\`へ移行済みか（docs/backup-ci.md 5章）を確認してください。`,
        checkReason: issueNumber === null ? null : "blocked",
        notify: true,
      },
      now,
      "gave_up",
    );
    return "merge_failed";
  }
}

// ---------------------------------------------------------------------------
// 巡回

let sweepInFlight = false;

/** pollerの巡回で呼ぶ。合格したまま、マージの判定が済んでいない実行を進める */
export async function sweepBackupCiMerges(now = new Date()): Promise<{ checked: number; errors: number }> {
  if (sweepInFlight) return { checked: 0, errors: 0 };
  sweepInFlight = true;
  try {
    const runs = await db.backupCiRun.findMany({
      where: {
        status: "passed",
        OR: [{ mergeStatus: null }, { mergeStatus: "reviewing" }],
        completedAt: { gte: new Date(now.getTime() - MERGE_WATCH_MS) },
      },
      orderBy: { updatedAt: "asc" },
      take: SWEEP_MAX_RUNS,
    });
    let errors = 0;
    for (const run of runs) {
      try {
        await advanceBackupCiMerge(run, now);
      } catch (error) {
        errors += 1;
        console.error(`[backup-ci-merge] 進められませんでした ${run.repositoryFullName}#${run.prNumber} (${run.id}):`, error);
      }
    }
    return { checked: runs.length, errors };
  } finally {
    sweepInFlight = false;
  }
}
