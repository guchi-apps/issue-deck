import type { ReleaseFixFinding, ReleaseFixInternalRound, ReleaseFixInternalSession, ReleaseFixSeries } from "@prisma/client";

import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchBranchHeadSha } from "@/lib/github/branches-api";
import { addIssueLabels, createComment, removeIssueLabel } from "@/lib/github/issues-api";
import {
  accrueActiveSeconds,
  appendAttempt,
  classifyLegacyStopReason,
  decideInternalResume,
  decideInternalStop,
  evaluateInternalGate,
  INTERNAL_DEFAULT_BUDGET_MINUTES,
  INTERNAL_LEASE_MINUTES,
  internalNextAction,
  internalResumeNeed,
  internalStopReasonMessage,
  isInternalStopReason,
  nextFindingKey,
  validateReviewReport,
  type InternalAttempt,
  type InternalFindingRecord,
  type InternalGate,
  type InternalResumeNeed,
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
 * 論理セッションは「リポジトリ＋修正Issue番号」で、再検証の失敗で世代が進んでも記録（指摘・往復・稼働時間・予算）を引き継ぐ。
 *
 * #4587: 固定の往復数・系列作成からの時間では止めず、**稼働時間（待機・中断を除く）の予算と進捗の根拠**で一時停止する。
 * 一時停止は作業を失わず、同じ記録から別の担当が再開できる。**状態の取得（`readInternalStatus`・`loadInternalViewForUi`）は
 * 読み取り専用**で、停止・再開・担当の変更・Issueコメント・ラベルの操作は書き込みの経路（報告・`pause`・`resume`・`claim`・`release`）だけが持つ。
 */

const CHECK_USER_LABELS = ["00.check-user", "01.check-blocked"];
const STOP_COMMENT_MARKER = "<!-- issue-deck-release-fix-internal -->";
const RESUME_COMMENT_MARKER = "<!-- issue-deck-release-fix-internal-resume -->";

export type InternalReportError =
  | { ok: false; error: "series_not_found"; message: string }
  | { ok: false; error: "repository_not_found"; message: string }
  | { ok: false; error: "branch_not_found"; message: string }
  | { ok: false; error: "invalid_report"; message: string }
  | { ok: false; error: "paused"; message: string }
  /** 担当が変わった・解放された後の遅延報告、担当していない報告 */
  | { ok: false; error: "stale_assignee"; message: string }
  /** 別の担当が持ち時間の内にいる */
  | { ok: false; error: "lease_held"; message: string }
  /** 再開に必要な入力が足りない */
  | { ok: false; error: "input_required"; message: string }
  /** 一時停止していない（二重の再開を含む） */
  | { ok: false; error: "not_paused"; message: string }
  /** 完了・置換・本番反映済みなど、再開してはいけない対象 */
  | { ok: false; error: "not_resumable"; message: string }
  /** 報告が検証したと申告するSHAが、いまのブランチのHEADと違う（旧SHAの結果を最新HEADへ付け替えない。#4588） */
  | { ok: false; error: "stale_sha"; message: string; currentSha: string }
  /** 実装担当と同じ主体のレビューは、独立レビューとして数えない（#4588） */
  | { ok: false; error: "self_review_not_independent"; message: string };

export type InternalFindingView = {
  key: string;
  title: string;
  detail: string | null;
  status: "open" | "resolved";
  reopenCount: number;
  regressionCount: number;
  resolution: string | null;
};
export type InternalRoundView = {
  round: number;
  reviewVerdict: "pass" | "findings" | null;
  reviewTargetSha: string | null;
  testState: InternalTestState | null;
  testTargetSha: string | null;
  openFindingCount: number;
};

export type InternalPauseView = {
  kind: InternalStopReason;
  message: string;
  nextAction: string;
  resumeNeed: InternalResumeNeed;
  pausedAt: string | null;
  pausedSha: string | null;
  /** 入力なしで再開できる（回復済みの実行障害など） */
  autoResumable: boolean;
};

export type InternalStatusView = {
  /** 内部確認を求める系列か。旧い系列は求めない */
  required: boolean;
  gate: Pick<InternalGate, "complete" | "blocker" | "message" | "targetSha">;
  rounds: InternalRoundView[];
  findings: InternalFindingView[];
  /** 稼働時間と実行予算（分）。`round`は独立レビューの回数（表示用で、停止の条件ではない） */
  limits: { round: number; activeMinutes: number; budgetMinutes: number };
  /** 一時停止していないときはnull */
  pause: InternalPauseView | null;
  /** 取得時点の記録から見た停止の見込み（読み取り専用の評価。実際の一時停止は次の書き込みで起きる） */
  pendingPause: { kind: InternalStopReason; message: string } | null;
  assignee: { name: string | null; epoch: number; leaseActive: boolean; leaseUntil: string | null };
  attempts: InternalAttempt[];
  /** 旧い画面・スクリプト向けの互換（一時停止の文面。停止していなければnull） */
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
  regressionCount: row.regressionCount ?? 0,
  lastRound: row.lastRound,
});

