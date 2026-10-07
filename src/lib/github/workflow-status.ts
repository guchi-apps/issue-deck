import { type LucideIcon } from "lucide-react";

import {
  ADVANCED_PROGRESS_STATUSES,
  getProgressStatusIndex,
  hasActiveProgress,
  PROGRESS_SEGMENTS,
  resolveProgressStatus,
  type ProgressSegmentKey,
  type ProgressSource,
  type ProgressStatusKey,
} from "@/lib/issue-progress";
import type { IssuePullRequestProgress } from "@/lib/issue-pull-request-progress";
import type { Issue } from "@/types/issue";

export type WorkflowStep = {
  /** 対応する進捗状態のキー */
  key: ProgressStatusKey;
  /** GitHub Projects v2 の Status 名。ツールチップに出して盤面の列名と対応づける */
  projectStatus: string;
  /** ステップ表示用の短い日本語ラベル */
  label: string;
  /** ステップ表示用のアイコン（円の中身。未完了・現在ステップ時のみ使う。完了済みはCheckで統一） */
  icon: LucideIcon;
  /**
   * この段階でGitHub Actions（実装・レビューエージェント）の実行が進行し得るかどうか。
   * `develop`（developマージ完了）・`done`（mainマージ完了）はマージ後の定常状態で
   * 実行は走らないため、一覧の実行状況ポーリング対象から外してGitHub APIの消費を抑える。
   */
  active: boolean;
};

/**
 * マルチエージェント運用における実装状況ステップ（Planning〜Done）の遷移順。
 *
 * 定義の実体は[issue-progress.ts](../issue-progress.ts)の`PROGRESS_STATUSES`にあり、ここでは
 * ステップ表示用に「未着手を除く6状態」だけを取り出している。未着手（`ready`）を
 * 含めないのは、進捗が動いていないissueではステップ表示自体を出さない仕様のため
 * （`getWorkflowStepIndex`がnullを返す）。
 */
export const WORKFLOW_STEPS: readonly WorkflowStep[] = ADVANCED_PROGRESS_STATUSES.map((status) => ({
  key: status.key,
  projectStatus: status.projectStatus,
  label: status.label,
  icon: status.icon,
  active: status.active,
}));

/**
 * issueのワークフロー上の現在ステップのindexを返す。未着手ならnull。
 *
 * 判定は[issue-progress.ts](../issue-progress.ts)の`resolveProgressStatus`に委ねており、
 * **Project Statusだけを見る**（進捗ラベルは #991 Phase 5 で廃止済み）。
 */
export function getWorkflowStepIndex(issue: ProgressSource): number | null {
  const status = resolveProgressStatus(issue);
  if (status === "ready") return null;
  const index = WORKFLOW_STEPS.findIndex((step) => step.key === status);
  return index === -1 ? null : index;
}

/**
 * GitHub Actionsの実行が進行し得る段階かどうか。実行状況のポーリング対象を絞り込むのに使う。
 * 判定の詳細は`hasActiveProgress`を参照。
 */
export function hasActiveWorkflowStep(issue: ProgressSource): boolean {
  return hasActiveProgress(issue);
}

/**
 * コメント欄の「引き継いでIssueを作成」ボタンを表示すべきかどうか。
 * このissueで直接修正を続けるのが難しい（developへのPRがマージ済み、またはissueがclosed）
 * 場合にのみ表示し、まだ同じブランチで修正できる段階では非表示にする（#452）。
 */
export function canCreateFollowupFromComment(
  issue: Pick<Issue, "state" | "projectStatus">,
): boolean {
  if (issue.state === "closed") return true;
  const status = resolveProgressStatus(issue);
  if (status === "ready") return false;
  return getProgressStatusIndex(status) >= getProgressStatusIndex("develop");
}

/** 一覧の進捗バーのマスの状態（#2867）。済んだ／いまここ／まだ */
export type ProgressSegmentState = "done" | "current" | "pending";

export type ProgressSegmentView = {
  key: ProgressSegmentKey;
  label: string;
  state: ProgressSegmentState;
  /** 次のマスが別の段に属する（＝段の境目。すき間を広く取る） */
  stageEnd: boolean;
};

/**
 * 本番マージの2点トラッカーの状態（#2927）。主バー（`PROGRESS_SEGMENTS`）はdevelopまでしか
 * 追わないため、release・doneはここで別デザインとして表す。
 *
 * - `hidden`: developへまだ到達していない（主バー側で表示中）。トラッカー自体を出さない
 * - `pending`: develop到達済み・本番マージはまだ（1つ目・2つ目とも輪郭）
 * - `in-progress`: リリースPR作成〜マージ待ち（1つ目が塗り＋点滅、2つ目は輪郭）
 * - `done`: mainへマージ完了（1つ目・2つ目とも塗り、つなぐ線も塗り）
 */
export type ProductionTrackerState = "hidden" | "pending" | "in-progress" | "done";

