"use client";

import { Check } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

export type MobileViewSheetItem<Id extends string> = {
  id: Id;
  label: string;
  icon: LucideIcon;
  /** 右端に出す件数。nullなら出さない（PRの「すべてのPR」など、数えていないビュー） */
  count: number | null;
  /** 件数バッジを強調するか（Issueの「ユーザーの確認待ち」） */
  highlighted?: boolean;
};

type MobileViewSheetProps<Id extends string> = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** シートの見出し（「表示するIssue」「表示するPull Request」） */
  title: string;
  /** 選べるビュー。並びは呼び出し側の指定順のまま出す */
  items: readonly MobileViewSheetItem<Id>[];
  selectedId: Id;
  onSelect: (id: Id) => void;
};

/**
 * スマホの一覧で表示するビューを選ぶボトムシート（#1645）。IssueとPull Requestで共用する（#1691）。
 *
 * 元は一覧の上部に横スクロールのタブとして並べていたが、画面に2つ強しか映らず、
 * 残りは横スクロールで探しに行くことになっていた。縦に全部並べれば1画面に収まり、
 * 「いくつあるのか」「いまどれなのか」も同時に読める。
 */
export function MobileViewSheet<Id extends string>({
  open,
  onOpenChange,
  title,
  items,
  selectedId,
  onSelect,
}: MobileViewSheetProps<Id>) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto overscroll-contain">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
        </SheetHeader>

        <div className="flex flex-col p-2 pt-0">
          {items.map((item) => {
            const Icon = item.icon;
            const active = item.id === selectedId;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  onSelect(item.id);
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
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.count !== null && (
                  <span
                    className={cn(
                      "shrink-0 text-xs text-muted-foreground",
                      item.highlighted &&
                        "flex size-5 items-center justify-center rounded-full bg-amber-500 text-white",
                    )}
                  >
                    {item.count}
                  </span>
                )}
                <Check className={cn("size-4 shrink-0", !active && "invisible")} />
              </button>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}
