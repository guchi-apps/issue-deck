import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { createComment } from "@/lib/github/issues-api";
import { fetchPullRequest } from "@/lib/github/pull-requests-api";
import { sendReleaseCompletionStopPush } from "@/lib/notifications/release-completion-stop-push";
import {
  AUTOPILOT_STOP_LABEL,
  buildAutopilotRequestKey,
  decideAutopilot,
  type AutopilotStopReason,
} from "@/lib/release-autopilot";
import { RELEASE_COMPLETION_SCOPE_READY, releaseCompletionStopMessage } from "@/lib/release-completion";
import { startReleaseCompletionRun, stopReleaseCompletionRun } from "@/lib/release-completion-run";
import { requestRcFinalize } from "@/lib/release-finalize-run";
import { ensurePublishApprovalRun, revokePublishApproval } from "@/lib/release-publish-approval-run";
import { loadRcOverview, type Context } from "@/lib/release-rc-run";
import { buildBulkDecisionRows, toBulkDecisionItem } from "@/lib/release-review-bulk";
import { applyReleaseReviewDecision, loadDecisionContext } from "@/lib/release-review-decision-apply";
import { generateRecommendationsForTarget } from "@/lib/release-review-recommendation-prefetch";
import { loadReleaseVerificationSummary } from "@/lib/release-verification-load";

/**
 * 「本番公開を開始」した候補の全自動の巡回。判断は純関数`decideAutopilot`。
 *
 * **新しい実行経路は作らない。** 指摘の確定（`applyReleaseReviewDecision`）・自動修正の開始
 * （`startReleaseCompletionRun`）・公開承認（`requestRcFinalize`）は、人がボタンを押したときと同じ関数を、
 * 開始者の名義で呼ぶ。本番mainへのマージは公開承認の系列が従来の関門を通して行う。
 */

const ATTEMPT_INTERVAL_MS = 60 * 1000;
/** 候補ごとの直近の試行時刻と実行中の印（プロセス内のみ）。推奨の生成は長いので重ねて走らせない */
const lastAttemptAt = new Map<string, number>();
const running = new Set<string>();

const MARKER = "<!-- issue-deck:release-autopilot -->";

export type AutopilotSweepAction = { candidateId: string; repositoryFullName: string; action: string; detail?: string };

type Row = {
  id: string;
  repositoryFullName: string;
  phase: string;
  createdAt: Date;
  autoPublishUserId: string | null;
  autoPublishStartedAt: Date | null;
};

export async function runReleaseAutopilotSweep(now: Date = new Date()): Promise<{ scanned: number; actions: AutopilotSweepAction[] }> {
  const rows: Row[] = await db.releaseCandidate.findMany({
    where: { activeKey: { not: null }, phase: { in: ["review", "preparing", "awaiting_approval"] }, currentRevision: { gt: 0 }, autoPublishUserId: { not: null }, autoPublishStoppedAt: null },
    select: { id: true, repositoryFullName: true, phase: true, createdAt: true, autoPublishUserId: true, autoPublishStartedAt: true },
  });
  const actions: AutopilotSweepAction[] = [];
  for (const row of rows) {
    const last = lastAttemptAt.get(row.id);
    if (running.has(row.id) || (last !== undefined && now.getTime() - last < ATTEMPT_INTERVAL_MS)) continue;
    lastAttemptAt.set(row.id, now.getTime());
    running.add(row.id);
    try {
      const result = await advance(row, now);
      if (result) actions.push({ candidateId: row.id, repositoryFullName: row.repositoryFullName, ...result });
    } catch (error) {
      // 1本の障害で他の候補を止めない。次の巡回で再評価する
      console.error("[runReleaseAutopilotSweep]", row.repositoryFullName, row.id, error);
    } finally {
      running.delete(row.id);
    }
  }
  return { scanned: rows.length, actions };
}

