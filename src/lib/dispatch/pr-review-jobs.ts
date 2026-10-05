import type { DispatchJob } from "@prisma/client";

import { db } from "@/lib/db";
import {
  DISPATCH_HOST_ONLINE_WINDOW_MS,
  isDispatchHostOnline,
  parseDispatchHostRepositories,
  type DispatchAgent,
} from "@/lib/dispatch/dispatch-job";
import { expireStaleDispatchJobs } from "@/lib/dispatch/jobs";
import {
  buildPrReviewActiveKey,
  describePrReviewGateState,
  isAutoMergeJobName,
  isPrReviewResumable,
  PR_REVIEW_RESUME_MAX_ATTEMPTS,
  PR_REVIEW_RESUME_WINDOW_MS,
  resolvePrReviewGateState,
  type PrReviewGateState,
} from "@/lib/dispatch/pr-review";
import { getInstallationToken } from "@/lib/github/app-auth";
import { GITHUB_API, githubFetch } from "@/lib/github/request";
import {
  fetchPullRequest,
  fetchWorkflowRun,
  fetchWorkflowRunJobs,
  rerunWorkflowJob,
} from "@/lib/github/actions-api";

/**
 * develop向けPRのAIレビュー（`PR_REVIEW`・#3990）のDB操作。純関数は`pr-review.ts`。
 *
 * 流れは「Actionsが`requestPrReviewJob`で積む → サブPCのpollerがclaim → レビューのスクリプトが
 * 生存報告と結果を報告 → `resumePrReviewMerge`が最終マージ判定（`auto-merge`ジョブ）だけを再実行」。
 * **GitHub-hostedのrunnerを結果待ちのために保持しない**のが目的で、待つのは誰もいない。
 */

export type PrReviewTarget = {
  repositoryFullName: string;
  prNumber: number;
  headSha: string;
  agent: DispatchAgent;
};

type PrReviewRejection = "no_host";

export type RequestPrReviewJobResult =
  | { ok: true; job: DispatchJob; created: boolean; gate: PrReviewGateState }
  | { ok: false; rejection: PrReviewRejection; message: string };

/** 同じPR・HEAD・agentの最新のジョブ。再依頼（手動の再実行）は最新だけを見る */
export async function findLatestPrReviewJob(target: PrReviewTarget): Promise<DispatchJob | null> {
  return db.dispatchJob.findFirst({
    where: {
      kind: "PR_REVIEW",
      repositoryFullName: target.repositoryFullName,
      prNumber: target.prNumber,
      headSha: target.headSha,
      agent: target.agent,
    },
    orderBy: { createdAt: "desc" },
  });
}

/** Actionsのゲートが読む状態。ジョブが無ければ`missing` */
export async function getPrReviewGate(target: PrReviewTarget, now: Date = new Date()) {
  await expireStaleDispatchJobs(now);
  const job = await findLatestPrReviewJob(target);
  return { job, gate: resolvePrReviewGateState(job) };
}

/**
 * レビューを実行できるホストを選ぶ。**起動前の失敗を、ここで即座に確定させる**ために、オンラインで
 * 対応を申告し、そのリポジトリを持つホストがなければ積まずに断る（30分待たずに原因が分かる）。
 */
async function pickReviewHost(
  repositoryFullName: string,
  agent: DispatchAgent,
  now: Date,
): Promise<string | null> {
  const hosts = await db.dispatchHost.findMany({
    where: { lastSeenAt: { gte: new Date(now.getTime() - DISPATCH_HOST_ONLINE_WINDOW_MS) } },
    orderBy: { name: "asc" },
  });
  const capable = hosts.filter(
    (host) =>
      isDispatchHostOnline(host.lastSeenAt, now) &&
      host.prReviewCapable === true &&
      (agent !== "codex" || host.codexCapable === true) &&
      parseDispatchHostRepositories(host.repositories).includes(repositoryFullName),
  );
  if (capable.length === 0) return null;
  // 実行待ちが少ないホストへ寄せる
  const load = await db.dispatchJob.groupBy({
    by: ["targetHost"],
    where: {
      kind: "PR_REVIEW",
      status: { in: ["QUEUED", "CLAIMED", "RUNNING"] },
      targetHost: { in: capable.map((host) => host.name) },
    },
    _count: { _all: true },
  });
  const counts = new Map(load.map((row) => [row.targetHost, row._count._all]));
  return [...capable].sort(
    (a, b) => (counts.get(a.name) ?? 0) - (counts.get(b.name) ?? 0) || a.name.localeCompare(b.name),
  )[0].name;
}

