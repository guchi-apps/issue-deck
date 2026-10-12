import type { ReleaseFixSeries } from "@prisma/client";

import { parseClaudeLocalModel, parseCodexLocalModel, resolveAiExecutionAgent } from "@/lib/app-settings";
import { db } from "@/lib/db";
import { removeCheckUserWithReason } from "@/lib/dispatch/check-user-labels";
import { enqueueDispatchJob } from "@/lib/dispatch/jobs";
import { fetchPullRequest } from "@/lib/github/actions-api";
import { getInstallationToken } from "@/lib/github/app-auth";
import {
  addIssueLabels,
  createComment,
  createIssue,
  fetchIssueState,
  fetchIssueStateOrThrow,
  updateIssue,
} from "@/lib/github/issues-api";
import {
  fetchOpenPullRequestsForBase,
  fetchPullRequestForRebuild,
  isAncestorCommit,
  fetchPullRequestsByHead,
  fetchReleaseRebuildCandidate,
  type GithubApiPullRequest,
} from "@/lib/github/release-api";
import { releaseWorkflowExists } from "@/lib/github/release-workflow-cache";
import { isUniqueConstraintError } from "@/lib/prisma-error";
import { decideInternalHold } from "@/lib/release-fix-internal";
import { evaluateInternalGateForSweep, loadInternalViewForUi, type InternalStatusView } from "@/lib/release-fix-internal-run";
import {
  buildReleaseFixIssue,
  buildReleaseFixSourceKey,
  canStartNextGeneration,
  classifyIntegrationFailure,
  decideReleaseFix,
  decideReverification,
  decideReverificationFollowUp,
  defaultVerifyConditions,
  isLegacyReverificationStopReason,
  isRebuildFailureReason,
  NOTHING_TO_ADD_REASON,
  isReleaseFixActive,
  itemFromFinding,
  parseReleaseFixStatus,
  releaseFixActiveKey,
  releaseFixStepIndex,
  reviewFindingKey,
  RELEASE_FIX_STATUS_LABEL,
  REBUILD_FAILURE_REASONS,
  type ReleaseFixCauseClass,
  type ReleaseFixDraftItem,
  type ReleaseFixSourceKind,
  type ReleaseFixStartState,
  type ReleaseFixStatus,
} from "@/lib/release-fix-series";
import { buildDispatchActiveKey } from "@/lib/dispatch/dispatch-job";
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
  /** 修正を反映したリリースの準備に失敗して止まっている（#4398）。修正Issueは作成済みなので作り直さない */
  rebuildFailed: boolean;
  createdAt: string;
  /** 修正Issueの実行の状況（#4396）。一覧の取得時にだけ埋め、それ以外は`none` */
  startState: ReleaseFixStartState;
  /** 内部確認（#4410）の状態。求めない系列・一覧以外ではnull */
  internal: InternalStatusView | null;
  /** 世代を進めた起案が、前の世代と同じ修正Issueへ戻した（追加PRの理由はIssueに記録）か */
  continuedFromParent: boolean;
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
    rebuildFailed: status === "stopped" && isRebuildFailureReason(row.stopReason),
    createdAt: row.createdAt.toISOString(),
    startState: "none",
    internal: null,
    continuedFromParent: false,
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
  const views = rows.map(toReleaseFixSeriesView);
  // 内部確認の状態（#4410）。記録だけを読む（GitHubは呼ばない）。世代を進めた系列は前の世代と同じIssueを使う
  await Promise.all(
    views.map(async (view, index) => {
      const row = rows[index];
      view.internal = await loadInternalViewForUi(row.repositoryFullName, row.issueNumber, row.internalReview, row.internalStopReason);
      view.continuedFromParent = row.parentId !== null && rows.some((other) => other.id === row.parentId && other.issueNumber === row.issueNumber);
    }),
  );
  // 開始前（修正PRがまだ無い）の系列だけ、実行の状況を読む（#4396）
  const pending = views.filter((view) => view.status === "issue_created");
  if (pending.length === 0) return views;
  const states = await Promise.all(pending.map((view) => readReleaseFixStartState(repositoryFullName, view.issueNumber)));
  pending.forEach((view, index) => {
    view.startState = states[index];
  });
  return views;
}

/**
 * 修正Issueの実行の状況（#4396）。受付済みは未完了の配車ジョブ、実行中は`11.local`ラベル
 * （ローカル起動・サブPCの起動で付く。無人実行は修正PRができた時点で`fix_in_progress`へ進む）。
 */
