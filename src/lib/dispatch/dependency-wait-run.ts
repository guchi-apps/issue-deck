import type { SessionDependencyWait } from "@prisma/client";

import { db } from "@/lib/db";
import {
  buildDependencyResumeInstruction,
  buildDependencyUrl,
  decideDependencyWait,
  detectLegacyHoldCandidate,
  evaluateConditions,
  formatDependencyRef,
  isActiveDependencyWaitStatus,
  parseDependencyRef,
  parseDependencyWaitStatus,
  DEPENDENCY_WAIT_CONDITIONS,
  type ConditionResult,
  type DependencyObservation,
  type DependencyRef,
  type DependencyWaitCondition,
  type DependencyWaitStatus,
  type DependencyWaitView,
} from "@/lib/dispatch/dependency-wait";
import { addCheckUserWithReason } from "@/lib/dispatch/check-user-labels";
import { resolveInstallationToken } from "@/lib/dispatch/installation-token";
import { enqueueSessionControlJob } from "@/lib/dispatch/jobs";
import { findDispatchSessionForIssue } from "@/lib/dispatch/sessions";
import { GithubApiError } from "@/lib/github/github-api-error";
import { createComment, fetchIssueState } from "@/lib/github/issues-api";
import { fetchPullRequest } from "@/lib/github/pull-requests-api";
import { GITHUB_API, githubFetch } from "@/lib/github/request";
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
  };
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

/**
 * 依存先の現在の状態を読む。本番（main）への反映は、マージ済みPRのマージコミットがmainの
 * 祖先かどうかで確かめる（`compare/{sha}...main`が`ahead`か`identical`なら入っている）。
 */
export async function observeDependency(ref: DependencyRef): Promise<DependencyObservation> {
  const parsed = parseRepositoryFullName(ref.repository);
  if (!parsed) throw new Error(`依存先のリポジトリ名が不正です: ${ref.repository}`);
  const token = await resolveInstallationToken(ref.repository);
  if (!token) throw new Error(`${ref.repository}はIssueDeckに接続されておらず、状態を読めません`);

  if (ref.kind === "issue") {
    const state = await fetchIssueState(parsed.owner, parsed.repo, ref.number, token);
    if (!state) throw new Error(`${formatDependencyRef(ref)}の状態を取得できませんでした`);
    return { state, merged: null, baseRef: null, inProduction: null };
  }

  const pr = await fetchPullRequest(parsed.owner, parsed.repo, ref.number, token);
  const merged = pr.merged === true;
  let inProduction: boolean | null = null;
  if (merged) {
    const sha = (pr as { merge_commit_sha?: string | null }).merge_commit_sha ?? null;
    if (sha) {
      const res = await githubFetch(
        `${GITHUB_API}/repos/${parsed.owner}/${parsed.repo}/compare/${sha}...main`,
        token,
      );
      if (res.ok) {
        const compare: { status?: string } = await res.json().catch(() => ({}));
        inProduction = compare.status === "ahead" || compare.status === "identical";
      } else if (res.status === 401) {
        throw new GithubApiError(401, "GitHub API request failed: 401");
      }
    }
  }
  return {
    state: pr.state === "closed" ? "closed" : "open",
    merged,
    baseRef: pr.base?.ref ?? null,
    inProduction,
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
  const advanced = await advanceDependencyWait(row.id, { manual: false }, deps);
  return advanced ?? toDependencyWaitView(row);
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

async function failResume(row: SessionDependencyWait, reason: string): Promise<SessionDependencyWait> {
  const updated = await db.sessionDependencyWait.update({
    where: { id: row.id },
    data: { status: "RESUME_FAILED", failureReason: reason.slice(0, 300) },
  });
  await notifyOnce(row, `failed:${reason.slice(0, 40)}`, async () => {
    await postIssueComment(
      row.repositoryFullName,
      row.issueNumber,
      `依存先 ${row.depRepository}#${row.depNumber} の再開条件は成立しましたが、実装を再開できませんでした。\n\n- 理由: ${reason}\n\nIssueDeckのIssue詳細から「作業を再開」で再試行できます。`,
    );
    await raiseCheckUser(row.repositoryFullName, row.issueNumber, "blocked");
  });
  return updated;
}

/**
 * 条件が成立した待ちを再開する。**`WAITING`/`NEEDS_CONFIRM`/`RESUME_FAILED`→`RESUME_REQUESTED`の
 * 遷移を`updateMany`で1本だけが取る**ので、巡回・イベント・手動操作が重なっても指示は1回しか積まない。
 */
async function requestResume(row: SessionDependencyWait, userId: string | null): Promise<SessionDependencyWait> {
  const claimed = await db.sessionDependencyWait.updateMany({
    where: { id: row.id, status: { in: ["WAITING", "NEEDS_CONFIRM", "RESUME_FAILED"] } },
    data: {
      status: "RESUME_REQUESTED",
      resumeRequestedAt: new Date(),
      failureReason: null,
      satisfiedAt: row.satisfiedAt ?? new Date(),
    },
  });
  const current = (await db.sessionDependencyWait.findUnique({ where: { id: row.id } })) ?? row;
  if (claimed.count !== 1) return current;

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
    requestedByUserId: userId,
  });
  if (!result.ok) return failResume(current, result.message);
  return db.sessionDependencyWait.update({
    where: { id: row.id },
    data: { resumeJobId: result.job.id },
  });
}

