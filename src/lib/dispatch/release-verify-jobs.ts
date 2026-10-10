import type { DispatchJob } from "@prisma/client";

import { db } from "@/lib/db";
import {
  DISPATCH_HOST_ONLINE_WINDOW_MS,
  isDispatchHostOnline,
  parseDispatchHostRepositories,
} from "@/lib/dispatch/dispatch-job";
import { expireStaleDispatchJobs } from "@/lib/dispatch/jobs";
import { notifyDispatchHostWake } from "@/lib/dispatch/wake-notify";
import type { ReleaseVerificationKind } from "@/lib/release-merge-gate";
import { describeIntegrationNotApplicable } from "@/lib/release-verification-config";
import {
  recordReleaseVerificationResult,
  type ReleaseVerificationTarget,
} from "@/lib/release-verification";

/**
 * リリースPRの統合検証（`RELEASE_VERIFY`・#4237）のDB操作。実行はサブPCのpollerが取りに来る。
 * 結果（`ReleaseVerification`）はランナーが`POST /api/dispatch/release-verify`の`report`で記録し、
 * ジョブの状態は`POST /api/dispatch/report`が持つ。**ジョブ側の`SUCCEEDED`は「検証を完走した」だけで、
 * 合格は`ReleaseVerification.state`が持つ。**
 */

export function buildReleaseVerifyActiveKey(
  target: ReleaseVerificationTarget,
  kind: ReleaseVerificationKind,
): string {
  return `release_verify:${target.repoFullName}#${target.prNumber}@${target.baseSha}:${target.headSha}:${kind}`;
}

export type RequestReleaseVerifyResult =
  | { ok: true; outcome: "queued" | "already_queued"; job: DispatchJob }
  /** このリポジトリは検証できない。ジョブは積まず、`not_applicable`として記録した */
  | { ok: true; outcome: "not_applicable"; reason: string }
  | { ok: false; rejection: "no_host"; message: string };

async function pickReleaseVerifyHost(repositoryFullName: string, now: Date): Promise<string | null> {
  const hosts = await db.dispatchHost.findMany({
    where: { lastSeenAt: { gte: new Date(now.getTime() - DISPATCH_HOST_ONLINE_WINDOW_MS) } },
    orderBy: { name: "asc" },
  });
  const capable = hosts.filter(
    (host) =>
      isDispatchHostOnline(host.lastSeenAt, now) &&
      host.releaseVerifyCapable === true &&
      parseDispatchHostRepositories(host.repositories).includes(repositoryFullName),
  );
  return capable[0]?.name ?? null;
}

/**
 * 統合検証を積む（冪等）。同じ対象（PR・base・head）に未完了のジョブがあればそれを返す。
 * 新しいbase/headが積まれたら、同じPRの**古い対象の待機中ジョブは取り消す**（結果は「対象変更による
 * 無効」になり使われない）。検証できないリポジトリは`not_applicable`を理由付きで記録して終える。
 */
export async function requestReleaseVerifyJob(
  target: ReleaseVerificationTarget,
  now: Date = new Date(),
): Promise<RequestReleaseVerifyResult> {
  const notApplicable = describeIntegrationNotApplicable(target.repoFullName);
  if (notApplicable !== null) {
    await recordReleaseVerificationResult(target, {
      kind: "integration",
      state: "not_applicable",
      message: notApplicable,
    });
    return { ok: true, outcome: "not_applicable", reason: notApplicable };
  }

  await expireStaleDispatchJobs(now);
  const activeKey = buildReleaseVerifyActiveKey(target, "integration");
  const existing = await db.dispatchJob.findFirst({ where: { activeKey } });
  if (existing) return { ok: true, outcome: "already_queued", job: existing };

  const hostName = await pickReleaseVerifyHost(target.repoFullName, now);
  if (hostName === null) {
    const message = `${target.repoFullName}の統合検証を実行できるサブPCがありません（オフライン・pollerが未対応・リポジトリ未登録のいずれか）。`;
    await recordReleaseVerificationResult(target, { kind: "integration", state: "failed", message });
    return { ok: false, rejection: "no_host", message };
  }

  await db.dispatchJob.updateMany({
    where: {
      kind: "RELEASE_VERIFY",
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
        // 必須列。PR番号を埋め草として入れる（`PR_REVIEW`と同じ）
        issueNumber: target.prNumber,
        targetHost: hostName,
        kind: "RELEASE_VERIFY",
        agent: "claude",
        status: "QUEUED",
        activeKey,
        prNumber: target.prNumber,
        baseSha: target.baseSha,
        headSha: target.headSha,
      },
    });
    notifyDispatchHostWake(job.targetHost);
    return { ok: true, outcome: "queued", job };
  } catch {
    const raced = await db.dispatchJob.findFirst({ where: { activeKey } });
    if (raced) return { ok: true, outcome: "already_queued", job: raced };
    throw new Error("統合検証のジョブを積めませんでした");
  }
}

const REPORTABLE_STATES = ["passed", "failed", "needs_check", "not_applicable"] as const;

/**
 * 統合検証ジョブの終了報告を`ReleaseVerification`へ反映する（#4237）。**記録先はジョブ自身の対象
 * （PR・base・head）で、報告の本文からは決めない**——ランナーが別の対象へ書けないようにする。
 * 完走（`succeeded`）でも結果が無ければ`failed`にし、「結果の無い成功」でゲートを通さない。
 * `skipped`（同じ対象の検証が別に動いている）は、そちらが記録するので何もしない。
 */
export async function applyReleaseVerifyReport(
  job: {
    repositoryFullName: string;
    prNumber?: number | null;
    baseSha?: string | null;
    headSha?: string | null;
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
  const raw = (body ?? {}) as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" && v !== "" ? v.slice(0, max) : null);
  const reported = (REPORTABLE_STATES as readonly unknown[]).includes(raw.state)
    ? (raw.state as (typeof REPORTABLE_STATES)[number])
    : null;
  if (status === "succeeded" && reported) {
    return recordReleaseVerificationResult(target, {
      kind: "integration",
      state: reported,
      summary: str(raw.summary, 20000),
      findings: raw.findings,
      unverifiedScope: str(raw.unverifiedScope, 5000),
      evidenceUrl: str(raw.evidenceUrl, 500),
      message: str(raw.message, 5000) ?? message,
    });
  }
  return recordReleaseVerificationResult(target, {
    kind: "integration",
    state: "failed",
    message:
      status === "failed"
        ? (message ?? "統合検証が失敗しました")
        : "統合検証は終了しましたが、結果が報告されませんでした",
  });
}
