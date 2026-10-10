import type { ReleaseFixSeries } from "@prisma/client";

import { db } from "@/lib/db";
import { fetchPullRequest } from "@/lib/github/actions-api";
import { getInstallationToken } from "@/lib/github/app-auth";
import { addIssueLabels, createComment, createIssue, updateIssue } from "@/lib/github/issues-api";
import {
  fetchOpenPullRequestsForBase,
  fetchPullRequestsByHead,
  fetchReleaseRebuildCandidate,
  type GithubApiPullRequest,
} from "@/lib/github/release-api";
import { releaseWorkflowExists } from "@/lib/github/release-workflow-cache";
import { isUniqueConstraintError } from "@/lib/prisma-error";
import {
  buildReleaseFixIssue,
  buildReleaseFixSourceKey,
  canStartNextGeneration,
  classifyIntegrationFailure,
  decideReleaseFix,
  decideReverification,
  defaultVerifyConditions,
  isReleaseFixActive,
  itemFromFinding,
  parseReleaseFixStatus,
  releaseFixActiveKey,
  releaseFixStepIndex,
  reviewFindingKey,
  RELEASE_FIX_STATUS_LABEL,
  type ReleaseFixCauseClass,
  type ReleaseFixDraftItem,
  type ReleaseFixSourceKind,
  type ReleaseFixStatus,
} from "@/lib/release-fix-series";
import { redactDiagnosticText } from "@/lib/release-review-diagnostic";
import {
  decideAutoRebuildTrigger,
  rebuildEventKey,
} from "@/lib/release-rebuild-history";
import { findLatestApprovalEventId, recordRebuildEvent } from "@/lib/release-rebuild-history-run";
import { rebuildReleaseCandidate } from "@/lib/release-rebuild-run";
import { requestSelectiveRebuild } from "@/lib/release-rebuild-selection-run";
import { releaseCallerSupportsSelection } from "@/lib/github/release-api";
import { loadReleaseVerificationSummary } from "@/lib/release-verification-load";
import type { ReleaseVerificationSection } from "@/lib/release-verification-summary";

/**
 * リリース候補の修正系列（#4317）の外部操作。判断は`release-fix-series.ts`の純関数が持つ。
 *
 * **再起動しても続きから進める形にする。** 進行はすべて`ReleaseFixSeries`の行に置く。
 * 二重起案は`activeKey`のユニーク制約、二重の作り直しは`rebuildClaimedAt`の条件付き更新が止める。
 * **develop向けの修正PRのマージは既存の自動レビュー・マージ機構に任せ、ここはマージ済みかを観測するだけ**
 * （GitHubの保護を外して取り込まない）。
 */

const FROZEN_PREFIX = "release-main/v";
const CHECK_USER_LABELS = ["00.check-user", "01.check-blocked"];
const PLAN_REQUIRED_LABEL = "21.plan-required";
const REBUILD_TIMEOUT_MS = 30 * 60 * 1000;
const STOP_COMMENT_MARKER = "<!-- issue-deck-release-fix -->";

export type ReleaseFixSeriesView = {
  id: string;
  status: ReleaseFixStatus;
  statusLabel: string;
  active: boolean;
  stepIndex: number;
  sourceKind: ReleaseFixSourceKind;
  causeClass: ReleaseFixCauseClass;
  itemTitles: string[];
  releasePrNumber: number;
  originBaseSha: string;
  originHeadSha: string;
  issueNumber: number;
  fixPrNumber: number | null;
  successorPrNumber: number | null;
  successorBaseSha: string | null;
  successorHeadSha: string | null;
  generation: number;
  parentId: string | null;
  stopReason: string | null;
  createdAt: string;
};

