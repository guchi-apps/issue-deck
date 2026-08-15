"use client";

import { GitBranch, GitPullRequest, Home, ListChecks } from "lucide-react";

import { cn } from "@/lib/utils";

// タブのidは`mscreen`クエリの値そのもの（`selectTab`が`navigate({ screen: tab })`へ
// そのまま渡す）。「Issue」タブのidが`repos`なのはそのためで、開くのはリポジトリ一覧
// （→リポジトリを選ぶとそのリポジトリのIssue一覧）になる（#1436）。idを`issues`にすると
// 全リポジトリ横断のIssue一覧（`mscreen=issues`）と衝突し、既存URLの意味が変わってしまう。
// その横断一覧はフッターから外し、ホームからのドリルダウンだけで開く。
//
// **4枠目は「設定」から「ブランチ」へ入れ替えた（#1638）。** ブランチ画面は日常的に開くのに
// ホームの「フロー」から1段掘る必要があり（#1455）、逆に設定は毎日押すものではない。
// 5つに増やすとタブの幅が1つあたり98px→78pxまで詰まるため、設定はホームのヘッダー右上
// （`mobile-home-screen.tsx`の歯車）へ移した。`mscreen=settings`のURLはそのまま生きている。
const items = [
  { id: "home", label: "ホーム", icon: Home },
  { id: "repos", label: "Issue", icon: ListChecks },
  { id: "pull-requests", label: "PR", icon: GitPullRequest },
  { id: "flow", label: "ブランチ", icon: GitBranch },
] as const;

export type MobileBottomNavTab = (typeof items)[number]["id"];

type MobileBottomNavProps = {
  /**
   * 点灯させるタブ。**`null`はどのタブも点灯させない**（#1638）。設定画面のように、
   * フッターに対応するタブが無い画面がある。
   */
  active?: MobileBottomNavTab | null;
  onSelect?: (tab: MobileBottomNavTab) => void;
};

export function MobileBottomNav({ active = "home", onSelect }: MobileBottomNavProps) {
  return (
    <nav className="flex shrink-0 border-t bg-background md:hidden">
      {items.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => onSelect?.(id)}
          className={cn(
            "flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 py-2 text-xs text-muted-foreground",
            active === id && "text-foreground",
          )}
        >
          <Icon className="size-5" />
          {label}
        </button>
      ))}
    </nav>
  );
}
