import { Prisma, type DispatchJob } from "@prisma/client";

import { db } from "@/lib/db";
import {
  DISPATCH_HOST_ONLINE_WINDOW_MS,
  isDispatchHostOnline,
  parseDispatchHostRepositories,
} from "@/lib/dispatch/dispatch-job";
import { expireStaleDispatchJobs } from "@/lib/dispatch/jobs";
import { notifyDispatchHostWake } from "@/lib/dispatch/wake-notify";
import {
  describeReleaseReviewAssignee,
  resolveReleaseReviewAssignee,
  type ReleaseReviewAssignee,
} from "@/lib/release-review-assignee";
import { normalizeReleaseReviewDiagnostic } from "@/lib/release-review-diagnostic";
import { normalizeReleaseReview } from "@/lib/release-review-result";
import {
  recordReleaseVerificationResult,
  type ReleaseVerificationTarget,
} from "@/lib/release-verification";

/**
 * リリースPRの全体AIレビュー（`RELEASE_REVIEW`・#4238）のDB操作。実行はサブPCのpollerが取りに来る。
 * 結果は`ReleaseVerification`（`kind=ai_review`）へ記録する。**ジョブ側の`SUCCEEDED`は「レビューを
 * 完走した」だけで、合否は記録が持つ**（統合検証の`release-verify-jobs.ts`と同じ）。
 */

export function buildReleaseReviewActiveKey(target: ReleaseVerificationTarget): string {
  return `release_review:${target.repoFullName}#${target.prNumber}@${target.baseSha}:${target.headSha}`;
}

export type RequestReleaseReviewResult =
  | { ok: true; outcome: "queued" | "already_queued"; job: DispatchJob; assignee: ReleaseReviewAssignee }
  | { ok: false; rejection: "no_host"; message: string };

async function pickReleaseReviewHost(
  repositoryFullName: string,
  assignee: ReleaseReviewAssignee,
  now: Date,
): Promise<string | null> {
  const hosts = await db.dispatchHost.findMany({
    where: { lastSeenAt: { gte: new Date(now.getTime() - DISPATCH_HOST_ONLINE_WINDOW_MS) } },
    orderBy: { name: "asc" },
  });
  const capable = hosts.filter(
    (host) =>
      isDispatchHostOnline(host.lastSeenAt, now) &&
      host.releaseReviewCapable === true &&
      (assignee.agent !== "codex" || host.codexCapable === true) &&
      parseDispatchHostRepositories(host.repositories).includes(repositoryFullName),
  );
  return capable[0]?.name ?? null;
}

/**
 * 失敗した全体レビューを同じ対象でやり直す（#4300）。**積めたとき（`already_queued`を除く）だけ**、
 * 同対象の`ai_review`を`waiting`へ戻して旧実行の診断・指摘を消す。残すと、再実行中も旧実行の
 * 失敗原因が現在の結果として出続ける。重複防止は`requestReleaseReviewJob`の`activeKey`に従う
 * （実行中・待機中のジョブがあれば何もしない）。
 */
export async function rerunReleaseReviewJob(
  target: ReleaseVerificationTarget,
  now: Date = new Date(),
): Promise<RequestReleaseReviewResult> {
  const result = await requestReleaseReviewJob(target, now);
  if (result.ok && result.outcome === "queued") {
    await db.releaseVerification.updateMany({
      where: { ...target, kind: "ai_review" },
      data: { state: "waiting", findings: Prisma.DbNull, message: null, summary: null, unverifiedScope: null },
    });
  }
  return result;
}

/**
 * 全体レビューを積む（冪等）。同じ対象（PR・base・head）に未完了のジョブがあればそれを返し、
 * 新しい対象が積まれたら同じPRの古い待機中ジョブは取り消す。**積めない理由は`ai_review`の
 * 失敗として記録する**（未実施のまま黙らせず、画面に理由を出す）。
 */
