import {
  isPropagationRunning,
  propagationTargets,
  repairPropagationTargets,
  repairPropagationWorkflows,
  sharedFilePropagationTargets,
  sharedFilePropagationWork,
  workflowTagGroup,
  type WorkflowTagStatus,
} from "@/lib/workflow-tags";
import type { WorkflowTagsOverview } from "@/lib/workflow-tags-store";

/**
 * 設定の「共有ワークフローの配布」を開かなくても分かる状態表示（#4016）。
 *
 * **詳細の画面と同じ判定関数**（`propagationTargets`等）から数える。件数の単位はリポジトリで、
 * タグ・caller・配布物の3種に同じリポジトリが重なっても1件に数える。
 */
export type WorkflowTagSummaryKind =
  | "checking"
  | "unknown"
  | "publish"
  | "distribute"
  | "running"
  | "pending"
  | "latest";

export type WorkflowTagSummaryPart = { kind: WorkflowTagSummaryKind; label: string };

export type WorkflowTagSummary = {
  /** 最も強調する状態（バッジの色・アイコン用。色だけに頼らず`parts`の文字も出す） */
  kind: WorkflowTagSummaryKind;
  parts: WorkflowTagSummaryPart[];
};

export type WorkflowTagSummaryInput = {
  overview: WorkflowTagsOverview | null;
  /** 直近の取得が失敗した。`overview`が残っていても現在確認済みとは扱わない */
  failed: boolean;
  /** 起動したが配布runがまだ見えていない状態。どの種別のrunか分からないため全種別を実行中とみなす */
  awaitingRun?: boolean;
};

function names(list: WorkflowTagStatus[]): Set<string> {
  return new Set(list.map((status) => status.fullName));
}

export function summarizeWorkflowTags({
  overview,
  failed,
  awaitingRun = false,
}: WorkflowTagSummaryInput): WorkflowTagSummary {
  if (!overview) {
    return failed
      ? { kind: "unknown", parts: [{ kind: "unknown", label: "確認できません" }] }
      : { kind: "checking", parts: [{ kind: "checking", label: "確認中" }] };
  }

  const repositories = overview.repositories;
  const tagRunning = awaitingRun || isPropagationRunning(overview.propagation);
  const repairRunning = awaitingRun || isPropagationRunning(overview.repairPropagation);
  const sharedRunning = awaitingRun || isPropagationRunning(overview.sharedFilePropagation);

  // 実行中の種別が受け持つ未着手は「配布中」へ、そうでない種別の未着手だけを「配布が必要」に数える。
  // PR未作成の対象は実行中も未着手に数えられるため、分けないと「配布中」が出ない
  const running = new Set<string>();
  const needed = new Set<string>();
  for (const [targets, isRunning] of [
    [propagationTargets(repositories), tagRunning],
    [repairPropagationTargets(repositories), repairRunning],
    [sharedFilePropagationTargets(repositories), sharedRunning],
  ] as const) {
    for (const name of names(targets)) (isRunning ? running : needed).add(name);
  }

  // 配布PRが出来ていて、まだ反映されていない（マージ待ち）もの。PRがあるだけでは最新にしない
  const pending = new Set<string>();
  for (const status of repositories) {
    if (
      workflowTagGroup(status) === "pull-request" ||
      (repairPropagationWorkflows(status).length > 0 && status.repairPullRequest !== null) ||
      (sharedFilePropagationWork(status).length > 0 && status.sharedFilePullRequest !== null)
    ) {
      pending.add(status.fullName);
    }
  }

  const publishNeeded = overview.sourceAhead?.hasContentDiff === true;
  // 公開の要否を判定できない（最新タグ・比較結果が取れない）。「最新」へ倒さない
  const publishUnknown =
    overview.latest === null ||
    overview.sourceAhead === null ||
    overview.sourceAhead.hasContentDiff === null;
  const unverified = overview.unverifiedRepositories?.length ?? 0;

  const parts: WorkflowTagSummaryPart[] = [];
  if (publishNeeded) {
    parts.push({ kind: "publish", label: "新しいバージョンの公開・配布が必要" });
  }
  if (needed.size > 0) {
    parts.push({ kind: "distribute", label: `配布が必要：${needed.size}リポジトリ` });
  }
  if (running.size > 0) parts.push({ kind: "running", label: "配布中" });
  if (pending.size > 0) {
    parts.push({ kind: "pending", label: `反映待ち：${pending.size}リポジトリ` });
  }

  const uncertain = publishUnknown || unverified > 0 || failed;
  if (parts.length === 0) {
    return uncertain
      ? { kind: "unknown", parts: [{ kind: "unknown", label: "確認できません" }] }
      : { kind: "latest", parts: [{ kind: "latest", label: "最新" }] };
  }

  if (uncertain) {
    parts.push({
      kind: "unknown",
      label: failed ? "再確認に失敗（前回の結果）" : "一部確認できません",
    });
  }
  return { kind: parts[0]!.kind, parts };
}
