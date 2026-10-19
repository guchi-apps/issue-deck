/**
 * 「おまかせ」のモデル判定の当たり外れを測る集計（#4852）。**計器であって役ではない。**
 *
 * Sonnet 5.5とOpus 5.5の単価差は2倍にとどまるため、Sonnetがやり直しを1回起こすと節約分は
 * 消える。判定の基準（Jevの確率しきい値・ルールでSonnetへ振る範囲）を勘ではなくデータで
 * 見直せるよう、Issueごとに「実際に走ったモデル × 判定の経路」と、やり直しの指標・費用を結ぶ。
 *
 * - **単位はIssue。** 期間内に最初に積まれたClaudeの起動ジョブを「判定の記録」とし、同じIssueの
 *   後続の起動ジョブを「再起動」として数える
 * - **モデルの軸は実際に走ったモデル。** `DispatchJob.claudeModel`は`auto`のこともあるため使わず、
 *   そのIssueの実装セッション（`SessionUsage`の`source=local`・`kind=implementation`）の主モデルを
 *   採る。無ければ判定が出したモデル（`modelPickModel`。#4853）、それも無ければ`unknown`
 * - **修復の実行は`SessionUsage`のGitHub Actions行で数える。** `PullRequestRepairRun`はPR×種別で
 *   1行に上書きされ回数が残らないため使わない。`workflowName`は`GITHUB_WORKFLOW`（callerの`name:`）
 *   なので表示名で判定する（`repairWorkflowKind`）。PR番号しか持たない行（PR Repair）は、同じPRで
 *   Issue番号も持つ別の行からIssueを引く
 * - Claude自動レビューの「要修正」はDBに残らない（PRコメントのマーカーだけ）。review-fixの実行で近似する
 *
 * DBに触れない純関数にしてあり、受け口（`/api/dispatch/model-pick-outcomes`）がDBの行を渡す。
 */

import { pickPrimaryModel } from "@/lib/agent-model-color";

/** 判定の経路。`manual`は判定を使わず人が選んだ起動、`unrecorded`は#4853より前の行など記録の無いもの */
export type ModelPickOutcomeRoute = "jev" | "ai" | "rule" | "manual" | "unrecorded";

/** 実際に走ったモデルの系統 */
export type ModelPickOutcomeModel = "opus" | "sonnet" | "fable" | "haiku" | "unknown";

export type RepairWorkflowKind = "ci-fix" | "conflict-resolve" | "pr-repair" | "review-fix";

/** Jevの確率帯。しきい値の見直しの材料にするため、Sonnetを選んだ確率で分ける */
export type JevProbabilityBand = "high" | "low" | "none";

/** Jevの確率帯の境目（P(sonnet) ≥ 0.7）。docs/multi-agent/prompts-and-models.mdの見直し基準と揃える */
export const JEV_SONNET_PROBABILITY_THRESHOLD = 0.7;

export type ModelPickOutcomeLaunch = {
  repositoryFullName: string;
  issueNumber: number;
  createdAt: Date;
  claudeModel: string | null;
  modelPickSource: string | null;
  modelPickModel: string | null;
  modelPickProbabilities: unknown;
};

export type ModelPickOutcomeUsage = {
  source: string;
  kind: string;
  /** ownerを除いたリポジトリ名（`SessionUsage.repository`） */
  repository: string | null;
  issueNumber: number | null;
  prNumber: number | null;
  workflowName: string | null;
  costUsd: number;
  models: string[];
};

export type ModelPickOutcomeIssue = {
  repositoryFullName: string;
  issueNumber: number;
  route: ModelPickOutcomeRoute;
  model: ModelPickOutcomeModel;
  /** 判定が出したモデル（`modelPickModel`）。記録が無ければnull */
  pickedModel: string | null;
  /** 判定が出したモデルと実際に走ったモデルが違った（人が上書きした）か。比べられなければnull */
  overridden: boolean | null;
  jevBand: JevProbabilityBand;
  relaunches: number;
  repairs: Record<RepairWorkflowKind, number>;
  costUsd: number;
};