export function toReleaseFixSeriesView(row: ReleaseFixSeries): ReleaseFixSeriesView {
  const status = parseReleaseFixStatus(row.status) ?? "stopped";
  const items = Array.isArray(row.items) ? (row.items as { title?: unknown }[]) : [];
  return {
    id: row.id,
    status,
    statusLabel: RELEASE_FIX_STATUS_LABEL[status],
    active: isReleaseFixActive(status),
    stepIndex: releaseFixStepIndex({
      status,
      fixPrNumber: row.fixPrNumber,
      successorPrNumber: row.successorPrNumber,
    }),
    sourceKind: row.sourceKind as ReleaseFixSourceKind,
    causeClass: row.causeClass as ReleaseFixCauseClass,
    itemTitles: items.map((item) => (typeof item.title === "string" ? item.title : "")).filter((t) => t !== ""),
    releasePrNumber: row.releasePrNumber,
    originBaseSha: row.originBaseSha,
    originHeadSha: row.originHeadSha,
    issueNumber: row.issueNumber,
    fixPrNumber: row.fixPrNumber,
    successorPrNumber: row.successorPrNumber,
    successorBaseSha: row.successorBaseSha,
    successorHeadSha: row.successorHeadSha,
    generation: row.generation,
    parentId: row.parentId,
    stopReason: row.stopReason,
    createdAt: row.createdAt.toISOString(),
  };
}

/** このリリースPRに関係する系列（起点がこのPR、または作り直しの後継がこのPR）を新しい順に返す */
export async function listReleaseFixSeries(
  repositoryFullName: string,
  releasePrNumber: number,
): Promise<ReleaseFixSeriesView[]> {
  const rows = await db.releaseFixSeries.findMany({
    where: {
      repositoryFullName,
      OR: [{ releasePrNumber }, { successorPrNumber: releasePrNumber }],
    },
    orderBy: { createdAt: "desc" },
    take: 30,
  });
  return rows.map(toReleaseFixSeriesView);
}

export type CreateReleaseFixInput = {
  userId: string;
  owner: string;
  repo: string;
  token: string;
  releasePr: GithubApiPullRequest;
  sourceKind: ReleaseFixSourceKind;
  /** 全体レビューの指摘のうち、起案する項目の添字（現在のSHAの結果に対するもの） */
  findingIndexes: number[];
  causeClass: ReleaseFixCauseClass;
  decisionQuestion: string | null;
  /** 実行障害の疑いがあっても、コード修正として起案する（利用者の明示） */
  acknowledgeExecutionFailure: boolean;
  /** 現在のSHAでの検証結果（呼び出し側が`loadReleaseVerificationSummary`で取る） */
  section: ReleaseVerificationSection;
  baseSha: string;
  headSha: string;
};

export type CreateReleaseFixResult =
  | { outcome: "created" | "existing"; series: ReleaseFixSeriesView }
  | { outcome: "execution_failure"; message: string }
  | { outcome: "no_items"; message: string }
  | { outcome: "blocked"; message: string };

function releaseVersionOf(headRef: string): string | null {
  return headRef.startsWith(FROZEN_PREFIX) ? headRef.slice(FROZEN_PREFIX.length) : null;
}

function itemsFromSection(input: CreateReleaseFixInput): { items: ReleaseFixDraftItem[]; keys: string[] } | null {
  if (input.sourceKind === "review_finding") {
    const chosen = [...new Set(input.findingIndexes)]
      .map((index) => input.section.findings[index])
      .filter((finding) => finding !== undefined);
    if (chosen.length === 0) return null;
    return { items: chosen.map(itemFromFinding), keys: chosen.map(reviewFindingKey) };
  }
  const reason = [input.section.reason, input.section.summary].filter(Boolean).join("\n");
  const progress = input.section.progress;
  const stepLabel =
    progress && progress.currentIndex !== null ? (progress.steps[progress.currentIndex]?.label ?? "") : "";
  const stage = stepLabel ? `（工程: ${stepLabel}）` : "";
  const text = redactDiagnosticText(reason).trim();
  const item: ReleaseFixDraftItem = {
    title: `統合検証の失敗${stage}`,
    detail: text === "" ? "失敗の詳細は記録されていません。証跡のURLを確認してください。" : text.slice(0, 2000),
    file: null,
    evidence: input.section.evidenceUrl,
    recommendation: null,
    pullRequests: input.section.affectedPullRequests,
  };
  return { items: [item], keys: [`integration|${stepLabel}|${text.slice(0, 200)}`] };
}

/**
 * 修正Issueを起案して系列を作る。同じ対象・指摘は既存の系列を返し、**Issueを増やさない**。
 * 実行障害（AI起動・認証・接続など）は`acknowledgeExecutionFailure`が無ければ起案せず、再実行を勧める。
 */