async function advance(row: Row, now: Date): Promise<{ action: string; detail?: string } | null> {
  const userId = row.autoPublishUserId;
  if (!userId) return null;
  const repository = await db.repository.findFirst({ where: { fullName: row.repositoryFullName }, include: { installation: true } });
  if (!repository) return null;
  const ctx: Context = {
    owner: repository.ownerLogin,
    repo: repository.name,
    token: await getInstallationToken(repository.installation.installationId),
  };

  const view = (await loadRcOverview(ctx)).candidate;
  if (!view || view.id !== row.id || view.prNumber === null) return null;
  const prNumber = view.prNumber;
  const pull = await fetchPullRequest(ctx.owner, ctx.repo, prNumber, ctx.token);
  if (!pull.base?.sha) return null;
  const current = { baseSha: pull.base.sha, headSha: pull.head.sha };

  const startedAt = row.autoPublishStartedAt ?? row.createdAt;
  const [activeRun, recentRuns, approval] = await Promise.all([
    db.releaseCompletionRun.findUnique({ where: { activeKey: row.repositoryFullName }, select: { id: true } }),
    db.releaseCompletionRun.findMany({
      // 再開より前に止まった系列・取り消した承認は数えない
      where: { repositoryFullName: row.repositoryFullName, createdAt: { gte: startedAt } },
      orderBy: { createdAt: "desc" },
      select: { candidatePrNumber: true, status: true, stopReason: true, stopDetail: true },
    }),
    db.releasePublishApproval.findFirst({ where: { candidateId: row.id, createdAt: { gte: startedAt } }, orderBy: { createdAt: "desc" }, select: { status: true } }),
  ]);
  const verification = await loadReleaseVerificationSummary(row.repositoryFullName, prNumber, current);

  const candidateRun = recentRuns.find((run) => run.candidatePrNumber === prNumber) ?? null;
  const decision = decideAutopilot({
    now,
    startedAt,
    phase: view.phase,
    hasPendingRevision: view.revisions.some((revision) => revision.status === "requested"),
    runActive: activeRun !== null,
    candidateRunStatus: candidateRun?.status ?? null,
    approvalStatus: approval?.status ?? null,
    contract: view.finalizeContract,
    verification,
    labels: (pull.labels ?? []).map((label: { name?: string }) => label.name ?? ""),
  });

  const stop = async (reason: AutopilotStopReason, notify: boolean, detail?: string) => {
    await stopAutopilot(row, ctx, prNumber, reason, notify, detail, now);
    return { action: `stop:${reason}`, detail };
  };

  switch (decision.action) {
    case "wait":
      return null;
    case "stop": {
      if (decision.reason !== "run_stopped") return stop(decision.reason, decision.notify);
      const advanced = candidateRun?.stopReason === "base_changed" || candidateRun?.stopReason === "candidate_changed";
      const detail = releaseCompletionStopMessage(candidateRun?.stopReason ?? null, candidateRun?.stopDetail ?? null) ?? undefined;
      return stop(advanced ? "main_advanced" : "run_stopped", decision.notify, detail);
    }
    case "approve": {
      const contract = view.finalizeContract;
      if (!contract) return null;
      const result = await requestRcFinalize({
        ...ctx,
        userId,
        candidateId: row.id,
        expectedHeadSha: contract.headSha,
        bumpKind: null,
        requestKey: buildAutopilotRequestKey(row.id, contract.headSha, startedAt),
        approvePublish: true,
      });
      if (result.ok) return { action: "approved" };
      // 状態の取り違え・同時操作は、次の巡回で取り直せば解ける
      if (["unobserved", "in_progress", "wrong_phase", "run_active", "candidate_changed", "not_ready"].includes(result.error)) {
        return { action: "retry", detail: result.error };
      }
      return stop(result.error === "main_advanced" ? "main_advanced" : "approval_failed", true, ("message" in result && result.message) || result.error);
    }
    case "start_fix": {
      const result = await startReleaseCompletionRun({
        ...ctx,
        userId,
        pullRequestNumber: prNumber,
        ...current,
        scope: RELEASE_COMPLETION_SCOPE_READY,
        now,
      });
      return result.ok ? { action: "start_fix" } : { action: "retry", detail: result.error };
    }
    case "decide_findings": {
      const loaded = await loadDecisionContext({
        ...ctx,
        pullRequestNumber: prNumber,
        expectedBase: current.baseSha,
        expectedHead: current.headSha,
        userId,
      });
      if (!loaded.ok) return { action: "retry", detail: "release_pr_changed" };
      const section = loaded.ctx.section;
      const rowsWith = async (retry: boolean) => {
        const recommendations = await generateRecommendationsForTarget({ repoFullName: row.repositoryFullName, prNumber, current, retry });
        return buildBulkDecisionRows({
          findings: section.findings,
          suggestions: section.suggestions,
          decisions: section.decisions ?? null,
          recommendations: recommendations.byFinding,
        });
      };
      let table = await rowsWith(false);
      if (table.some((item) => item.fallback !== null)) table = await rowsWith(true);
      // 推奨の無い指摘は、安全側の判定を勝手に入れず人へ渡す
      const missing = table.filter((item) => item.fallback !== null).length;
      if (missing > 0) return stop("recommendations_unavailable", true, `${missing}件`);
      for (const item of table) {
        const input = toBulkDecisionItem(item, item.decision);
        if (!input) continue;
        // 人の判断ではないので、出どころを残す（画面は「自動で確定」と出す）
        const saved = await applyReleaseReviewDecision(loaded.ctx, { ...input, reasonSourceOverride: "autopilot" });
        if (!saved.ok) return { action: "retry", detail: `${item.findingId}: ${String(saved.body.error ?? saved.status)}` };
      }
      return { action: "decided", detail: `${table.length}件` };
    }
  }
}