/** 内部確認を求める、進行中の系列（同じ修正Issueの最新の世代） */
/** 報告先のリポジトリ取り違え（#4964）にその場で気付けるよう、照会した対象を名前で返す */
function seriesNotFound(repositoryFullName: string, issueNumber: number): InternalReportError {
  return {
    ok: false,
    error: "series_not_found",
    message: `${repositoryFullName}#${issueNumber} に結び付いた、進行中の内部確認つきの修正系列がありません。別のリポジトリの修正なら --repo <owner/repo> を付けて報告してください`,
  };
}

async function findActiveSeries(repositoryFullName: string, issueNumber: number): Promise<ReleaseFixSeries | null> {
  const rows = await db.releaseFixSeries.findMany({
    where: { repositoryFullName, issueNumber, internalReview: true },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  return rows.find((row) => isReleaseFixActive(row.status)) ?? null;
}

async function loadRecords(repositoryFullName: string, issueNumber: number) {
  const [rounds, findings] = await Promise.all([
    db.releaseFixInternalRound.findMany({ where: { repositoryFullName, issueNumber }, orderBy: { round: "asc" } }),
    db.releaseFixFinding.findMany({ where: { repositoryFullName, issueNumber }, orderBy: { key: "asc" } }),
  ]);
  return { rounds, findings };
}

/** 記録の無い（まだ書き込みが無い）セッションの既定値。読み取りでは行を作らない */
function defaultSession(repositoryFullName: string, issueNumber: number): ReleaseFixInternalSession {
  const now = new Date(0);
  return {
    id: "",
    repositoryFullName,
    issueNumber,
    activeSeconds: 0,
    lastActivityAt: null,
    budgetMinutes: INTERNAL_DEFAULT_BUDGET_MINUTES,
    pauseKind: null,
    pauseDetail: null,
    pausedAt: null,
    pausedSha: null,
    resumeBaseRound: 0,
    nextAction: null,
    assignee: null,
    assignmentEpoch: 0,
    leaseUntil: null,
    attempts: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 旧方式の停止（`internalStopReason`だけが入っている系列）を、新方式の一時停止として読み替える。
 * **理由の文面と記録は保持する**。読み取りでも同じ読み替えをするので、行が無くても画面は同じ内容になる。
 */
function withLegacyPause(session: ReleaseFixInternalSession, series: Pick<ReleaseFixSeries, "internalStopReason">): ReleaseFixInternalSession {
  if (session.pauseKind !== null || series.internalStopReason === null) return session;
  const kind = classifyLegacyStopReason(series.internalStopReason);
  return { ...session, pauseKind: kind, pauseDetail: series.internalStopReason, pausedAt: session.pausedAt ?? session.updatedAt };
}

async function readSession(series: ReleaseFixSeries): Promise<ReleaseFixInternalSession> {
  const row = await db.releaseFixInternalSession.findFirst({ where: { repositoryFullName: series.repositoryFullName, issueNumber: series.issueNumber } });
  return withLegacyPause(row ?? defaultSession(series.repositoryFullName, series.issueNumber), series);
}

/** 書き込みの経路だけが使う。行が無ければ作り、旧方式の停止があれば一時停止として取り込む */
async function ensureSession(series: ReleaseFixSeries): Promise<ReleaseFixInternalSession> {
  const key = { repositoryFullName: series.repositoryFullName, issueNumber: series.issueNumber };
  let row = await db.releaseFixInternalSession.findFirst({ where: key });
  if (!row) {
    const legacy = series.internalStopReason !== null ? classifyLegacyStopReason(series.internalStopReason) : null;
    row = await db.releaseFixInternalSession
      .create({
        data: {
          ...key,
          pauseKind: legacy,
          pauseDetail: legacy ? series.internalStopReason : null,
          pausedAt: legacy ? new Date() : null,
          nextAction: legacy ? internalNextAction(legacy) : null,
          attempts: legacy ? [{ at: new Date().toISOString(), kind: "pause", by: null, detail: `旧方式の停止を引き継ぎました: ${series.internalStopReason}`, sha: null } satisfies InternalAttempt] : undefined,
        },
      })
      .catch(async () => db.releaseFixInternalSession.findFirst({ where: key }));
  }
  return row ?? defaultSession(series.repositoryFullName, series.issueNumber);
}

function evaluateStop(input: { session: ReleaseFixInternalSession; rounds: ReleaseFixInternalRound[]; findings: ReleaseFixFinding[]; gateComplete: boolean; activeSeconds?: number }) {
  return decideInternalStop({
    // 再開より前の往復は、停滞の根拠にしない（同じ停滞で即座に再停止しない）
    rounds: input.rounds.filter((r) => r.round > input.session.resumeBaseRound).map(toRoundRecord),
    findings: input.findings.map(toFindingRecord),
    activeMinutes: Math.floor((input.activeSeconds ?? input.session.activeSeconds) / 60),
    budgetMinutes: input.session.budgetMinutes,
    gateComplete: input.gateComplete,
  });
}

function buildStatus(input: {
  series: Pick<ReleaseFixSeries, "internalReview" | "internalStopReason">;
  session: ReleaseFixInternalSession;
  rounds: ReleaseFixInternalRound[];
  findings: ReleaseFixFinding[];
  currentSha: string | null;
  now: Date;
}): InternalStatusView {
  const { session } = input;
  const paused = session.pauseKind !== null && isInternalStopReason(session.pauseKind);
  const gate = evaluateInternalGate({
    rounds: input.rounds.map(toRoundRecord),
    findings: input.findings.map(toFindingRecord),
    currentSha: input.currentSha,
    stopped: paused,
  });
  const decision = paused ? ({ stop: false } as const) : evaluateStop({ session, rounds: input.rounds, findings: input.findings, gateComplete: gate.complete });
  const kind = paused ? (session.pauseKind as InternalStopReason) : null;
  const message = kind ? (session.pauseDetail ?? internalStopReasonMessage(kind)) : null;
  const leaseActive = session.assignee !== null && session.leaseUntil !== null && session.leaseUntil.getTime() > input.now.getTime();
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
      regressionCount: f.regressionCount ?? 0,
      resolution: f.resolution,
    })),
    limits: {
      round: input.rounds.filter((r) => r.reviewVerdict !== null).length,
      activeMinutes: Math.floor(session.activeSeconds / 60),
      budgetMinutes: session.budgetMinutes,
    },
    pause: kind
      ? {
          kind,
          message: message as string,
          nextAction: session.nextAction ?? internalNextAction(kind),
          resumeNeed: internalResumeNeed(kind),
          pausedAt: session.pausedAt ? session.pausedAt.toISOString() : null,
          pausedSha: session.pausedSha,
          autoResumable: kind === "environment",
        }
      : null,
    pendingPause: decision.stop ? { kind: decision.reason, message: internalStopReasonMessage(decision.reason, decision.detail) } : null,
    assignee: { name: session.assignee, epoch: session.assignmentEpoch, leaseActive, leaseUntil: session.leaseUntil ? session.leaseUntil.toISOString() : null },
    attempts: Array.isArray(session.attempts) ? (session.attempts as InternalAttempt[]).slice(-10) : [],
    stopReason: message,
  };
}

