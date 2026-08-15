"use client";

import { Bot, Loader2, RotateCcw } from "lucide-react";

import { IssueDetailSection } from "@/components/dashboard/issue-detail-section";
import { MarkdownBody } from "@/components/dashboard/markdown-body";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useIssueSummary } from "@/hooks/use-issue-summary";
import type { Issue } from "@/types/issue";

// 要約は見出し＋箇条書きのMarkdownで生成される。本文より控えめに見せたいので、
// MarkdownBodyの既定サイズ・余白を要約向けに縮めて表示する（#631）。
const SUMMARY_MARKDOWN_CLASS =
  "text-sm leading-relaxed [&>*:first-child]:mt-0 [&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-sm [&_p]:mb-2 [&_ul]:mb-2 [&_ol]:mb-2";

type IssueAiSummaryProps = {
  issue: Issue;
};

type SummaryHandle = ReturnType<typeof useIssueSummary>;

/** 要約が本文・コメントの追加に追いついていないか */
function isSummaryStale(state: SummaryHandle["state"]): boolean {
  return (
    state?.summary !== null &&
    state?.commentCountAtGeneration !== null &&
    state?.commentCountAtGeneration !== undefined &&
    state?.currentCommentCount !== undefined &&
    state.commentCountAtGeneration !== state.currentCommentCount
  );
}

/** 見出しを除いた要約の中身。スマホの詳細と、PCの折りたたみセクションで共有する */
function IssueAiSummaryBody({
  state,
  isLoading,
  isGenerating,
  error,
  notConfigured,
  generate,
}: SummaryHandle) {
  if (isLoading) return <Skeleton className="h-16 w-full" />;
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (notConfigured)
    return <p className="text-sm text-muted-foreground">Claudeのトークンが設定されていません</p>;

  if (!state?.summary) {
    return (
      <Button variant="outline" size="sm" disabled={isGenerating} onClick={generate}>
        {isGenerating ? <Loader2 className="animate-spin" /> : <Bot />}
        要約を生成
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <MarkdownBody content={state.summary} className={SUMMARY_MARKDOWN_CLASS} />
      {isSummaryStale(state) && (
        <p className="text-xs text-muted-foreground">
          コメントが追加されており、要約の内容が更新されていない可能性があります
        </p>
      )}
    </div>
  );
}

/** 見出し＋要約を常に開いた形で出す。スマホの詳細（`mobile-issue-detail.tsx`）で使う */
export function IssueAiSummary({ issue }: IssueAiSummaryProps) {
  const handle = useIssueSummary(issue);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <Bot className="size-4" />
          AI要約
        </h2>
        {handle.state?.summary && (
          <Button
            variant="outline"
            size="xs"
            disabled={handle.isGenerating}
            onClick={handle.generate}
          >
            {handle.isGenerating ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            再生成
          </Button>
        )}
      </div>
      <IssueAiSummaryBody {...handle} />
    </div>
  );
}

/**
 * PCのIssue詳細向けに、AI要約を折りたたみセクションとして出す（#1577）。
 *
 * **フックはここで1回だけ呼ぶ。** 畳んだ行に出す状態（未生成・生成済み・生成中）は
 * `useIssueSummary`が持っているため、親が要約の有無を知るには親でも同じフックを呼ぶことになり、
 * 取得が二重になる。セクションごとこのコンポーネントが持つことでその重複を避けている。
 */
export function IssueAiSummarySection({ issue }: IssueAiSummaryProps) {
  const handle = useIssueSummary(issue);
  const hasSummary = Boolean(handle.state?.summary);

  return (
    <IssueDetailSection
      id="ai-summary"
      title="AI要約"
      summary={
        <span className="text-xs text-muted-foreground">
          {handle.isLoading
            ? "読み込み中"
            : handle.isGenerating
              ? "生成中…"
              : hasSummary
                ? isSummaryStale(handle.state)
                  ? "生成済み（コメント追加後）"
                  : "生成済み"
                : "未生成"}
        </span>
      }
    >
      <div className="flex flex-col gap-2">
        {hasSummary && (
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="xs"
              disabled={handle.isGenerating}
              onClick={handle.generate}
            >
              {handle.isGenerating ? <Loader2 className="animate-spin" /> : <RotateCcw />}
              再生成
            </Button>
          </div>
        )}
        <IssueAiSummaryBody {...handle} />
      </div>
    </IssueDetailSection>
  );
}