export async function requestReleaseReviewJob(
  target: ReleaseVerificationTarget,
  now: Date = new Date(),
): Promise<RequestReleaseReviewResult> {
  const setting = await db.appSetting.findUnique({
    where: { id: 1 },
    select: { appAiModelReasoning: true, aiExecutionProvider: true },
  });
  const assignee = resolveReleaseReviewAssignee(setting);

  await expireStaleDispatchJobs(now);
  const activeKey = buildReleaseReviewActiveKey(target);
  const existing = await db.dispatchJob.findFirst({ where: { activeKey } });
  if (existing) return { ok: true, outcome: "already_queued", job: existing, assignee };

  const hostName = await pickReleaseReviewHost(target.repoFullName, assignee, now);
  if (hostName === null) {
    const message = `${target.repoFullName}の全体レビュー（${describeReleaseReviewAssignee(assignee)}）を実行できるサブPCがありません（オフライン・pollerが未対応・リポジトリ未登録・Codex未対応のいずれか）。`;
    await recordReleaseVerificationResult(target, {
      kind: "ai_review",
      state: "failed",
      message,
      findings: {
        diagnostic: normalizeReleaseReviewDiagnostic({ stage: "prepare", cause: "no_host" }, target),
      },
    });
    return { ok: false, rejection: "no_host", message };
  }

  await db.dispatchJob.updateMany({
    where: {
      kind: "RELEASE_REVIEW",
      repositoryFullName: target.repoFullName,
      prNumber: target.prNumber,
      status: "QUEUED",
      OR: [{ headSha: { not: target.headSha } }, { baseSha: { not: target.baseSha } }],
    },
    data: {
      status: "CANCELED",
      activeKey: null,
      finishedAt: now,
      message: `新しい対象（${target.headSha.slice(0, 7)}）が積まれたため取り消しました。`,
    },
  });

  try {
    const job = await db.dispatchJob.create({
      data: {
        repositoryFullName: target.repoFullName,
        // 必須列。PR番号を埋め草として入れる（`PR_REVIEW`・`RELEASE_VERIFY`と同じ）
        issueNumber: target.prNumber,
        targetHost: hostName,
        kind: "RELEASE_REVIEW",
        agent: assignee.agent,
        claudeModel: assignee.claudeModel,
        codexModel: assignee.codexModel,
        status: "QUEUED",
        activeKey,
        prNumber: target.prNumber,
        baseSha: target.baseSha,
        headSha: target.headSha,
      },
    });
    notifyDispatchHostWake(job.targetHost);
    return { ok: true, outcome: "queued", job, assignee };
  } catch {
    const raced = await db.dispatchJob.findFirst({ where: { activeKey } });
    if (raced) return { ok: true, outcome: "already_queued", job: raced, assignee };
    throw new Error("全体レビューのジョブを積めませんでした");
  }
}

/**
 * 全体レビューの終了報告を`ReleaseVerification`へ反映する。**記録先はジョブ自身の対象（PR・base・head）で、
 * 報告の本文からは決めない。** 完走しても結果が無い・形が不正なときは`failed`にし、「結果の無い成功」で
 * ゲートを通さない。結果には対象SHA・担当AI・指摘・影響PR/ファイルを残す。
 */
export async function applyReleaseReviewReport(
  job: {
    repositoryFullName: string;
    prNumber?: number | null;
    baseSha?: string | null;
    headSha?: string | null;
    agent?: string | null;
    claudeModel?: string | null;
    codexModel?: string | null;
  },
  status: "succeeded" | "failed" | "skipped",
  message: string | null,
  body: unknown,
): Promise<boolean> {
  if (status === "skipped" || job.prNumber == null || !job.baseSha || !job.headSha) return false;
  const target: ReleaseVerificationTarget = {
    repoFullName: job.repositoryFullName,
    prNumber: job.prNumber,
    baseSha: job.baseSha,
    headSha: job.headSha,
  };
  const agent = `${job.agent ?? "claude"}:${job.agent === "codex" ? (job.codexModel ?? "") : (job.claudeModel ?? "")}`;
  const normalized = status === "succeeded" ? normalizeReleaseReview(body) : null;
  if (normalized) {
    const raw = (body ?? {}) as Record<string, unknown>;
    return recordReleaseVerificationResult(target, {
      kind: "ai_review",
      state: normalized.state,
      agent,
      summary: normalized.summary,
      findings: { ...normalized.detail, targetBaseSha: target.baseSha, targetHeadSha: target.headSha },
      unverifiedScope: normalized.unverifiedScope,
      message: typeof raw.message === "string" ? raw.message.slice(0, 5000) : message,
    });
  }
  // 実行失敗の診断（#4300）。コードへの指摘ではないので`findings`の指摘配列には入れず、
  // 対象SHA付きの`diagnostic`として持つ。報告が無い（古い実行側）ときは持たず、画面は原因未特定として出す
  const diagnostic = normalizeReleaseReviewDiagnostic(
    (body as { diagnostic?: unknown } | null)?.diagnostic,
    target,
  );
  return recordReleaseVerificationResult(target, {
    kind: "ai_review",
    state: "failed",
    agent,
    findings: diagnostic ? { diagnostic } : Prisma.DbNull,
    summary: null,
    message:
      status === "failed"
        ? (message ?? "全体レビューが失敗しました")
        : "全体レビューは終了しましたが、結果が報告されませんでした",
  });
}
