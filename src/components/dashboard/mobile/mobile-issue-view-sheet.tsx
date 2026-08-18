"use client";

import { MobileViewSheet } from "@/components/dashboard/mobile/mobile-view-sheet";
import { navViewIcons, type NavView } from "@/lib/nav-views";
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
 * 見た目と操作はPull Request側と共通の`MobileViewSheet`が持ち、ここはIssue固有の
 * 材料（アイコン・件数・強調するビュー）を組み立てるだけにしている（#1691）。
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
    <MobileViewSheet
      open={open}
      onOpenChange={onOpenChange}
      title="表示するIssue"
      items={views.map((navView) => {
        const count = navCounts[navView.id] ?? 0;
        return {
          id: navView.id,
          label: navView.label,
          icon: navViewIcons[navView.id],
          count,
          // 確認待ちの強調は件数バッジだけに閉じる（#1443）。行ごとamberに塗ると
          // 選択中の行（primary）と役割が混ざる。
          highlighted: navView.id === "check-user" && count > 0,
        };
      })}
      selectedId={view}
      onSelect={onSelect}
    />
  );
}