/**
 * 現在の状態（ゲートの判定つき）。`currentSha`はブランチのHEAD（サーバーが取り直した値）。
 * **読み取り専用**: 停止・稼働時間の加算・担当の変更・Issueコメント・ラベルの操作を一切しない。
 */
export async function readInternalStatus(
  repositoryFullName: string,
  issueNumber: number,
): Promise<{ ok: true; status: InternalStatusView } | InternalReportError> {
  const series = await findActiveSeries(repositoryFullName, issueNumber);
  if (!series) return seriesNotFound(repositoryFullName, issueNumber);
  const access = await repositoryAccess(repositoryFullName);
  if (!access) return { ok: false, error: "repository_not_found", message: "リポジトリが見つかりません" };
  const currentSha = await fetchBranchHeadSha(access.owner, access.repo, `issue-${issueNumber}`, access.token);
  const { rounds, findings } = await loadRecords(repositoryFullName, issueNumber);
  const session = await readSession(series);
  return { ok: true, status: buildStatus({ series, session, rounds, findings, currentSha, now: new Date() }) };
}

type Mutable = { series: ReleaseFixSeries; access: Access; sha: string | null; session: ReleaseFixInternalSession };

/** 稼働時間を加算して返す。一時停止中は加算しない（待機・中断・停止中は予算を消費しない） */
async function accrue(session: ReleaseFixInternalSession, now: Date): Promise<ReleaseFixInternalSession> {
  if (session.pauseKind !== null) return session;
  const activeSeconds = accrueActiveSeconds({ activeSeconds: session.activeSeconds, lastActivityAt: session.lastActivityAt, now });
  const updated = await db.releaseFixInternalSession.update({ where: { id: session.id }, data: { activeSeconds, lastActivityAt: now } });
  return updated;
}

/**
 * 停滞・予算到達なら一時停止する（書き込みの経路だけが呼ぶ）。**Issueへ理由と必要な操作を残し、本人判断が要る原因だけ
 * `00.check-user`を付ける**（実行環境の障害は付けない。#4587）。同じ停止は一度だけ。
 */