/**
 * 1件の待ちを前へ進める。`WAITING`系は条件を観測し直して判断し、再開の追跡中は
 * 「指示の送信」「実際に動き出したか」を確かめる。**送信しただけでは実行中にしない。**
 */
export async function advanceDependencyWait(
  id: string,
  options: { manual: boolean; userId?: string | null },
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
    row = await db.sessionDependencyWait.update({
      where: { id },
      data: { lastCheckedAt: now, lastError: message.slice(0, 300) },
    });
    return toDependencyWaitView(row);
  }

  const decision = decideDependencyWait(results);
  // 手動の「作業を再開」は、人の確認を要する条件（検証など）を人が引き受ける操作。
  // ただし**機械で判断できる未成立の条件が残っているときは再開しない**
  const manualOverride = options.manual && decision === "needs_confirm";
  row = await db.sessionDependencyWait.update({
    where: { id },
    data: {
      lastCheckedAt: now,
      lastError: null,
      lastObservation: results,
      ...(status === "RESUME_FAILED" ? {} : { status: decision === "needs_confirm" ? "NEEDS_CONFIRM" : "WAITING" }),
    },
  });

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
    if (options.manual && status === "RESUME_FAILED") {
      // 失敗後の再確認で条件が崩れていたら待機へ戻す
      row = await db.sessionDependencyWait.update({ where: { id }, data: { status: "WAITING", failureReason: null } });
    }
    return toDependencyWaitView(row);
  }

  // 自動で再開してよいのは、全条件が機械で成立したとき（resume）か、人が押したとき
  if (decision === "resume" || manualOverride) {
    const requested = await requestResume(row, options.userId ?? null);
    return toDependencyWaitView(requested);
  }
  return toDependencyWaitView(row);
}

async function trackRequested(row: SessionDependencyWait, now: Date): Promise<SessionDependencyWait> {
  if (!row.resumeJobId) {
    // 要求を取ったがジョブを積む前に落ちた。巡回が一定時間後に失敗として拾う
    const requestedAt = row.resumeRequestedAt?.getTime() ?? now.getTime();
    if (now.getTime() - requestedAt > DEPENDENCY_WAIT_RESUME_CONFIRM_TIMEOUT_MS) {
      return failResume(row, "再開の指示を積めないまま止まりました");
    }
    return row;
  }
  const job = await db.dispatchJob.findUnique({ where: { id: row.resumeJobId }, select: { status: true } });
  if (!job) return failResume(row, "再開の指示ジョブが見つかりません");
  if (job.status === "SUCCEEDED") {
    return db.sessionDependencyWait.update({
      where: { id: row.id },
      data: { status: "RESUME_SENT", resumeSentAt: now },
    });
  }
  if (job.status === "FAILED" || job.status === "TIMEOUT" || job.status === "CANCELED" || job.status === "SKIPPED") {
    return failResume(row, `再開の指示を送れませんでした（${job.status}）`);
  }
  return row;
}

async function trackSent(row: SessionDependencyWait, now: Date): Promise<SessionDependencyWait> {
  const session = await findDispatchSessionForIssue({
    repositoryFullName: row.repositoryFullName,
    issueNumber: row.issueNumber,
  });
  const sentAt = row.resumeSentAt ?? now;
  if (
    session &&
    session.state === "ALIVE" &&
    session.activity === "WORKING" &&
    session.activityAt &&
    new Date(session.activityAt).getTime() >= sentAt.getTime()
  ) {
    const updated = await db.sessionDependencyWait.update({
      where: { id: row.id },
      data: { status: "RESUMED", resumedAt: now, activeKey: null },
    });
    await notifyOnce(row, "resumed", () =>
      postIssueComment(
        row.repositoryFullName,
        row.issueNumber,
        `依存先 ${row.depRepository}#${row.depNumber} の再開条件が成立したため、実装を再開しました。`,
      ),
    );
    return updated;
  }
  if (now.getTime() - sentAt.getTime() > DEPENDENCY_WAIT_RESUME_CONFIRM_TIMEOUT_MS) {
    return failResume(row, "再開の指示を送りましたが、セッションが動き出したことを確認できませんでした");
  }
  return row;
}

/** 手動の再確認／再開（画面の「条件を再確認」「作業を再開」） */
export async function recheckDependencyWait(
  id: string,
  options: { resume: boolean; userId: string },
  deps: Deps = defaultDeps,
): Promise<DependencyWaitView | null> {
  return advanceDependencyWait(id, { manual: options.resume, userId: options.userId }, deps);
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
      // 失敗して止まった待ちは、人の「作業を再開」を待つ（自動では蒸し返さない）
      if (stored.status === "RESUME_FAILED") continue;
      const view = await advanceDependencyWait(stored.id, { manual: false }, deps);
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
