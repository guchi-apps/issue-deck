import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import {
  fetchActivePullRequestRepairRun,
  recordPullRequestRepairRun,
} from "@/lib/github/pull-request-repair-run";
import { resolveRepairDispatch } from "@/lib/github/pull-request-repair";
import { decideAutoRepairLoop, type AutoRepairLoopState } from "@/lib/github/pull-request-repair-loop";
import { fetchPullRequest } from "@/lib/github/pull-requests-api";
import { parsePullRequestReviewVerdict } from "@/lib/github/pull-request-review-verdict";
import { fetchPullRequestCiState } from "@/lib/github/release-api";
import { dispatchWorkflow } from "@/lib/github/workflow-dispatch";

/**
 * 実行中の自動修復系列を1巡する。pollerから呼び、修復後の新HEADのCIと再レビューを待ってから
 * 次の種類を1つだけdispatchする。個々のworkflowの開始・終了表示は既存のRepairRunをそのまま使う。
 */
export async function runPullRequestAutoRepairSweep(): Promise<{ scanned: number; dispatched: number }> {
  const loops = await db.pullRequestAutoRepairLoop.findMany({ where: { status: "running" } });
  let dispatched = 0;

  for (const stored of loops) {
    try {
      const repository = await db.repository.findFirst({
        where: { fullName: stored.repositoryFullName },
        include: { installation: true },
      });
      if (!repository) continue;
      const [owner, repo] = stored.repositoryFullName.split("/");
      if (!owner || !repo) continue;
      const token = await getInstallationToken(repository.installation.installationId);
      const pullRequest = await fetchPullRequest(owner, repo, stored.pullRequestNumber, token);
      const current = await fetchPullRequestCiState(owner, repo, stored.pullRequestNumber, token);
      const verdict = parsePullRequestReviewVerdict(pullRequest.body);
      const review =
        verdict?.reviewedSha === pullRequest.head.sha
          ? verdict.reviewKind === "ok"
            ? "lgtm"
            : verdict.reviewKind === "changes-requested"
              ? "changes-requested"
              : "needs-check"
          : null;
      const active = await fetchActivePullRequestRepairRun(stored.repositoryFullName, stored.pullRequestNumber);
      const loop: AutoRepairLoopState = {
        status: "running",
        headSha: stored.headSha,
        round: stored.round,
        currentKind: stored.currentKind === "ci" || stored.currentKind === "conflict" || stored.currentKind === "review" ? stored.currentKind : null,
        lastFingerprint: stored.lastFingerprint,
      };
      const decision = decideAutoRepairLoop(loop, {
        state: pullRequest.state === "closed" ? "closed" : "open",
        headSha: pullRequest.head.sha,
        mergeable: current.mergeable,
        ciState: current.ciState,
        review,
        repairRunning: active !== null,
      });
      if (decision.action === "wait") continue;
      if (decision.action === "complete") {
        await db.pullRequestAutoRepairLoop.update({
          where: { repositoryFullName_pullRequestNumber: { repositoryFullName: stored.repositoryFullName, pullRequestNumber: stored.pullRequestNumber } },
          data: { status: "completed", currentKind: null, headSha: pullRequest.head.sha, stopReason: null },
        });
        continue;
      }
      if (decision.action === "stop") {
        await db.pullRequestAutoRepairLoop.update({
          where: { repositoryFullName_pullRequestNumber: { repositoryFullName: stored.repositoryFullName, pullRequestNumber: stored.pullRequestNumber } },
          data: { status: "stopped", currentKind: null, headSha: pullRequest.head.sha, stopReason: decision.reason },
        });
        continue;
      }
      const dispatch = resolveRepairDispatch(
        { number: pullRequest.number, baseRef: pullRequest.base.ref, headRef: pullRequest.head.ref },
        decision.kind,
      );
      await dispatchWorkflow(owner, repo, dispatch.workflowFile, dispatch.ref, dispatch.inputs, token);
      // workflow自身の開始報告より先にpollerが次巡へ入っても、同じHEAD・同じ問題を
      // repeated_problemと誤認しないよう、初回のrepair APIと同じくdispatch成功時点でrunningを記録する。
      await recordPullRequestRepairRun({
        repositoryFullName: stored.repositoryFullName,
        pullRequestNumber: stored.pullRequestNumber,
        kind: decision.kind,
        status: "running",
      });
      await db.pullRequestAutoRepairLoop.update({
        where: { repositoryFullName_pullRequestNumber: { repositoryFullName: stored.repositoryFullName, pullRequestNumber: stored.pullRequestNumber } },
        data: {
          headSha: pullRequest.head.sha,
          round: { increment: 1 },
          currentKind: decision.kind,
          lastFingerprint: decision.fingerprint,
          stopReason: null,
        },
      });
      dispatched += 1;
    } catch (error) {
      // 1本のAPI・workflow障害で他PRのループを止めない。次回巡回で再評価する。
      console.error("[runPullRequestAutoRepairSweep]", stored.repositoryFullName, stored.pullRequestNumber, error);
    }
  }
  return { scanned: loops.length, dispatched };
}