async function pauseIfNeeded(ctx: Mutable, gateComplete: boolean): Promise<{ kind: InternalStopReason; message: string } | null> {
  if (ctx.session.pauseKind !== null) return null;
  const { rounds, findings } = await loadRecords(ctx.series.repositoryFullName, ctx.series.issueNumber);
  const decision = evaluateStop({ session: ctx.session, rounds, findings, gateComplete });
  if (!decision.stop) return null;
  const paused = await pauseInternal(ctx, decision.reason, decision.detail ?? null, { by: null });
  return paused ? { kind: decision.reason, message: internalStopReasonMessage(decision.reason, decision.detail) } : null;
}

async function pauseInternal(ctx: Mutable, kind: InternalStopReason, detail: string | null, opts: { by: string | null }): Promise<boolean> {
  const { series, access, session } = ctx;
  const message = internalStopReasonMessage(kind, detail ?? undefined);
  const now = new Date();
  const claimed = await db.releaseFixInternalSession.updateMany({
    where: { id: session.id, pauseKind: null },
    data: {
      pauseKind: kind,
      pauseDetail: message,
      pausedAt: now,
      pausedSha: ctx.sha,
      lastActivityAt: null,
      nextAction: internalNextAction(kind),
      attempts: appendAttempt(session.attempts, { at: now.toISOString(), kind: "pause", by: opts.by, detail: message, sha: ctx.sha }) as never,
    },
  });
  if (claimed.count === 0) return false;
  await db.releaseFixSeries.updateMany({ where: { id: series.id }, data: { internalStopReason: message } });
  // 実行環境の障害は、本人の判断を待つ状態にしない（回復すれば入力なしで再開できる）
  if (kind === "environment") return true;
  const body = `リリース修正の内部確認を一時停止しました（#4587）。作業内容・指摘・稼働時間の記録は保持されています。\n\n原因: ${message}\n\n必要な操作: ${internalNextAction(kind)}\n\n再開はリリース画面または修正Issueの内部確認の欄から行います。別のエージェントへ引き継ぐ場合も、同じ記録から続けます。\n\n${STOP_COMMENT_MARKER}`;
  await createComment(access.owner, access.repo, series.issueNumber, access.token, { body }).catch(() => undefined);
  await addIssueLabels(access.owner, access.repo, series.issueNumber, access.token, CHECK_USER_LABELS).catch(() => undefined);
  return true;
}

/** 担当の照合。担当がいるなら担当と世代番号の一致を求め、解放・引き継ぎの後の遅延報告を弾く */
export type Actor = {
  assignee?: string | null;
  epoch?: number | null;
  /** 独立レビューの報告者（担当ではない）。担当名の照合をせず、世代番号だけで遅延報告を弾く（#4588） */
  reviewer?: boolean;
};

/** 報告が検証したと申告するSHA（外部向けは必須）。省略時は従来どおりサーバーが取り直したHEADを使う */
type ExpectedSha = { expectedSha?: string | null };

function checkActor(session: ReleaseFixInternalSession, actor: Actor): InternalReportError | null {
  const epoch = actor.epoch ?? null;
  const assignee = actor.assignee ?? null;
  if (actor.reviewer) {
    if (epoch === null || epoch !== session.assignmentEpoch) {
      return { ok: false, error: "stale_assignee", message: "担当の世代が変わっているため、この報告は記録しません。最新の状態を読み直し、レビュー対象を確かめてから報告してください" };
    }
    return null;
  }
  if (epoch !== null && epoch !== session.assignmentEpoch) {
    return { ok: false, error: "stale_assignee", message: "担当が変わっているため、この報告は記録しません。最新の状態を読み直し、担当を取得してから続けてください" };
  }
  if (session.assignee !== null && (assignee !== session.assignee || epoch === null)) {
    return { ok: false, error: "stale_assignee", message: `現在の担当は ${session.assignee} です。担当を取得（claim）してから報告してください` };
  }
  return null;
}

type Prepared = { error: InternalReportError } | (Mutable & { sha: string });

