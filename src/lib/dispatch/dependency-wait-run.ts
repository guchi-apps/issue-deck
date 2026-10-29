import type { Prisma, SessionDependencyWait } from "@prisma/client";

import { db } from "@/lib/db";
import {
  buildDependencyResumeInstruction,
  buildDependencyUrl,
  DEFAULT_IMPLEMENTATION_CONDITIONS,
  DEFAULT_INTEGRATION_BRANCH,
  isClosedWaitReviewCandidate,
  decideDependencyWait,
  detectLegacyHoldCandidate,
  evaluateConditions,
  formatDependencyRef,
  isActiveDependencyWaitStatus,
  parseDependencyRef,
  parseDependencyWaitStatus,
  DEPENDENCY_WAIT_CONDITIONS,
  DEPENDENCY_RESUME_AUTO_RETRY_DELAYS_MS,
  isTransientResumeFailure,
  nextDependencyResumeRetryAt,
  type ConditionResult,
  type DependencyConditionRevision,
  type DependencyObservation,
  type ImplementationPrObservation,
  type DependencyRef,
  type DependencyWaitCondition,
  type DependencyWaitStatus,
  type DependencyWaitView,
} from "@/lib/dispatch/dependency-wait";
import { addCheckUserWithReason } from "@/lib/dispatch/check-user-labels";
import { describeInstructionJobFailure } from "@/lib/dispatch/input-stash";
import { resolveInstallationToken } from "@/lib/dispatch/installation-token";
import { enqueueSessionControlJob } from "@/lib/dispatch/jobs";
import { findDispatchSessionForIssue } from "@/lib/dispatch/sessions";
import { defaultVerifyDeps } from "@/lib/execution-plan/register";
import { fetchBranchHeadSha } from "@/lib/github/branches-api";
import { GithubApiError } from "@/lib/github/github-api-error";
import { createComment, fetchIssueState } from "@/lib/github/issues-api";
import { fetchPullRequest } from "@/lib/github/pull-requests-api";
import { GITHUB_API, githubFetch } from "@/lib/github/request";
import { reportProgressStatus } from "@/lib/github/report-progress";
import { parseRepositoryFullName } from "@/lib/local-session";

/** 巡回で同じ待ちを評価し直す最短間隔。GitHub APIの消費を抑え、重なった巡回を弾く */
export const DEPENDENCY_WAIT_SWEEP_INTERVAL_MS = 60 * 1000;
/** 再開の指示を送ってから、セッションが動き出したと確認できるまで待つ上限 */
export const DEPENDENCY_WAIT_RESUME_CONFIRM_TIMEOUT_MS = 10 * 60 * 1000;

const AGENT_MARKER = "<!-- issue-deck-agent:implementer -->";

export function activeKeyFor(repositoryFullName: string, issueNumber: number): string {
  return `${repositoryFullName}#${issueNumber}`;
}

function parseConditions(value: unknown): DependencyWaitCondition[] {
  if (!Array.isArray(value)) return [];
  return value.filter((c): c is DependencyWaitCondition =>
    (DEPENDENCY_WAIT_CONDITIONS as readonly string[]).includes(c),
  );
}

function parseResults(value: unknown): ConditionResult[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (r): r is ConditionResult =>
      !!r && typeof r === "object" && typeof (r as ConditionResult).condition === "string",
  );
}

export function toDependencyWaitView(row: SessionDependencyWait): DependencyWaitView {
  const dependency: DependencyRef = {
    repository: row.depRepository,
    number: row.depNumber,
    kind: row.depKind === "pr" ? "pr" : "issue",
  };
  return {
    id: row.id,
    repositoryFullName: row.repositoryFullName,
    issueNumber: row.issueNumber,
    dependency,
    dependencyUrl: buildDependencyUrl(dependency),
    conditions: parseConditions(row.conditions),
    reason: row.reason,
    status: parseDependencyWaitStatus(row.status) ?? "WAITING",
    source: row.source === "manual" ? "manual" : "session",
    results: parseResults(row.lastObservation),
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    lastError: row.lastError,
    failureReason: row.failureReason,
    resumeRequestedAt: row.resumeRequestedAt?.toISOString() ?? null,
    resumeSentAt: row.resumeSentAt?.toISOString() ?? null,
    resumedAt: row.resumedAt?.toISOString() ?? null,
    autoRetryCount: row.autoRetryCount,
    nextAutoRetryAt:
      row.status === "RESUME_FAILED" ? (nextDependencyResumeRetryAt(row)?.toISOString() ?? null) : null,
    conditionHistory: parseConditionHistory(row.conditionHistory),
  };
}

