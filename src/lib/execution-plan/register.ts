import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { resolveInstallationToken } from "@/lib/dispatch/installation-token";
import { diffPlans, validateReplan, type PlanDiff } from "@/lib/execution-plan/diff";
import { formatRef, refKey, type PlanIssue, type PlanIssueRef, type PlanSnapshot } from "@/lib/execution-plan/types";
import { parsePlanInput, computeStages } from "@/lib/execution-plan/validate";
import { fetchIssueStateOrThrow } from "@/lib/github/issues-api";
import { GITHUB_API, githubFetch } from "@/lib/github/request";
import { fetchSubIssueRelations } from "@/lib/github/sub-issues-api";
import { parseRepositoryFullName } from "@/lib/local-session";

/**
 * 子Issueの実装PRの探し方。**`issue-<番号>`ブランチをheadとするPR**（運用の規約）。
 * `merged`/`released`条件はIssueでは機械判定できない（`evaluateConditions`はPR参照だけを評価する）ため、
 * 実行側（#4536）はここで解決したPRへ`observeDependency`を向ける。
 * `none`（まだPRが無い）は、これから着手する子では正常。成立とはみなさない。
 */
export type BranchPrResolution = { kind: "none" } | { kind: "one"; number: number } | { kind: "many"; numbers: number[] };

export type VerifyDeps = {
  /** 接続されていない（権限外）リポジトリは`null` */
  tokenFor: (repository: string) => Promise<string | null>;
  /** 存在しなければ`null`。取得失敗は投げる（「存在しない」と区別する） */
  issueState: (ref: PlanIssueRef, token: string) => Promise<"open" | "closed" | null>;
  branchPrs: (ref: PlanIssueRef, token: string) => Promise<BranchPrResolution>;
  subIssues: (ref: PlanIssueRef, token: string) => Promise<PlanIssueRef[]>;
};

export const defaultVerifyDeps: VerifyDeps = {
  tokenFor: resolveInstallationToken,
  issueState: async (ref, token) => {
    const parsed = parseRepositoryFullName(ref.repository);
    if (!parsed) return null;
    return fetchIssueStateOrThrow(parsed.owner, parsed.repo, ref.number, token);
  },
  branchPrs: async (ref, token) => {
    const parsed = parseRepositoryFullName(ref.repository);
    if (!parsed) return { kind: "none" };
    const url =
      `${GITHUB_API}/repos/${parsed.owner}/${parsed.repo}/pulls` +
      `?head=${encodeURIComponent(`${parsed.owner}:issue-${ref.number}`)}&state=all&per_page=20`;
    const res = await githubFetch(url, token);
    if (!res.ok) throw new Error(`PRの確認に失敗しました（${formatRef(ref)}: HTTP ${res.status}）`);
    const pulls = (await res.json()) as { number: number; state: string; merged_at: string | null }[];
    // マージされずに閉じられたPRは実装の証拠ではない
    const live = pulls.filter((p) => p.state === "open" || p.merged_at);
    if (live.length === 0) return { kind: "none" };
    if (live.length === 1) return { kind: "one", number: live[0].number };
    return { kind: "many", numbers: live.map((p) => p.number) };
  },
  subIssues: async (ref, token) => {
    const parsed = parseRepositoryFullName(ref.repository);
    if (!parsed) return [];
    const relations = await fetchSubIssueRelations(token, parsed.owner, parsed.repo, ref.number);
    return relations.children.map((c) => ({ repository: c.repositoryFullName, number: c.number }));
  },
};

export type VerifyResult = {
  errors: PlanIssue[];
  /** 登録は妨げないが人が知るべきこと（GitHubのサブIssueと計画の不一致など） */
  warnings: string[];
  /** 完了済み（クローズ）の子 */
  closed: Set<string>;
};

/**
 * 計画をGitHubと照合する。**取得に失敗した対象は「存在しない」「依存なし」「完了」のいずれにも解釈せず、
 * 登録不可のエラーにする。** 同じ対象への問い合わせは1回にまとめる。
 */
