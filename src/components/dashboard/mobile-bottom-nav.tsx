"use client";

import { GitBranch, GitPullRequest, Home, ListChecks } from "lucide-react";

import { NotificationBadge } from "@/components/dashboard/notification-content";
import { useNotificationState } from "@/components/dashboard/notification-state";
import {
  describeReleaseMergePending,
  type ReleaseMergePendingCounts,
} from "@/lib/release-merge-pending";
import { cn } from "@/lib/utils";

// タブのidは`mscreen`クエリの値そのもの（`selectTab`が`navigate({ screen: tab })`へ
// そのまま渡す）。「Issue」タブのidが`repos`なのはそのためで、開くのはリポジトリ一覧
// （→リポジトリを選ぶとそのリポジトリのIssue一覧）になる（#1436）。idを`issues`にすると
// 全リポジトリ横断のIssue一覧（`mscreen=issues`）と衝突し、既存URLの意味が変わってしまう。
// その横断一覧はフッターから外し、ホームの「いまの状況」のカードとメニューからのドリルダウン
// だけで開く（#1690）。
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

type MobileBottomNavViewProps = {
  /**
   * 点灯させるタブ。**`null`はどのタブも点灯させない**（#1638）。設定画面のように、
   * フッターに対応するタブが無い画面がある。
   */
  active?: MobileBottomNavTab | null;
  onSelect?: (tab: MobileBottomNavTab) => void;
  /**
   * 「ブランチ」タブのアイコンに重ねる反映待ちの件数（#2055）。**`null`は未取得**で、
   * そのときは何も出さない（0を出すと「待っているものが無い」と読めてしまう）。
   */
  mergePending?: ReleaseMergePendingCounts | null;
};

/**
 * スマホのフッター（#1436・#1638）。
 *
 * **反映待ちの件数はProviderから自分で読む。** フッターは`NotificationProvider`の内側に
 * 置かれており、Providerを描いている`issue-deck-shell.tsx`はその親なのでフックを呼べず、
 * propで配れない。ベルと同じ材料を同じ1本のポーリングから読むので、取得は増えない
 * （`notification-state.tsx`。新しく`useRepositoryReleaseStatuses`を呼ぶと2本走る）。
 */
export function MobileBottomNav(props: Omit<MobileBottomNavViewProps, "mergePending">) {
  const { releaseMergePending } = useNotificationState();

  return <MobileBottomNavView {...props} mergePending={releaseMergePending} />;
}

/**
 * 描画だけを持つ本体。Providerに依存しないので、件数を渡してそのまま試験できる。
 */
export function MobileBottomNavView({
  active = "home",
  onSelect,
  mergePending = null,
}: MobileBottomNavViewProps) {
  // アイコンに重ねるのは合計だけ（#2055）。1枠98pxに内訳2つは収まらず、収めるには
  // フッターを56px→68pxへ伸ばすことになる。内訳はタブを開いた「ブランチ」画面が持ち、
  // 開かずに読めるようにtitle・aria-labelへ入れる。
  const pendingCount = mergePending?.total ?? 0;
  const pendingLabel = describeReleaseMergePending(mergePending);

  return (
    <nav className="flex shrink-0 border-t bg-background md:hidden">
      {items.map(({ id, label, icon: Icon }) => {
        const showsBadge = id === "flow" && pendingCount > 0;

        return (
          <button
            key={id}
            type="button"
            onClick={() => onSelect?.(id)}
            // バッジを出すときだけ内訳を添える。0件のときまで付けると、押す前に読まれる
            // 情報が「反映待ちはありません」だけのタブになる
            aria-label={showsBadge ? `${label}（${pendingLabel}）` : undefined}
            title={showsBadge ? pendingLabel : undefined}
            className={cn(
              "flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 py-2 text-xs text-muted-foreground",
              active === id && "text-foreground",
            )}
          >
            {/* バッジはアイコンの角に重ねるので、基準になる箱をアイコンだけに絞る。
                ボタン全体を基準にすると、幅98pxの枠の右上（＝隣のタブとの境目）へ飛ぶ */}
            <span className="relative inline-flex">
              <Icon className="size-5" />
              {showsBadge && (
                <NotificationBadge
                  count={pendingCount}
                  hasError={mergePending?.hasError ?? false}
                  className="-top-1.5 -right-2.5"
                />
              )}
            </span>
            {label}
          </button>
        );
      })}
    </nav>
  );
}
