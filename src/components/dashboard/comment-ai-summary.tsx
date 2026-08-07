"use client";

import { Bot, Loader2, RotateCcw } from "lucide-react";

import { MarkdownBody } from "@/components/dashboard/markdown-body";
import { Button } from "@/components/ui/button";

// 要約は見出し＋箇条書きのMarkdownで生成されるが、MarkdownBodyの既定サイズは本文向けで
// 要約枠には大きすぎる。枠内の各要素を要約向けに縮める（#631）。
const SUMMARY_MARKDOWN_CLASS =
  "mt-1 text-xs leading-relaxed [&>*:first-child]:mt-0 [&_h3]:mt-2 [&_h3]:mb-1 [&_h3]:text-xs [&_p]:mb-1.5 [&_ul]:mb-1.5 [&_ol]:mb-1.5 [&_ul]:pl-4 [&_ol]:pl-4 [&_code]:text-[0.6875rem] [&_pre]:p-2 [&_pre]:text-[0.6875rem]";

type CommentAiSummaryProps = {
  summary: string | null;
  isGenerating: boolean;
  error: string | null;
  notConfigured: boolean;
  onGenerate: () => void;
};

export function CommentAiSummary({ summary, isGenerating, error, notConfigured, onGenerate }: CommentAiSummaryProps) {
  return (
    <div className="mt-2 mb-2 rounded-md border border-dashed p-2">
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

      {!error && summary && <MarkdownBody content={summary} className={SUMMARY_MARKDOWN_CLASS} />}
    </div>
  );
}