async function prepare(repositoryFullName: string, issueNumber: number, actor: Actor, opts: { allowPaused?: boolean; expectedSha?: string | null } = {}): Promise<Prepared> {
  const series = await findActiveSeries(repositoryFullName, issueNumber);
  if (!series) return { error: seriesNotFound(repositoryFullName, issueNumber) };
  const access = await repositoryAccess(repositoryFullName);
  if (!access) return { error: { ok: false, error: "repository_not_found", message: "リポジトリが見つかりません" } };
  const sha = await fetchBranchHeadSha(access.owner, access.repo, `issue-${issueNumber}`, access.token);
  if (!sha) return { error: { ok: false, error: "branch_not_found", message: `ブランチ issue-${issueNumber} が見つかりません。確認する内容をpushしてから報告してください` } };
  const session = await ensureSession(series);
  const stale = checkActor(session, actor);
  if (stale) return { error: stale };
  if (opts.expectedSha && opts.expectedSha !== sha) {
    return { error: { ok: false, error: "stale_sha", currentSha: sha, message: `報告が検証したSHA（${opts.expectedSha.slice(0, 7)}）はブランチの現在のHEAD（${sha.slice(0, 7)}）ではありません。最新の内容を取得して検証し直してから報告してください` } };
  }
  if (session.pauseKind !== null && !opts.allowPaused) {
    return { error: { ok: false, error: "paused", message: `${session.pauseDetail ?? internalStopReasonMessage(session.pauseKind as InternalStopReason)}。再開してから報告してください` } };
  }
  return { series, access, sha, session };
}

/** 担当のリースを延ばす（報告のたびに） */
async function renewLease(session: ReleaseFixInternalSession, actor: Actor, now: Date): Promise<ReleaseFixInternalSession> {
  if (session.assignee === null || (actor.assignee ?? null) !== session.assignee) return session;
  return db.releaseFixInternalSession.update({ where: { id: session.id }, data: { leaseUntil: new Date(now.getTime() + INTERNAL_LEASE_MINUTES * 60_000) } });
}

/** 独立レビューの結果を記録する。往復を1つ進め、指摘を採番・解消・再発として更新する */
export async function recordInternalReview(input: {
  repositoryFullName: string;
  issueNumber: number;
  report: ReviewReport;
  summary: string | null;
  actor?: Actor;
  /** 外部エージェントの報告主体。渡すと担当と別の主体であることを確かめ、往復へ記録する（#4588） */
  reviewer?: { kind: "external"; ref: string; /** 担当名（claimで記録した名前）がこの報告主体のものか。現担当と、過去に担当を取った主体の両方を見る */ isSelf: (assigneeName: string) => boolean } | null;
} & ExpectedSha): Promise<{ ok: true; round: number; status: InternalStatusView } | InternalReportError> {
  const actor = input.actor ?? {};
  const prepared = await prepare(input.repositoryFullName, input.issueNumber, actor, { expectedSha: input.expectedSha });
  if ("error" in prepared) return prepared.error;
  const { series, access, sha } = prepared;
  if (input.reviewer) {
    const claimed = [prepared.session.assignee, ...(Array.isArray(prepared.session.attempts) ? (prepared.session.attempts as InternalAttempt[]) : []).filter((a) => a.kind === "claim" || a.kind === "handover").map((a) => a.by)];
    if (claimed.some((name) => typeof name === "string" && input.reviewer!.isSelf(name))) {
      return { ok: false, error: "self_review_not_independent", message: "実装を担当している主体と同じ主体のレビューは、独立レビューとして記録しません。別のトークン・別のエージェントでレビューしてください" };
    }
  }
  const now = new Date();
  let session = await renewLease(await accrue(prepared.session, now), actor, now);

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
    // 開いたままの再指摘（未解消）と、解消後の再発を区別して数える
    const data =
      f.status === "resolved"
        ? { status: "open", resolution: null, lastRound: roundNo, regressionCount: { increment: 1 } }
        : { status: "open", resolution: null, lastRound: roundNo, reopenCount: { increment: 1 } };
    await db.releaseFixFinding.update({ where: { id: f.id }, data });
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
    reviewedAt: now,
    openFindingCount: openCount,
    ...(input.reviewer ? { reviewerKind: input.reviewer.kind, reviewerRef: input.reviewer.ref.slice(0, 120) } : {}),
  };
  if (reuse) {
    await db.releaseFixInternalRound.update({ where: { id: reuse.id }, data });
  } else {
    await db.releaseFixInternalRound.create({ data: { repositoryFullName: input.repositoryFullName, issueNumber: input.issueNumber, round: roundNo, ...data } });
  }
  session = (await db.releaseFixInternalSession.findFirst({ where: { id: session.id } })) ?? session;
  const ctx: Mutable = { series, access, sha, session };
  const status = await statusAfterWrite(ctx);
  const paused = status.gate.complete ? null : await pauseIfNeeded(ctx, false);
  return { ok: true, round: roundNo, status: paused ? await statusAfterWrite({ ...ctx, session: await reloadSession(session) }) : status };
}

async function reloadSession(session: ReleaseFixInternalSession): Promise<ReleaseFixInternalSession> {
  return (await db.releaseFixInternalSession.findFirst({ where: { id: session.id } })) ?? session;
}

