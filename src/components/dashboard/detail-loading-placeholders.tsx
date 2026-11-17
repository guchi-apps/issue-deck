"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { checkUserReason } from "@/lib/github/approval-labels";
import type { IssueLabel } from "@/types/issue";

export const ARTIFACT_REQUIRED_LABEL = "25.artifact-required";

export type DetailLoadingInput = {
  labels: readonly Pick<IssueLabel, "name">[];
  /** 進行状況（計画の返事待ちを含む）の取得が1回完了している */
  dispatchLoaded: boolean;
  /** 計画の返事待ちが既に見つかっている */
  planRequestPresent: boolean;
  artifactsLoaded: boolean;
  /** コメントを取得中（初回） */
  commentsLoading: boolean;
  /** 未反映の計画レビューが既に見つかっている */
  planReviewPresent: boolean;
};

export type DetailLoadingState = {
  plan: boolean;
  artifacts: boolean;
  planReview: boolean;
};

/**
 * 「出るはず」と分かっている欄だけ、取得が終わるまで枠を出す判定（#5471）。
 *
 * 該当なしと分かった（取得が完了した）時点で必ずfalseに戻る。ラベルから出るはずと
 * 判断できない欄は枠を出さない（大半のIssueはアーティファクトも計画も持たない）。
 */
export function resolveDetailLoading(input: DetailLoadingInput): DetailLoadingState {
  const planReason = checkUserReason(input.labels) === "plan";
  return {
    plan: planReason && !input.dispatchLoaded && !input.planRequestPresent,
    artifacts:
      input.labels.some((label) => label.name === ARTIFACT_REQUIRED_LABEL) &&
      !input.artifactsLoaded,
    planReview: planReason && input.commentsLoading && !input.planReviewPresent,
  };
}

/** 取得中の枠1つ。`role="status"`で読み上げにも「取得中」を伝える */
export function DetailLoadingCard({ label, tall = false }: { label: string; tall?: boolean }) {
  return (
    <section
      role="status"
      aria-live="polite"
      data-testid="detail-loading-card"
      className="flex flex-col gap-2 rounded-xl border bg-card p-3"
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent"
        />
        <span className="text-sm font-semibold">{label}</span>
      </div>
      {tall ? <Skeleton className="h-20 w-full" /> : <Skeleton className="h-3 w-3/4" />}
    </section>
  );
}