export async function readReleaseFixStartState(
  repositoryFullName: string,
  issueNumber: number,
): Promise<ReleaseFixStartState> {
  const job = await db.dispatchJob.findUnique({
    where: { activeKey: buildDispatchActiveKey(repositoryFullName, issueNumber) },
    select: { id: true },
  });
  if (job) return "queued";
  const labelled = await db.issue.findFirst({
    where: { number: issueNumber, repository: { fullName: repositoryFullName }, labels: { some: { name: "11.local" } } },
    select: { id: true },
  });
  return labelled ? "running" : "none";
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
      internalReview: true,
      continuation: parent !== null,
    },
    sourceKey,
  );
  // 再検証で追加の修正が出たとき（世代を進めるとき）は、新しいIssueを起こさず**同じ修正Issue**へ戻す（#4410）。
  // 元のPRはマージ済みなので足せず、追加PRが不可避になる。その理由と親Issueとの関係を、Issueのコメントに記録する。
  // Issueが閉じている・見つからないときだけ、従来どおり新しいIssueにする
  let reusedIssueNumber: number | null = null;
  if (parent) {
    // 取得に失敗したときは新しいIssueへ逃げず、再試行できる失敗として投げる（#4468）
    const state = await fetchIssueStateOrThrow(owner, repo, parent.issueNumber, input.token);
    if (state === "open") {
      const note =
        `${draft.body}\n\n---\n\n**追加の修正（世代 ${generation}）。** 前の世代の修正PR${parent.fixPrNumber ? `（#${parent.fixPrNumber}）` : ""}はすでにdevelopへマージ済みで、そのPRには追加できないため、` +
        "同じ修正Issue・同じ`issue-" + parent.issueNumber + "`ブランチ・引き継いだ内部確認の記録（指摘ID・往復）のまま、追加のPRを1件作ります。新しい修正Issueは作りません。\n\n" +
        STOP_COMMENT_MARKER;
      // 継続理由のコメントは記録であって前提ではない。失敗しても同じIssueを継続対象にする
      await createComment(owner, repo, parent.issueNumber, input.token, { body: note }).catch(() => undefined);
      reusedIssueNumber = parent.issueNumber;
    }
  }
  const issue = reusedIssueNumber
    ? { number: reusedIssueNumber }
    : await createIssue(owner, repo, input.token, {
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
        internalReview: true,
      },
    });
    return { outcome: "created", series: toReleaseFixSeriesView(row) };
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    // 同時の起案に負けた。今作ったIssueは閉じ、先に作られた系列を返す
    if (reusedIssueNumber === null) {
      await updateIssue(owner, repo, issue.number, input.token, { state: "closed", state_reason: "not_planned" }).catch(
        () => undefined,
      );
    }
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
): Promise<{ rows: ReleaseFixSeries[]; closedUnmerged: Set<string>; prHeadShas: Map<string, string> }> {
  const result: ReleaseFixSeries[] = [];
  const closedUnmerged = new Set<string>();
  const prHeadShas = new Map<string, string>();
  for (const row of rows) {
    // 同じ修正Issueの前の世代が使ったPR（マージ済み）は、この世代の修正PRとして拾わない（#4410）
    const used = new Set(
      (await db.releaseFixSeries.findMany({ where: { repositoryFullName: row.repositoryFullName, issueNumber: row.issueNumber, id: { not: row.id } }, select: { fixPrNumber: true } }))
        .map((other) => other.fixPrNumber)
        .filter((n): n is number => n !== null),
    );
    const prs = (await fetchPullRequestsByHead(ctx.owner, ctx.repo, `issue-${row.issueNumber}`, "develop", ctx.token)).filter((pr) => !used.has(pr.number));
    const merged = prs.find((pr) => pr.merged_at !== null);
    const open = prs.find((pr) => pr.state === "open");
    const target = merged ?? open ?? prs[0] ?? null;
    if (!target) {
      result.push(row);
      continue;
    }
    if (!merged && !open) closedUnmerged.add(row.id);
    prHeadShas.set(row.id, target.head.sha);
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
  return { rows: result, closedUnmerged, prHeadShas };
}

async function sweepGroup(repositoryFullName: string, releasePrNumber: number, rows: ReleaseFixSeries[]): Promise<{ rebuilt: boolean; changed: number }> {
  const access = await repositoryToken(repositoryFullName);
  if (!access) return { rebuilt: false, changed: 0 };
  const ctx = access;
  const { owner, repo, token } = access;

  const { rows: observed, closedUnmerged, prHeadShas } = await observeFixPullRequests(ctx, rows);
  // 内部確認（#4410）。PRのhead SHAを確認した内容と照合し、未完了・不一致の修正は取り込まない
  const internalHolds = new Map<string, string>();
  for (const row of observed) {
    if (!row.internalReview || row.fixPrNumber === null) continue;
    const gate = await evaluateInternalGateForSweep(row, prHeadShas.get(row.id) ?? null);
    const hold = decideInternalHold({ required: true, gate });
    if (hold.hold) internalHolds.set(row.id, hold.reason);
  }

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
  // 修正PRが候補の一覧に無くても、実際にdevelopへマージ済みで元の候補の祖先でなければ「足せるPR」として扱う（#4422）。
  // 手動の選択画面と同じ照合。取得に失敗したら断定せず次の巡回へ回す
  const developPullRequests = candidate?.pullRequests.map((pr) => pr.number) ?? [];
  if (candidate && frozen) {
    try {
      for (const row of observed) {
        const n = row.fixPrNumber;
        if (n === null || row.fixPrMergedAt === null || developPullRequests.includes(n)) continue;
        const pr = await fetchPullRequestForRebuild(owner, repo, n, token);
        if (!pr?.merged_at || !pr.merge_commit_sha || pr.base.ref !== "develop") continue;
        if (!(await isAncestorCommit(owner, repo, pr.merge_commit_sha, frozen.head.sha, token))) developPullRequests.push(n);
      }
    } catch (error) {
      console.error("[release-fix-series] fix PR lookup failed", releasePrNumber, error);
      return { rebuilt: false, changed: 0 };
    }
  }

  const decision = decideReleaseFix({
    selective,
    series: observed.map((row) => ({
      id: row.id,
      status: row.status === "stopped" && row.stopReason === NOTHING_TO_ADD_REASON ? "fix_merged" : parseReleaseFixStatus(row.status) ?? "stopped",
      issueNumber: row.issueNumber,
      fixPrNumber: row.fixPrNumber,
      fixPrMerged: row.fixPrMergedAt !== null,
      fixPrClosedUnmerged: closedUnmerged.has(row.id),
      acceptedExtraPrs: Array.isArray(row.acceptedExtraPrs) ? (row.acceptedExtraPrs as number[]) : [],
      internalHold: internalHolds.get(row.id) ?? null,
    })),
    candidate: {
      originStillOpen,
      originMerged,
      developPullRequests,
      complete: candidate?.complete !== false,
    },
  });
  if (decision.action === "wait") return { rebuilt: false, changed: 0 };
  if (decision.action === "stop") {
    // 再評価でも同じ理由なら、停止の記録を重ねない
    if (decision.reason === NOTHING_TO_ADD_REASON && decision.seriesIds.every((id) => observed.find((r) => r.id === id)?.status === "stopped")) {
      return { rebuilt: false, changed: 0 };
    }
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
            : REBUILD_FAILURE_REASONS.selective;
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
      ? REBUILD_FAILURE_REASONS.closedThenDispatchFailed
      : REBUILD_FAILURE_REASONS.full;
    return { rebuilt: false, changed: await stopRows(ctx, decision.seriesIds, "stopped", reason) };
  }
  return { rebuilt: true, changed: decision.seriesIds.length };
}

/** 作り直し中・再検証中の系列を進める（後継候補の検出と、新しいSHAでの検証結果の判定） */
async function sweepSuccessor(row: ReleaseFixSeries, hostName: string | null): Promise<number> {
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

  // reverifying（と、旧い巡回が再検証失敗で止めた`stopped`。#4478）
  if (row.successorPrNumber === null) return 0;
  // すでに同じ修正Issueの次世代が起案されているなら、旧世代は後継追跡へ移すだけ（二重起案・二重起動しない）
  const child = await db.releaseFixSeries.findFirst({ where: { parentId: row.id }, orderBy: { createdAt: "desc" } });
  if (child) return supersedeByContinuation(access, row, child);
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
    // 旧い巡回が止めていた系列が通った場合、その停止で付けた確認待ちを解く
    if (row.status === "stopped") await resolveStopLabels(access, row.issueNumber);
    return 1;
  }
  return continueAfterReverification(access, row, successor, summary, current, hostName);
}