export type ProgressSegmentsResult = {
  segments: ProgressSegmentView[];
  /** 済んだマスの重みの合計（0〜100）。ツールチップの「目安 xx%」。develop到達以降は常に100 */
  ratio: number;
  /** 本番マージの2点トラッカーの状態（#2927） */
  productionTracker: ProductionTrackerState;
};

/**
 * #3941以前の7分割バーで使っていたフェーズ内位置。呼び出し側との互換性のため残すが、
 * 一覧の3フェーズバーの現在地には使わない。詳細はバー左側の状態文言で表示する。
 */
export type ProgressSegmentPositions = {
  implementation?: "exploring" | "editing" | "verifying";
  developPr?: "checks" | "merge";
};

/** develop・release・doneの`ProgressStatusKey`配列上のindex（`resolveProgressSegments`で使い回す） */
const DEVELOP_STATUS_INDEX = getProgressStatusIndex("develop");
const RELEASE_STATUS_INDEX = getProgressStatusIndex("release");

/**
 * 進捗Statusから、3フェーズそれぞれの状態と目安%、本番マージの2点トラッカーの状態を出す。
 *
 * - いまの段より前のマスは`done`、後のマスは`pending`
 * - 進行中のフェーズは`current`、それより前は`done`、後は`pending`
 * - **developへのマージが完了した（`develop`到達）以降は主バーを常に満タン（`ratio`=100）
 *   にする。** developより先（release・done）は主バーの対象外で、2点トラッカー
 *   （`productionTracker`）が別デザインとして担う
 * - `ready`・未知のStatusはnull（`getWorkflowStepIndex`と同じで、バー自体を出さない）
 */
export function resolveProgressSegments(
  issue: ProgressSource,
  _positions: ProgressSegmentPositions = {},
): ProgressSegmentsResult | null {
  const status = resolveProgressStatus(issue);
  if (getWorkflowStepIndex(issue) === null) return null;
  const statusIndex = getProgressStatusIndex(status);
  const currentKey = currentSegmentKey(status);
  const reachedDevelop = statusIndex >= DEVELOP_STATUS_INDEX;

  const totalWeight = PROGRESS_SEGMENTS.reduce((sum, segment) => sum + segment.weight, 0);
  let doneWeight = 0;
  let reachedCurrent = false;
  const segments = PROGRESS_SEGMENTS.map((segment, index): ProgressSegmentView => {
    const next = PROGRESS_SEGMENTS[index + 1];
    const stageEnd = next !== undefined && next.status !== segment.status;
    const segmentStatusIndex = getProgressStatusIndex(segment.status);
    let state: ProgressSegmentState;
    if (reachedDevelop || segmentStatusIndex < statusIndex) {
      state = "done";
    } else if (segmentStatusIndex > statusIndex || reachedCurrent) {
      state = "pending";
    } else if (segment.key === currentKey) {
      state = "current";
      reachedCurrent = true;
    } else {
      state = "done";
    }
    if (state === "done") doneWeight += segment.weight;
    return { key: segment.key, label: segment.label, state, stageEnd };
  });
  const ratio = reachedDevelop ? 100 : Math.round((doneWeight / totalWeight) * 100);
  const productionTracker: ProductionTrackerState = !reachedDevelop
    ? "hidden"
    : statusIndex === DEVELOP_STATUS_INDEX
      ? "pending"
      : statusIndex === RELEASE_STATUS_INDEX
        ? "in-progress"
        : "done";
  return { segments, ratio, productionTracker };
}

/** いまの段のうち`current`にするマス。段に1マスしか無ければそれ */
function currentSegmentKey(status: ProgressStatusKey): ProgressSegmentKey | null {
  if (status === "develop") return null;
  return PROGRESS_SEGMENTS.find((segment) => segment.status === status)?.key ?? null;
}

/**
 * 重みを整数pxへ割り付ける（#2867）。**合計は必ず`available`に一致し、各マスは`min`以上。**
 *
 * 一覧の進捗バー（すき間を引いた幅をマス数へ配る）で使うため、`flex`の伸縮に任せると下限を
 * 当てたマスのぶん全体が縮む（親が`overflow-hidden`だと末尾が切れる）。ここで先に整数へ丸め、
 * 端数は余りの大きい順に1pxずつ足す（最大剰余法）。下限を当てて`available`を超える場合は、
 * 下限の無いマスから重みの大きい順に削って合わせる。
 */
export function allocateSegmentWidths(
  weights: readonly number[],
  available: number,
  min: number,
): number[] {
  if (weights.length === 0) return [];
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const exact = weights.map((weight) => (total > 0 ? (weight / total) * available : 0));
  const widths = exact.map((value) => Math.max(min, Math.floor(value)));
  let remaining = available - widths.reduce((sum, width) => sum + width, 0);
  // 余りを、切り捨てた端数の大きい順に配る
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const { index } of order) {
    if (remaining <= 0) break;
    widths[index] += 1;
    remaining -= 1;
  }
  // 下限で膨らんで超えたぶんは、下限より大きいマスから幅の大きい順に削る
  while (remaining < 0) {
    const index = widths
      .map((width, i) => ({ width, i }))
      .filter(({ width }) => width > min)
      .sort((a, b) => b.width - a.width || a.i - b.i)[0]?.i;
    if (index === undefined) break;
    widths[index] -= 1;
    remaining += 1;
  }
  return widths;
}