async function statusAfterWrite(ctx: Mutable): Promise<InternalStatusView> {
  const series = (await db.releaseFixSeries.findFirst({ where: { id: ctx.series.id } })) ?? ctx.series;
  const { rounds, findings } = await loadRecords(series.repositoryFullName, series.issueNumber);
  return buildStatus({ series, session: withLegacyPause(await reloadSession(ctx.session), series), rounds, findings, currentSha: ctx.sha, now: new Date() });
}

/** テスト結果を記録する。最新の往復へ書き、対象SHAを添える（対象が変わったあとの合格は流用されない） */
export async function recordInternalTest(input: {
  repositoryFullName: string;
  issueNumber: number;
  state: InternalTestState;
  summary: string | null;
  actor?: Actor;
} & ExpectedSha): Promise<{ ok: true; round: number; status: InternalStatusView } | InternalReportError> {
  const actor = input.actor ?? {};
  const prepared = await prepare(input.repositoryFullName, input.issueNumber, actor, { expectedSha: input.expectedSha });
  if ("error" in prepared) return prepared.error;
  const { series, access, sha } = prepared;
  const now = new Date();
  const session = await renewLease(await accrue(prepared.session, now), actor, now);
  const ctx: Mutable = { series, access, sha, session };

  // 記録する前に予算を評価する（予算を超えてからのテスト合格でゲートを完了させない）
  const before = await pauseIfNeeded(ctx, false);
  if (before) return { ok: false, error: "paused", message: before.message };

  const { rounds } = await loadRecords(input.repositoryFullName, input.issueNumber);
  const latest = rounds[rounds.length - 1];
  const data = { testState: input.state, testTargetSha: sha, testSummary: input.summary ? input.summary.slice(0, 8000) : null, testedAt: now };
  let roundNo: number;
  if (latest) {
    roundNo = latest.round;
    await db.releaseFixInternalRound.update({ where: { id: latest.id }, data });
  } else {
    roundNo = 1;
    await db.releaseFixInternalRound.create({ data: { repositoryFullName: input.repositoryFullName, issueNumber: input.issueNumber, round: 1, ...data } });
  }
  return { ok: true, round: roundNo, status: await statusAfterWrite(ctx) };
}

/** 実行環境の障害・本人の判断や権限の不足を、担当が報告して一時停止する（作業内容は保持される） */
export async function pauseInternalByReport(input: {
  repositoryFullName: string;
  issueNumber: number;
  kind: "environment" | "needs_decision";
  detail: string | null;
  actor?: Actor;
}): Promise<{ ok: true; status: InternalStatusView } | InternalReportError> {
  const prepared = await prepare(input.repositoryFullName, input.issueNumber, input.actor ?? {}, { allowPaused: true });
  if ("error" in prepared) {
    // ブランチが無くても環境障害は報告できるようにはしない（対象を特定できないため）
    return prepared.error;
  }
  const { series, access, sha } = prepared;
  const session = await accrue(prepared.session, new Date());
  const ctx: Mutable = { series, access, sha, session };
  await pauseInternal(ctx, input.kind, input.detail ? input.detail.slice(0, 500) : null, { by: input.actor?.assignee ?? null });
  return { ok: true, status: await statusAfterWrite(ctx) };
}

/**
 * 担当の取得（`claim`）と引き継ぎ（`takeover`）。別の担当が持ち時間の内にいるときは、明示の引き継ぎがなければ取らない。
 * 担当が変わると世代番号が増え、旧担当の遅延報告は`stale_assignee`で弾かれる。同じ担当の再取得はリースの更新（世代は変えない）。
 */
export async function claimInternalSession(input: {
  repositoryFullName: string;
  issueNumber: number;
  assignee: string;
  takeover?: boolean;
}): Promise<{ ok: true; epoch: number; handover: boolean; status: InternalStatusView } | InternalReportError> {
  const series = await findActiveSeries(input.repositoryFullName, input.issueNumber);
  if (!series) return seriesNotFound(input.repositoryFullName, input.issueNumber);
  const access = await repositoryAccess(input.repositoryFullName);
  if (!access) return { ok: false, error: "repository_not_found", message: "リポジトリが見つかりません" };
  const sha = await fetchBranchHeadSha(access.owner, access.repo, `issue-${input.issueNumber}`, access.token);
  const session = await ensureSession(series);
  const now = new Date();
  const leaseActive = session.assignee !== null && session.leaseUntil !== null && session.leaseUntil.getTime() > now.getTime();
  const same = session.assignee === input.assignee;
  if (!same && leaseActive && !input.takeover) {
    return { ok: false, error: "lease_held", message: `${session.assignee} が担当中です（持ち時間は ${session.leaseUntil?.toISOString()} まで）。引き継ぐ場合は引き継ぎを明示してください` };
  }
  const handover = session.assignee !== null && !same;
  const epoch = same ? session.assignmentEpoch : session.assignmentEpoch + 1;
  // 世代番号を条件に更新する。同時に取得しようとした一方だけが成功する
  const claimed = await db.releaseFixInternalSession.updateMany({
    where: { id: session.id, assignmentEpoch: session.assignmentEpoch },
    data: {
      assignee: input.assignee,
      assignmentEpoch: epoch,
      leaseUntil: new Date(now.getTime() + INTERNAL_LEASE_MINUTES * 60_000),
      ...(same ? {} : { attempts: appendAttempt(session.attempts, { at: now.toISOString(), kind: handover ? "handover" : "claim", by: input.assignee, detail: handover ? `${session.assignee} から引き継ぎ` : null, sha }) as never }),
    },
  });
  if (claimed.count === 0) return { ok: false, error: "lease_held", message: "ほかの担当が同時に取得しました。状態を読み直してください" };
  const ctx: Mutable = { series, access, sha, session };
  return { ok: true, epoch, handover, status: await statusAfterWrite(ctx) };
}