type SweepContext = { owner: string; repo: string; token: string };

/**
 * 本系列が停止時に付けた`00.check-user`＋`01.check-blocked`を解く。
 * 外してよい理由かどうかは既存のガード（`removeCheckUserWithReason`）が見るので、
 * マージ待ち・計画承認待ちなど他理由の札は消さない。失敗しても継続は止めない。
 */
async function resolveStopLabels(ctx: SweepContext, issueNumber: number): Promise<void> {
  await removeCheckUserWithReason(ctx.owner, ctx.repo, issueNumber, ctx.token).catch((error: unknown) => {
    console.error("[release-fix-series] stop label cleanup failed", issueNumber, error);
  });
}

/** 旧世代を、次世代（同じ論理作業）へ引き継いだものとして畳む。冪等 */
async function supersedeByContinuation(ctx: SweepContext, row: ReleaseFixSeries, child: ReleaseFixSeries): Promise<number> {
  const sameIssue = child.issueNumber === row.issueNumber;
  const reason = sameIssue
    ? `同じ修正Issue #${child.issueNumber} の世代 ${child.generation} へ引き継ぎました（再検証の追加指摘）`
    : `修正Issue #${child.issueNumber} の世代 ${child.generation} へ引き継ぎました（再検証の追加指摘）`;
  const moved = await db.releaseFixSeries.updateMany({
    where: { id: row.id, status: { in: ["reverifying", "stopped", "awaiting_decision"] } },
    data: { status: "superseded", activeKey: null, stopReason: reason },
  });
  if (moved.count === 0) return 0;
  // 旧Issueに確認待ちが残らないようにする。別Issueへ移った場合は、現在の担当を旧Issueへ残す
  if (row.status === "stopped" || row.status === "awaiting_decision") await resolveStopLabels(ctx, row.issueNumber);
  if (!sameIssue) {
    await createComment(ctx.owner, ctx.repo, row.issueNumber, ctx.token, {
      body: `この修正は後継のIssue #${child.issueNumber}（世代 ${child.generation}）へ引き継がれました。このIssueでの対応は不要です。\n\n${STOP_COMMENT_MARKER}`,
    }).catch(() => undefined);
  }
  return 1;
}

