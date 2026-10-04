import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import {
  fetchActivePullRequestRepairRun,
  recordPullRequestRepairRun,
} from "@/lib/github/pull-request-repair-run";
import { isRepairSymptomGone, resolveRepairDispatch } from "@/lib/github/pull-request-repair";
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
  const now = new Date();
  const timeoutAt = new Date(now.getTime() - 30 * 60 * 1000);
  const sweepAt = new Date(now.getTime() - 60 * 1000);
  // dispatching中にプロセス停止・DB障害が起きた系列は放置せず停止させる。
  await db.pullRequestAutoRepairLoop.updateMany({
    where: { status: "dispatching", updatedAt: { lt: timeoutAt } },
    data: { status: "stopped", currentKind: null, stopReason: "timed_out" },
  });
  const loops = await db.pullRequestAutoRepairLoop.findMany({ where: { status: "running" } });
  let dispatched = 0;

  for (const stored of loops) {
    try {
      // subpc poller自体は30秒周期でも、同じ系列のGitHub API巡回は最大1分に1回に抑える。
      // updateManyでclaimするため、複数pollerが同時に来ても1本だけがAPIを消費する。
      const sweepClaim = await db.pullRequestAutoRepairLoop.updateMany({
        where: {
          repositoryFullName: stored.repositoryFullName,
          pullRequestNumber: stored.pullRequestNumber,
          status: "running",
          OR: [{ lastSweepAt: null }, { lastSweepAt: { lt: sweepAt } }],
        },
        data: { lastSweepAt: now },
      });
      if (sweepClaim.count !== 1) continue;
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
          ? verdict.reviewKind === "ok" || verdict.reviewKind === "skipped"
            ? "lgtm"
            : verdict.reviewKind === "changes-requested"
              ? "changes-requested"
              : "needs-check"
          : null;
      const recordedActive = await fetchActivePullRequestRepairRun(stored.repositoryFullName, stored.pullRequestNumber);
      // workflowの終了報告だけ欠落してRepairRunがrunningのまま残る場合がある。
      // 現在のPR状態で元の症状が既に消えていれば、手動開始側と同じく残留記録を無効扱いにする。
      const active =
        recordedActive !== null &&
        !isRepairSymptomGone(recordedActive.kind, {
          mergeable: current.mergeable,
          ciState: current.ciState,
        })
          ? recordedActive
          : null;
      // workflow実行中に30分を超えても、終了後のCI・レビュー待ちはそこから30分確保する。
      // currentKindが残っていてactiveが消えた最初の巡回を「workflow終了観測」とし、待機時計をリセットする。
      if (active === null && stored.currentKind !== null) {
        await db.pullRequestAutoRepairLoop.update({
          where: { repositoryFullName_pullRequestNumber: { repositoryFullName: stored.repositoryFullName, pullRequestNumber: stored.pullRequestNumber } },
          data: { currentKind: null, waitStartedAt: now },
        });
        continue;
      }
      // workflowが実際に走っている間は既存のRepairRun（最大6時間）を正とし、待機タイムアウトしない。
      // workflow終了を観測してcurrentKindを消した後、CI/レビュー待ちだけが30分以上続いた場合に停止する。
      if (active === null && stored.currentKind === null && stored.waitStartedAt !== null && stored.waitStartedAt < timeoutAt) {
        await db.pullRequestAutoRepairLoop.update({
          where: { repositoryFullName_pullRequestNumber: { repositoryFullName: stored.repositoryFullName, pullRequestNumber: stored.pullRequestNumber } },
          data: { status: "stopped", currentKind: null, headSha: pullRequest.head.sha, stopReason: "timed_out" },
        });
        continue;
      }
      const loop: AutoRepairLoopState = {
        status: "running",
        headSha: stored.headSha,
        round: stored.round,
        currentKind: stored.currentKind === "ci" || stored.currentKind === "conflict" || stored.currentKind === "review" ? stored.currentKind : null,
        lastFingerprint: stored.lastFingerprint,
      };
      if (active === null && stored.currentKind === null && stored.waitStartedAt === null) {
        await db.pullRequestAutoRepairLoop.update({
          where: { repositoryFullName_pullRequestNumber: { repositoryFullName: stored.repositoryFullName, pullRequestNumber: stored.pullRequestNumber } },
          data: { waitStartedAt: now },
        });
      }
      const decision = decideAutoRepairLoop(loop, {
        state: pullRequest.state === "closed" ? "closed" : "open",
        draft: pullRequest.draft,
        reviewRequired: pullRequest.base.ref === "develop" && /^issue-(\d+)$/.test(pullRequest.head.ref),
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
      // 複数pollerが同時に同じ系列を評価しても1本だけがdispatchするよう、観測した
      // snapshot（running + head + round）をDBで原子的にclaimする。
      const claimed = await db.pullRequestAutoRepairLoop.updateMany({
        where: {
          repositoryFullName: stored.repositoryFullName,
          pullRequestNumber: stored.pullRequestNumber,
          status: "running",
          headSha: stored.headSha,
          round: stored.round,
        },
        data: { status: "dispatching", currentKind: decision.kind, waitStartedAt: null },
      });
      if (claimed.count !== 1) continue;

      const dispatch = resolveRepairDispatch(
        { number: pullRequest.number, baseRef: pullRequest.base.ref, headRef: pullRequest.head.ref },
        decision.kind,
      );
      try {
        await dispatchWorkflow(owner, repo, dispatch.workflowFile, dispatch.ref, dispatch.inputs, token);
      } catch (error) {
        // 恒久的なworkflow未配置等で1分ごとに無限再試行しない。手動開始と同じく停止して理由を表示する。
        await db.pullRequestAutoRepairLoop.updateMany({
          where: {
            repositoryFullName: stored.repositoryFullName,
            pullRequestNumber: stored.pullRequestNumber,
            status: "dispatching",
          },
          data: { status: "stopped", currentKind: null, stopReason: "dispatch_failed" },
        });
        throw error;
      }
      // workflow自身の開始報告より先にpollerが次巡へ入っても、同じHEAD・同じ問題を
      // repeated_problemと誤認しないよう、初回のrepair APIと同じくdispatch成功時点でrunningを記録する。
      // RepairRunは画面表示用の補助記録。workflowのdispatch自体が成功しているため、
      // 一時的なDB障害でこの記録だけ失敗しても系列の状態遷移を止めない。
      try {
        await recordPullRequestRepairRun({
          repositoryFullName: stored.repositoryFullName,
          pullRequestNumber: stored.pullRequestNumber,
          kind: decision.kind,
          status: "running",
        });
      } catch (error) {
        console.error("[runPullRequestAutoRepairSweep] failed to record repair run", stored.repositoryFullName, stored.pullRequestNumber, error);
      }
      await db.pullRequestAutoRepairLoop.update({
        where: { repositoryFullName_pullRequestNumber: { repositoryFullName: stored.repositoryFullName, pullRequestNumber: stored.pullRequestNumber } },
        data: {
          status: "running",
          headSha: pullRequest.head.sha,
          round: { increment: 1 },
          currentKind: decision.kind,
          lastFingerprint: decision.fingerprint,
          stopReason: null,
          waitStartedAt: null,
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