/**
 * Issue詳細の進捗表示に使う5フェーズ（#4128）。
 *
 * 内部のProject Status（`WORKFLOW_STEPS`の6状態）は既存自動化との互換性のため変えず、
 * 表示だけをここで「計画 → 実装 → レビュー → 本番反映待ち → 本番反映済み」へ集約する。
 * developへマージ・mainへマージ・デプロイは独立フェーズにせず、現在フェーズの詳細状態で言う。
 */
export type DisplayPhaseKey = "planning" | "implementation" | "review" | "release-wait" | "released";

export type DisplayPhase = {
  key: DisplayPhaseKey;
  label: string;
  /** ツールチップに出す、このフェーズに集約している内部Project Status */
  projectStatus: string;
  icon: LucideIcon;
};

const phaseIcon = (key: ProgressStatusKey): LucideIcon =>
  ADVANCED_PROGRESS_STATUSES.find((status) => status.key === key)?.icon ?? ADVANCED_PROGRESS_STATUSES[0].icon;

export const DISPLAY_PHASES: readonly DisplayPhase[] = [
  { key: "planning", label: "計画", projectStatus: "Planning", icon: phaseIcon("planning") },
  { key: "implementation", label: "実装", projectStatus: "Implementation", icon: phaseIcon("implementation") },
  { key: "review", label: "レビュー", projectStatus: "Develop PR", icon: phaseIcon("develop-pr") },
  { key: "release-wait", label: "本番反映待ち", projectStatus: "Develop / Release", icon: phaseIcon("develop") },
  { key: "released", label: "本番反映済み", projectStatus: "Done", icon: phaseIcon("done") },
];

const STATUS_TO_DISPLAY_PHASE: Partial<Record<ProgressStatusKey, DisplayPhaseKey>> = {
  planning: "planning",
  implementation: "implementation",
  "develop-pr": "review",
  develop: "release-wait",
  release: "release-wait",
  done: "released",
};

/** 現在の表示フェーズのindex。未着手・対応終了（本流ステップを出さない状態）はnull */
export function getDisplayPhaseIndex(issue: ProgressSource): number | null {
  const key = STATUS_TO_DISPLAY_PHASE[resolveProgressStatus(issue)];
  if (key === undefined) return null;
  return DISPLAY_PHASES.findIndex((phase) => phase.key === key);
}

/** 詳細状態の重さ。`attention`＝止まっている、`running`＝動いている、`waiting`＝人待ち、`idle`＝定常 */
export type PhaseDetailTone = "attention" | "running" | "waiting" | "idle";

export type PhaseDetail = { text: string; tone: PhaseDetailTone };

/**
 * 現在フェーズの詳細状態（1行）を導く。PR内訳は`buildIssuePullRequestProgress`の結果を
 * そのまま使い、優先順位（停止 > 実行中 > 人待ち）もそちらに従う。
 */
export function resolvePhaseDetail(
  status: ProgressStatusKey,
  options: { pullRequestProgress?: IssuePullRequestProgress | null; planApprovalPending?: boolean } = {},
): PhaseDetail | null {
  const pr = options.pullRequestProgress ?? null;
  switch (status) {
    case "planning":
      return options.planApprovalPending
        ? { text: "計画承認待ち", tone: "waiting" }
        : { text: "計画を作成中", tone: "running" };
    case "implementation":
      return { text: "実装中", tone: "running" };
    case "develop-pr": {
      if (pr === null) return { text: "レビュー開始待ち", tone: "running" };
      if (pr.stopKind === "conflict") return { text: "コンフリクト解消待ち", tone: "attention" };
      if (pr.stopKind === "ci") return { text: "CI失敗", tone: "attention" };
      if (pr.stopKind === "review") return { text: "修正対応中", tone: "attention" };
      if (pr.label === "マージ待ち") {
        const needsCheck = pr.steps.some((step) => step.key === "ai-review" && step.state === "needs-check");
        return needsCheck
          ? { text: "レビュー要確認", tone: "waiting" }
          : { text: "developへマージ待ち", tone: "waiting" };
      }
      if (pr.label === "マージ済み") return { text: "developへマージ中", tone: "running" };
      if (pr.label === "判定実施中") return { text: "レビュー中", tone: "running" };
      return { text: pr.label, tone: pr.tone === "waiting" ? "waiting" : "running" };
    }
    case "develop":
      return { text: "develop反映済み・本番リリース待ち", tone: "idle" };
    case "release": {
      if (pr === null) return { text: "本番リリース準備中", tone: "running" };
      if (pr.tone === "attention") return { text: pr.label, tone: "attention" };
      if (pr.tone === "waiting") return { text: "mainへマージ待ち", tone: "waiting" };
      return { text: "mainへマージ中", tone: "running" };
    }
    case "done":
      return { text: "本番反映完了", tone: "idle" };
    default:
      return null;
  }
}