/**
 * 再検証で修正が要ると判定されたあとの扱い（#4478）。失敗というだけで本人確認にせず、
 * 通常の追加指摘は同じ修正Issueの次世代へ戻す。実行障害は起案せず待ち、本人判断・上限は理由つきで止める。
 */
async function continueAfterReverification(
  ctx: SweepContext,
  row: ReleaseFixSeries,
  successor: GithubApiPullRequest,
  summary: Awaited<ReturnType<typeof loadReleaseVerificationSummary>>,
  current: { baseSha: string; headSha: string },
  hostName: string | null,
): Promise<number> {
  const followUp = decideReverificationFollowUp({
    integration: { state: summary.integration.state, reason: summary.integration.reason, summary: summary.integration.summary, findingCount: summary.integration.findings.length },
    aiReview: { state: summary.aiReview.state, reason: summary.aiReview.reason, summary: summary.aiReview.summary, findingCount: summary.aiReview.findings.length },
  });
  // 実行障害はコードの不具合と断定せず、Issue・PRを作らない。確認待ちにもしない（再実行は既存の機構が行う）
  if (followUp.action === "wait_rerun") return 0;
  if (followUp.action === "human") return stopRows(ctx, [row.id], "stopped", followUp.reason);

  const section = followUp.sourceKind === "review_finding" ? summary.aiReview : summary.integration;
  const result = await createReleaseFixSeries({
    userId: row.createdByUserId,
    owner: ctx.owner,
    repo: ctx.repo,
    token: ctx.token,
    releasePr: successor,
    sourceKind: followUp.sourceKind,
    findingIndexes: section.findings.map((_, index) => index),
    causeClass: "code",
    decisionQuestion: null,
    acknowledgeExecutionFailure: false,
    section,
    baseSha: current.baseSha,
    headSha: current.headSha,
  });
  if (result.outcome === "blocked") {
    return stopRows(ctx, [row.id], "stopped", `${result.message}。リリース画面の修正系列から、原因を整理したうえで手動で修正Issueを起案できます`);
  }
  if (result.outcome === "execution_failure") return 0;
  if (result.outcome === "no_items") {
    return stopRows(ctx, [row.id], "stopped", "再検証の指摘から起案する項目を読み取れませんでした。リリース画面で結果を確認し、必要なら手動で修正Issueを起案してください");
  }
  const child = await db.releaseFixSeries.findUnique({ where: { id: result.series.id } });
  if (!child) return 0;
  const changed = await supersedeByContinuation(ctx, row, child);
  await startContinuation(ctx, child, hostName);
  return changed || 1;
}

