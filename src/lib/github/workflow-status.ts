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

export type ProgressSegmentsResult = {
  segments: ProgressSegmentView[];
  /** 済んだマスの重みの合計（0〜100）。ツールチップの「目安 xx%」 */
  ratio: number;
};

/**
 * 段の中の位置。段に複数のマスがある場合に、どのマスが「いま」かを決める（#2867）。
 * `implementation`は調査／実装／検証・仕上げ、`develop-pr`はCI・レビュー／マージ待ち。
 * 他の段は1マスなので位置を持たない。
 */
export type ProgressSegmentPositions = {
  implementation?: "exploring" | "editing" | "verifying";
  developPr?: "checks" | "merge";
};

/**
 * 進捗Statusと段の中の位置から、9マスそれぞれの状態と目安%を出す（#2867）。
 *
 * - いまの段より前のマスは`done`、後のマスは`pending`
 * - いまの段に複数のマスがあれば、位置より前のマスが`done`・位置のマスが`current`。
 *   位置が渡されなければ最初のマスが`current`
 * - **終端（`done`）に着いたら全部`done`にする。** 本番反映済は「ここで待っている」ではなく
 *   完了なので、半分の濃さのマスを残さない
 * - `ready`・未知のStatusはnull（`getWorkflowStepIndex`と同じで、バー自体を出さない）
 */
export function resolveProgressSegments(
  issue: ProgressSource,
  positions: ProgressSegmentPositions = {},
): ProgressSegmentsResult | null {
  const status = resolveProgressStatus(issue);
  if (getWorkflowStepIndex(issue) === null) return null;
  const statusIndex = getProgressStatusIndex(status);
  const currentKey = currentSegmentKey(status, positions);

  let ratio = 0;
  let reachedCurrent = false;
  const segments = PROGRESS_SEGMENTS.map((segment, index): ProgressSegmentView => {
    const next = PROGRESS_SEGMENTS[index + 1];
    const stageEnd = next !== undefined && next.status !== segment.status;
    const segmentStatusIndex = getProgressStatusIndex(segment.status);
    let state: ProgressSegmentState;
    if (status === "done" || segmentStatusIndex < statusIndex) {
      state = "done";
    } else if (segmentStatusIndex > statusIndex || reachedCurrent) {
      state = "pending";
    } else if (segment.key === currentKey) {
      state = "current";
      reachedCurrent = true;
    } else {
      state = "done";
    }
    if (state === "done") ratio += segment.weight;
    return { key: segment.key, label: segment.label, state, stageEnd };
  });
  return { segments, ratio: Math.min(100, ratio) };
}

/** いまの段のうち`current`にするマス。段に1マスしか無ければそれ */
function currentSegmentKey(
  status: ProgressStatusKey,
  positions: ProgressSegmentPositions,
): ProgressSegmentKey | null {
  if (status === "implementation") return positions.implementation ?? "exploring";
  if (status === "develop-pr") return positions.developPr === "merge" ? "pr-merge" : "pr-checks";
  return PROGRESS_SEGMENTS.find((segment) => segment.status === status)?.key ?? null;
}

/**
 * 重みを整数pxへ割り付ける（#2867）。**合計は必ず`available`に一致し、各マスは`min`以上。**
 *
 * 40pxのバーからすき間を引いた幅を9マスへ配るため、`flex`の伸縮に任せると下限を当てた
 * マスのぶん全体が縮む（親が`overflow-hidden`だと末尾が切れる）。ここで先に整数へ丸め、
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
