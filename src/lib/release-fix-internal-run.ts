import type { ReleaseFixFinding, ReleaseFixInternalRound, ReleaseFixSeries } from "@prisma/client";

import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchBranchHeadSha } from "@/lib/github/branches-api";
import { addIssueLabels, createComment } from "@/lib/github/issues-api";
import {
  decideInternalStop,
  evaluateInternalGate,
  INTERNAL_MAX_MINUTES,
  INTERNAL_MAX_ROUNDS,
  internalStopReasonMessage,
  nextFindingKey,
  validateReviewReport,
  type InternalFindingRecord,
  type InternalGate,
  type InternalRoundRecord,
  type InternalStopReason,
  type InternalTestState,
  type ReviewReport,
} from "@/lib/release-fix-internal";
import { isReleaseFixActive } from "@/lib/release-fix-series";

/**
 * リリース修正の内部確認（#4410）の保存と外部操作。判断は`release-fix-internal.ts`の純関数が持つ。
 *
 * **確認の対象は、クライアントの申告ではなくサーバーがGitHubの`issue-<番号>`ブランチから取り直したHEAD SHA。**
 * 報告は進行中の内部確認つき`ReleaseFixSeries`に結び付くものだけを受け、別の系列・終わった系列には書かせない。
 * 論理セッションは「リポジトリ＋修正Issue番号」で、再検証の失敗で世代が進んでも記録（指摘・往復）を引き継ぐ。
 */

const CHECK_USER_LABELS = ["00.check-user", "01.check-blocked"];
const STOP_COMMENT_MARKER = "<!-- issue-deck-release-fix-internal -->";

export type InternalReportError =
  | { ok: false; error: "series_not_found"; message: string }
  | { ok: false; error: "repository_not_found"; message: string }
  | { ok: false; error: "branch_not_found"; message: string }
  | { ok: false; error: "invalid_report"; message: string }
  | { ok: false; error: "stopped"; message: string };

export type InternalFindingView = { key: string; title: string; detail: string | null; status: "open" | "resolved"; reopenCount: number; resolution: string | null };
export type InternalRoundView = {
  round: number;
  reviewVerdict: "pass" | "findings" | null;
  reviewTargetSha: string | null;
  testState: InternalTestState | null;
  testTargetSha: string | null;
  openFindingCount: number;
};

export type InternalStatusView = {
  /** 内部確認を求める系列か。旧い系列は求めない */
  required: boolean;
  gate: Pick<InternalGate, "complete" | "blocker" | "message" | "targetSha">;
  rounds: InternalRoundView[];
  findings: InternalFindingView[];
  limits: { round: number; maxRounds: number; elapsedMinutes: number; maxMinutes: number };
  stopReason: string | null;
};

type Access = { owner: string; repo: string; token: string };

async function repositoryAccess(repositoryFullName: string): Promise<Access | null> {
  const repository = await db.repository.findFirst({ where: { fullName: repositoryFullName }, include: { installation: true } });
  if (!repository) return null;
  const [owner, repo] = repositoryFullName.split("/");
  return { owner, repo, token: await getInstallationToken(repository.installation.installationId) };
}

const toRoundRecord = (row: ReleaseFixInternalRound): InternalRoundRecord => ({
  round: row.round,
  reviewVerdict: row.reviewVerdict === "pass" || row.reviewVerdict === "findings" ? row.reviewVerdict : null,
  reviewTargetSha: row.reviewTargetSha,
  testState: row.testState === "passed" || row.testState === "failed" ? row.testState : null,
  testTargetSha: row.testTargetSha,
  openFindingCount: row.openFindingCount,
});

const toFindingRecord = (row: ReleaseFixFinding): InternalFindingRecord => ({
  key: row.key,
  title: row.title,
  status: row.status === "resolved" ? "resolved" : "open",
  reopenCount: row.reopenCount,
});