/**
 * 次世代の修正Issueの実装を、このホストで起動する（#4478）。二重起動しない:
 * 受付済み・実行中、またはこの世代の作成後にすでに起動ジョブを積んだものは何もしない。
 * 一時的な拒否（一時停止・ホストの不在）は積まずに次の巡回で再試行する。
 */
async function startContinuation(ctx: SweepContext, series: ReleaseFixSeries, hostName: string | null): Promise<void> {
  if (!hostName || series.status !== "issue_created") return;
  const repositoryFullName = series.repositoryFullName;
  if ((await readReleaseFixStartState(repositoryFullName, series.issueNumber)) !== "none") return;
  const prior = await db.dispatchJob.count({
    where: { repositoryFullName, issueNumber: series.issueNumber, createdAt: { gte: series.createdAt } },
  });
  if (prior > 0) return;
  const issueState = await fetchIssueState(ctx.owner, ctx.repo, series.issueNumber, ctx.token).catch(() => null);
  if (issueState !== "open") return;
  const setting = await db.appSetting.findUnique({
    where: { id: 1 },
    select: { defaultDispatchAgent: true, aiExecutionProvider: true, claudeLocalModel: true, codexModel: true },
  });
  const enqueued = await enqueueDispatchJob({
    repositoryFullName,
    issueNumber: series.issueNumber,
    hostName,
    agent: resolveAiExecutionAgent(setting?.defaultDispatchAgent, setting?.aiExecutionProvider),
    claudeModel: parseClaudeLocalModel(setting?.claudeLocalModel),
    codexModel: parseCodexLocalModel(setting?.codexModel),
    requestedByUserId: series.createdByUserId,
  });
  if (enqueued.ok) return;
  // 受付済み・動いているセッションがある、または一時的な拒否は、次の巡回で見直す。それ以外は人へ渡す
  if (["already_queued", "session_alive", "agent_paused", "host_offline"].includes(enqueued.rejection)) return;
  const reason = `修正Issueの実装を自動で起動できませんでした（${enqueued.message}）。Issue詳細の「修正を開始」から起動してください`;
  if (series.stopReason === reason) return;
  await db.releaseFixSeries.update({ where: { id: series.id }, data: { stopReason: reason } });
  await notifyStop(ctx, [series], "stopped", reason);
}

/** 進行中の系列を1回分進める。poller（`scripts/subpc-dispatch-poller.sh`）が定期的に呼ぶ */
export async function runReleaseFixSweep(options: { hostName?: string | null } = {}): Promise<SweepResult> {
  const hostName = options.hostName ?? null;
  const active = await db.releaseFixSeries.findMany({
    where: {
      OR: [
        { status: { in: ["issue_created", "fix_in_progress", "fix_merged", "awaiting_decision", "rebuilding", "reverifying"] } },
        // 候補の取りこぼしで「足すものがない」と止まった系列は、修正後に同じ元候補で再評価する（#4422）
        { status: "stopped", stopReason: NOTHING_TO_ADD_REASON },
        // 旧い巡回が再検証の失敗で一律に止めた系列は、再評価して同じ修正Issueの次世代へ戻す（#4478）
        { status: "stopped", successorPrNumber: { not: null }, stopReason: { contains: "の再検証で指摘・失敗が残りました（世代" } },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  const result: SweepResult = { checked: active.length, rebuilt: 0, changed: 0 };

  const groups = new Map<string, ReleaseFixSeries[]>();
  const successors: ReleaseFixSeries[] = [];
  for (const row of active) {
    if (row.status === "rebuilding" || row.status === "reverifying" || (row.status === "stopped" && isLegacyReverificationStopReason(row.stopReason))) {
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
      result.changed += await sweepSuccessor(row, hostName);
    } catch (error) {
      console.error("[release-fix-series] sweep successor failed", row.id, error);
    }
  }
  // 次世代の起動が一時的な理由で見送られていたものを、次の巡回で起動し直す（#4478）
  if (hostName) {
    for (const row of active) {
      if (row.status !== "issue_created" || row.parentId === null || !row.internalReview) continue;
      try {
        const access = await repositoryToken(row.repositoryFullName);
        if (access) await startContinuation(access, row, hostName);
      } catch (error) {
        console.error("[release-fix-series] continuation start failed", row.id, error);
      }
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