/** 止めた理由を残す。以後この候補は自動で進めない。二重の停止は最初の1回だけが知らせる */
async function stopAutopilot(
  row: Pick<Row, "id" | "repositoryFullName">,
  ctx: Context,
  prNumber: number | null,
  reason: AutopilotStopReason,
  notify: boolean,
  detail: string | undefined,
  now: Date,
): Promise<boolean> {
  const message = detail ? `${AUTOPILOT_STOP_LABEL[reason]}（${detail}）` : AUTOPILOT_STOP_LABEL[reason];
  const updated = await db.releaseCandidate.updateMany({
    where: { id: row.id, autoPublishUserId: { not: null }, autoPublishStoppedAt: null },
    data: { autoPublishStoppedAt: now, autoPublishStopCode: reason, autoPublishStopReason: message.slice(0, 2000) },
  });
  if (updated.count !== 1) return false;
  if (!notify || prNumber === null) return true;
  await createComment(ctx.owner, ctx.repo, prNumber, ctx.token, {
    body: [`本番公開の自動実行を止めました。${message}`, "", "このPRの画面から状況を確かめて、続きを操作してください。", "", MARKER, "<!-- issue-deck-agent:guide -->"].join("\n"),
  }).catch((error: unknown) => console.error("[release-autopilot] コメントに失敗しました", row.id, error));
  await sendReleaseCompletionStopPush(
    { repositoryFullName: row.repositoryFullName, pullRequestNumber: prNumber, publish: true, reason: message },
    now,
  );
  return true;
}

export type StopAutopilotResult = { ok: true } | { ok: false; error: "not_found" | "already_publishing" };

/**
 * 画面の「自動公開を止める」。**先に全自動を外してから**、出していた公開承認と進行中の系列を止める
 * （巡回が止めた直後に承認し直さないようにする）。本番マージを確保した後は取り消せない
 */
export async function stopReleaseAutopilotByUser(input: Context & { userId: string; candidateId: string; now?: Date }): Promise<StopAutopilotResult> {
  const now = input.now ?? new Date();
  const repositoryFullName = `${input.owner}/${input.repo}`;
  const row = await db.releaseCandidate.findFirst({
    where: { id: input.candidateId, repositoryFullName },
    select: { id: true, repositoryFullName: true, revisions: { select: { prNumber: true } } },
  });
  if (!row) return { ok: false, error: "not_found" };
  await stopAutopilot(row, input, null, "stopped_by_user", false, undefined, now);
  const revoked = await revokePublishApproval({ repositoryFullName, candidateId: row.id, userId: input.userId, now });
  if (!revoked.ok && revoked.error === "already_publishing") return { ok: false, error: "already_publishing" };
  const run = await db.releaseCompletionRun.findUnique({ where: { activeKey: repositoryFullName }, select: { id: true, candidatePrNumber: true } });
  if (run && row.revisions.some((revision) => revision.prNumber === run.candidatePrNumber)) {
    await stopReleaseCompletionRun({ repositoryFullName, runId: run.id, userId: input.userId, token: input.token, now });
  }
  return { ok: true };
}

export type ResumeAutopilotResult = { ok: true } | { ok: false; error: "not_found" | "not_resumable"; message?: string };

/**
 * 停止した全自動の再開。**押した人を公開の指示者として記録し直し**、期限と見る系列・承認の起点を今にする。
 * mainマージ前の候補だけが対象で、公開準備より後は有効な公開承認が残っているときに系列を作り直す
 */
export async function resumeReleaseAutopilot(input: Context & { userId: string; candidateId: string; now?: Date }): Promise<ResumeAutopilotResult> {
  const now = input.now ?? new Date();
  const repositoryFullName = `${input.owner}/${input.repo}`;
  const row = await db.releaseCandidate.findFirst({
    where: { id: input.candidateId, repositoryFullName },
    select: { id: true, phase: true, autoPublishUserId: true, autoPublishStoppedAt: true },
  });
  if (!row || row.autoPublishUserId === null) return { ok: false, error: "not_found" };
  if (row.autoPublishStoppedAt === null) return { ok: true };
  if (!["review", "preparing", "awaiting_approval"].includes(row.phase)) return { ok: false, error: "not_resumable" };
  const approval = await db.releasePublishApproval.findUnique({ where: { activeKey: row.id }, select: { id: true, status: true } });
  if (row.phase !== "review" && approval?.status !== "active") {
    return { ok: false, error: "not_resumable", message: "公開承認が残っていないため再開できません。候補を取り消して作り直してください" };
  }
  await db.releaseCandidate.updateMany({
    where: { id: row.id, autoPublishStoppedAt: { not: null } },
    data: { autoPublishUserId: input.userId, autoPublishStartedAt: now, autoPublishStoppedAt: null, autoPublishStopCode: null, autoPublishStopReason: null },
  });
  if (row.phase !== "review" && approval) {
    const ensured = await ensurePublishApprovalRun(input, approval.id, now);
    if (!ensured.ok) return { ok: false, error: "not_resumable", message: ensured.message };
  }
  lastAttemptAt.delete(row.id);
  return { ok: true };
}
