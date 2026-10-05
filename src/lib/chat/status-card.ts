import type { ChatStatusCard, ChatStatusRow, ChatTone } from "@/lib/chat/types";
import type { RepairKind } from "@/lib/github/pull-request-repair";
import type { CiState } from "@/lib/github/release-api";
import type { PullRequestReviewVerdict } from "@/lib/github/pull-request-review-verdict";

/**
 * 状態カードの組み立て（#3975）。判定そのものは既存の関数が返した値をそのまま写し、ここでは
 * 「言葉と色」に変えるだけ。CI・レビュー・コンフリクト・修復の判定ロジックは持たない。
 */

const CI_LABEL: Record<CiState, { value: string; tone: ChatTone }> = {
  success: { value: "成功", tone: "ok" },
  failure: { value: "失敗", tone: "bad" },
  pending: { value: "実行中", tone: "warn" },
  unknown: { value: "不明", tone: "mut" },
};

const REPAIR_KIND_LABEL: Record<RepairKind, string> = {
  ci: "CIの失敗",
  conflict: "コンフリクト",
  review: "レビュー指摘",
};

export function repairKindLabel(kind: RepairKind): string {
  return REPAIR_KIND_LABEL[kind];
}

function reviewRow(verdict: PullRequestReviewVerdict | null): ChatStatusRow {
  if (!verdict) return { label: "レビュー", value: "記録なし", tone: "mut" };
  switch (verdict.reviewKind) {
    case "ok":
      return { label: "レビュー", value: "問題なし", tone: "ok" };
    case "changes-requested":
      return { label: "レビュー", value: "要修正", tone: "bad" };
    case "needs-check":
      return { label: "レビュー", value: "要確認", tone: "warn" };
    case "skipped":
      return { label: "レビュー", value: "省略", tone: "mut" };
    default:
      return { label: "レビュー", value: "記録なし", tone: "mut" };
  }
}

export type PullRequestStatusInput = {
  repo: string;
  number: number;
  title: string;
  htmlUrl: string;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  headRef: string;
  ciState: CiState;
  /** `true`＝マージ可能・`false`＝コンフリクト・`null`＝判定中 */
  mergeable: boolean | null;
  reviewVerdict: PullRequestReviewVerdict | null;
  activeRepair: { kind: RepairKind } | null;
  repairKinds: RepairKind[];
};

export function relatedIssueFromBranch(headRef: string): number | null {
  const matched = /^issue-(\d+)$/.exec(headRef);
  return matched ? Number(matched[1]) : null;
}

export function buildPullRequestStatusCard(input: PullRequestStatusInput): ChatStatusCard {
  const stateRow: ChatStatusRow = input.merged
    ? { label: "状態", value: "マージ済み", tone: "mut" }
    : input.state === "closed"
      ? { label: "状態", value: "クローズ", tone: "mut" }
      : input.draft
        ? { label: "状態", value: "ドラフト", tone: "mut" }
        : { label: "状態", value: "オープン", tone: "ok" };
  const ci = CI_LABEL[input.ciState];
  const conflict: ChatStatusRow =
    input.mergeable === false
      ? { label: "コンフリクト", value: "あり", tone: "bad" }
      : input.mergeable === true
        ? { label: "コンフリクト", value: "なし", tone: "ok" }
        : { label: "コンフリクト", value: "判定中", tone: "mut" };
  const repair: ChatStatusRow = input.activeRepair
    ? { label: "修復", value: `実行中（${REPAIR_KIND_LABEL[input.activeRepair.kind]}）`, tone: "warn" }
    : { label: "修復", value: "未実行", tone: "mut" };

  return {
    type: "status",
    repo: input.repo,
    number: input.number,
    kind: "pr",
    title: input.title,
    htmlUrl: input.htmlUrl,
    rows: [stateRow, { label: "CI", value: ci.value, tone: ci.tone }, reviewRow(input.reviewVerdict), conflict, repair],
    relatedIssue: relatedIssueFromBranch(input.headRef),
    repairKinds: input.repairKinds,
    session: null,
  };
}

export type IssueStatusInput = {
  repo: string;
  number: number;
  title: string;
  htmlUrl: string;
  state: "OPEN" | "CLOSED";
  assigneeLogin: string | null;
  labels: string[];
  session: { label: string; state: string } | null;
};

export function buildIssueStatusCard(input: IssueStatusInput): ChatStatusCard {
  const rows: ChatStatusRow[] = [
    input.state === "OPEN"
      ? { label: "状態", value: "オープン", tone: "ok" }
      : { label: "状態", value: "クローズ", tone: "mut" },
    { label: "担当", value: input.assigneeLogin ?? "なし", tone: "mut" },
    {
      label: "ラベル",
      value: input.labels.length > 0 ? input.labels.join(" / ") : "なし",
      tone: input.labels.includes("00.check-user") ? "warn" : "mut",
    },
  ];
  return {
    type: "status",
    repo: input.repo,
    number: input.number,
    kind: "issue",
    title: input.title,
    htmlUrl: input.htmlUrl,
    rows,
    relatedIssue: null,
    repairKinds: [],
    session: input.session,
  };
}
