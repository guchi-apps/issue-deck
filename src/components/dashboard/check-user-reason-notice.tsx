"use client";

import { ArrowDown, ExternalLink, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { focusCheckUserTarget } from "@/lib/check-user-focus";
import type { CheckUserGuidance } from "@/lib/github/check-user-guidance";
import { cn } from "@/lib/utils";

/** 移動ボタンの文言。**行き先を名前で出す**（押した先で何を押すかは`buttons`が受け持つ） */
const SCROLL_BUTTON_LABEL = {
  approval: "承認欄へ移動",
  "pull-requests": "対応PRへ移動",
  // 計画の承認パネル（#2061）。Issue詳細の上部にあるので、他の2つと違って上へ動く
  plan: "計画へ移動",
} as const;

/**
 * `00.check-user`の理由（`01.check-*`）ごとに、**次にどこの何を押せばよいか**を出す（#1663）。
 *
 * 進捗ステッパーのバッジ（「ユーザー確認待ち・計画の承認」）と承認カードの見出しは、求められて
 * いる行為の名前までしか表さない。Remote Controlを開くのか・対応PRをマージするのか・コメント欄の
 * 「承認」を押すのかは画面のどこにも無く、理由と実行先の組み合わせを毎回思い出す必要があった。
 *
 * パネルの主役は**行き先ボタン1つ**で、押すと実際に操作する場所までスクロールする
 * （`focusCheckUserTarget`）。ローカルセッションが入力待ちのときだけは画面のボタンがどこにも
 * 届かないため、唯一効く出口であるRemote Controlを開くボタンに差し替わる（判定は
 * `resolveCheckUserGuidance`）。
 *
 * 置き場所はPC・スマホ共通で2か所（Issue詳細上部の`IssueStatusCard`と、コメント欄の承認カード）。
 * **同じ内容を同じ体裁で出す**のは、読む場所によって次の操作が違って見えないようにするため
 * （#1631の`MergeCheckReasonNotice`と同じ考え方）。色も確認待ちの表示に合わせてamberで揃える。
 */
export function CheckUserReasonNotice({
  guidance,
  className,
  children,
}: {
  guidance: CheckUserGuidance;
  className?: string;
  /** 理由の詳細（`01.check-merge`のときの「自動マージされなかった理由」など） */
  children?: ReactNode;
}) {
  const { action } = guidance;

  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-md bg-amber-500/15 px-2.5 py-2 ring-1 ring-inset ring-amber-500/40",
        className,
      )}
    >
      {/* エージェントの状態は見出しと同じ行へ寄せる（#2057）。以前はパネルの4行目に
          「待機中 マージするまで次の工程へ進みません」として独立した段を持っていたが、
          補足文はどの理由でも説明文かボタンの案内の言い換えだった（`check-user-guidance.ts`） */}
      <p className="flex items-center gap-2 text-xs font-semibold text-amber-700 dark:text-amber-400">
        <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0">{guidance.heading}</span>
        <span className="ml-auto shrink-0 rounded bg-background px-1.5 py-0.5 text-[11px] font-semibold text-foreground ring-1 ring-inset ring-border">
          {guidance.agentState}
        </span>
      </p>
      <p className="text-[13px] leading-relaxed">{guidance.description}</p>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        {action?.kind === "remote-control" && (
          <Button size="sm" variant="outline" className="bg-background" asChild>
            <a href={action.url} target="_blank" rel="noreferrer">
              Remote Controlで開く
              <ExternalLink />
            </a>
          </Button>
        )}
        {action?.kind === "scroll" && (
          <Button
            size="sm"
            variant="outline"
            className="bg-background"
            onClick={() => focusCheckUserTarget(action.target)}
          >
            {SCROLL_BUTTON_LABEL[action.target]}
            <ArrowDown />
          </Button>
        )}
        <p className="text-xs text-muted-foreground">{guidance.buttons}</p>
      </div>
      {children}
    </div>
  );
}