export async function createReleaseFixSeries(input: CreateReleaseFixInput): Promise<CreateReleaseFixResult> {
  const { owner, repo, releasePr, section } = input;
  const repositoryFullName = `${owner}/${repo}`;

  if (input.sourceKind === "review_finding" && section.state === "failed") {
    return { outcome: "execution_failure", message: "全体レビューが実行障害で完了していません。コードの指摘ではないため、再実行を先に行ってください" };
  }
  if (input.sourceKind === "integration_failure") {
    if (section.state !== "failed" && section.state !== "needs_check") {
      return { outcome: "no_items", message: "統合検証は失敗していません" };
    }
    const kind = classifyIntegrationFailure([section.reason, section.summary].filter(Boolean).join("\n"));
    if (kind === "execution" && !input.acknowledgeExecutionFailure) {
      return {
        outcome: "execution_failure",
        message: "統合検証の実行障害の可能性があります（コードの不具合と断定できません）。環境の復旧と再実行を先に行ってください",
      };
    }
  }

  const picked = itemsFromSection(input);
  if (!picked) return { outcome: "no_items", message: "起案する指摘が選ばれていません" };

  const sourceKey = buildReleaseFixSourceKey({
    repositoryFullName,
    releasePrNumber: releasePr.number,
    baseSha: input.baseSha,
    headSha: input.headSha,
    sourceKind: input.sourceKind,
    itemKeys: picked.keys,
  });
  const activeKey = releaseFixActiveKey(repositoryFullName, releasePr.number, sourceKey);

  const duplicate = await db.releaseFixSeries.findUnique({ where: { activeKey } });
  if (duplicate) return { outcome: "existing", series: toReleaseFixSeriesView(duplicate) };

  // 後継候補での再検証失敗から続ける場合は、世代を進める（上限・同一問題の再発で止める）
  const parent = await db.releaseFixSeries.findFirst({
    where: { repositoryFullName, successorPrNumber: releasePr.number },
    orderBy: { createdAt: "desc" },
  });
  const ancestorKeys: string[] = [];
  for (let cursor: ReleaseFixSeries | null = parent, depth = 0; cursor && depth < 10; depth += 1) {
    ancestorKeys.push(cursor.sourceKey);
    cursor = cursor.parentId ? await db.releaseFixSeries.findUnique({ where: { id: cursor.parentId } }) : null;
  }
  const generation = parent ? parent.generation + 1 : 1;
  const next = canStartNextGeneration({ generation, sourceKey, ancestorSourceKeys: ancestorKeys });
  if (!next.ok) return { outcome: "blocked", message: next.reason };

  const draft = buildReleaseFixIssue(
    {
      repositoryFullName,
      releasePrNumber: releasePr.number,
      releaseVersion: releaseVersionOf(releasePr.head.ref),
      baseSha: input.baseSha,
      headSha: input.headSha,
      sourceKind: input.sourceKind,
      causeClass: input.causeClass,
      items: picked.items,
      decisionQuestion: input.decisionQuestion,
      previousIssueNumber: parent?.issueNumber ?? null,
      generation,
      relatedPullRequests: [...new Set(picked.items.flatMap((item) => item.pullRequests))],
      verifyConditions: defaultVerifyConditions(input.sourceKind),
    },
    sourceKey,
  );
  const issue = await createIssue(owner, repo, input.token, {
    title: draft.title,
    body: draft.body,
    labels: input.causeClass === "decision" ? [PLAN_REQUIRED_LABEL] : [],
  });

  try {
    const row = await db.releaseFixSeries.create({
      data: {
        repositoryFullName,
        releasePrNumber: releasePr.number,
        releaseVersion: releaseVersionOf(releasePr.head.ref),
        originBaseSha: input.baseSha,
        originHeadSha: input.headSha,
        sourceKind: input.sourceKind,
        causeClass: input.causeClass,
        sourceKey,
        items: picked.items as unknown as object,
        issueNumber: issue.number,
        status: "issue_created",
        activeKey,
        parentId: parent?.id ?? null,
        generation,
        createdByUserId: input.userId,
      },
    });
    return { outcome: "created", series: toReleaseFixSeriesView(row) };
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    // 同時の起案に負けた。今作ったIssueは閉じ、先に作られた系列を返す
    await updateIssue(owner, repo, issue.number, input.token, { state: "closed", state_reason: "not_planned" }).catch(
      () => undefined,
    );
    const winner = await db.releaseFixSeries.findUnique({ where: { activeKey } });
    if (!winner) throw error;
    return { outcome: "existing", series: toReleaseFixSeriesView(winner) };
  }
}