function parseConditionHistory(value: unknown): DependencyConditionRevision[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (r): r is DependencyConditionRevision =>
      !!r && typeof r === "object" && typeof (r as DependencyConditionRevision).at === "string",
  );
}

/** 画面用: 待ち中のものと、直近に終わったもの（再開済み・失敗を数日は見せる） */
export async function listDependencyWaitViews(now: Date = new Date()): Promise<DependencyWaitView[]> {
  const since = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  const rows = await db.sessionDependencyWait.findMany({
    where: { OR: [{ activeKey: { not: null } }, { updatedAt: { gte: since } }] },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
  return rows.map(toDependencyWaitView);
}

/** マージ済みPRのマージコミットがmainの祖先か。取得できなければ`null`（401だけは投げる） */
async function fetchInProduction(
  parsed: { owner: string; repo: string },
  pr: { merged?: boolean; merge_commit_sha?: string | null },
  token: string,
): Promise<boolean | null> {
  if (pr.merged !== true) return null;
  const sha = pr.merge_commit_sha ?? null;
  if (!sha) return null;
  const res = await githubFetch(`${GITHUB_API}/repos/${parsed.owner}/${parsed.repo}/compare/${sha}...main`, token);
  if (res.ok) {
    const compare: { status?: string } = await res.json().catch(() => ({}));
    return compare.status === "ahead" || compare.status === "identical";
  }
  if (res.status === 401) throw new GithubApiError(401, "GitHub API request failed: 401");
  return null;
}

/**
 * 開発の統合ブランチ（#4570）。`develop`があればそれ、無ければリポジトリのデフォルトブランチ。
 * **mainへのマージをdevelopへのマージと取り違えないため**、評価側がPRのbaseと突き合わせる。
 */
export async function resolveIntegrationBranch(
  repositoryFullName: string,
  parsed: { owner: string; repo: string },
  token: string,
): Promise<string> {
  const develop = await fetchBranchHeadSha(parsed.owner, parsed.repo, DEFAULT_INTEGRATION_BRANCH, token);
  if (develop) return DEFAULT_INTEGRATION_BRANCH;
  const row = await db.repository.findFirst({ where: { fullName: repositoryFullName }, select: { defaultBranch: true } });
  return row?.defaultBranch || "main";
}

/**
 * 依存先の現在の状態を読む。本番（main）への反映は、マージ済みPRのマージコミットがmainの
 * 祖先かどうかで確かめる（`compare/{sha}...main`が`ahead`か`identical`なら入っている）。
 *
 * 依存先がIssueのときは、`issue-<番号>`ブランチをheadとするPRへ解決して実装PRの状態も返す（#4570）。
 * マージされず閉じたPRは実装の証拠にしない。解決に失敗したら`implementationError`に残し、成立にしない。
 */
export async function observeDependency(ref: DependencyRef): Promise<DependencyObservation> {
  const parsed = parseRepositoryFullName(ref.repository);
  if (!parsed) throw new Error(`依存先のリポジトリ名が不正です: ${ref.repository}`);
  const token = await resolveInstallationToken(ref.repository);
  if (!token) throw new Error(`${ref.repository}はIssueDeckに接続されておらず、状態を読めません`);

  const integrationBranch = await resolveIntegrationBranch(ref.repository, parsed, token).catch((error) => {
    if (error instanceof GithubApiError && error.status === 401) throw error;
    // 統合ブランチ不明の観測は`merged`を成立にしない（人の確認待ち）。原因を追えるよう残す
    console.warn("[dependency-wait] 統合ブランチを取得できません", ref.repository, error);
    return null;
  });

  if (ref.kind === "issue") {
    const state = await fetchIssueState(parsed.owner, parsed.repo, ref.number, token);
    if (!state) throw new Error(`${formatDependencyRef(ref)}の状態を取得できませんでした`);
    const base: DependencyObservation = { state, merged: null, baseRef: null, inProduction: null, integrationBranch };
    try {
      const resolved = await defaultVerifyDeps.branchPrs({ repository: ref.repository, number: ref.number }, token);
      const numbers =
        resolved.kind === "none" ? [] : resolved.kind === "one" ? [resolved.number] : resolved.numbers;
      const prs: ImplementationPrObservation[] = [];
      for (const number of numbers) {
        const pr = await fetchPullRequest(parsed.owner, parsed.repo, number, token);
        prs.push({
          number,
          merged: pr.merged === true,
          baseRef: pr.base?.ref ?? null,
          inProduction: await fetchInProduction(parsed, pr as never, token),
        });
      }
      return { ...base, implementationPrs: prs };
    } catch (error) {
      if (error instanceof GithubApiError && error.status === 401) throw error;
      return { ...base, implementationError: error instanceof Error ? error.message : "不明" };
    }
  }

  const pr = await fetchPullRequest(parsed.owner, parsed.repo, ref.number, token);
  const merged = pr.merged === true;
  const inProduction = await fetchInProduction(parsed, pr as never, token);
  return {
    state: pr.state === "closed" ? "closed" : "open",
    merged,
    baseRef: pr.base?.ref ?? null,
    inProduction,
    integrationBranch,
  };
}

type Deps = {
  observe: (ref: DependencyRef) => Promise<DependencyObservation>;
  now: () => Date;
};
const defaultDeps: Deps = { observe: observeDependency, now: () => new Date() };

async function postIssueComment(repositoryFullName: string, issueNumber: number, text: string) {
  const parsed = parseRepositoryFullName(repositoryFullName);
  if (!parsed) return;
  try {
    const token = await resolveInstallationToken(repositoryFullName);
    if (!token) return;
    await createComment(parsed.owner, parsed.repo, issueNumber, token, {
      body: `${text}\n\n${AGENT_MARKER}`,
    });
  } catch (error) {
    console.error("[dependency-wait] Issueコメントを投稿できませんでした", error);
  }
}

async function raiseCheckUser(repositoryFullName: string, issueNumber: number, reason: "input" | "blocked") {
  const parsed = parseRepositoryFullName(repositoryFullName);
  if (!parsed) return;
  try {
    const token = await resolveInstallationToken(repositoryFullName);
    if (!token) return;
    await addCheckUserWithReason(parsed.owner, parsed.repo, issueNumber, token, reason);
  } catch (error) {
    console.error("[dependency-wait] 確認待ちを記録できませんでした", error);
  }
}

/**
 * 通知は状態の変わり目ごとに1回だけ。`notifiedKey`を`updateMany where notifiedKey != key`で
 * 席取りするので、同じ理由では巡回・手動操作が重なっても繰り返さない。
 */
async function notifyOnce(
  row: SessionDependencyWait,
  key: string,
  send: () => Promise<void>,
): Promise<void> {
  const claimed = await db.sessionDependencyWait.updateMany({
    where: { id: row.id, OR: [{ notifiedKey: null }, { notifiedKey: { not: key } }] },
    data: { notifiedKey: key },
  });
  if (claimed.count === 1) await send();
}

/**
 * 待ちの出入りに合わせて進捗を動かす（#5118）。前提が未達で保留したIssueは盤面で作業中に
 * 見えるため、登録で`Ready`へ戻し、再開が確認できたら`Implementation`へ進める。
 * `onlyFrom`で他の段（`Develop PR`以降など）は動かさず、**失敗しても待ちの処理は止めない**。
 */
async function reportWaitProgress(
  repositoryFullName: string,
  issueNumber: number,
  status: "ready" | "implementation",
  onlyFrom: ("planning" | "implementation" | "ready")[],
): Promise<void> {
  try {
    await reportProgressStatus({ repositoryFullName, issueNumber, status, onlyFrom });
  } catch (error) {
    console.error(`[dependency-wait] 進捗を${status}へ動かせませんでした（${repositoryFullName}#${issueNumber}）`, error);
  }
}

/**
 * セッション自身（または画面）からの待機登録。**登録時にも現在の依存状態を確認し**、成立済みの
 * 条件を古い情報で待ち続けない。同じIssueで待ちが続いているなら内容を更新する（二重登録しない）。
 */
export async function registerDependencyWait(
  params: {
    repositoryFullName: string;
    issueNumber: number;
    dependency: DependencyRef;
    conditions: DependencyWaitCondition[];
    reason: string;
    source: "session" | "manual";
  },
  deps: Deps = defaultDeps,
): Promise<DependencyWaitView> {
  const activeKey = activeKeyFor(params.repositoryFullName, params.issueNumber);
  const data = {
    depRepository: params.dependency.repository,
    depNumber: params.dependency.number,
    depKind: params.dependency.kind,
    conditions: params.conditions,
    reason: params.reason,
    source: params.source,
    status: "WAITING" as DependencyWaitStatus,
    lastObservation: undefined,
    lastError: null,
    failureReason: null,
    resumeFailedAt: null,
    autoRetryCount: 0,
    notifiedKey: null,
    resumeJobId: null,
    resumeRequestedAt: null,
    resumeSentAt: null,
    satisfiedAt: null,
  };
  const existing = await db.sessionDependencyWait.findUnique({ where: { activeKey } });
  const row = existing
    ? await db.sessionDependencyWait.update({ where: { id: existing.id }, data })
    : await db.sessionDependencyWait.create({
        data: {
          ...data,
          repositoryFullName: params.repositoryFullName,
          issueNumber: params.issueNumber,
          activeKey,
        },
      });
  await reportWaitProgress(params.repositoryFullName, params.issueNumber, "ready", [
    "planning",
    "implementation",
  ]);
  const advanced = await advanceDependencyWait(row.id, { manual: false }, deps);
  return advanced ?? toDependencyWaitView(row);
}

/**
 * 既存の`closed`待ちを、実装の取り込み待ち（`merged`）へ見直す（#4570）。
 * **人が1件ずつ確認して押す操作**で、対象は`isClosedWaitReviewCandidate`だけ。変更前後・理由・操作者を
 * `conditionHistory`へ残し、見直した直後に条件を評価し直す（成立済みなら再開まで進む）。
 * 再開の追跡中・終了済みの待ちは変えない（二重起動を起こさない）。
 */
export async function reviseClosedWaitToMerged(
  id: string,
  userId: string | null,
  deps: Deps = defaultDeps,
): Promise<DependencyWaitView | null | "not_candidate"> {
  const row = await db.sessionDependencyWait.findUnique({ where: { id } });
  if (!row) return null;
  const view = toDependencyWaitView(row);
  if (!isClosedWaitReviewCandidate(view)) return "not_candidate";
  const after: DependencyWaitCondition[] = [...DEFAULT_IMPLEMENTATION_CONDITIONS];
  const revision: DependencyConditionRevision = {
    at: deps.now().toISOString(),
    by: userId,
    before: view.conditions,
    after,
    reason: "通常の実装の取り込み待ちとして、クローズ待ちをdevelopマージ待ちへ見直した",
  };
  // 状態が候補のままのときだけ更新する（巡回・再開と重なっても1回しか書き換えない）
  const claimed = await db.sessionDependencyWait.updateMany({
    where: { id, status: row.status, conditions: { equals: row.conditions as never } },
    data: {
      conditions: after,
      conditionHistory: [...(view.conditionHistory ?? []), revision],
      lastObservation: undefined,
      status: "WAITING",
      notifiedKey: null,
    },
  });
  if (claimed.count !== 1) return "not_candidate";
  return advanceDependencyWait(id, { manual: false }, deps);
}

export async function cancelDependencyWait(id: string): Promise<DependencyWaitView | null> {
  const row = await db.sessionDependencyWait.findUnique({ where: { id } });
  if (!row) return null;
  const updated = await db.sessionDependencyWait.update({
    where: { id },
    data: { status: "CANCELLED", activeKey: null },
  });
  return toDependencyWaitView(updated);
}

/** 観測中に解除・再試行された待ちを、古い処理の結果で上書きしない。 */
async function updateObservedWait(
  row: SessionDependencyWait,
  data: Prisma.SessionDependencyWaitUpdateManyMutationInput,
): Promise<{ applied: boolean; row: SessionDependencyWait }> {
  const result = await db.sessionDependencyWait.updateMany({
    where: {
      id: row.id,
      status: row.status,
      activeKey: row.activeKey,
      resumeJobId: row.resumeJobId,
      resumeRequestedAt: row.resumeRequestedAt,
    },
    data,
  });
  return {
    applied: result.count === 1,
    row: (await db.sessionDependencyWait.findUnique({ where: { id: row.id } })) ?? row,
  };
}

/**
 * 再開の失敗を記録する。**一時的な理由（未送信入力・作業中）で再試行が残っている間は、
 * `00.check-user`を付けずにコメントだけ残す**（#5005。巡回が間隔を空けて自動で再試行する）。
 * 再試行を使い切った・一時的でない理由のときは、従来どおり`00.check-user`＋`01.check-blocked`で人へ渡す
 * （Push通知は`check-user-push.ts`がラベルから送る）。
 */
async function failResume(row: SessionDependencyWait, reason: string, now: Date): Promise<SessionDependencyWait> {
  const failureReason = reason.slice(0, 300);
  const result = await updateObservedWait(row, { status: "RESUME_FAILED", failureReason, resumeFailedAt: now });
  if (!result.applied || result.row.status !== "RESUME_FAILED") return result.row;
  const updated = result.row;
  const dep = `${row.depRepository}#${row.depNumber}`;
  if (nextDependencyResumeRetryAt(updated)) {
    await notifyOnce(updated, `retry:${reason.slice(0, 40)}`, () =>
      postIssueComment(
        row.repositoryFullName,
        row.issueNumber,
        `依存先 ${dep} の再開条件は成立しましたが、再開の指示を見送りました。\n\n- 理由: ${reason}\n\n一時的な理由のため、間隔を空けて最大${DEPENDENCY_RESUME_AUTO_RETRY_DELAYS_MS.length}回まで自動で再試行します。入力欄に下書きが残っている場合は、送信するか消してください。`,
      ),
    );
    return updated;
  }
  const exhausted = isTransientResumeFailure(failureReason) && updated.autoRetryCount > 0;
  await notifyOnce(updated, `failed:${reason.slice(0, 40)}`, async () => {
    await postIssueComment(
      row.repositoryFullName,
      row.issueNumber,
      `依存先 ${dep} の再開条件は成立しましたが、${
        exhausted ? `自動の再試行（${updated.autoRetryCount}回）でも` : ""
      }実装を再開できませんでした。\n\n- 理由: ${reason}\n\nIssueDeckのIssue詳細から「作業を再開」で再試行できます。`,
    );
    await raiseCheckUser(row.repositoryFullName, row.issueNumber, "blocked");
  });
  return updated;
}

/**
 * 条件が成立した待ちを再開する。**`WAITING`/`NEEDS_CONFIRM`/`RESUME_FAILED`→`RESUME_REQUESTED`の
 * 遷移を`updateMany`で1本だけが取る**ので、巡回・イベント・手動操作が重なっても指示は1回しか積まない。
 */
async function requestResume(
  row: SessionDependencyWait,
  userId: string | null,
  now: Date,
  stashInput = false,
): Promise<SessionDependencyWait> {
  if (!row.activeKey || !["WAITING", "NEEDS_CONFIRM", "RESUME_FAILED"].includes(row.status)) return row;
  const claimed = await updateObservedWait(row, {
    status: "RESUME_REQUESTED",
    resumeRequestedAt: now,
    resumeJobId: null,
    resumeSentAt: null,
    resumedAt: null,
    failureReason: null,
    // 人が押した再開は、一時的な失敗の再試行回数を数え直す（自動の再試行は巡回が数える）
    ...(userId ? { autoRetryCount: 0 } : {}),
    satisfiedAt: row.satisfiedAt ?? now,
  });
  const current = claimed.row;
  if (!claimed.applied || current.status !== "RESUME_REQUESTED" || current.resumeJobId !== null) return current;

  const session = await findDispatchSessionForIssue({
    repositoryFullName: row.repositoryFullName,
    issueNumber: row.issueNumber,
  });
  if (!session || session.state !== "ALIVE") {
    // 消失・終了したセッションは、待ちの記録（理由・条件）を残したまま既存の復旧経路へ渡す。
    // 画面の「セッションを復旧」（SessionRecoveryButton）が履歴を引き継いで呼び戻す
    return failResume(
      current,
      "実装セッションが終了しています。「セッションを復旧」で履歴を引き継いで呼び戻してください",
      now,
    );
  }
  const result = await enqueueSessionControlJob({
    repositoryFullName: row.repositoryFullName,
    issueNumber: row.issueNumber,
    hostName: session.host,
    kind: "INSTRUCTION",
    instruction: buildDependencyResumeInstruction({
      repository: row.depRepository,
      number: row.depNumber,
      kind: row.depKind === "pr" ? "pr" : "issue",
    }),
    recovery: false,
    // 未送信入力の退避（#4383）。確認ダイアログを通した手動の再開だけが立てる
    stashInput,
    requestedByUserId: userId,
  });
  if (!result.ok) return failResume(current, result.message, now);
  return (await updateObservedWait(current, { resumeJobId: result.job.id })).row;
}

/**
 * 1件の待ちを前へ進める。`WAITING`系は条件を観測し直して判断し、再開の追跡中は
 * 「指示の送信」「実際に動き出したか」を確かめる。**送信しただけでは実行中にしない。**
 */
export async function advanceDependencyWait(
  id: string,
  options: { manual: boolean; userId?: string | null; stashInput?: boolean; autoRetry?: boolean },
  deps: Deps = defaultDeps,
): Promise<DependencyWaitView | null> {
  let row = await db.sessionDependencyWait.findUnique({ where: { id } });
  if (!row) return null;
  const status = parseDependencyWaitStatus(row.status) ?? "WAITING";
  const now = deps.now();

  if (status === "RESUME_REQUESTED") return toDependencyWaitView(await trackRequested(row, now));
  if (status === "RESUME_SENT") return toDependencyWaitView(await trackSent(row, now));
  if (status === "RESUMED" || status === "CANCELLED") return toDependencyWaitView(row);

  const ref: DependencyRef = {
    repository: row.depRepository,
    number: row.depNumber,
    kind: row.depKind === "pr" ? "pr" : "issue",
  };
  const conditions = parseConditions(row.conditions);

  let results: ConditionResult[];
  try {
    results = evaluateConditions(conditions, ref, await deps.observe(ref));
  } catch (error) {
    // 取得失敗は理由付きで残し、待機は維持する（次の巡回・手動の再確認で取り直す）
    const message = error instanceof Error ? error.message : "依存先の状態を取得できませんでした";
    row = (await updateObservedWait(row, { lastCheckedAt: now, lastError: message.slice(0, 300) })).row;
    return toDependencyWaitView(row);
  }

  const decision = decideDependencyWait(results);
  // 手動の「作業を再開」は、人の確認を要する条件（検証など）を人が引き受ける操作。
  // ただし**機械で判断できる未成立の条件が残っているときは再開しない**
  const manualOverride = options.manual && decision === "needs_confirm";
  const observed = await updateObservedWait(row, {
    lastCheckedAt: now,
    lastError: null,
    lastObservation: results,
    ...(status === "RESUME_FAILED" ? {} : { status: decision === "needs_confirm" ? "NEEDS_CONFIRM" : "WAITING" }),
  });
  row = observed.row;
  const expectedStatus = status === "RESUME_FAILED" ? status : decision === "needs_confirm" ? "NEEDS_CONFIRM" : "WAITING";
  if (!observed.applied || row.status !== expectedStatus) return toDependencyWaitView(row);

  if (decision === "needs_confirm" && !manualOverride) {
    await notifyOnce(row, "needs_confirm", async () => {
      await postIssueComment(
        row!.repositoryFullName,
        row!.issueNumber,
        `依存先 ${formatDependencyRef(ref)} は機械で確認できる条件を満たしましたが、人の確認が必要な条件が残っています。確認できたらIssueDeckのIssue詳細から「作業を再開」を押してください。`,
      );
      await raiseCheckUser(row!.repositoryFullName, row!.issueNumber, "input");
    });
    return toDependencyWaitView(row);
  }
  if (decision === "wait") {
    if ((options.manual || options.autoRetry) && status === "RESUME_FAILED") {
      // 失敗後の再確認で条件が崩れていたら待機へ戻す
      row = (await updateObservedWait(row, { status: "WAITING", failureReason: null })).row;
    }
    return toDependencyWaitView(row);
  }

  // 自動で再開してよいのは、全条件が機械で成立したとき（resume）か、人が押したとき
  if (decision === "resume" || manualOverride) {
    const requested = await requestResume(row, options.userId ?? null, now, options.manual && options.stashInput === true);
    return toDependencyWaitView(requested);
  }
  return toDependencyWaitView(row);
}

async function trackRequested(row: SessionDependencyWait, now: Date): Promise<SessionDependencyWait> {
  if (!row.resumeJobId) {
    // 要求を取ったがジョブを積む前に落ちた。巡回が一定時間後に失敗として拾う
    const requestedAt = row.resumeRequestedAt?.getTime() ?? now.getTime();
    if (now.getTime() - requestedAt > DEPENDENCY_WAIT_RESUME_CONFIRM_TIMEOUT_MS) {
      return failResume(row, "再開の指示を積めないまま止まりました", now);
    }
    return row;
  }
  const job = await db.dispatchJob.findUnique({
    where: { id: row.resumeJobId },
    select: { status: true, message: true, finishedAt: true },
  });
  if (!job) return failResume(row, "再開の指示ジョブが見つかりません", now);
  if (job.status === "SUCCEEDED") {
    // 巡回時刻で上書きすると、送信から巡回までに走ったツール・応答を見落とす。
    return (await updateObservedWait(row, {
      status: "RESUME_SENT",
      resumeSentAt: job.finishedAt ?? now,
    })).row;
  }
  if (job.status === "FAILED" || job.status === "TIMEOUT" || job.status === "CANCELED" || job.status === "SKIPPED") {
    // ジョブの具体的な理由を失敗理由へ載せる（#4383。「SKIPPED」だけで終えない）
    return failResume(row, describeInstructionJobFailure(job.status, job.message), now);
  }
  // 未処理のまま期限を過ぎたら、理由付きで止めて再試行を促す（送信待ちを無期限にしない）
  const requestedAt = row.resumeRequestedAt?.getTime() ?? now.getTime();
  if (now.getTime() - requestedAt > DEPENDENCY_WAIT_RESUME_CONFIRM_TIMEOUT_MS) {
    return failResume(row, "再開の指示がサブPCに取り込まれないまま期限を過ぎました。サブPCの稼働を確認して再試行してください", now);
  }
  return row;
}

async function trackSent(row: SessionDependencyWait, now: Date): Promise<SessionDependencyWait> {
  const job = row.resumeJobId
    ? await db.dispatchJob.findUnique({
        where: { id: row.resumeJobId },
        select: { status: true, claimedAt: true, finishedAt: true, targetHost: true, tmuxSessionName: true },
      })
    : null;
  const session = await findDispatchSessionForIssue({
    repositoryFullName: row.repositoryFullName,
    issueNumber: row.issueNumber,
  });
  const sentAt = row.resumeSentAt ?? now;
  // INSTRUCTIONはRUNNINGを経由しない。成功報告のHTTPより先に活動が届く場合もあるため、
  // 成功済みジョブのclaim以降を照合する。要求・キュー登録時刻は使わない。
  const activityAfter = job?.claimedAt ?? job?.finishedAt ?? sentAt;
  const activityTimes = session
    ? [
        session.stepSeenAt,
        session.activity === "WORKING" || session.activity === "RESPONDED" ? session.activityAt : null,
      ]
    : [];
  if (
    job?.status === "SUCCEEDED" &&
    session?.state === "ALIVE" &&
    session.host === job.targetHost &&
    (!job.tmuxSessionName || session.tmuxSessionName === job.tmuxSessionName) &&
    activityTimes.some((value) => value != null && Date.parse(value) > activityAfter.getTime())
  ) {
    const result = await updateObservedWait(row, { status: "RESUMED", resumedAt: now, activeKey: null });
    if (!result.applied || result.row.status !== "RESUMED") return result.row;
    await reportWaitProgress(row.repositoryFullName, row.issueNumber, "implementation", ["ready"]);
    await notifyOnce(result.row, "resumed", () =>
      postIssueComment(
        row.repositoryFullName,
        row.issueNumber,
        `依存先 ${row.depRepository}#${row.depNumber} の再開条件が成立したため、実装を再開しました。`,
      ),
    );
    return result.row;
  }
  if (now.getTime() - sentAt.getTime() > DEPENDENCY_WAIT_RESUME_CONFIRM_TIMEOUT_MS) {
    return failResume(row, "再開の指示を送りましたが、セッションが動き出したことを確認できませんでした", now);
  }
  return row;
}

/** 手動の再確認／再開（画面の「条件を再確認」「作業を再開」） */
export async function recheckDependencyWait(
  id: string,
  options: { resume: boolean; userId: string; stashInput?: boolean },
  deps: Deps = defaultDeps,
): Promise<DependencyWaitView | null> {
  return advanceDependencyWait(
    id,
    { manual: options.resume, userId: options.userId, stashInput: options.stashInput },
    deps,
  );
}

/**
 * pollerから呼ぶ1巡。イベントの欠落・サービス再起動を回収する定期照合を兼ねる。
 * 行ごとに実行権を取り、1件の障害で他を止めない。
 */
export async function runDependencyWaitSweep(
  deps: Deps = defaultDeps,
): Promise<{ scanned: number; actions: { id: string; status: string }[] }> {
  const now = deps.now();
  const rows = await db.sessionDependencyWait.findMany({ where: { activeKey: { not: null } } });
  const actions: { id: string; status: string }[] = [];
  for (const stored of rows) {
    try {
      const claim = await db.sessionDependencyWait.updateMany({
        where: {
          id: stored.id,
          OR: [
            { lastSweepAt: null },
            { lastSweepAt: { lt: new Date(now.getTime() - DEPENDENCY_WAIT_SWEEP_INTERVAL_MS) } },
          ],
        },
        data: { lastSweepAt: now },
      });
      if (claim.count !== 1) continue;
      // 失敗して止まった待ちは、人の「作業を再開」を待つ。例外は一時的な理由（未送信入力・作業中）で
      // 見送られたものだけで、間隔を空けて上限回数まで自動で再試行する（#5005）
      let autoRetry = false;
      if (stored.status === "RESUME_FAILED") {
        const retryAt = nextDependencyResumeRetryAt(stored);
        if (!retryAt || now < retryAt) continue;
        const counted = await db.sessionDependencyWait.updateMany({
          where: { id: stored.id, status: "RESUME_FAILED", autoRetryCount: stored.autoRetryCount },
          data: { autoRetryCount: stored.autoRetryCount + 1 },
        });
        if (counted.count !== 1) continue;
        autoRetry = true;
      }
      const view = await advanceDependencyWait(stored.id, { manual: false, autoRetry }, deps);
      if (view && view.status !== stored.status) actions.push({ id: stored.id, status: view.status });
    } catch (error) {
      console.error("[runDependencyWaitSweep]", stored.id, error);
    }
  }
  return { scanned: rows.length, actions };
}

/**
 * 「保留コメントと`11.local`だけが残る」既存の保留（#687相当）の依存先候補。待機の登録が無い
 * Issueのコメントから拾うだけで、**登録も再開もしない**（人が画面で確定する）。
 */
export async function findLegacyHoldCandidate(params: {
  repositoryFullName: string;
  issueNumber: number;
  commentBodies: readonly string[];
}): Promise<{ dependency: DependencyRef; excerpt: string } | null> {
  const active = await db.sessionDependencyWait.findUnique({
    where: { activeKey: activeKeyFor(params.repositoryFullName, params.issueNumber) },
  });
  if (active && isActiveDependencyWaitStatus(parseDependencyWaitStatus(active.status) ?? "WAITING")) {
    return null;
  }
  const candidate = detectLegacyHoldCandidate(params.commentBodies);
  return candidate && parseDependencyRef(candidate.dependency) ? candidate : null;
}
