"use client";

import { AlertTriangle, Check, GitPullRequestArrow, Loader2, Send } from "lucide-react";

import type { WorkflowTagsState } from "@/components/dashboard/workflow-tag-status";
import { formatTimeOfDay } from "@/lib/format-date-time";
import {
  summarizeWorkflowTags,
  type WorkflowTagSummaryKind,
} from "@/lib/workflow-tag-summary";

const TONE: Record<WorkflowTagSummaryKind, string> = {
  publish: "border-amber-500/50 text-amber-700 dark:text-amber-400",
  distribute: "border-amber-500/50 text-amber-700 dark:text-amber-400",
  running: "border-border text-foreground",
  pending: "border-border text-foreground",
  latest: "border-border text-muted-foreground",
  checking: "border-border text-muted-foreground",
  unknown: "border-destructive/50 text-destructive",
};

function KindIcon({ kind }: { kind: WorkflowTagSummaryKind }) {
  const className = "size-3 shrink-0";
  switch (kind) {
    case "publish":
    case "distribute":
      return <Send className={className} aria-hidden />;
    case "running":
    case "checking":
      return <Loader2 className={`${className} animate-spin`} aria-hidden />;
    case "pending":
      return <GitPullRequestArrow className={className} aria-hidden />;
    case "latest":
      return <Check className={className} aria-hidden />;
    case "unknown":
      return <AlertTriangle className={className} aria-hidden />;
  }
}

/**
 * 「共有ワークフローの配布」を開かなくても、公開・配布の必要性と進行状況が分かる状態表示（#4016）。
 *
 * 色やホバーに頼らず、文字（と形の違うアイコン）で状態を伝える。押すと項目が開き、既存の配布画面
 * （理由・対象・PR・実行状況）へ進める。古い結果は最終確認時刻と「再確認中」で現在確認済みと区別する。
 */
export function WorkflowTagSummaryBadge({
  tags,
  onOpen,
}: {
  tags: WorkflowTagsState;
  onOpen: () => void;
}) {
  const summary = summarizeWorkflowTags({
    overview: tags.overview,
    failed: tags.error !== null,
    awaitingRun: tags.awaiting,
  });
  const refreshing = tags.isLoading && tags.overview !== null;

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`共有ワークフローの状態: ${summary.parts.map((part) => part.label).join("、")}。押すと詳細を開く`}
      className="mt-1 flex min-w-0 flex-wrap items-center gap-1 text-left"
      data-testid="workflow-tag-summary"
    >
      {summary.parts.map((part) => (
        <span
          key={part.kind + part.label}
          className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${TONE[part.kind]}`}
        >
          <KindIcon kind={part.kind} />
          <span className="break-words">{part.label}</span>
        </span>
      ))}
      {(refreshing || tags.fetchedAt !== null) && (
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {refreshing ? "再確認中" : `最終確認 ${formatTimeOfDay(tags.fetchedAt!)}`}
        </span>
      )}
    </button>
  );
}
