import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchPullRequest } from "@/lib/github/pull-requests-api";
import { resolveRepairDispatch, type RepairKind } from "@/lib/github/pull-request-repair";
import { recordPullRequestRepairRun } from "@/lib/github/pull-request-repair-run";
import { AUTO_REPAIR_MAX_ROUNDS } from "@/lib/github/pull-request-repair-loop";
import { dispatchWorkflow } from "@/lib/github/workflow-dispatch";

/**
 * PR自動修復系列（#3978）を始める処理。画面の「PRを自動修正」（`POST /api/pull-requests/repair`）と、
 * 本番復旧系列（#3998）の両方から使う。以前はAPIルートに直書きで、サーバー側から系列を渡す口が無かった。
 */

type RepairTarget = {
  repositoryFullName: string;
  pullRequestNumber: number;
};

function loopKey({ repositoryFullName, pullRequestNumber }: RepairTarget) {
  return { repositoryFullName_pullRequestNumber: { repositoryFullName, pullRequestNumber } };
}

async function isLoopInProgress(target: RepairTarget): Promise<boolean> {
  const existing = await db.pullRequestAutoRepairLoop.findUnique({
    where: loopKey(target),
    select: { status: true },
  });
  return existing?.status === "running" || existing?.status === "dispatching";
}

/**
 * 1種類目の修復をすぐ起動して系列を始める（画面のボタン用）。
 *
 * workflow起動前に系列を記録する。DB保存に失敗したのにworkflowだけ走る「孤児dispatch」を作らない。
 * completed/stoppedは過去の系列なので、新しい手動開始ではラウンドをリセットする。
 * running/dispatchingの系列があれば二重にdispatchしない（`in_progress`を返す）。
 */
export async function startPullRequestAutoRepairLoop(params: {
  owner: string;
  repo: string;
  token: string;
  pullRequest: { number: number; headSha: string; baseRef: string; headRef: string };
  kind: RepairKind;
  maxRounds?: number;
}): Promise<{ ok: true } | { ok: false; reason: "in_progress" }> {
  const { owner, repo, token, pullRequest, kind } = params;
  const target = { repositoryFullName: `${owner}/${repo}`, pullRequestNumber: pullRequest.number };
  // 自動sweepまたは別の手動操作が既に系列を進めている間は二重dispatchしない。
  if (await isLoopInProgress(target)) return { ok: false, reason: "in_progress" };

  const dispatch = resolveRepairDispatch(
    { number: pullRequest.number, baseRef: pullRequest.baseRef, headRef: pullRequest.headRef },
    kind,
  );
  const state = {
    status: "dispatching",
    headSha: pullRequest.headSha,
    round: 1,
    currentKind: kind,
    lastFingerprint: `${pullRequest.headSha}:${kind}`,
    stopReason: null,
    lastSweepAt: null,
    waitStartedAt: null,
    maxRounds: params.maxRounds ?? AUTO_REPAIR_MAX_ROUNDS,
  };
  await db.pullRequestAutoRepairLoop.upsert({
    where: loopKey(target),
    create: { ...target, ...state },
    update: state,
  });

  try {
    await dispatchWorkflow(owner, repo, dispatch.workflowFile, dispatch.ref, dispatch.inputs, token);
  } catch (error) {
    await db.pullRequestAutoRepairLoop.update({
      where: loopKey(target),
      data: { status: "stopped", currentKind: null, stopReason: "dispatch_failed" },
    });
    throw error;
  }
  // sweepがrunning系列を拾う前にRepairRunを記録する。これによりdispatch直後の巡回が
  // activeなしをworkflow終了と誤認してcurrentKindを消す競合を防ぐ。
  await recordPullRequestRepairRun({ ...target, kind, status: "running" }).catch((error: unknown) => {
    console.warn(`[startPullRequestAutoRepairLoop] ${owner}/${repo}#${pullRequest.number} の記録:`, error);
  });
  await db.pullRequestAutoRepairLoop.update({ where: loopKey(target), data: { status: "running" } });
  // 以後はpollerが新HEADのCI・再レビューを待ち、必要なら次の1種類を起動する。
  return { ok: true };
}

