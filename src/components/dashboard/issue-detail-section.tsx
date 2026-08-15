"use client";

import type { ReactNode } from "react";

import { ChevronRight } from "lucide-react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { usePersistedState } from "@/hooks/use-persisted-state";
import { cn } from "@/lib/utils";

type IssueDetailSectionProps = {
  /**
   * 開閉状態の保存キー。**Issueごとではなくセクションごとに1つ**にする（#1577）。
   * Issueごとに覚えると、開くIssueが変わるたびに既定の「畳む」へ戻り、覚えている意味が無くなる。
   */
  id: string;
  /**
   * このセクションの枠へ広げる目印のprops（#1663の`checkUserTargetProps`）。
   * **開閉状態の保存キー（`id`）とは別物**で、画面内の別の場所からスクロールして
   * 来るためだけに使う。idではなくdata属性なのは、PC版とスマホ版が同時にDOMへ
   * 乗るため（`check-user-focus.ts`）。
   */
  targetProps?: Record<string, string>;
  title: string;
  /** 見出しに添える件数。0やnullなら出さない */
  count?: number | null;
  /** 畳んでいるときも見せておく要約（内訳バッジ・進捗バーなど） */
  summary?: ReactNode;
  /**
   * trueの間は必ず開いた状態にし、畳めなくする。マージ待ちのように
   * 「畳まれていると押すべきものに気付けない」場面のための逃げ道（#1577）。
   */
  forceOpen?: boolean;
  /** `attention`は枠をamberでハイライトする（マージ待ちの対応PR） */
  tone?: "default" | "attention";
  className?: string;
  children: ReactNode;
};

/**
 * Issue詳細の補助情報（対応PR・親子Issue・AI要約）を畳めるようにする入れ物（#1577）。
 *
 * 3つとも常に全開だったため、対応PRが6件あるようなIssueでは本文（説明）が画面外へ押し出されていた。
 * 既定は「畳む」で、畳んだ行には件数と要約だけを残す。**畳んでもデータの取得は止めない** —
 * 件数と要約を出すのに必要なので、取得を止めると畳んだ行が空になる。
 */
export function IssueDetailSection({
  id,
  targetProps,
  title,
  count = null,
  summary,
  forceOpen = false,
  tone = "default",
  className,
  children,
}: IssueDetailSectionProps) {
  const [persistedOpen, setPersistedOpen] = usePersistedState(
    `issue-detail.section.${id}`,
    false,
  );
  const open = forceOpen || persistedOpen;

  return (
    <Collapsible
      {...targetProps}
      open={open}
      onOpenChange={(next) => {
        // 強制的に開いている間の開閉操作は保存へ反映しない（畳めないのに設定だけ変わるのを防ぐ）
        if (!forceOpen) setPersistedOpen(next);
      }}
      className={cn(
        "rounded-lg border",
        tone === "attention" && "border-amber-500 bg-amber-500/10",
        className,
      )}
    >
      <CollapsibleTrigger
        disabled={forceOpen}
        className={cn(
          "flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left",
          !forceOpen && "hover:bg-accent/50",
          open ? "rounded-t-lg" : "rounded-lg",
        )}
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
            forceOpen && "invisible",
          )}
        />
        <span className="shrink-0 text-xs font-semibold text-muted-foreground">
          {title}
          {count !== null && count > 0 && <span className="ml-1 font-normal">{count}</span>}
        </span>
        {summary && (
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{summary}</span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t px-3 py-2.5">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
