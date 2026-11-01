/**
 * PR詳細の「AIレビューを再実行」（#5158）。
 *
 * 要確認・要修正の指摘が、コードを変えずに解消することがある（secretの同期・外部設定・別PRのマージなど、
 * 人の作業が前提だった指摘）。HEADが変わらないと`claude-review-develop.yml`は走り直さないため、
 * **現在のHEADに対するAIレビューのrunをそのまま再実行する**。
 *
 * PRをclose→reopenして起動し直す方法（`restartReviewAtSameHead`）もあるが、close/reopenは
 * 他のワークフロー・通知・PRの履歴まで動かすうえ、reopenに失敗するとPRが閉じたまま残る。
 * 画面から人が押す操作としては、既存のrunの再実行のほうが影響が小さい。
 *
 * 対象は現在のHEADのrunに限る。古いSHAのrunを再実行して、現在のPRがレビュー済みに見えることを避ける。
 */
import type { CiRerunRun } from "@/lib/pull-request-ci-rerun";

/** AIレビューのworkflowファイル（callerの名前。配布先も同じ名前で置く） */
export const REVIEW_WORKFLOW_FILE = "claude-review-develop.yml";

function workflowFile(path: string | null): string {
  return (path ?? "").split("@")[0].split("/").pop() ?? "";
}

export type ReviewRerunDecision =
  | { action: "rerun"; runId: number }
  | {
      action: "reject";
      code: "pull_request_not_open" | "not_develop" | "head_changed" | "no_run" | "in_progress";
    };

export function decideReviewRerun(
  current: { state: string; merged: boolean; baseRef: string; headSha: string },
  requestedHeadSha: string,
  runs: CiRerunRun[],
): ReviewRerunDecision {
  if (current.merged || current.state !== "open") return { action: "reject", code: "pull_request_not_open" };
  // AIレビューはdevelop向けPRにだけ走る（main向けは全体レビューの別系統）
  if (current.baseRef !== "develop") return { action: "reject", code: "not_develop" };
  if (current.headSha !== requestedHeadSha) return { action: "reject", code: "head_changed" };
  const targets = runs.filter(
    (run) => run.headSha === current.headSha && run.event === "pull_request" && workflowFile(run.path) === REVIEW_WORKFLOW_FILE,
  );
  if (targets.length === 0) return { action: "reject", code: "no_run" };
  // 実行中のrunがあれば、それが新しい判定を出す。連打・重複依頼もここで止まる
  if (targets.some((run) => run.status !== "completed")) return { action: "reject", code: "in_progress" };
  // 同じHEADに複数ある（再実行済み・reopen）ときは最新のrunを再実行する
  const latest = targets.reduce((a, b) => (b.id > a.id ? b : a));
  return { action: "rerun", runId: latest.id };
}

export function reviewRerunErrorMessage(code: string | undefined): string {
  switch (code) {
    case "pull_request_not_open":
      return "このPRはすでにクローズまたはマージされています。「更新」を押して最新の状態を確認してください。";
    case "not_develop":
      return "AIレビューはdevelop向けのPRだけで動きます。";
    case "head_changed":
      return "PRのコミットが更新されています。新しいコミットのAIレビューは自動で走ります。「更新」を押して状態を確認してください。";
    case "no_run":
      return "現在のコミットに対するAIレビューの実行記録がありません。ローカルのレビューで判定されたPRは、GitHubから再レビューを依頼してください。";
    case "in_progress":
      return "AIレビューが実行中です。完了すると判定が更新されます。";
    case "permission_denied":
      return "GitHub AppにActionsの書き込み権限がありません。権限を付与するか、GitHubで開いて再実行してください。";
    case "not_found":
      return "対象のPRが見つかりません。「更新」を押して一覧を取り直してください。";
    default:
      return "AIレビューの再実行に失敗しました。少し待ってからもう一度押してください。";
  }
}
