"use client";

import { Bot, Loader2, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";

type CommentAiSummaryProps = {
  summary: string | null;
  isGenerating: boolean;
  error: string | null;
  notConfigured: boolean;
  onGenerate: () => void;
};

export function CommentAiSummary({ summary, isGenerating, error, notConfigured, onGenerate }: CommentAiSummaryProps) {
  return (
    <div className="mt-2 rounded-md border border-dashed p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
          <Bot className="size-3.5" />
          AI要約
        </span>
        {summary && (
          <Button variant="ghost" size="xs" disabled={isGenerating} onClick={onGenerate}>
            {isGenerating ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            再生成
          </Button>
        )}
      </div>

      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}

      {!error && notConfigured && (
        <p className="mt-1 text-xs text-muted-foreground">Claudeのトークンが設定されていません</p>
      )}

      {!error && !notConfigured && !summary && (
        <Button variant="outline" size="xs" className="mt-1" disabled={isGenerating} onClick={onGenerate}>
          {isGenerating ? <Loader2 className="animate-spin" /> : <Bot />}
          要約を生成
        </Button>
      )}

      {!error && summary && <p className="mt-1 text-xs whitespace-pre-wrap">{summary}</p>}
    </div>
  );
}