/** 担当の解放。世代番号を進め、解放した担当の遅延報告を弾く。作業内容・指摘・稼働時間は保持する */
export async function releaseInternalSession(input: { repositoryFullName: string; issueNumber: number; actor: Actor; /** 利用者の操作（引き継ぎのための強制解放） */ force?: boolean }): Promise<{ ok: true; status: InternalStatusView } | InternalReportError> {
  const series = await findActiveSeries(input.repositoryFullName, input.issueNumber);
  if (!series) return seriesNotFound(input.repositoryFullName, input.issueNumber);
  const session = await ensureSession(series);
  const stale = input.force ? null : checkActor(session, input.actor);
  if (stale) return stale;
  const now = new Date();
  const settled = await accrue(session, now);
  if (settled.assignee !== null) {
    await db.releaseFixInternalSession.updateMany({
      where: { id: session.id, assignmentEpoch: session.assignmentEpoch },
      data: { assignee: null, leaseUntil: null, assignmentEpoch: session.assignmentEpoch + 1, lastActivityAt: null, attempts: appendAttempt(session.attempts, { at: now.toISOString(), kind: "release", by: session.assignee, detail: null, sha: null }) as never },
    });
  }
  const access = await repositoryAccess(input.repositoryFullName);
  return { ok: true, status: await statusAfterWrite({ series, access: access as Access, sha: null, session }) };
}

/**
 * 一時停止の再開（停止・担当の操作とは分離。状態の取得では起きない）。
 * 最新の対象・稼働担当・停止原因を照合する: 系列が完了・置換・本番反映済みなら再開しない／停止していなければ（二重の再開を含む）再開しない／
 * 原因ごとの入力（予算の追加・方針）が無ければ求める。予算到達は**稼働時間を足す**だけで、累積の記録はゼロに戻さない。
 */
