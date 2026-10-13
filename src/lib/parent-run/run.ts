import type { ParentRun, ParentRunChild, Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import type { ClaudeModel, CodexLocalModel } from "@/lib/app-settings";
import { observeDependency } from "@/lib/dispatch/dependency-wait-run";
import type { DispatchAgent } from "@/lib/dispatch/dispatch-job";
import { enqueueDispatchJob } from "@/lib/dispatch/jobs";
import { defaultVerifyDeps, getPlanView, type VerifyDeps } from "@/lib/execution-plan/register";
import { refKey, type PlanIssueRef, type PlanSnapshot } from "@/lib/execution-plan/types";
import {
  collectObservedRefs,
  evaluateRun,
  isChildReleased,
  parseChildLaunchState,
  parseParentRunStatus,
  type ChildDisplay,
  type ChildLaunchState,
  type CompletionEvidence,
  type ParentRunStatus,
  type RefObservation,
  type RunEvaluation,
} from "@/lib/parent-run/decide";

/** 同じ実行を巡回で評価し直す最短間隔。GitHub APIの消費を抑え、重なった巡回を弾く */
export const PARENT_RUN_SWEEP_INTERVAL_MS = 30 * 1000;
/** 起動の受付中のまま止まったとみなす時間（プロセスの再起動で取り残された行を未起動へ戻す） */
export const PARENT_RUN_LAUNCHING_STALE_MS = 2 * 60 * 1000;

export function activeKeyForRun(parent: PlanIssueRef): string {
  return `${parent.repository}#${parent.number}`;
}

export type RunSummary = {
  counts: RunEvaluation["counts"];
  next: string | null;
  evidence: CompletionEvidence[];
  complete: boolean;
};

export type ParentRunChildView = {
  repository: string;
  number: number;
  title: string | null;
  launchState: ChildLaunchState;
  attempt: number;
  verified: boolean;
  display: ChildDisplay;
};

export type ParentRunView = {
  id: string;
  parent: PlanIssueRef;
  status: ParentRunStatus;
  planVersion: number;
  hostName: string;
  agent: string;
  maxParallel: number;
  startedAt: string;
  notice: string | null;
  verified: boolean;
  summary: RunSummary | null;
  children: ParentRunChildView[];
};

type RunRow = ParentRun & { children: ParentRunChild[] };

function fallbackDisplay(): ChildDisplay {
  return { phase: "waiting", label: "未評価", reason: "巡回の評価待ちです", dependencies: [], prNumber: null, action: null };
}

export async function toRunView(row: RunRow, plan: PlanSnapshot | null): Promise<ParentRunView> {
  const titles = new Map((plan?.children ?? []).map((c) => [refKey(c), c.title ?? null]));
  const order = new Map((plan?.children ?? []).map((c, i) => [refKey(c), i]));
  const children = [...row.children]
    .sort((a, b) => (order.get(`${a.repository}#${a.number}`) ?? 0) - (order.get(`${b.repository}#${b.number}`) ?? 0))
    .map((c): ParentRunChildView => ({
      repository: c.repository,
      number: c.number,
      title: titles.get(`${c.repository}#${c.number}`) ?? null,
      launchState: parseChildLaunchState(c.launchState),
      attempt: c.attempt,
      verified: c.verifiedAt !== null,
      display: (c.display as ChildDisplay | null) ?? fallbackDisplay(),
    }));
  return {
    id: row.id,
    parent: { repository: row.parentRepository, number: row.parentIssue },
    status: parseParentRunStatus(row.status) ?? "RUNNING",
    planVersion: row.planVersion,
    hostName: row.hostName,
    agent: row.agent,
    maxParallel: row.maxParallel,
    startedAt: row.createdAt.toISOString(),
    notice: row.notice,
    verified: row.verifiedAt !== null,
    summary: (row.summary as RunSummary | null) ?? null,
    children,
  };
}

async function planSnapshotOf(parent: PlanIssueRef, version: number): Promise<PlanSnapshot | null> {
  const view = await getPlanView(parent, version);
  return view ? view.plan : null;
}

/** 親の最新の実行（稼働中を優先し、無ければ直近に終わったもの） */
export async function getParentRunView(parent: PlanIssueRef): Promise<ParentRunView | null> {
  const row = await db.parentRun.findFirst({
    where: { parentRepository: parent.repository, parentIssue: parent.number },
    orderBy: [{ createdAt: "desc" }],
    include: { children: true },
  });
  if (!row) return null;
  return toRunView(row, await planSnapshotOf(parent, row.planVersion));
}

export type StartParentRunParams = {
  parent: PlanIssueRef;
  userId: string;
  hostName: string;
  agent: DispatchAgent;
  claudeModel?: ClaudeModel | null;
  codexModel?: CodexLocalModel | null;
  maxParallel?: number;
};

export type StartParentRunResult =
  | { ok: true; run: ParentRunView }
  | { ok: false; status: number; error: string; message: string };

/**
 * 親の実行を開始する。**開始時の計画版へ結びつけ、対象の子をその版から固定する**
 * （以後に計画・子一覧が変わっても、稼働中の対象は黙って増減しない）。
 * 稼働中の実行がある親は`activeKey`のunique制約で2件目を作れない（連打・複数タブでも1件）。
 */
export async function startParentRun(params: StartParentRunParams, deps: Deps = defaultDeps): Promise<StartParentRunResult> {
  const plan = await getPlanView(params.parent);
  if (!plan) {
    return { ok: false, status: 404, error: "plan_not_found", message: "実行計画が登録されていません。計画を登録してから開始してください" };
  }
  const maxParallel = Math.min(Math.max(Math.trunc(params.maxParallel ?? 2), 1), 8);
  const planVersion = plan.currentVersion;
  let runId: string;
  try {
    const created = await db.$transaction(async (tx) => {
      // 稼働中の実行が無いときだけ、結びつける版を現在版へ更新する（再計画後の再実行）
      await tx.executionPlan.updateMany({
        where: { parentRepository: params.parent.repository, parentIssue: params.parent.number },
        data: { boundVersion: planVersion },
      });
      return tx.parentRun.create({
        data: {
          parentRepository: params.parent.repository,
          parentIssue: params.parent.number,
          planVersion,
          hostName: params.hostName,
          agent: params.agent,
          claudeModel: params.claudeModel ?? null,
          codexModel: params.codexModel ?? null,
          maxParallel,
          status: "RUNNING",
          startedByUserId: params.userId,
          activeKey: activeKeyForRun(params.parent),
          children: { create: plan.plan.children.map((c) => ({ repository: c.repository, number: c.number })) },
        },
      });
    });
    runId = created.id;
  } catch {
    return { ok: false, status: 409, error: "already_running", message: "この親は既に実行中です。一時停止・再開は実行中のパネルから行ってください" };
  }
  // 次の巡回を待たず、開始の直後に最初の評価と起動まで進める。失敗しても実行自体は有効で、巡回が拾う
  try {
    const row = await db.parentRun.findUniqueOrThrow({ where: { id: runId }, include: { children: true } });
    await advanceRun(row, deps);
  } catch (error) {
    console.error("[parent-run] 開始直後の評価に失敗しました（次の巡回で再試行します）", error);
  }
  const view = await getParentRunView(params.parent);
  return { ok: true, run: view as ParentRunView };
}

export type Deps = {
  verify: VerifyDeps;
  observePr: (ref: PlanIssueRef & { number: number }) => Promise<{ merged: boolean; inProduction: boolean | null; integration?: boolean }>;
  enqueue: typeof enqueueDispatchJob;
  now: () => Date;
};

export const defaultDeps: Deps = {
  verify: defaultVerifyDeps,
  observePr: async (ref) => {
    const o = await observeDependency({ repository: ref.repository, number: ref.number, kind: "pr" });
    // developへのマージとmainへのマージを取り違えない（#4570）。統合ブランチが不明なら検査しない
    const integration = o.integrationBranch ? o.baseRef === o.integrationBranch : undefined;
    return { merged: o.merged === true, inProduction: o.inProduction, integration };
  },
  enqueue: enqueueDispatchJob,
  now: () => new Date(),
};

/** 1つのIssueの現在の状態を集める。**取得できなかった項目は`error`として残し、完了とは扱わない** */
export async function observeRef(ref: PlanIssueRef, child: ParentRunChild | undefined, deps: Deps): Promise<RefObservation> {
  const base: RefObservation = { issue: "error", pr: { kind: "error", message: "未取得" }, needsUser: false, jobStatus: null, sessionAlive: false };
  const token = await deps.verify.tokenFor(ref.repository).catch(() => null);
  if (!token) {
    const message = `${ref.repository}はIssueDeckに接続されていないか、権限がありません`;
    return { ...base, error: message, pr: { kind: "error", message } };
  }
  try {
    const state = await deps.verify.issueState(ref, token);
    if (state === null) return { ...base, issue: "missing", pr: { kind: "none" } };
    base.issue = state;
  } catch (error) {
    const message = error instanceof Error ? error.message : "不明";
    return { ...base, error: message, pr: { kind: "error", message } };
  }
  try {
    const resolved = await deps.verify.branchPrs(ref, token);
    if (resolved.kind === "one") {
      const obs = await deps.observePr({ repository: ref.repository, number: resolved.number });
      base.pr = { kind: "one", number: resolved.number, merged: obs.merged, inProduction: obs.inProduction, integration: obs.integration };
    } else {
      base.pr = resolved;
    }
  } catch (error) {
    base.pr = { kind: "error", message: error instanceof Error ? error.message : "不明" };
  }
  const issueRow = await db.issue.findFirst({
    where: { number: ref.number, repository: { fullName: ref.repository } },
    select: { checkUserLabeledAt: true },
  });
  base.needsUser = issueRow?.checkUserLabeledAt != null;
  if (child?.jobId) {
    const job = await db.dispatchJob.findUnique({ where: { id: child.jobId }, select: { status: true } });
    base.jobStatus = job?.status ?? null;
  }
  const alive = await db.dispatchSession.findFirst({
    where: { repositoryFullName: ref.repository, issueNumber: ref.number, state: "ALIVE" },
    select: { id: true },
  });
  base.sessionAlive = alive !== null;
  return base;
}

const RECOVERABLE_REJECTIONS = new Set(["host_offline", "agent_not_capable", "agent_paused"]);

/**
 * 実行1件を評価して進める。**評価はDBの状態とGitHubの現状から毎回やり直す**ので、プロセスの再起動・
 * 巡回の取りこぼしがあっても、次の巡回で同じ結論に戻る。対象は開始時の子だけで、広げない。
 */
export async function advanceRun(row: RunRow, deps: Deps = defaultDeps): Promise<{ launched: string[] }> {
  const status = parseParentRunStatus(row.status) ?? "RUNNING";
  const parent = { repository: row.parentRepository, number: row.parentIssue };
  const plan = await planSnapshotOf(parent, row.planVersion);
  if (!plan) {
    await db.parentRun.update({ where: { id: row.id }, data: { notice: `結びつけた計画v${row.planVersion}が見つかりません。実行を進められません` } });
    return { launched: [] };
  }

  // 起動の受付中のまま止まった行（再起動で取り残された）は未起動へ戻す。ジョブが積まれていれば
  // 次の起動で`already_queued`/`session_alive`になり、同じ子が二重に起動されることはない
  const staleBefore = new Date(deps.now().getTime() - PARENT_RUN_LAUNCHING_STALE_MS);
  await db.parentRunChild.updateMany({
    where: { runId: row.id, launchState: "LAUNCHING", updatedAt: { lt: staleBefore } },
    data: { launchState: "PENDING" },
  });
  const children = await db.parentRunChild.findMany({ where: { runId: row.id } });
  const childByKey = new Map(children.map((c) => [`${c.repository}#${c.number}`, c]));

  // 開始時の対象だけ（子と、その依存先）を観測する
  const refs = collectObservedRefs(plan);
  const observations = new Map<string, RefObservation>();
  await Promise.all(
    refs.map(async (ref) => {
      observations.set(refKey(ref), await observeRef(ref, childByKey.get(refKey(ref)), deps));
    }),
  );

  const evaluation = evaluateRun({
    plan,
    status,
    maxParallel: row.maxParallel,
    children: plan.children.flatMap((child) => {
      const c = childByKey.get(refKey(child));
      return c ? [{ child, launchState: parseChildLaunchState(c.launchState), verifiedAt: c.verifiedAt, lastError: c.lastError }] : [];
    }),
    observations,
    parentVerifiedAt: row.verifiedAt,
  });

  const overrides = new Map<string, Partial<ChildDisplay>>();
  const launched: string[] = [];
  for (const key of evaluation.toLaunch) {
    const child = childByKey.get(key);
    if (!child) continue;
    // 起動の取得は条件付き更新で1つの巡回・操作だけが通る（連打・巡回競合・複数インスタンス）
    const claimed = await db.parentRunChild.updateMany({
      where: { id: child.id, launchState: "PENDING", attempt: child.attempt },
      data: { launchState: "LAUNCHING", lastError: null },
    });
    if (claimed.count !== 1) continue;
    const result = await deps.enqueue({
      repositoryFullName: child.repository,
      issueNumber: child.number,
      hostName: row.hostName,
      agent: row.agent === "codex" ? "codex" : "claude",
      claudeModel: (row.claudeModel as ClaudeModel | null) ?? null,
      codexModel: (row.codexModel as CodexLocalModel | null) ?? null,
      requestedByUserId: row.startedByUserId,
    }).catch((error: unknown) => ({ ok: false as const, rejection: "error" as const, message: error instanceof Error ? error.message : "不明" }));
    if (result.ok) {
      await db.parentRunChild.update({
        where: { id: child.id },
        data: { launchState: "LAUNCHED", jobId: result.job.id, launchedAt: deps.now(), lastError: null },
      });
      launched.push(key);
      overrides.set(key, { phase: "running", label: "起動待ち", reason: "ジョブを積みました。ホストが受け取り次第、起動します" });
    } else if (result.rejection === "already_queued" || result.rejection === "session_alive") {
      // 既に動いている子は再利用する（二重起動しない）
      await db.parentRunChild.update({ where: { id: child.id }, data: { launchState: "LAUNCHED", launchedAt: deps.now() } });
      overrides.set(key, { phase: "running", label: "実行中", reason: "既存の実行を再利用しています" });
    } else if (RECOVERABLE_REJECTIONS.has(result.rejection)) {
      await db.parentRunChild.update({ where: { id: child.id }, data: { launchState: "PENDING", lastError: result.message.slice(0, 500) } });
      overrides.set(key, { phase: "waiting", label: "待機（実行先）", reason: `${result.message}（回復し次第、自動で再試行します）` });
    } else {
      await db.parentRunChild.update({
        where: { id: child.id },
        data: { launchState: "LAUNCH_FAILED", lastError: result.message.slice(0, 500) },
      });
      overrides.set(key, { phase: "attention", label: "起動失敗", reason: result.message, action: "retry" });
    }
  }

  // 画面用の状態を保存する。ここで起動した子の表示は、起動の結果で上書きする
  for (const e of evaluation.children) {
    const key = refKey(e.child);
    const child = childByKey.get(key);
    if (!child) continue;
    const display = { ...e.display, ...(overrides.get(key) ?? {}) };
    await db.parentRunChild.update({ where: { id: child.id }, data: { display: display as unknown as Prisma.InputJsonValue } });
  }

  const planView = await getPlanView(parent);
  const notice =
    planView && planView.currentVersion > row.planVersion
      ? `計画に新しい版（v${planView.currentVersion}）があります。この実行はv${row.planVersion}の対象のまま進みます`
      : null;
  const summary: RunSummary = {
    counts: evaluation.counts,
    next: evaluation.next,
    evidence: evaluation.completion.evidence,
    complete: evaluation.completion.complete,
  };
  const complete = evaluation.completion.complete && status !== "STOPPED";
  await db.parentRun.update({
    where: { id: row.id },
    data: {
      notice,
      summary: summary as unknown as Prisma.InputJsonValue,
      ...(complete ? { status: "COMPLETED", activeKey: null } : {}),
    },
  });
  return { launched };
}

/** pollerの巡回。稼働中（PAUSEDを含む）の実行を、間隔を空けて1件ずつ進める。1件の例外は他を止めない */
export async function runParentRunSweep(deps: Deps = defaultDeps): Promise<{ actions: { runId: string; launched: string[] }[] }> {
  const now = deps.now();
  const rows = await db.parentRun.findMany({ where: { activeKey: { not: null } }, select: { id: true } });
  const actions: { runId: string; launched: string[] }[] = [];
  for (const { id } of rows) {
    const claimed = await db.parentRun.updateMany({
      where: { id, activeKey: { not: null }, OR: [{ lastSweepAt: null }, { lastSweepAt: { lt: new Date(now.getTime() - PARENT_RUN_SWEEP_INTERVAL_MS) } }] },
      data: { lastSweepAt: now },
    });
    if (claimed.count !== 1) continue;
    try {
      const row = await db.parentRun.findUnique({ where: { id }, include: { children: true } });
      if (!row || row.activeKey === null) continue;
      const result = await advanceRun(row, deps);
      if (result.launched.length > 0) actions.push({ runId: id, launched: result.launched });
    } catch (error) {
      console.error(`[parent-run] 巡回に失敗しました (${id})`, error);
    }
  }
  return { actions };
}

export type RunAction =
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stop" }
  | { type: "retry"; child: PlanIssueRef }
  | { type: "verify"; child?: PlanIssueRef };

export type RunActionResult = { ok: true; run: ParentRunView } | { ok: false; status: number; error: string; message: string };

/**
 * 実行への操作。**一時停止は新規起動だけを止め**、起動済みの子には触らない。停止は未起動の子を起動しない
 * 状態にして実行を閉じる（起動済みの子の中止は、既存の子ごとの中止経路を使う）。
 */
export async function applyRunAction(parent: PlanIssueRef, action: RunAction, deps: Deps = defaultDeps): Promise<RunActionResult> {
  const row = await db.parentRun.findFirst({
    where: { parentRepository: parent.repository, parentIssue: parent.number },
    orderBy: { createdAt: "desc" },
    include: { children: true },
  });
  const fail = (status: number, error: string, message: string): RunActionResult => ({ ok: false, status, error, message });
  if (!row) return fail(404, "run_not_found", "この親の実行がありません");
  const status = parseParentRunStatus(row.status) ?? "RUNNING";
  const active = row.activeKey !== null;

  switch (action.type) {
    case "pause": {
      if (!active || status !== "RUNNING") return fail(409, "not_running", "進行中の実行ではありません");
      await db.parentRun.update({ where: { id: row.id }, data: { status: "PAUSED" } });
      break;
    }
    case "resume": {
      if (!active || status !== "PAUSED") return fail(409, "not_paused", "一時停止中の実行ではありません");
      await db.parentRun.update({ where: { id: row.id }, data: { status: "RUNNING", lastSweepAt: null } });
      break;
    }
    case "stop": {
      if (!active) return fail(409, "not_active", "既に終了している実行です");
      await db.$transaction([
        db.parentRunChild.updateMany({ where: { runId: row.id, launchState: { in: ["PENDING", "LAUNCH_FAILED"] } }, data: { launchState: "SKIPPED" } }),
        db.parentRun.update({ where: { id: row.id }, data: { status: "STOPPED", activeKey: null } }),
      ]);
      break;
    }
    case "retry": {
      if (!active) return fail(409, "not_active", "終了した実行の子は再試行できません。新しく開始してください");
      const child = row.children.find((c) => c.repository === action.child.repository && c.number === action.child.number);
      if (!child) return fail(404, "child_not_found", "この実行の対象に含まれない子です（開始時の対象は広げません）");
      // 再試行は同じ子・同じ計画で、試行番号を進めて取り直す。成果（PR・セッション）は引き継ぐ
      const reset = await db.parentRunChild.updateMany({
        where: { id: child.id, launchState: { in: ["LAUNCH_FAILED", "LAUNCHED", "SKIPPED"] } },
        data: { launchState: "PENDING", attempt: { increment: 1 }, jobId: null, lastError: null },
      });
      if (reset.count !== 1) return fail(409, "not_retryable", "再試行できる状態ではありません");
      await db.parentRun.update({ where: { id: row.id }, data: { lastSweepAt: null } });
      break;
    }
    case "verify": {
      const now = deps.now();
      if (action.child) {
        const child = row.children.find((c) => c.repository === action.child?.repository && c.number === action.child?.number);
        if (!child) return fail(404, "child_not_found", "この実行の対象に含まれない子です");
        // 記録の前に、実装PRのdevelopマージ・main反映をサーバー側で観測し直す（未完了の子へ記録させない）
        const obs = await observeRef({ repository: child.repository, number: child.number }, child, deps);
        if (!isChildReleased(obs)) {
          return fail(409, "child_not_released", "実装PRのdevelopマージとmainへの反映を確認できないため、本番確認を記録できません");
        }
        await db.parentRunChild.update({ where: { id: child.id }, data: { verifiedAt: now } });
      } else {
        // 親全体の確認も、記録の前に全ての子を再観測する（未完了のまま記録させない）
        const plan = await planSnapshotOf(parent, row.planVersion);
        if (!plan) return fail(409, "plan_not_found", "結びつけた計画が見つからないため、本番確認を記録できません");
        const childByKey = new Map(row.children.map((c) => [`${c.repository}#${c.number}`, c]));
        const unreleased: string[] = [];
        await Promise.all(
          plan.children.map(async (c) => {
            const obs = await observeRef(c, childByKey.get(refKey(c)), deps);
            if (!isChildReleased(obs)) unreleased.push(refKey(c));
          }),
        );
        if (unreleased.length > 0) {
          return fail(409, "children_not_released", `実装PRのdevelopマージとmainへの反映を確認できない子があるため、本番確認を記録できません: ${unreleased.join(", ")}`);
        }
        await db.parentRun.update({ where: { id: row.id }, data: { verifiedAt: now } });
      }
      if (active) await db.parentRun.update({ where: { id: row.id }, data: { lastSweepAt: null } });
      break;
    }
  }
  // 操作の結果をすぐ画面へ返すため、稼働中なら評価し直す（失敗しても操作自体は成立している）
  if (action.type !== "stop") {
    try {
      const fresh = await db.parentRun.findUnique({ where: { id: row.id }, include: { children: true } });
      if (fresh && fresh.activeKey !== null) await advanceRun(fresh, deps);
    } catch (error) {
      console.error("[parent-run] 操作後の評価に失敗しました", error);
    }
  }
  const view = await getParentRunView(parent);
  return { ok: true, run: view as ParentRunView };
}

/** 一覧の行に出す印（#4536）。稼働中・一時停止中・要対応がある実行だけを軽く返す */
export type ParentRunBadge = {
  repositoryFullName: string;
  issueNumber: number;
  status: ParentRunStatus;
  counts: RunEvaluation["counts"] | null;
};

export async function listParentRunBadges(): Promise<ParentRunBadge[]> {
  const rows = await db.parentRun.findMany({
    where: { activeKey: { not: null } },
    select: { parentRepository: true, parentIssue: true, status: true, summary: true },
  });
  return rows.map((r) => ({
    repositoryFullName: r.parentRepository,
    issueNumber: r.parentIssue,
    status: parseParentRunStatus(r.status) ?? "RUNNING",
    counts: (r.summary as RunSummary | null)?.counts ?? null,
  }));
}