// ---------------------------------------------------------------------------
// 巡回

async function repositoryToken(repositoryFullName: string): Promise<{ token: string; owner: string; repo: string } | null> {
  const repository = await db.repository.findFirst({
    where: { fullName: repositoryFullName },
    include: { installation: true },
  });
  if (!repository) return null;
  const [owner, repo] = repositoryFullName.split("/");
  return { token: await getInstallationToken(repository.installation.installationId), owner, repo };
}

async function notifyStop(
  ctx: { owner: string; repo: string; token: string },
  rows: ReleaseFixSeries[],
  status: ReleaseFixStatus,
  reason: string,
): Promise<void> {
  for (const row of rows) {
    // 利用者の手が要る止まり方だけ、Issueへ理由を残して札を付ける（Push通知が鳴る）
    const body = `リリース候補 #${row.releasePrNumber} の修正系列が「${RELEASE_FIX_STATUS_LABEL[status]}」になりました。\n\n${reason}\n\n${STOP_COMMENT_MARKER}`;
    await createComment(ctx.owner, ctx.repo, row.issueNumber, ctx.token, { body }).catch(() => undefined);
    if (status !== "superseded") {
      await addIssueLabels(ctx.owner, ctx.repo, row.issueNumber, ctx.token, CHECK_USER_LABELS).catch(() => undefined);
    }
  }
}

async function findOpenFrozenReleasePr(owner: string, repo: string, token: string): Promise<GithubApiPullRequest | null> {
  const open = await fetchOpenPullRequestsForBase(owner, repo, "main", token);
  return open.find((pr) => pr.head.ref.startsWith(FROZEN_PREFIX)) ?? null;
}

type SweepResult = { checked: number; rebuilt: number; changed: number };

async function stopRows(
  ctx: { owner: string; repo: string; token: string },
  ids: string[],
  status: "stopped" | "superseded" | "awaiting_decision",
  reason: string,
): Promise<number> {
  // すでに同じ状態・理由なら何もしない（巡回のたびにコメントを重ねない）
  const rows = await db.releaseFixSeries.findMany({ where: { id: { in: ids } } });
  const fresh = rows.filter((row) => row.status !== status || row.stopReason !== reason);
  if (fresh.length === 0) return 0;
  await db.releaseFixSeries.updateMany({
    where: { id: { in: fresh.map((row) => row.id) } },
    data: { status, stopReason: reason, ...(status === "awaiting_decision" ? {} : { activeKey: null }) },
  });
  await notifyStop(ctx, fresh, status, reason);
  // 操作履歴（#4359）。判断待ち・停止・元候補の取消／置換を系列ごとに残す（同じ状態・理由は`dedupeKey`で1件）
  const kind = status === "awaiting_decision" ? "decision_waiting" : status === "superseded" ? "superseded" : "stopped";
  for (const row of fresh) {
    await recordRebuildEvent({
      repositoryFullName: row.repositoryFullName,
      originPrNumber: row.releasePrNumber,
      originHeadSha: row.originHeadSha,
      kind,
      actor: { kind: "system" },
      trigger: "sweep",
      reason,
      seriesId: row.id,
      payload: {
        fixPrs: row.fixPrNumber !== null ? [row.fixPrNumber] : undefined,
        pendingPrs: status === "awaiting_decision" ? pendingFromReason(reason) : undefined,
      },
      dedupeKey: rebuildEventKey.stop(row.id, kind, reason),
    });
  }
  return fresh.length;
}

