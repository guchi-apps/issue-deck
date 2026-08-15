"use client";

import { Check } from "lucide-react";

import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { navViewIcons, type NavView } from "@/lib/nav-views";
import { cn } from "@/lib/utils";
import type { NavViewId } from "@/types/issue";

type MobileIssueViewSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 選べるビュー。並びは呼び出し側の指定順のまま出す */
  views: readonly NavView[];
  view: NavViewId;
  /** ビューごとの該当Issue件数。`00.check-user`の強調表示にも使う */
  navCounts: Record<NavViewId, number>;
  onSelect: (view: NavViewId) => void;
};

/**
 * スマホのIssue一覧で表示するビューを選ぶボトムシート（#1645）。
 *
 * 元は一覧の上部に横スクロールのタブとして並べていたが、画面に2つ強しか映らず、
 * 残りは横スクロールで探しに行くことになっていた。縦に全部並べれば1画面に収まり、
 * 「いくつあるのか」「いまどれなのか」も同時に読める。
 */
export function MobileIssueViewSheet({
  open,
  onOpenChange,
  views,
  view,
  navCounts,
  onSelect,
}: MobileIssueViewSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto overscroll-contain">
        <SheetHeader>
          <SheetTitle>表示するIssue</SheetTitle>
        </SheetHeader>

        <div className="flex flex-col p-2 pt-0">
          {views.map((navView) => {
            const count = navCounts[navView.id] ?? 0;
            const Icon = navViewIcons[navView.id];
            const active = navView.id === view;
            // 確認待ちの強調は件数バッジだけに閉じる（#1443）。行ごとamberに塗ると
            // 選択中の行（primary）と役割が混ざる。
            const highlighted = navView.id === "check-user" && count > 0;
            return (
              <button
                key={navView.id}
                type="button"
                onClick={() => {
                  onSelect(navView.id);
                  onOpenChange(false);
                }}
                aria-current={active ? "true" : undefined}
                // 行の高さは指で押せる大きさ（52px）を確保し、行のどこを押しても選べるようにする
                className={cn(
                  "flex h-13 items-center gap-3 rounded-lg px-3 text-left text-sm",
                  active && "bg-primary/10 font-medium text-primary",
                )}
              >
                <Icon className={cn("size-5 shrink-0", !active && "text-muted-foreground")} />
                <span className="min-w-0 flex-1 truncate">{navView.label}</span>
                <span
                  className={cn(
                    "shrink-0 text-xs text-muted-foreground",
                    highlighted &&
                      "flex size-5 items-center justify-center rounded-full bg-amber-500 text-white",
                  )}
                >
                  {count}
                </span>
                <Check className={cn("size-4 shrink-0", !active && "invisible")} />
              </button>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}
