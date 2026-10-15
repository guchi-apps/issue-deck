/**
 * PRのCI再実行の対象選定と文言（#4626）。
 *
 * 対象は**現在のheadコミットのrun**だけで、`pull_request`イベントのrunに限る。古いSHAのrunを
 * 再実行して現在のPRが検証済みに見えることを避ける。issue-deckが配る運用自動化（AIレビュー・
 * 自動マージ・自動修復・リリース起動など。`NON_CI_WORKFLOW_FILES`と同じ）とデプロイ系は
 * 対象外で、AIレビューの再実行とは別の操作として扱う。
 */
export type CiRerunScope = "failed" | "all";

export type CiRerunRun = {
  id: number;
  name: string | null;
  path: string | null;
  status: string;
  conclusion: string | null;
  headSha: string;
  event: string;
  htmlUrl: string | null;
};

const NON_CI_WORKFLOW_FILES = new Set([
  "claude-issue-dispatch.yml",
  "claude-review-develop.yml",
  "claude-conflict-resolve.yml",
  "claude-ci-fix.yml",
  "claude-review-fix.yml",
  "claude-pr-repair.yml",
  "issue-labels.yml",
  "release-develop-to-main.yml",
  "shared-knowledge-propose.yml",
  "propagate-workflow-tag.yml",
  "sync-secrets.yml",
  "deploy.yml",
  "release.yml",
]);

function workflowFile(path: string | null): string {
  return (path ?? "").split("@")[0].split("/").pop() ?? "";
}

/** 現在のheadに対応する、再実行してよいCIのrunだけを残す */
export function selectCiRuns(runs: CiRerunRun[], headSha: string): CiRerunRun[] {
  return runs.filter(
    (run) => run.headSha === headSha && run.event === "pull_request" && !NON_CI_WORKFLOW_FILES.has(workflowFile(run.path)),
  );
}

const FAILED_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "startup_failure", "action_required"]);

export type CiRerunDecision =
  | { action: "rerun"; scope: CiRerunScope; runIds: number[] }
  | { action: "reject"; code: "pull_request_not_open" | "head_changed" | "no_run" | "in_progress" | "nothing_failed" };

export function decideCiRerun(
  current: { state: string; merged: boolean; headSha: string },
  requestedHeadSha: string,
  runs: CiRerunRun[],
  scope: CiRerunScope,
): CiRerunDecision {
  if (current.merged || current.state !== "open") return { action: "reject", code: "pull_request_not_open" };
  if (current.headSha !== requestedHeadSha) return { action: "reject", code: "head_changed" };
  const targets = selectCiRuns(runs, current.headSha);
  if (targets.length === 0) return { action: "reject", code: "no_run" };
  // 実行中のrunがあると再実行できない（連打・重複依頼もここで止まる）
  if (targets.some((run) => run.status !== "completed")) return { action: "reject", code: "in_progress" };
  if (scope === "all") return { action: "rerun", scope, runIds: targets.map((run) => run.id) };
  const failed = targets.filter((run) => run.conclusion !== null && FAILED_CONCLUSIONS.has(run.conclusion));
  if (failed.length === 0) return { action: "reject", code: "nothing_failed" };
  return { action: "rerun", scope, runIds: failed.map((run) => run.id) };
}

export function ciRerunErrorMessage(code: string | undefined): string {
  switch (code) {
    case "pull_request_not_open":
      return "このPRはすでにクローズまたはマージされています。「更新」を押して最新の状態を確認してください。";
    case "head_changed":
      return "PRのコミットが更新されています。「更新」を押して最新の状態を確認してから、もう一度押してください。";
    case "no_run":
      return "現在のコミットに対するCIの実行記録がありません。コミットを更新するか、最新のマージ先を取り込むとCIが起動します。";
    case "in_progress":
      return "CIが実行中のため再実行できません。完了してからもう一度押してください。";
    case "nothing_failed":
      return "失敗・キャンセルされたCIがありません。成功済みを含めてやり直す場合は「全体を再実行」を使ってください。";
    case "permission_denied":
      return "GitHub AppにActionsの書き込み権限がありません。権限を付与するか、GitHubで開いて再実行してください。";
    case "not_found":
      return "対象のPRが見つかりません。「更新」を押して一覧を取り直してください。";
    default:
      return "CIの再実行に失敗しました。少し待ってからもう一度押してください。";
  }
}