export async function verifyPlanAgainstGithub(
  parent: PlanIssueRef,
  plan: PlanSnapshot,
  deps: VerifyDeps = defaultVerifyDeps,
): Promise<VerifyResult> {
  const errors: PlanIssue[] = [];
  const warnings: string[] = [];
  const closed = new Set<string>();
  const tokens = new Map<string, string | null>();
  const states = new Map<string, "open" | "closed" | null | "failed">();

  const token = async (repository: string): Promise<string | null> => {
    if (!tokens.has(repository)) tokens.set(repository, await deps.tokenFor(repository).catch(() => null));
    return tokens.get(repository) ?? null;
  };
  const check = async (ref: PlanIssueRef, path: string, label: string) => {
    const key = refKey(ref);
    if (!states.has(key)) {
      const t = await token(ref.repository);
      if (!t) {
        states.set(key, "failed");
        errors.push({ path, message: `${label} ${key}: ${ref.repository}はIssueDeckに接続されていないか権限外です` });
      } else {
        try {
          const state = await deps.issueState(ref, t);
          states.set(key, state);
          if (state === null) errors.push({ path, message: `${label} ${key}は存在しません` });
        } catch (error) {
          states.set(key, "failed");
          errors.push({ path, message: `${label} ${key}の取得に失敗しました（${error instanceof Error ? error.message : "不明"}）。存在・完了のどちらとも判断しません` });
        }
      }
    }
    return states.get(key);
  };

  await check(parent, "parent", "親Issue");
  for (const [i, child] of plan.children.entries()) {
    const state = await check(child, `children[${i}]`, "子Issue");
    if (state === "closed") closed.add(refKey(child));
    for (const [j, dep] of child.dependsOn.entries()) {
      const path = `children[${i}].dependsOn[${j}]`;
      await check(dep, path, "依存先");
      if (!dep.conditions.some((c) => c === "merged" || c === "released")) continue;
      // merged/releasedは実装PRへ解決して評価する。取得失敗・曖昧は登録不可、PR未作成は着手前として許容する
      const t = await token(dep.repository);
      if (!t || states.get(refKey(dep)) === "failed" || states.get(refKey(dep)) === null) continue;
      try {
        const pr = await deps.branchPrs(dep, t);
        if (pr.kind === "many") {
          errors.push({ path, message: `${refKey(dep)}の実装ブランチ（issue-${dep.number}）に対応するPRが複数あり（${pr.numbers.map((n) => `#${n}`).join(", ")}）、merged/releasedを一意に評価できません` });
        } else if (pr.kind === "none" && states.get(refKey(dep)) === "closed") {
          errors.push({ path, message: `${refKey(dep)}はクローズ済みで実装PRが無いため、merged/releasedは成立しません。closedを使うかPRを明示してください` });
        }
      } catch (error) {
        errors.push({ path, message: `${refKey(dep)}の実装PRの確認に失敗しました（${error instanceof Error ? error.message : "不明"}）` });
      }
    }
  }

  // GitHubネイティブのサブIssueとの対応（親が取得できたときだけ）
  const parentToken = await token(parent.repository);
  if (parentToken && states.get(refKey(parent)) && states.get(refKey(parent)) !== "failed") {
    try {
      const native = new Set((await deps.subIssues(parent, parentToken)).map(refKey));
      const planned = new Set(plan.children.map(refKey));
      const notLinked = [...planned].filter((k) => !native.has(k));
      const unplanned = [...native].filter((k) => !planned.has(k));
      if (notLinked.length) warnings.push(`GitHubのサブIssueに未登録の子があります: ${notLinked.join(", ")}（計画は有効。親子リンクは別途必要です）`);
      if (unplanned.length) warnings.push(`GitHub上のサブIssueで計画に含まれないものがあります: ${unplanned.join(", ")}（実行対象にはなりません）`);
    } catch (error) {
      errors.push({ path: "parent", message: `親のサブIssueの取得に失敗しました（${error instanceof Error ? error.message : "不明"}）` });
    }
  }
  return { errors, warnings, closed };
}

export type PlanView = {
  parent: PlanIssueRef;
  currentVersion: number;
  boundVersion: number | null;
  plan: PlanSnapshot;
  stages: string[][];
  versions: { version: number; changeNote: string; author: string; createdAt: string }[];
};

type RegisterResult =
  | { ok: true; view: PlanView; diff: PlanDiff | null; warnings: string[] }
  | { ok: false; status: number; errors: PlanIssue[] };

function toView(
  row: { parentRepository: string; parentIssue: number; currentVersion: number; boundVersion: number | null },
  versions: { version: number; snapshot: unknown; changeNote: string; author: string; createdAt: Date }[],
): PlanView {
  const current = versions.find((v) => v.version === row.currentVersion);
  const plan = current?.snapshot as PlanSnapshot;
  return {
    parent: { repository: row.parentRepository, number: row.parentIssue },
    currentVersion: row.currentVersion,
    boundVersion: row.boundVersion,
    plan,
    stages: computeStages(plan).map((stage) => stage.map(refKey)),
    versions: versions
      .map((v) => ({ version: v.version, changeNote: v.changeNote, author: v.author, createdAt: v.createdAt.toISOString() }))
      .sort((a, b) => a.version - b.version),
  };
}

export async function getPlanView(parent: PlanIssueRef, version?: number): Promise<PlanView | null> {
  const row = await db.executionPlan.findUnique({
    where: { parentRepository_parentIssue: { parentRepository: parent.repository, parentIssue: parent.number } },
    include: { versions: true },
  });
  if (!row) return null;
  const view = toView(row, row.versions);
  if (version === undefined) return view;
  const target = row.versions.find((v) => v.version === version);
  if (!target) return null;
  const plan = target.snapshot as PlanSnapshot;
  return { ...view, plan, stages: computeStages(plan).map((s) => s.map(refKey)) };
}

/**
 * 計画を登録する（初回）か、新しい版として更新する。**検証に通らなければ何も保存しない。**
 * 更新は`expectedVersion`（直前に読んだ版）が現在版と一致するときだけ受け付ける（競合する更新を上書きしない）。
 */
export async function savePlan(params: {
  parent: PlanIssueRef;
  payload: unknown;
  author: string;
  changeNote: string;
  expectedVersion?: number;
  confirmRemove?: string[];
  deps?: VerifyDeps;
}): Promise<RegisterResult> {
  const parsed = parsePlanInput(params.payload, params.parent);
  if (!parsed.ok) return { ok: false, status: 400, errors: parsed.errors };
  const note = params.changeNote.trim().slice(0, 300);
  if (!note) return { ok: false, status: 400, errors: [{ path: "changeNote", message: "変更理由が必要です" }] };

  const existing = await db.executionPlan.findUnique({
    where: { parentRepository_parentIssue: { parentRepository: params.parent.repository, parentIssue: params.parent.number } },
    include: { versions: true },
  });
  if (existing && params.expectedVersion !== existing.currentVersion) {
    return {
      ok: false,
      status: 409,
      errors: [{ path: "expectedVersion", message: `現在の版はv${existing.currentVersion}です。最新を取得して指定してください` }],
    };
  }

  const verified = await verifyPlanAgainstGithub(params.parent, parsed.plan, params.deps);
  const errors = [...verified.errors];
  let diff: PlanDiff | null = null;
  if (existing) {
    const prev = existing.versions.find((v) => v.version === existing.currentVersion)?.snapshot as PlanSnapshot;
    diff = diffPlans(prev, parsed.plan);
    errors.push(
      ...validateReplan(prev, parsed.plan, { completed: verified.closed, confirmRemove: new Set(params.confirmRemove ?? []) }),
    );
  }
  if (errors.length > 0) return { ok: false, status: 422, errors };

  const snapshot = parsed.plan as unknown as Prisma.InputJsonValue;
  if (!existing) {
    try {
      await db.executionPlan.create({
        data: {
          parentRepository: params.parent.repository,
          parentIssue: params.parent.number,
          currentVersion: 1,
          createdBy: params.author,
          versions: { create: { version: 1, snapshot, changeNote: note, author: params.author } },
        },
      });
    } catch {
      return { ok: false, status: 409, errors: [{ path: "parent", message: "同じ親の計画が同時に登録されました。取得し直してください" }] };
    }
  } else {
    const next = existing.currentVersion + 1;
    // 条件付き更新で、同時に走った更新のどちらか1本だけが版を進める
    const advanced = await db.executionPlan.updateMany({
      where: { id: existing.id, currentVersion: existing.currentVersion },
      data: { currentVersion: next },
    });
    if (advanced.count !== 1) {
      return { ok: false, status: 409, errors: [{ path: "expectedVersion", message: "同時に更新されました。取得し直してください" }] };
    }
    await db.executionPlanVersion.create({
      data: { planId: existing.id, version: next, snapshot, changeNote: note, author: params.author },
    });
  }
  const view = await getPlanView(params.parent);
  return { ok: true, view: view as PlanView, diff, warnings: verified.warnings };
}

/** 実行（#4536）が開始時の版へ結びつく。以降の計画変更は結びつけた版に影響しない */
export async function bindPlanVersion(parent: PlanIssueRef, version: number): Promise<boolean> {
  const row = await db.executionPlan.findUnique({
    where: { parentRepository_parentIssue: { parentRepository: parent.repository, parentIssue: parent.number } },
  });
  if (!row || version > row.currentVersion || version < 1) return false;
  const res = await db.executionPlan.updateMany({
    where: { id: row.id, boundVersion: null },
    data: { boundVersion: version },
  });
  return res.count === 1;
}
