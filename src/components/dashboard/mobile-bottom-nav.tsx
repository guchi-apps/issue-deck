"use client";

import { GitPullRequest, Home, ListChecks, Settings } from "lucide-react";

import { cn } from "@/lib/utils";

// タブのidは`mscreen`クエリの値そのもの（`selectTab`が`navigate({ screen: tab })`へ
// そのまま渡す）。「Issue」タブのidが`repos`なのはそのためで、開くのはリポジトリ一覧
// （→リポジトリを選ぶとそのリポジトリのIssue一覧）になる（#1436）。idを`issues`にすると
// 全リポジトリ横断のIssue一覧（`mscreen=issues`）と衝突し、既存URLの意味が変わってしまう。
// その横断一覧はフッターから外し、ホームからのドリルダウンだけで開く。
const items = [
  { id: "home", label: "ホーム", icon: Home },
  { id: "repos", label: "Issue", icon: ListChecks },
  { id: "pull-requests", label: "PR", icon: GitPullRequest },
  { id: "settings", label: "設定", icon: Settings },
] as const;

export type MobileBottomNavTab = (typeof items)[number]["id"];

type MobileBottomNavProps = {
  active?: MobileBottomNavTab;
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