/**
 * 修復を起動せずに系列だけを始める（本番復旧系列用。#3998）。
 *
 * ラウンド0の`running`で置くと、次の巡回（`runPullRequestAutoRepairSweep`）がCI・レビューを待ち、
 * 問題があれば修復を起動し、何も無ければ`completed`にする。いまの問題を開始側で判定し直さずに済む。
 * running/dispatchingの系列が既にあれば（人が先に始めていれば）上書きしない。
 */
export async function enrollPullRequestAutoRepairLoop(params: {
  repositoryFullName: string;
  pullRequestNumber: number;
  headSha: string;
  maxRounds: number;
}): Promise<boolean> {
  const target = { repositoryFullName: params.repositoryFullName, pullRequestNumber: params.pullRequestNumber };
  if (await isLoopInProgress(target)) return false;
  const state = {
    status: "running",
    headSha: params.headSha,
    round: 0,
    currentKind: null,
    lastFingerprint: null,
    stopReason: null,
    lastSweepAt: null,
    waitStartedAt: null,
    maxRounds: params.maxRounds,
  };
  await db.pullRequestAutoRepairLoop.upsert({
    where: loopKey(target),
    create: { ...target, ...state },
    update: state,
  });
  return true;
}

/**
 * レビューのhandoff（#3363・#4043）で`review-fix`が始まったことを自動修復系列へ載せる（#4318）。
 *
 * handoffは系列を作らないため、修正をpushした後のCI・再レビュー・残存指摘の再修正が系列側から
 * 見えなかった。ClaudeはrepairRuns報告、Codexは`/api/dispatch/review-fix`の依頼から呼ぶ。
 * 報告にHEADのSHAが無い旧形式でも動くよう、HEADはここでGitHubから引く。
 *
 * - 系列が無い・`completed`なら、1回目を消化済み（`round: 1`・`currentKind: review`）で始める
 * - 巡回が`review`を起動した直後の報告（`currentKind`がすでに`review`）は数え直さない
 * - 待機中の系列にhandoffが始まったときは1回に数え、同じHEADを巡回が重ねて起動しないよう
 *   `lastFingerprint`を揃える。上限は系列の`maxRounds`（3）を超えて増やさない
 * - `stopped`は止めた理由を残すため上書きしない
 * 失敗してもhandoff自体は止めない（呼び出し側が握る）。
 */
export async function recordReviewFixHandoffStarted(params: {
  repositoryFullName: string;
  pullRequestNumber: number;
}): Promise<"registered" | "counted" | "skipped"> {
  const target = { repositoryFullName: params.repositoryFullName, pullRequestNumber: params.pullRequestNumber };
  const existing = await db.pullRequestAutoRepairLoop.findUnique({ where: loopKey(target), select: { status: true, currentKind: true, round: true, maxRounds: true } });
  if (existing?.status === "stopped") return "skipped";
  if (existing && (existing.status === "dispatching" || existing.currentKind === "review")) return "skipped";

  const repository = await db.repository.findFirst({ where: { fullName: target.repositoryFullName }, include: { installation: true } });
  const [owner, repo] = target.repositoryFullName.split("/");
  if (!repository || !owner || !repo) return "skipped";
  const token = await getInstallationToken(repository.installation.installationId);
  const pullRequest = await fetchPullRequest(owner, repo, target.pullRequestNumber, token);
  if (pullRequest.state !== "open" || pullRequest.draft) return "skipped";

  const fingerprint = `${pullRequest.head.sha}:review`;
  if (existing?.status === "running") {
    await db.pullRequestAutoRepairLoop.update({
      where: loopKey(target),
      data: {
        headSha: pullRequest.head.sha,
        round: Math.min(existing.round + 1, existing.maxRounds),
        currentKind: "review",
        lastFingerprint: fingerprint,
        waitStartedAt: null,
      },
    });
    return "counted";
  }
  const state = {
    status: "running",
    headSha: pullRequest.head.sha,
    round: 1,
    currentKind: "review",
    lastFingerprint: fingerprint,
    stopReason: null,
    lastSweepAt: null,
    waitStartedAt: null,
    maxRounds: AUTO_REPAIR_MAX_ROUNDS,
  };
  await db.pullRequestAutoRepairLoop.upsert({ where: loopKey(target), create: { ...target, ...state }, update: state });
  return "registered";
}