/**
 * レビューを積む（冪等）。同じPR・HEAD・agentに**未完了のジョブがあればそれを返し**、完了済みで
 * 判定が出ていればそれも返す（二重にレビューしない）。失敗・時間切れ・取り消しの後の再依頼
 * （Actionsの手動再実行）だけが新しいジョブを作る。
 *
 * 新しいHEADが積まれたら、同じPR・agentの**古いHEADの待機中のジョブは取り消す**（結果が使われないので
 * Codexの枠を消費しない）。走り出したものは止められないが、結果は古いHEADとして使われない。
 */
export async function requestPrReviewJob(params: {
  target: PrReviewTarget;
  baseSha: string;
  workflowRunId: string | null;
  now?: Date;
}): Promise<RequestPrReviewJobResult> {
  const now = params.now ?? new Date();
  const { target } = params;
  await expireStaleDispatchJobs(now);

  const latest = await findLatestPrReviewJob(target);
  if (latest) {
    const gate = resolvePrReviewGateState(latest);
    if (gate.state === "pending" || gate.state === "done") {
      // 再実行されたrunが最終マージ判定を再開できるよう、runの紐付けだけを更新する
      if (params.workflowRunId && latest.workflowRunId !== params.workflowRunId) {
        const updated = await db.dispatchJob.update({
          where: { id: latest.id },
          data: { workflowRunId: params.workflowRunId, mergeResumedAt: null, mergeResumeAttempts: 0 },
        });
        return { ok: true, job: updated, created: false, gate };
      }
      return { ok: true, job: latest, created: false, gate };
    }
  }

  const hostName = await pickReviewHost(target.repositoryFullName, target.agent, now);
  if (hostName === null) {
    return {
      ok: false,
      rejection: "no_host",
      message: `${target.repositoryFullName}のPRレビュー（${target.agent}）を実行できるサブPCがありません（オフライン・pollerが未対応・リポジトリ未登録のいずれか）。`,
    };
  }

  // 古いHEADの待機中のジョブを取り消す
  await db.dispatchJob.updateMany({
    where: {
      kind: "PR_REVIEW",
      repositoryFullName: target.repositoryFullName,
      prNumber: target.prNumber,
      agent: target.agent,
      status: "QUEUED",
      headSha: { not: target.headSha },
    },
    data: {
      status: "CANCELED",
      activeKey: null,
      finishedAt: now,
      message: `新しいHEAD（${target.headSha.slice(0, 7)}）が積まれたため取り消しました。`,
    },
  });

  try {
    const job = await db.dispatchJob.create({
      data: {
        repositoryFullName: target.repositoryFullName,
        // 必須列。PR番号を埋め草として入れる（読むのは`prNumber`。GitHubはIssueとPRで番号を共有する）
        issueNumber: target.prNumber,
        targetHost: hostName,
        kind: "PR_REVIEW",
        agent: target.agent,
        status: "QUEUED",
        activeKey: buildPrReviewActiveKey(
          target.repositoryFullName,
          target.prNumber,
          target.headSha,
          target.agent,
        ),
        prNumber: target.prNumber,
        baseSha: params.baseSha,
        headSha: target.headSha,
        workflowRunId: params.workflowRunId,
      },
    });
    return { ok: true, job, created: true, gate: resolvePrReviewGateState(job) };
  } catch {
    // 同時に積まれて`activeKey`の一意制約に当たった。先に積まれた方を返す
    const raced = await findLatestPrReviewJob(target);
    if (raced) return { ok: true, job: raced, created: false, gate: resolvePrReviewGateState(raced) };
    throw new Error("PRレビューのジョブを積めませんでした");
  }
}

export type ResumeResult =
  | "resumed" // auto-mergeジョブを再実行した
  | "stale" // PRのHEADが変わっていた。新しいrunが判定するので再開しない
  | "waiting" // runがまだ実行中で再実行できない。あとで試し直す
  | "skipped" // 再開の対象外（未完了・紐付けなし・既に再開済み）
  | "gave_up"; // 試行の上限・期間を超えた

function describeResumeNote(result: ResumeResult): string {
  return result === "stale"
    ? "PRのHEADが変わったため最終マージ判定は再開しませんでした。"
    : "最終マージ判定の再開を諦めました。PRのActionsから auto-merge を再実行してください。";
}

/**
 * 再開を諦めたことをPRへ伝える（best-effort）。**黙って諦めると、自動マージが止まったまま誰も気付かない**
 * （結果が出ていないPRは自動マージしない方針なので、止まるのは安全側だが、止まった理由は残す）。
 */