export async function resumeInternal(input: {
  repositoryFullName: string;
  issueNumber: number;
  addMinutes?: number | null;
  direction?: string | null;
  assignee?: string | null;
  by?: string | null;
  /** エージェントからの再開。入力が要らない回復済みの実行障害に限る（予算・方針の入力は人が与える） */
  autoOnly?: boolean;
}): Promise<{ ok: true; status: InternalStatusView } | InternalReportError> {
  const rows = await db.releaseFixSeries.findMany({ where: { repositoryFullName: input.repositoryFullName, issueNumber: input.issueNumber, internalReview: true }, orderBy: { createdAt: "desc" }, take: 5 });
  const series = rows.find((row) => isReleaseFixActive(row.status)) ?? null;
  if (!series) {
    return { ok: false, error: "not_resumable", message: rows.length > 0 ? "この修正系列は完了・置換・本番反映のいずれかで終わっているため、再開しません" : "この修正Issueに結び付いた内部確認つきの修正系列がありません" };
  }
  if (series.fixPrMergedAt !== null) return { ok: false, error: "not_resumable", message: "修正PRはすでにマージ済みのため、再開しません" };
  const access = await repositoryAccess(input.repositoryFullName);
  if (!access) return { ok: false, error: "repository_not_found", message: "リポジトリが見つかりません" };
  const sha = await fetchBranchHeadSha(access.owner, access.repo, `issue-${input.issueNumber}`, access.token);
  if (!sha) return { ok: false, error: "branch_not_found", message: `ブランチ issue-${input.issueNumber} が見つかりません` };
  const session = await ensureSession(series);
  const kind = session.pauseKind;
  if (kind === null || !isInternalStopReason(kind)) return { ok: false, error: "not_paused", message: "一時停止していません（すでに再開されています）" };

  if (input.autoOnly && kind !== "environment") return { ok: false, error: "input_required", message: "この停止は利用者の入力（予算の追加または方針）が必要です。リリース画面から再開してください" };
  const direction = input.direction && input.direction.trim() !== "" ? input.direction.trim().slice(0, 2000) : null;
  const requested = input.addMinutes !== undefined && input.addMinutes !== null && Number.isFinite(input.addMinutes) ? Math.floor(input.addMinutes) : null;
  // 旧方式の往復数・経過時間による停止は、新しい予算の範囲内なら入力なしで再評価して再開できる
  const legacyBudget = kind === "budget_reached" && Math.floor(session.activeSeconds / 60) < session.budgetMinutes;
  const need = legacyBudget ? { ok: true as const, addMinutes: 0 } : decideInternalResume({ kind, addMinutes: requested, direction });
  if (!need.ok) return need;

  const now = new Date();
  const { rounds } = await loadRecords(input.repositoryFullName, input.issueNumber);
  const lastRound = rounds.length > 0 ? rounds[rounds.length - 1].round : 0;
  const assignee = input.assignee && input.assignee.trim() !== "" ? input.assignee.trim().slice(0, 120) : null;
  const changesAssignee = assignee !== null && assignee !== session.assignee;
  // 停止の原因を条件にして更新する。同時に再開しようとした一方だけが成功する
  const claimed = await db.releaseFixInternalSession.updateMany({
    where: { id: session.id, pauseKind: kind },
    data: {
      pauseKind: null,
      pauseDetail: null,
      pausedAt: null,
      pausedSha: null,
      nextAction: null,
      resumeBaseRound: lastRound,
      budgetMinutes: session.budgetMinutes + need.addMinutes,
      lastActivityAt: now,
      ...(changesAssignee ? { assignee, assignmentEpoch: session.assignmentEpoch + 1, leaseUntil: new Date(now.getTime() + INTERNAL_LEASE_MINUTES * 60_000) } : {}),
      attempts: appendAttempt(session.attempts, {
        at: now.toISOString(),
        kind: "resume",
        by: input.by ?? assignee,
        detail: [need.addMinutes > 0 ? `予算を${need.addMinutes}分追加` : null, direction ? `方針: ${direction}` : null, session.pausedSha && session.pausedSha !== sha ? "停止後に対象の内容が変わっています" : null].filter(Boolean).join(" ／ ") || null,
        sha,
      }) as never,
    },
  });
  if (claimed.count === 0) return { ok: false, error: "not_paused", message: "ほかの操作が先に再開しました" };
  // 方針の入力で、同じ停滞の数え直しを始める（指摘そのものと履歴は残す）
  await db.releaseFixFinding.updateMany({ where: { repositoryFullName: input.repositoryFullName, issueNumber: input.issueNumber, status: "open" }, data: { reopenCount: 0 } });
  await db.releaseFixSeries.updateMany({ where: { id: series.id }, data: { internalStopReason: null } });
  if (kind !== "environment") {
    await removeIssueLabel(access.owner, access.repo, series.issueNumber, access.token, "00.check-user").catch(() => undefined);
    await removeIssueLabel(access.owner, access.repo, series.issueNumber, access.token, "01.check-blocked").catch(() => undefined);
  }
  const lines = [`リリース修正の内部確認を再開しました（#4587）。`, need.addMinutes > 0 ? `実行予算を稼働${need.addMinutes}分追加しました（合計${session.budgetMinutes + need.addMinutes}分）。` : null, direction ? `方針: ${direction}` : null, "未解決の指摘・独立レビュー・テストの記録は引き継がれています。未完了の部分から続けてください。"].filter(Boolean);
  await createComment(access.owner, access.repo, series.issueNumber, access.token, { body: `${lines.join("\n\n")}\n\n${RESUME_COMMENT_MARKER}` }).catch(() => undefined);
  return { ok: true, status: await statusAfterWrite({ series, access, sha, session }) };
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

/** 画面用。取得に必要なのは記録だけ（GitHubを呼ばない・書き込まない）。ゲートは最新の往復が示す確認対象で評価する */
export async function loadInternalViewForUi(repositoryFullName: string, issueNumber: number, internalReview: boolean, stopReason: string | null): Promise<InternalStatusView | null> {
  if (!internalReview) return null;
  const { rounds, findings } = await loadRecords(repositoryFullName, issueNumber);
  const series = { internalReview, internalStopReason: stopReason };
  const row = await db.releaseFixInternalSession.findFirst({ where: { repositoryFullName, issueNumber } });
  const session = withLegacyPause(row ?? defaultSession(repositoryFullName, issueNumber), series);
  const latest = rounds[rounds.length - 1];
  return buildStatus({ series, session, rounds, findings, currentSha: latest?.testTargetSha ?? latest?.reviewTargetSha ?? null, now: new Date() });
}