export type ModelPickOutcomeGroup = {
  model: ModelPickOutcomeModel;
  route: ModelPickOutcomeRoute;
  jevBand: JevProbabilityBand;
  issues: number;
  /** 再起動か修復が1回以上あったIssueの数 */
  redoIssues: number;
  redoRate: number;
  relaunches: number;
  repairs: number;
  /** 判定と実際のモデルを比べられたIssueの数と、そのうち違ったものの数 */
  comparable: number;
  overridden: number;
  totalCostUsd: number;
  avgCostUsd: number;
};

export type ModelPickOutcomeSummary = {
  issues: ModelPickOutcomeIssue[];
  groups: ModelPickOutcomeGroup[];
};

const REPAIR_WORKFLOW_PATTERNS: { kind: RepairWorkflowKind; pattern: RegExp }[] = [
  { kind: "ci-fix", pattern: /ci[\s_-]*fix/i },
  { kind: "conflict-resolve", pattern: /conflict[\s_-]*resolve/i },
  { kind: "pr-repair", pattern: /pr[\s_-]*repair/i },
  { kind: "review-fix", pattern: /review[\s_-]*fix/i },
];

/**
 * ワークフローの表示名（`GITHUB_WORKFLOW`）から修復の種類を引く。対象外ならnull。
 *
 * issue-deckのcallerの`name:`は`Claude CI Fix`・`Claude Conflict Resolve`・`Claude PR Repair`・
 * `Claude Review Fix`。大小文字と区切りの違いは許すが、**callerの名前を別の語へ変えた配布先は数えない。**
 */
export function repairWorkflowKind(workflowName: string | null): RepairWorkflowKind | null {
  if (!workflowName) return null;
  return REPAIR_WORKFLOW_PATTERNS.find(({ pattern }) => pattern.test(workflowName))?.kind ?? null;
}

/** モデルID・エイリアスを系統へ寄せる（`claude-opus-5-5` → `opus`） */
export function modelFamily(model: string | null | undefined): ModelPickOutcomeModel | null {
  if (!model) return null;
  for (const family of ["opus", "sonnet", "fable", "haiku"] as const) {
    if (model.toLowerCase().includes(family)) return family;
  }
  return null;
}

function parseRoute(source: string | null): ModelPickOutcomeRoute {
  return source === "jev" || source === "ai" || source === "rule" || source === "manual" ? source : "unrecorded";
}

