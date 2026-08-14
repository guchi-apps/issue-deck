import type { CiState } from "@/lib/github/release-api";

/**
 * PRの詰まりを自動で直す種類（#1293）。
 * `ci`はCIの失敗、`conflict`はbaseブランチとのコンフリクトを指す。
 */
export type RepairKind = "ci" | "conflict";

/** Issue専用ブランチの命名規約（`scripts/start-issue.sh`が作成する`issue-<番号>`） */
const ISSUE_BRANCH_PATTERN = /^issue-(\d+)$/;

/** develop向け`issue-<番号>`PRのCI失敗を直すワークフロー（#807） */
export const CI_FIX_WORKFLOW_FILE = "claude-ci-fix.yml";

/** develop向け`issue-<番号>`PRのコンフリクトを解消するワークフロー（#315） */
export const CONFLICT_RESOLVE_WORKFLOW_FILE = "claude-conflict-resolve.yml";

/** Issueに紐づかないPR（バンプPR・develop→mainのリリースPR等）を直すワークフロー（#1293） */
export const PR_REPAIR_WORKFLOW_FILE = "claude-pr-repair.yml";

/**
 * `workflow_dispatch`のref。ワークフローの実体は常に`develop`の内容で動かす。
 * 対象ブランチのcheckoutはワークフロー側が行うため、ここでheadブランチを指す必要はない。
 */
export const REPAIR_DISPATCH_REF = "develop";

export type RepairDispatch = {
  workflowFile: string;
  ref: string;
  inputs: Record<string, string>;
};

export type RepairTargetPullRequest = {
  number: number;
  baseRef: string;
  headRef: string;
};

/**
 * 対象PRと修復の種類から、起動すべきワークフローと入力を決める。
 *
 * develop向けの`issue-<番号>`PRだけは、リトライ上限・Issueへの報告・実装ワークフローとの
 * concurrency直列化を備えた既存の専用ワークフロー（#807・#315）へ渡す。それ以外
 * （バンプPR・develop→mainのリリースPR・規約外のPR）は対応するIssueが存在しないため、
 * PR自身へ報告する`claude-pr-repair.yml`が受け持つ。
 */
export function resolveRepairDispatch(
  pullRequest: RepairTargetPullRequest,
  kind: RepairKind,
): RepairDispatch {
  const issueMatch = ISSUE_BRANCH_PATTERN.exec(pullRequest.headRef);
  if (issueMatch && pullRequest.baseRef === "develop") {
    return {
      workflowFile: kind === "ci" ? CI_FIX_WORKFLOW_FILE : CONFLICT_RESOLVE_WORKFLOW_FILE,
      ref: REPAIR_DISPATCH_REF,
      inputs: { issue_number: issueMatch[1] },
    };
  }

  return {
    workflowFile: PR_REPAIR_WORKFLOW_FILE,
    ref: REPAIR_DISPATCH_REF,
    inputs: { pr_number: String(pullRequest.number), mode: kind },
  };
}

/**
 * 自動修復のボタンを出してよいPRか。マージできない状態にあること自体は条件にせず
 * （それは`repairKindsFor`が判定する）、そもそも直しても意味が無い状態だけを外す。
 */
export function canRepairFromDeck(pullRequest: {
  state: "open" | "closed";
  draft: boolean;
}): boolean {
  return pullRequest.state === "open" && !pullRequest.draft;
}

/**
 * 今このPRに出してよい修復ボタンの種類。CI状態とコンフリクト有無から決める。
 *
 * `mergeable`はGitHub側が非同期に判定するため、取得できていない（`null`）間は
 * コンフリクトのボタンを出さない。「判定前イコールコンフリクトなし」として扱うのではなく、
 * 判定が出るまで押せる状態にしないという意味（押しても対象PRの状態を再確認する
 * ワークフロー側で弾かれるだけになる）。
 */
export function repairKindsFor(
  pullRequest: { state: "open" | "closed"; draft: boolean; ciState: CiState | null },
  mergeable: boolean | null | undefined,
): RepairKind[] {
  if (!canRepairFromDeck(pullRequest)) return [];

  const kinds: RepairKind[] = [];
  if (mergeable === false) kinds.push("conflict");
  if (pullRequest.ciState === "failure") kinds.push("ci");
  return kinds;
}

/** ボタンの文言。一覧・詳細・リリース進捗のどこでも同じ言い回しにする */
export const REPAIR_KIND_LABEL: Record<RepairKind, string> = {
  ci: "CI失敗を自動修正",
  conflict: "コンフリクトを自動解消",
};

/** 確認ダイアログで「何が起きるか」を説明する文 */
export const REPAIR_KIND_DESCRIPTION: Record<RepairKind, string> = {
  ci: "失敗したCIのログをClaude Codeが読んで原因を修正し、検証したうえでpushします。",
  conflict:
    "baseブランチの最新をClaude Codeが取り込み、コンフリクトを解消して検証したうえでpushします。",
};