/** 判断待ちの理由文から、原因になったPR番号（`#123`）を取り出す */
function pendingFromReason(reason: string): number[] {
  const body = /（((?:#\d+(?:、)?)+)）/.exec(reason)?.[1] ?? "";
  return [...body.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
}

/** 修正PRの状態を観測して系列へ反映する（マージは既存の機構が行う。ここは見るだけ） */
async function observeFixPullRequests(
  ctx: { owner: string; repo: string; token: string },
  rows: ReleaseFixSeries[],
): Promise<{ rows: ReleaseFixSeries[]; closedUnmerged: Set<string> }> {
  const result: ReleaseFixSeries[] = [];
  const closedUnmerged = new Set<string>();
  for (const row of rows) {
    const prs = await fetchPullRequestsByHead(ctx.owner, ctx.repo, `issue-${row.issueNumber}`, "develop", ctx.token);
    const merged = prs.find((pr) => pr.merged_at !== null);
    const open = prs.find((pr) => pr.state === "open");
    const target = merged ?? open ?? prs[0] ?? null;
    if (!target) {
      result.push(row);
      continue;
    }
    if (!merged && !open) closedUnmerged.add(row.id);
    const mergedAt = merged?.merged_at ? new Date(merged.merged_at) : null;
    const nextStatus: ReleaseFixStatus | null =
      row.status === "issue_created" || row.status === "fix_in_progress"
        ? mergedAt
          ? "fix_merged"
          : "fix_in_progress"
        : null;
    const changed = row.fixPrNumber !== target.number || (mergedAt && !row.fixPrMergedAt) || (nextStatus && nextStatus !== row.status);
    if (!changed) {
      result.push({ ...row, fixPrMergedAt: row.fixPrMergedAt ?? mergedAt });
      continue;
    }
    result.push(
      await db.releaseFixSeries.update({
        where: { id: row.id },
        data: {
          fixPrNumber: target.number,
          ...(mergedAt ? { fixPrMergedAt: mergedAt } : {}),
          ...(nextStatus ? { status: nextStatus } : {}),
        },
      }),
    );
  }
  return { rows: result, closedUnmerged };
}

async function sweepGroup(repositoryFullName: string, releasePrNumber: number, rows: ReleaseFixSeries[]): Promise<{ rebuilt: boolean; changed: number }> {
  const access = await repositoryToken(repositoryFullName);
  if (!access) return { rebuilt: false, changed: 0 };
  const ctx = access;
  const { owner, repo, token } = access;

  const { rows: observed, closedUnmerged } = await observeFixPullRequests(ctx, rows);

  const frozen = await findOpenFrozenReleasePr(owner, repo, token);
  const origin = rows[0];
  const originStillOpen = frozen !== null && frozen.number === releasePrNumber && frozen.head.sha === origin.originHeadSha;
  let originMerged = false;
  if (!originStillOpen) {
    const original = (await fetchPullRequest(owner, repo, releasePrNumber, token)) as GithubApiPullRequest & { merged?: boolean };
    originMerged = original.merged === true;
  }
  const candidate = frozen && originStillOpen ? await fetchReleaseRebuildCandidate(owner, repo, frozen.head.sha, token) : null;
  // 選んだ作り直し（#4335）に対応していれば、修正PRだけを元の候補へ足す（無関係な変更で判断待ちにしない）
  const selective = frozen && originStillOpen ? await releaseCallerSupportsSelection(owner, repo, token) : false;

  const decision = decideReleaseFix({
    selective,
    series: observed.map((row) => ({
      id: row.id,
      status: parseReleaseFixStatus(row.status) ?? "stopped",
      issueNumber: row.issueNumber,
      fixPrNumber: row.fixPrNumber,
      fixPrMerged: row.fixPrMergedAt !== null,
      fixPrClosedUnmerged: closedUnmerged.has(row.id),
      acceptedExtraPrs: Array.isArray(row.acceptedExtraPrs) ? (row.acceptedExtraPrs as number[]) : [],
    })),
    candidate: {
      originStillOpen,
      originMerged,
      developPullRequests: candidate?.pullRequests.map((pr) => pr.number) ?? [],
    },
  });
  if (decision.action === "wait") return { rebuilt: false, changed: 0 };
  if (decision.action === "stop") {
    return { rebuilt: false, changed: await stopRows(ctx, decision.seriesIds, decision.status, decision.reason) };
  }

  if (!frozen || !(await releaseWorkflowExists(owner, repo, token))) {
    return { rebuilt: false, changed: await stopRows(ctx, decision.seriesIds, "stopped", "リリースworkflowが見つからないため、候補を自動で作り直せません") };
  }

  // 二重の作り直しを止める。条件付き更新で取れた系列だけが進める（再起動・同時巡回・重複イベントに耐える）
  const claimedAt = new Date();
  const claim = await db.releaseFixSeries.updateMany({
    where: { id: { in: decision.seriesIds }, rebuildClaimedAt: null },
    data: { status: "rebuilding", rebuildClaimedAt: claimedAt, stopReason: null },
  });
  if (claim.count !== decision.seriesIds.length) {
    // 一部だけ取れた＝別の巡回が先に進めている。こちらは何もしない
    return { rebuilt: false, changed: claim.count };
  }

  const issues = observed.map((row) => `#${row.issueNumber}`).join("、");
  // 手動の承認が根拠にあるかで、操作履歴の契機を分ける（「自動で作り直した」だけで説明しない。#4359）
  const hasApproval = observed.some((row) => Array.isArray(row.acceptedExtraPrs) && (row.acceptedExtraPrs as number[]).length > 0);
  const approvalEventId = hasApproval ? await findLatestApprovalEventId(repositoryFullName, releasePrNumber, frozen.head.sha) : null;
  const history = {
    trigger: decideAutoRebuildTrigger({ approvalEventId }),
    seriesIds: decision.seriesIds,
    fixPrs: observed.map((row) => row.fixPrNumber).filter((n): n is number => n !== null),
    approvalEventId,
  };
  if (decision.selectedPrs.length > 0) {
    const result = await requestSelectiveRebuild({
      owner,
      repo,
      token,
      releasePr: frozen,
      selected: decision.selectedPrs.map((number) => ({ number })),
      source: "fix_series",
      userId: null,
      history,
    }).catch((error: unknown) => {
      console.error("[release-fix-series] selective rebuild failed", error);
      return { ok: false as const, error: "dispatch_failed" as const };
    });
    if (!result.ok) {
      const reason =
        result.error === "rebuild_in_progress"
          ? "同じ候補への作り直しが既に起動されています。画面の進捗を確認してください"
          : result.error === "invalid_selection"
            ? `修正PRを元の候補へ足せません（${result.problems.map((p) => `#${p.number}: ${p.label}`).join("、")}）`
            : "選んだ修正PRで候補を作り直せませんでした。画面の「修正を入れて作り直す」から手動で作り直せます";
      return { rebuilt: false, changed: await stopRows(ctx, decision.seriesIds, "stopped", reason) };
    }
    return { rebuilt: true, changed: decision.seriesIds.length };
  }
  let closed = false;
  await recordRebuildEvent({
    repositoryFullName,
    originPrNumber: releasePrNumber,
    originHeadSha: frozen.head.sha,
    kind: "rebuild_started",
    actor: { kind: "system" },
    trigger: history.trigger,
    seriesId: decision.seriesIds[0],
    payload: {
      mode: "full",
      fixPrs: history.fixPrs,
      approvalEventId: approvalEventId ?? undefined,
      selectedPrs: (candidate?.pullRequests ?? []).map((pr) => ({ number: pr.number, mergeSha: pr.mergeSha ?? null, title: pr.title })),
      excludedPrs: [],
    },
    dedupeKey: rebuildEventKey.startFull(repositoryFullName, releasePrNumber, frozen.head.sha, decision.seriesIds),
  });
  try {
    await rebuildReleaseCandidate({
      owner,
      repo,
      token,
      releasePr: frozen,
      candidate,
      extraComment: `修正Issue（${issues}）の修正PRがdevelopへ取り込まれたため、issue-deckの修正系列（#4317）が自動で作り直しました。`,
      onClosed: () => {
        closed = true;
      },
    });
  } catch (error) {
    console.error("[release-fix-series] rebuild failed", error);
    const reason = closed
      ? "元の候補を閉じたあと、リリースworkflowの起動に失敗しました。画面の「リリースする」から起動し直してください"
      : "候補の作り直しに失敗しました。修正は取り込み済みです。画面の「修正を入れて作り直す」から手動で作り直せます";
    return { rebuilt: false, changed: await stopRows(ctx, decision.seriesIds, "stopped", reason) };
  }
  return { rebuilt: true, changed: decision.seriesIds.length };
}

/** 作り直し中・再検証中の系列を進める（後継候補の検出と、新しいSHAでの検証結果の判定） */
async function sweepSuccessor(row: ReleaseFixSeries): Promise<number> {
  const access = await repositoryToken(row.repositoryFullName);
  if (!access) return 0;
  const { owner, repo, token } = access;

  if (row.status === "rebuilding") {
    const frozen = await findOpenFrozenReleasePr(owner, repo, token);
    if (frozen && frozen.number !== row.releasePrNumber && frozen.base) {
      await db.releaseFixSeries.update({
        where: { id: row.id },
        data: {
          status: "reverifying",
          successorPrNumber: frozen.number,
          successorBaseSha: frozen.base.sha,
          successorHeadSha: frozen.head.sha,
        },
      });
      await recordRebuildEvent({
        repositoryFullName: row.repositoryFullName,
        originPrNumber: row.releasePrNumber,
        originHeadSha: row.originHeadSha,
        kind: "successor_created",
        actor: { kind: "system" },
        trigger: "sweep",
        seriesId: row.id,
        payload: { successor: { number: frozen.number, headSha: frozen.head.sha, baseSha: frozen.base.sha } },
        dedupeKey: rebuildEventKey.successor(row.repositoryFullName, row.releasePrNumber, frozen.number),
      });
      return 1;
    }
    if (row.rebuildClaimedAt && Date.now() - row.rebuildClaimedAt.getTime() > REBUILD_TIMEOUT_MS) {
      return stopRows(access, [row.id], "stopped", "作り直しを起動しましたが、後継の候補が作られませんでした。リリースworkflowの実行を確認してください");
    }
    return 0;
  }

  // reverifying
  if (row.successorPrNumber === null) return 0;
  const successor = (await fetchPullRequest(owner, repo, row.successorPrNumber, token)) as GithubApiPullRequest & {
    state?: string;
    merged?: boolean;
  };
  if (successor.state !== "open") {
    return stopRows(
      access,
      [row.id],
      "superseded",
      successor.merged
        ? "後継の候補はすでに本番へマージされました"
        : "後継の候補が取り消された、または別の候補へ置き換えられました。この系列の追跡を終了します",
    );
  }
  if (!successor.base) return 0;
  const current = { baseSha: successor.base.sha, headSha: successor.head.sha };
  // 利用者が候補をさらに作り直した場合は、そのSHAへ追従せず系列を終える（旧SHAの結果を流用しない）
  if (current.headSha !== row.successorHeadSha) {
    return stopRows(access, [row.id], "superseded", "後継の候補が更新されたため、この系列の追跡を終了します。新しい候補は検証をやり直しています");
  }
  const summary = await loadReleaseVerificationSummary(row.repositoryFullName, row.successorPrNumber, current);
  const read = (state: string): "passed" | "failed" | "needs_check" | "pending" | "not_applicable" => {
    if (state === "passed" || state === "failed" || state === "needs_check" || state === "not_applicable") return state;
    return "pending";
  };
  const verdict = decideReverification({ integration: read(summary.integration.state), aiReview: read(summary.aiReview.state) });
  if (verdict === "pending") return 0;
  if (verdict === "ready") {
    await db.releaseFixSeries.update({ where: { id: row.id }, data: { status: "ready", activeKey: null, stopReason: null } });
    return 1;
  }
  return stopRows(
    access,
    [row.id],
    "stopped",
    `後継候補 #${row.successorPrNumber} の再検証で指摘・失敗が残りました（世代 ${row.generation}）。後継候補から修正Issueを起案すると、同じ系列として続きます`,
  );
}

/** 進行中の系列を1回分進める。poller（`scripts/subpc-dispatch-poller.sh`）が定期的に呼ぶ */
export async function runReleaseFixSweep(): Promise<SweepResult> {
  const active = await db.releaseFixSeries.findMany({
    where: { status: { in: ["issue_created", "fix_in_progress", "fix_merged", "awaiting_decision", "rebuilding", "reverifying"] } },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  const result: SweepResult = { checked: active.length, rebuilt: 0, changed: 0 };

  const groups = new Map<string, ReleaseFixSeries[]>();
  const successors: ReleaseFixSeries[] = [];
  for (const row of active) {
    if (row.status === "rebuilding" || row.status === "reverifying") {
      successors.push(row);
      continue;
    }
    const key = `${row.repositoryFullName}#${row.releasePrNumber}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  for (const rows of groups.values()) {
    try {
      const outcome = await sweepGroup(rows[0].repositoryFullName, rows[0].releasePrNumber, rows);
      result.changed += outcome.changed;
      if (outcome.rebuilt) result.rebuilt += 1;
    } catch (error) {
      console.error("[release-fix-series] sweep group failed", rows[0].repositoryFullName, error);
    }
  }
  for (const row of successors) {
    try {
      result.changed += await sweepSuccessor(row);
    } catch (error) {
      console.error("[release-fix-series] sweep successor failed", row.id, error);
    }
  }
  return result;
}

/**
 * 判断待ちの系列に対して、修正と無関係な変更を含めて作り直すことを利用者が確認する。
 * **確認したPR番号だけを記録する**（後から別の変更が入ればまた判断待ちになる）。
 */
export async function acceptReleaseFixExtraPullRequests(seriesId: string, userId: string): Promise<
  { ok: true } | { ok: false; error: "not_found" | "not_awaiting_decision" | "release_pr_changed" }
> {
  const row = await db.releaseFixSeries.findUnique({ where: { id: seriesId } });
  if (!row) return { ok: false, error: "not_found" };
  if (row.status !== "awaiting_decision") return { ok: false, error: "not_awaiting_decision" };
  const access = await repositoryToken(row.repositoryFullName);
  if (!access) return { ok: false, error: "not_found" };
  const frozen = await findOpenFrozenReleasePr(access.owner, access.repo, access.token);
  if (!frozen || frozen.number !== row.releasePrNumber || frozen.head.sha !== row.originHeadSha) {
    return { ok: false, error: "release_pr_changed" };
  }
  const candidate = await fetchReleaseRebuildCandidate(access.owner, access.repo, frozen.head.sha, access.token);
  const siblings = await db.releaseFixSeries.findMany({
    where: { repositoryFullName: row.repositoryFullName, releasePrNumber: row.releasePrNumber, status: "awaiting_decision" },
  });
  // 承認するのは、判断待ちにした時点で画面に示したPR（と修正PR）だけ。**承認の操作までの間に新しくdevelopへ
  // 入ったPRは承認済みにしない**（次の巡回で、あらためて判断待ちになる）。判断待ちの範囲を記録していない
  // 既存の待ちは、承認時点の候補全体を承認範囲として保持し、その旨を理由に残す（#4359）
  const waitingEvent = await db.releaseRebuildEvent.findFirst({
    where: {
      repositoryFullName: row.repositoryFullName,
      originPrNumber: row.releasePrNumber,
      originHeadSha: frozen.head.sha,
      kind: "decision_waiting",
    },
    orderBy: { createdAt: "desc" },
  });
  const waitingPrs = (waitingEvent?.payload as { pendingPrs?: number[] } | null)?.pendingPrs ?? null;
  const fixPrNumbers = new Set(siblings.map((s) => s.fixPrNumber).filter((n): n is number => n !== null));
  const approvedPullRequests =
    waitingPrs && waitingPrs.length > 0
      ? candidate.pullRequests.filter((pr) => waitingPrs.includes(pr.number) || fixPrNumbers.has(pr.number))
      : candidate.pullRequests;
  const accepted = approvedPullRequests.map((pr) => pr.number);
  // 承認の証跡を先に残す。承認した時点の範囲・コミットを保持し、後から入ったPRを承認済みにしない（#4359）
  await recordRebuildEvent({
    repositoryFullName: row.repositoryFullName,
    originPrNumber: row.releasePrNumber,
    originHeadSha: frozen.head.sha,
    kind: "approval",
    actor: { kind: "user", userId },
    trigger: "manual",
    reason: waitingPrs && waitingPrs.length > 0
      ? "判断待ちの追加PRを含めて作り直すことを承認"
      : "判断待ちの範囲の記録が無いため、承認時点の候補全体を承認範囲として保持",
    seriesId: row.id,
    payload: {
      approvedPrs: approvedPullRequests.map((pr) => ({ number: pr.number, mergeSha: pr.mergeSha ?? null, title: pr.title })),
      fixPrs: siblings.map((s) => s.fixPrNumber).filter((n): n is number => n !== null),
    },
    dedupeKey: rebuildEventKey.approval(row.repositoryFullName, row.releasePrNumber, frozen.head.sha, accepted, siblings.map((s) => s.id)),
  });
  // 条件付きで更新する。同時の承認で状態が先に動いていれば、こちらは何も書き換えない
  const updated = await db.releaseFixSeries.updateMany({
    where: { id: { in: siblings.map((s) => s.id) }, status: "awaiting_decision" },
    data: { acceptedExtraPrs: accepted, status: "fix_merged", stopReason: null },
  });
  if (updated.count === 0) return { ok: false, error: "not_awaiting_decision" };
  return { ok: true };
}