function sonnetProbability(probabilities: unknown): number | null {
  if (!probabilities || typeof probabilities !== "object" || Array.isArray(probabilities)) return null;
  const value = (probabilities as Record<string, unknown>).sonnet;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Jevの確率帯。Jev以外と、確率の記録が無いものは`none` */
export function jevProbabilityBand(route: ModelPickOutcomeRoute, probabilities: unknown): JevProbabilityBand {
  if (route !== "jev") return "none";
  const probability = sonnetProbability(probabilities);
  if (probability === null) return "none";
  return probability >= JEV_SONNET_PROBABILITY_THRESHOLD ? "high" : "low";
}

function shortRepository(fullName: string): string {
  return fullName.split("/").at(-1) ?? fullName;
}

function issueKey(repository: string, issueNumber: number): string {
  return `${repository}#${issueNumber}`;
}

function emptyRepairs(): Record<RepairWorkflowKind, number> {
  return { "ci-fix": 0, "conflict-resolve": 0, "pr-repair": 0, "review-fix": 0 };
}

/** 修復の回数の合計 */
export function totalRepairs(repairs: Record<RepairWorkflowKind, number>): number {
  return Object.values(repairs).reduce((sum, count) => sum + count, 0);
}

/**
 * 起動ジョブ（Claudeの`LAUNCH`だけを渡す）と使用量の行から、Issueごとの結果とモデル×経路の表を作る。
 */
export function buildModelPickOutcomes(
  launches: readonly ModelPickOutcomeLaunch[],
  usages: readonly ModelPickOutcomeUsage[],
): ModelPickOutcomeSummary {
  // Issueごとの起動ジョブ（古い順）。最初の1件を判定の記録とする
  const launchesByIssue = new Map<string, ModelPickOutcomeLaunch[]>();
  for (const launch of [...launches].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const key = issueKey(shortRepository(launch.repositoryFullName), launch.issueNumber);
    const list = launchesByIssue.get(key) ?? [];
    list.push(launch);
    launchesByIssue.set(key, list);
  }

  // PR番号しか持たない行のために、同じPRでIssue番号も持つ行からPR→Issueを引けるようにする
  const issueByPr = new Map<string, number>();
  for (const usage of usages) {
    if (usage.repository && usage.prNumber !== null && usage.issueNumber !== null) {
      issueByPr.set(issueKey(usage.repository, usage.prNumber), usage.issueNumber);
    }
  }

  const usagesByIssue = new Map<string, ModelPickOutcomeUsage[]>();
  for (const usage of usages) {
    if (!usage.repository) continue;
    const issueNumber =
      usage.issueNumber ?? (usage.prNumber !== null ? issueByPr.get(issueKey(usage.repository, usage.prNumber)) : undefined);
    if (issueNumber === undefined || issueNumber === null) continue;
    const key = issueKey(usage.repository, issueNumber);
    const list = usagesByIssue.get(key) ?? [];
    list.push(usage);
    usagesByIssue.set(key, list);
  }

  const issues: ModelPickOutcomeIssue[] = [];
  for (const [key, issueLaunches] of launchesByIssue) {
    const first = issueLaunches[0];
    const issueUsages = usagesByIssue.get(key) ?? [];
    const route = parseRoute(first.modelPickSource);

    const implementationModels = issueUsages
      .filter((usage) => usage.source === "local" && usage.kind === "implementation")
      .flatMap((usage) => usage.models);
    const ranModel = modelFamily(pickPrimaryModel(implementationModels));
    const pickedFamily = modelFamily(first.modelPickModel);
    const model = ranModel ?? pickedFamily ?? modelFamily(first.claudeModel) ?? "unknown";

    const repairs = emptyRepairs();
    for (const usage of issueUsages) {
      if (usage.source !== "github-actions") continue;
      const kind = repairWorkflowKind(usage.workflowName);
      if (kind) repairs[kind] += 1;
    }

    issues.push({
      repositoryFullName: first.repositoryFullName,
      issueNumber: first.issueNumber,
      route,
      model,
      pickedModel: first.modelPickModel,
      overridden: pickedFamily && model !== "unknown" ? pickedFamily !== model : null,
      jevBand: jevProbabilityBand(route, first.modelPickProbabilities),
      relaunches: issueLaunches.length - 1,
      repairs,
      costUsd: issueUsages.reduce((sum, usage) => sum + usage.costUsd, 0),
    });
  }

  const groups = new Map<string, ModelPickOutcomeGroup>();
  for (const issue of issues) {
    const key = `${issue.model}|${issue.route}|${issue.jevBand}`;
    const group = groups.get(key) ?? {
      model: issue.model,
      route: issue.route,
      jevBand: issue.jevBand,
      issues: 0,
      redoIssues: 0,
      redoRate: 0,
      relaunches: 0,
      repairs: 0,
      comparable: 0,
      overridden: 0,
      totalCostUsd: 0,
      avgCostUsd: 0,
    };
    const repairs = totalRepairs(issue.repairs);
    group.issues += 1;
    if (issue.relaunches > 0 || repairs > 0) group.redoIssues += 1;
    group.relaunches += issue.relaunches;
    group.repairs += repairs;
    if (issue.overridden !== null) {
      group.comparable += 1;
      if (issue.overridden) group.overridden += 1;
    }
    group.totalCostUsd += issue.costUsd;
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.redoRate = group.redoIssues / group.issues;
    group.avgCostUsd = group.totalCostUsd / group.issues;
  }

  return {
    issues,
    groups: [...groups.values()].sort(
      (a, b) => a.model.localeCompare(b.model) || a.route.localeCompare(b.route) || a.jevBand.localeCompare(b.jevBand),
    ),
  };
}
