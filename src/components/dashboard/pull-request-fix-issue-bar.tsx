"use client";

import { useState } from "react";
import { AlertCircle, Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  buildPullRequestFixIssueDraft,
  resolvePullRequestFixIssueTone,
  selectOpenChangeRequests,
  type PullRequestFixIssueDraft,
} from "@/lib/github/pull-request-fix-issue";
import type { PullRequestReviewCommentContent } from "@/lib/github/pull-request-review-comment";
import { cn } from "@/lib/utils";
import type { PullRequestEvent, PullRequestSummary } from "@/types/pull-request";

type PullRequestFixIssueBarProps = {
  pullRequest: PullRequestSummary;
  events: readonly PullRequestEvent[];
  onCreate: (draft: PullRequestFixIssueDraft) => void;
};

/**
 * 自動レビューの本文を取る。**失敗しても下書きは開く**——レビューが読めないことを理由に
 * 起案そのものを止めると、指摘を手で書き写す手段まで失う。
 */
async function fetchReview(pullRequest: PullRequestSummary): Promise<PullRequestReviewCommentContent | null> {
  const [owner, repo] = pullRequest.repositoryFullName.split("/");
  try {
    const res = await fetch(
      `/api/pull-requests/review?owner=${owner}&repo=${repo}&number=${pullRequest.number}`,
    );
    if (!res.ok) return null;
    const data: { review: PullRequestReviewCommentContent | null } = await res.json();
    return data.review;
  } catch {
    return null;
  }
}

/**
 * PR詳細のヘッダーと本文の間に置く「修正Issueを起案」（#2961）。
 *
 * 判定が要修正・要確認のときは色付きの帯で理由を添え、それ以外は右寄せのボタンだけにする。
 * 押すと自動レビューの本文を取り、下書きを埋めた新規作成ダイアログを開く（起票はしない）。
 */
export function PullRequestFixIssueBar({ pullRequest, events, onCreate }: PullRequestFixIssueBarProps) {
  const [isPreparing, setIsPreparing] = useState(false);

  const openChangeRequests = selectOpenChangeRequests(events);
  const tone = resolvePullRequestFixIssueTone(pullRequest, openChangeRequests);
  const verdictKind = pullRequest.reviewVerdict?.reviewKind;
  const headline =
    verdictKind === "changes-requested" || verdictKind === "needs-check"
      ? `自動レビューが「${pullRequest.reviewVerdict?.reviewLabel}」と判定しています`
      : "レビューで変更を求められています";

  async function handleClick() {
    setIsPreparing(true);
    const review = await fetchReview(pullRequest);
    setIsPreparing(false);
    onCreate(buildPullRequestFixIssueDraft({ pullRequest, review, openChangeRequests }));
  }

  const button = (
    <Button
      size="sm"
      variant={tone === "none" ? "ghost" : tone === "needs-check" ? "outline" : "default"}
      className={cn(
        "shrink-0",
        tone === "changes-requested" && "bg-destructive text-white hover:bg-destructive/90",
        tone !== "none" && "max-md:w-full",
      )}
      disabled={isPreparing}
      onClick={handleClick}
    >
      {isPreparing ? <Loader2 className="animate-spin" /> : <Plus />}
      修正Issueを起案
    </Button>
  );

  if (tone === "none") {
    return (
      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 border-b px-4 py-2">
        <p className="text-xs text-muted-foreground">レビュー後に気づいた修正も、ここからIssueにできます。</p>
        {button}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-l-[3px] py-3 pr-4 pl-[13px]",
        tone === "changes-requested"
          ? "border-l-destructive bg-destructive/10"
          : "border-l-amber-500 bg-amber-500/10",
      )}
    >
      <div className="min-w-0 flex-1 basis-56">
        <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">
          <AlertCircle
            className={cn(
              "size-4 shrink-0",
              tone === "changes-requested" ? "text-destructive" : "text-amber-600 dark:text-amber-400",
            )}
            aria-hidden="true"
          />
          {headline}
          {openChangeRequests.length > 0 && (
            <span className="inline-flex items-center rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive ring-1 ring-inset ring-destructive">
              変更を要求 {openChangeRequests.length}件
            </span>
          )}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          指摘を引用した新しいIssueの下書きを開きます。この画面からは起票しません。
        </p>
      </div>
      {button}
    </div>
  );
}
