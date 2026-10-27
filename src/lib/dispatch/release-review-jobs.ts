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
import { loadReleaseReviewContext } from "@/lib/release-review-context-load";
import {
  readAutoReevaluation,
  readOpsReevaluation,
  type ReviewAutoReevaluation,
  type ReviewOpsReevaluation,
} from "@/lib/release-review-reevaluation";
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

/** 積み方の指定。自動再評価（#4664）と統合検証の完了後の開始（#4763）が使い、画面の再実行は従来どおり */
export type ReleaseReviewRequestOptions = {
  /**
   * このホストにだけ積む。統合検証の証跡はそれを実行したホストのローカルファイルなので、自動再評価は
   * 検証したホストへ向ける（別ホストでは証跡を読めず、未確認のまま戻るだけになる）。不適格なら積まない
   */
  requiredHost?: string;
  /**
   * 適格ならこのホストを優先する（#4763）。統合検証の完了後に開始する全体レビューは、証跡のある統合検証の実行ホストへ向ける。
   * 不適格なら従来どおり名前順の先頭へフォールバックする（`requiredHost`と違い、積むこと自体はやめない）
   */
  preferredHost?: string | null;
  /** 積めるホストが無いとき`ai_review`へ失敗を記録するか（既定true）。自動経路は有効な結果を上書きしないためfalse */
  recordNoHost?: boolean;
};