async function notifyResumeGaveUp(job: DispatchJob): Promise<void> {
  try {
    if (job.prNumber === null) return;
    const repository = await db.repository.findFirst({
      where: { fullName: job.repositoryFullName },
      include: { installation: true },
    });
    const [owner, repo] = job.repositoryFullName.split("/");
    if (!repository || !owner || !repo) return;
    const token = await getInstallationToken(repository.installation.installationId);
    const body =
      `⚠️ サブPCのAIレビューが終わりましたが、最終マージ判定を自動で再開できませんでした（${describePrReviewGateState(resolvePrReviewGateState(job))}）。` +
      "このPRのActionsで `auto-merge` ジョブを再実行するか、内容を確認してマージしてください。自動マージは有効化していません。" +
      "\n\n<!-- issue-deck-source:codex-review-develop -->";
    await githubFetch(`${GITHUB_API}/repos/${owner}/${repo}/issues/${job.prNumber}/comments`, token, {
      method: "POST",
      body: { body },
    });
  } catch (error) {
    console.error(`[pr-review] 再開を諦めた通知を投稿できませんでした ${job.id}:`, error);
  }
}

/**
 * レビューが確定したPRの最終マージ判定を再開する（#3990）。**同じrunの`auto-merge`ジョブだけを再実行**する。
 * 他のジョブ（リスク判定・Claudeレビュー）は取得済みの結果を引き継ぐので走り直さない。再実行した
 * `auto-merge`はDispatchJobの状態を読み直して判定する。
 *
 * **PRのHEADがジョブのHEADと違うときは再実行しない。** 再実行は新しいHEADのrunと同じ`concurrency`の
 * グループに入り、実行中の新しいrunをキャンセルしかねない。古いHEADの結果は使わない方針とも合致する。
 */
export async function resumePrReviewMerge(jobId: string, now: Date = new Date()): Promise<ResumeResult> {
  const job = await db.dispatchJob.findUnique({ where: { id: jobId } });
  if (
    !job ||
    job.kind !== "PR_REVIEW" ||
    !isPrReviewResumable(job.status) ||
    job.mergeResumedAt !== null ||
    !job.workflowRunId ||
    job.prNumber === null ||
    !job.headSha
  ) {
    return "skipped";
  }
  const markDone = async (result: ResumeResult) => {
    if (result === "gave_up") await notifyResumeGaveUp(job);
    await db.dispatchJob.update({
      where: { id: job.id },
      data: {
        mergeResumedAt: now,
        message:
          result === "stale" || result === "gave_up"
            ? [job.message, describeResumeNote(result)].filter(Boolean).join(" ")
            : job.message,
      },
    });
    return result;
  };
  const finishedAt = job.finishedAt ?? job.updatedAt;
  if (now.getTime() - finishedAt.getTime() > PR_REVIEW_RESUME_WINDOW_MS) return markDone("gave_up");

  const repository = await db.repository.findFirst({
    where: { fullName: job.repositoryFullName },
    include: { installation: true },
  });
  const [owner, repo] = job.repositoryFullName.split("/");
  if (!repository || !owner || !repo) return markDone("gave_up");

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const pullRequest = await fetchPullRequest(owner, repo, job.prNumber, token);
    if (pullRequest.head.sha !== job.headSha) return markDone("stale");
    const runId = Number(job.workflowRunId);
    const run = await fetchWorkflowRun(owner, repo, runId, token);
    if (run.status !== "completed") return "waiting";
    const jobs = await fetchWorkflowRunJobs(owner, repo, runId, token);
    const autoMerge = jobs.find((candidate) => isAutoMergeJobName(candidate.name));
    if (!autoMerge?.id) return markDone("gave_up");
    await rerunWorkflowJob(owner, repo, autoMerge.id, token);
    return markDone("resumed");
  } catch (error) {
    const attempts = job.mergeResumeAttempts + 1;
    await db.dispatchJob.update({ where: { id: job.id }, data: { mergeResumeAttempts: attempts } });
    if (attempts >= PR_REVIEW_RESUME_MAX_ATTEMPTS) return markDone("gave_up");
    throw error;
  }
}

/** 巡回: 確定しているのに最終マージ判定を再開できていないレビューを再開する（pollerが呼ぶ） */
export async function sweepPrReviewResumes(now: Date = new Date()): Promise<Record<ResumeResult | "failed", number>> {
  await expireStaleDispatchJobs(now);
  const pending = await db.dispatchJob.findMany({
    where: {
      kind: "PR_REVIEW",
      status: { in: ["SUCCEEDED", "FAILED", "TIMEOUT", "SKIPPED"] },
      mergeResumedAt: null,
      workflowRunId: { not: null },
    },
    orderBy: { finishedAt: "asc" },
    take: 20,
  });
  const counts: Record<ResumeResult | "failed", number> = {
    resumed: 0,
    stale: 0,
    waiting: 0,
    skipped: 0,
    gave_up: 0,
    failed: 0,
  };
  for (const job of pending) {
    try {
      counts[await resumePrReviewMerge(job.id, now)] += 1;
    } catch (error) {
      counts.failed += 1;
      console.error(`[pr-review] 最終マージ判定を再開できませんでした ${job.id}:`, error);
    }
  }
  return counts;
}
