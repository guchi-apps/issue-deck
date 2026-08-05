"use client";

import { Bot, Loader2, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useIssueSummary } from "@/hooks/use-issue-summary";
import type { Issue } from "@/types/issue";

type IssueAiSummaryProps = {
  issue: Issue;
};

export function IssueAiSummary({ issue }: IssueAiSummaryProps) {
  const { state, isLoading, isGenerating, error, notConfigured, generate } = useIssueSummary(issue);

  const isStale =
    state?.summary !== null &&
    state?.commentCountAtGeneration !== null &&
    state?.commentCountAtGeneration !== undefined &&
    state?.currentCommentCount !== undefined &&
    state.commentCountAtGeneration !== state.currentCommentCount;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <Bot className="size-4" />
          AI要約
        </h2>
        {state?.summary && (
          <Button variant="outline" size="xs" disabled={isGenerating} onClick={generate}>
            {isGenerating ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            再生成
          </Button>
        )}
      </div>

      {isLoading && <Skeleton className="h-16 w-full" />}

      {!isLoading && error && <p className="text-sm text-destructive">{error}</p>}

      {!isLoading && !error && notConfigured && (
        <p className="text-sm text-muted-foreground">Claudeのトークンが設定されていません</p>
      )}

      {!isLoading && !error && !notConfigured && !state?.summary && (
        <Button variant="outline" size="sm" disabled={isGenerating} onClick={generate}>
          {isGenerating ? <Loader2 className="animate-spin" /> : <Bot />}
          要約を生成
        </Button>
      )}

      {!isLoading && !error && state?.summary && (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm whitespace-pre-wrap">{state.summary}</p>
          {isStale && (
            <p className="text-xs text-muted-foreground">
              コメントが追加されており、要約の内容が更新されていない可能性があります
            </p>
          )}
        </div>
      )}
    </div>
  );
}