async function pickReleaseReviewHost(
  repositoryFullName: string,
  assignee: ReleaseReviewAssignee,
  now: Date,
  requiredHost?: string,
  preferredHost?: string | null,
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
  if (requiredHost !== undefined) return capable.some((host) => host.name === requiredHost) ? requiredHost : null;
  if (preferredHost && capable.some((host) => host.name === preferredHost)) return preferredHost;
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
  /**
   * 自動再評価（統合検証の完了#4664・pollerの更新#5111）のとき、その印と積み方。印は結果の記録にも引き継ぎ、
   * 同じ証跡・同じホストの事実で繰り返さない
   */
  options: ReleaseReviewRequestOptions & {
    autoReevaluation?: ReviewAutoReevaluation;
    opsReevaluation?: ReviewOpsReevaluation;
  } = {},
): Promise<RequestReleaseReviewResult> {
  const before = await db.releaseVerification.findFirst({
    where: { ...target, kind: "ai_review" },
    select: { state: true, summary: true, unverifiedScope: true, updatedAt: true, findings: true },
  });
  const result = await requestReleaseReviewJob(target, now, options);
  if (result.ok && result.outcome === "queued") {
    // 旧結果は新テーブルを作らず、既存の`findings`JSONへ直前1件だけ残す（#4632）。履歴と現在の結果は`previousRun`の有無で分かれる
    const previousRun =
      before && before.state !== "waiting" && before.state !== "not_run"
        ? {
            state: before.state,
            at: before.updatedAt.toISOString(),
            unverifiedScope: before.unverifiedScope?.slice(0, 1000) ?? null,
            summary: before.summary?.slice(0, 600) ?? null,
          }
        : null;
    // 自動の再評価は、もう一方の契機の印を残す（消すと、その契機で同じ事実のまま積み直してしまう）。
    // 人の再実行は従来どおり印を持ち越さない
    const automatic = options.autoReevaluation !== undefined || options.opsReevaluation !== undefined;
    const autoReevaluation =
      options.autoReevaluation ?? (automatic ? readAutoReevaluation(before?.findings) : null);
    const opsReevaluation = options.opsReevaluation ?? (automatic ? readOpsReevaluation(before?.findings) : null);
    await db.releaseVerification.updateMany({
      where: { ...target, kind: "ai_review" },
      data: {
        state: "waiting",
        findings:
          previousRun || autoReevaluation || opsReevaluation
            ? {
                ...(previousRun ? { previousRun } : {}),
                ...(autoReevaluation ? { autoReevaluation } : {}),
                ...(opsReevaluation ? { opsReevaluation } : {}),
              }
            : Prisma.DbNull,
        message: null,
        summary: null,
        unverifiedScope: null,
      },
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
  options: ReleaseReviewRequestOptions = {},
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

  const hostName = await pickReleaseReviewHost(
    target.repoFullName,
    assignee,
    now,
    options.requiredHost,
    options.preferredHost,
  );
  if (hostName === null) {
    if (options.recordNoHost === false) {
      return { ok: false, rejection: "no_host", message: "全体レビューを積めるサブPCがないため見送りました" };
    }
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
 * 再実行で退避した直前の結果（`findings.previousRun`）と自動再評価の印（`autoReevaluation`・#4664）。
 * 新しい結果を記録するときに引き継ぐ。前者は完了後も履歴として読むため、後者は同じ証跡で再評価を繰り返さないため（#4632）
 */
async function loadCarriedFindings(target: ReleaseVerificationTarget): Promise<Record<string, unknown>> {
  const row = await db.releaseVerification
    .findFirst({ where: { ...target, kind: "ai_review" }, select: { findings: true } })
    .catch(() => null);
  const findings = row?.findings;
  if (typeof findings !== "object" || findings === null || Array.isArray(findings)) return {};
  const previous = (findings as Record<string, unknown>).previousRun;
  const marker = readAutoReevaluation(findings);
  const opsMarker = readOpsReevaluation(findings);
  return {
    ...(typeof previous === "object" && previous !== null && !Array.isArray(previous) ? { previousRun: previous } : {}),
    ...(marker ? { autoReevaluation: marker } : {}),
    ...(opsMarker ? { opsReevaluation: opsMarker } : {}),
  };
}

/**
 * 結果を出したホストと、その時点の起動時コミット（#5111）。報告してきたpollerがそのジョブを実行したので、
 * いまのホストの申告がそのまま実行時の事実になる。読めなければ記録しない（旧結果と同じ「事実不明」）
 */
async function loadReportingHostFacts(job: {
  claimedByHost?: string | null;
  targetHost?: string | null;
}): Promise<{ hostFacts: { host: string; startedCommit: string | null } } | Record<string, never>> {
  const host = job.claimedByHost ?? job.targetHost ?? null;
  if (!host) return {};
  const row = await db.dispatchHost
    .findUnique({ where: { name: host }, select: { checkoutStartedCommit: true } })
    .catch(() => null);
  if (!row) return {};
  return { hostFacts: { host, startedCommit: row.checkoutStartedCommit ?? null } };
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
    claimedByHost?: string | null;
    targetHost?: string | null;
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
  // 再レビューへ引き継げるかは、ランナーの申告ではなくサーバーが記録から取り直した文脈で決める（#4559）。
  // 文脈を読めないときは履歴不明として全体確認の扱いにする（引き継ぎを認めない側へ倒す）
  const context = status === "succeeded" ? await loadReleaseReviewContext(target).catch(() => null) : null;
  const normalized = status === "succeeded" ? normalizeReleaseReview(body, context) : null;
  const keepPrevious = await loadCarriedFindings(target);
  if (normalized) {
    const raw = (body ?? {}) as Record<string, unknown>;
    const hostFacts = await loadReportingHostFacts(job);
    return recordReleaseVerificationResult(target, {
      kind: "ai_review",
      state: normalized.state,
      agent,
      summary: normalized.summary,
      findings: {
        ...normalized.detail,
        targetBaseSha: target.baseSha,
        targetHeadSha: target.headSha,
        ...keepPrevious,
        ...hostFacts,
      },
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
    findings:
      diagnostic || Object.keys(keepPrevious).length > 0
        ? { ...(diagnostic ? { diagnostic } : {}), ...keepPrevious }
        : Prisma.DbNull,
    summary: null,
    message:
      status === "failed"
        ? (message ?? "全体レビューが失敗しました")
        : "全体レビューは終了しましたが、結果が報告されませんでした",
  });
}