/** 内部確認を求める、進行中の系列（同じ修正Issueの最新の世代） */
async function findActiveSeries(repositoryFullName: string, issueNumber: number): Promise<ReleaseFixSeries | null> {
  const rows = await db.releaseFixSeries.findMany({
    where: { repositoryFullName, issueNumber, internalReview: true },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  return rows.find((row) => isReleaseFixActive(row.status)) ?? null;
}

/** 内部確認の開始時刻。世代をまたぐので、同じIssueの最初の系列の作成時刻 */
async function internalStartedAt(repositoryFullName: string, issueNumber: number): Promise<Date> {
  const first = await db.releaseFixSeries.findFirst({ where: { repositoryFullName, issueNumber }, orderBy: { createdAt: "asc" }, select: { createdAt: true } });
  return first?.createdAt ?? new Date();
}

async function loadRecords(repositoryFullName: string, issueNumber: number) {
  const [rounds, findings] = await Promise.all([
    db.releaseFixInternalRound.findMany({ where: { repositoryFullName, issueNumber }, orderBy: { round: "asc" } }),
    db.releaseFixFinding.findMany({ where: { repositoryFullName, issueNumber }, orderBy: { key: "asc" } }),
  ]);
  return { rounds, findings };
}

function buildStatus(input: {
  series: Pick<ReleaseFixSeries, "internalReview" | "internalStopReason">;
  rounds: ReleaseFixInternalRound[];
  findings: ReleaseFixFinding[];
  currentSha: string | null;
  startedAt: Date;
  now: Date;
}): InternalStatusView {
  const gate = evaluateInternalGate({
    rounds: input.rounds.map(toRoundRecord),
    findings: input.findings.map(toFindingRecord),
    currentSha: input.currentSha,
    stopped: input.series.internalStopReason !== null,
  });
  return {
    required: input.series.internalReview,
    gate: { complete: gate.complete, blocker: gate.blocker, message: gate.message, targetSha: gate.targetSha },
    rounds: input.rounds.map((r) => ({ ...toRoundRecord(r) })),
    findings: input.findings.map((f) => ({
      key: f.key,
      title: f.title,
      detail: f.detail,
      status: f.status === "resolved" ? "resolved" : "open",
      reopenCount: f.reopenCount,
      resolution: f.resolution,
    })),
    limits: {
      round: input.rounds.filter((r) => r.reviewVerdict !== null).length,
      maxRounds: INTERNAL_MAX_ROUNDS,
      elapsedMinutes: Math.max(0, Math.floor((input.now.getTime() - input.startedAt.getTime()) / 60_000)),
      maxMinutes: INTERNAL_MAX_MINUTES,
    },
    stopReason: input.series.internalStopReason,
  };
}

/** 現在の状態（ゲートの判定つき）。`currentSha`はブランチのHEAD（サーバーが取り直した値） */
export async function readInternalStatus(
  repositoryFullName: string,
  issueNumber: number,
): Promise<{ ok: true; status: InternalStatusView } | InternalReportError> {
  const series = await findActiveSeries(repositoryFullName, issueNumber);
  if (!series) return { ok: false, error: "series_not_found", message: "この修正Issueに結び付いた、進行中の内部確認つきの修正系列がありません" };
  const access = await repositoryAccess(repositoryFullName);
  if (!access) return { ok: false, error: "repository_not_found", message: "リポジトリが見つかりません" };
  const currentSha = await fetchBranchHeadSha(access.owner, access.repo, `issue-${issueNumber}`, access.token);
  const { rounds, findings } = await loadRecords(repositoryFullName, issueNumber);
  const startedAt = await internalStartedAt(repositoryFullName, issueNumber);
  return { ok: true, status: buildStatus({ series, rounds, findings, currentSha, startedAt, now: new Date() }) };
}

async function stopIfNeeded(series: ReleaseFixSeries, access: Access, status: InternalStatusView): Promise<InternalStatusView> {
  if (series.internalStopReason !== null) return status;
  const { rounds, findings } = await loadRecords(series.repositoryFullName, series.issueNumber);
  const startedAt = await internalStartedAt(series.repositoryFullName, series.issueNumber);
  const decision = decideInternalStop({ rounds: rounds.map(toRoundRecord), findings: findings.map(toFindingRecord), startedAt, now: new Date() });
  if (!decision.stop) return status;
  await stopInternal(series, access, decision.reason, decision.detail);
  return { ...status, stopReason: internalStopReasonMessage(decision.reason, decision.detail), gate: { ...status.gate, complete: false, blocker: "stopped", message: "内部確認が上限に達したため止まっています" } };
}

/** 上限・再発・進捗なしで止める。**Issueへ理由と必要な判断を残し、`00.check-user`を付ける**（一度だけ） */
async function stopInternal(series: ReleaseFixSeries, access: Access, reason: InternalStopReason, detail?: string): Promise<void> {
  const message = internalStopReasonMessage(reason, detail);
  const claimed = await db.releaseFixSeries.updateMany({ where: { id: series.id, internalStopReason: null }, data: { internalStopReason: message } });
  if (claimed.count === 0) return;
  const body = `リリース修正の内部確認が止まりました（#4410）。\n\n${message}\n\n必要な判断: 残っている指摘を確かめ、方針を決めてこのIssueへ書いてください。続ける場合は、修正系列を起案し直して新しい世代として進めます。\n\n${STOP_COMMENT_MARKER}`;
  await createComment(access.owner, access.repo, series.issueNumber, access.token, { body }).catch(() => undefined);
  await addIssueLabels(access.owner, access.repo, series.issueNumber, access.token, CHECK_USER_LABELS).catch(() => undefined);
}

type Prepared = { error: InternalReportError } | { series: ReleaseFixSeries; access: Access; sha: string };

async function prepare(repositoryFullName: string, issueNumber: number): Promise<Prepared> {
  const series = await findActiveSeries(repositoryFullName, issueNumber);
  if (!series) return { error: { ok: false, error: "series_not_found", message: "この修正Issueに結び付いた、進行中の内部確認つきの修正系列がありません" } };
  const access = await repositoryAccess(repositoryFullName);
  if (!access) return { error: { ok: false, error: "repository_not_found", message: "リポジトリが見つかりません" } };
  const sha = await fetchBranchHeadSha(access.owner, access.repo, `issue-${issueNumber}`, access.token);
  if (!sha) return { error: { ok: false, error: "branch_not_found", message: `ブランチ issue-${issueNumber} が見つかりません。確認する内容をpushしてから報告してください` } };
  return { series, access, sha };
}

/** 独立レビューの結果を記録する。往復を1つ進め、指摘を採番・解消・再発として更新する */
export async function recordInternalReview(input: {
  repositoryFullName: string;
  issueNumber: number;
  report: ReviewReport;
  summary: string | null;
}): Promise<{ ok: true; round: number; status: InternalStatusView } | InternalReportError> {
  const prepared = await prepare(input.repositoryFullName, input.issueNumber);
  if ("error" in prepared) return prepared.error;
  const { series, access, sha } = prepared;
  if (series.internalStopReason !== null) return { ok: false, error: "stopped", message: series.internalStopReason };

  const { rounds, findings } = await loadRecords(input.repositoryFullName, input.issueNumber);
  const invalid = validateReviewReport(input.report, findings.map(toFindingRecord));
  if (invalid) return { ok: false, error: "invalid_report", message: invalid };

  // テストだけが先に記録された往復（レビュー未実施）はそこへ書き、それ以外は次の往復を作る
  const latest = rounds[rounds.length - 1];
  const reuse = latest && latest.reviewVerdict === null ? latest : null;
  const roundNo = reuse ? reuse.round : (latest?.round ?? 0) + 1;

  const keys = findings.map((f) => f.key);
  const byKey = new Map(findings.map((f) => [f.key, f]));
  for (const key of input.report.stillOpen) {
    const f = byKey.get(key)!;
    // 解消されないまま再び指摘された＝再発。開いたままの再指摘も「解消されなかった」として数える
    await db.releaseFixFinding.update({ where: { id: f.id }, data: { status: "open", resolution: null, lastRound: roundNo, reopenCount: { increment: 1 } } });
  }
  for (const r of input.report.resolved) {
    const f = byKey.get(r.key)!;
    await db.releaseFixFinding.update({ where: { id: f.id }, data: { status: "resolved", resolution: r.resolution.slice(0, 4000), lastRound: roundNo } });
  }
  for (const item of input.report.newFindings) {
    const key = nextFindingKey(keys);
    keys.push(key);
    await db.releaseFixFinding.create({
      data: {
        repositoryFullName: input.repositoryFullName,
        issueNumber: input.issueNumber,
        key,
        title: item.title.trim().slice(0, 255),
        detail: item.detail ? item.detail.slice(0, 4000) : null,
        status: "open",
        firstRound: roundNo,
        lastRound: roundNo,
      },
    });
  }
  const after = await db.releaseFixFinding.findMany({ where: { repositoryFullName: input.repositoryFullName, issueNumber: input.issueNumber } });
  const openCount = after.filter((f) => f.status === "open").length;
  const data = {
    reviewVerdict: input.report.verdict,
    reviewTargetSha: sha,
    reviewSummary: input.summary ? input.summary.slice(0, 8000) : null,
    reviewedAt: new Date(),
    openFindingCount: openCount,
  };
  if (reuse) {
    await db.releaseFixInternalRound.update({ where: { id: reuse.id }, data });
  } else {
    await db.releaseFixInternalRound.create({ data: { repositoryFullName: input.repositoryFullName, issueNumber: input.issueNumber, round: roundNo, ...data } });
  }
  const status = await currentStatus(series, sha);
  return { ok: true, round: roundNo, status: await stopIfNeeded(series, access, status) };
}

/** テスト結果を記録する。最新の往復へ書き、対象SHAを添える（対象が変わったあとの合格は流用されない） */
export async function recordInternalTest(input: {
  repositoryFullName: string;
  issueNumber: number;
  state: InternalTestState;
  summary: string | null;
}): Promise<{ ok: true; round: number; status: InternalStatusView } | InternalReportError> {
  const prepared = await prepare(input.repositoryFullName, input.issueNumber);
  if ("error" in prepared) return prepared.error;
  const { series, sha } = prepared;
  if (series.internalStopReason !== null) return { ok: false, error: "stopped", message: series.internalStopReason };

  const { rounds } = await loadRecords(input.repositoryFullName, input.issueNumber);
  const latest = rounds[rounds.length - 1];
  const data = { testState: input.state, testTargetSha: sha, testSummary: input.summary ? input.summary.slice(0, 8000) : null, testedAt: new Date() };
  let roundNo: number;
  if (latest) {
    roundNo = latest.round;
    await db.releaseFixInternalRound.update({ where: { id: latest.id }, data });
  } else {
    roundNo = 1;
    await db.releaseFixInternalRound.create({ data: { repositoryFullName: input.repositoryFullName, issueNumber: input.issueNumber, round: 1, ...data } });
  }
  return { ok: true, round: roundNo, status: await currentStatus(series, sha) };
}

async function currentStatus(series: ReleaseFixSeries, currentSha: string | null): Promise<InternalStatusView> {
  const { rounds, findings } = await loadRecords(series.repositoryFullName, series.issueNumber);
  const startedAt = await internalStartedAt(series.repositoryFullName, series.issueNumber);
  return buildStatus({ series, rounds, findings, currentSha, startedAt, now: new Date() });
}

/**
 * 巡回が使う、修正PRのhead SHAに対するゲート判定。**PRのhead SHAを確認対象と照合する**ので、
 * 内部確認の後にpushされた内容・確認していない内容のPRは完了にならない（マージ後にブランチが消えても照合できる）。
 */
export async function evaluateInternalGateForSweep(
  series: Pick<ReleaseFixSeries, "repositoryFullName" | "issueNumber" | "internalStopReason">,
  prHeadSha: string | null,
): Promise<InternalGate> {
  const { rounds, findings } = await loadRecords(series.repositoryFullName, series.issueNumber);
  return evaluateInternalGate({
    rounds: rounds.map(toRoundRecord),
    findings: findings.map(toFindingRecord),
    currentSha: prHeadSha,
    stopped: series.internalStopReason !== null,
  });
}

/** 画面用。取得に必要なのは記録だけ（GitHubを呼ばない）。ゲートは最新の往復が示す確認対象で評価する */
export async function loadInternalViewForUi(repositoryFullName: string, issueNumber: number, internalReview: boolean, stopReason: string | null): Promise<InternalStatusView | null> {
  if (!internalReview) return null;
  const { rounds, findings } = await loadRecords(repositoryFullName, issueNumber);
  const startedAt = await internalStartedAt(repositoryFullName, issueNumber);
  const latest = rounds[rounds.length - 1];
  return buildStatus({
    series: { internalReview, internalStopReason: stopReason },
    rounds,
    findings,
    currentSha: latest?.testTargetSha ?? latest?.reviewTargetSha ?? null,
    startedAt,
    now: new Date(),
  });
}
