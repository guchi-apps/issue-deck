"use client";

import { Gauge, GitBranch, History, Home } from "lucide-react";

import { NotificationBadge } from "@/components/dashboard/notification-content";
import { useNotificationState } from "@/components/dashboard/notification-state";
import {
  describeReleaseMergePending,
  type ReleaseMergePendingCounts,
} from "@/lib/release-merge-pending";
import { cn } from "@/lib/utils";

// タブのidは`mscreen`クエリの値そのもの（`selectTab`が`navigate({ screen: tab })`へ
// そのまま渡す）。
//
// **「設定」は#1638で「ブランチ」へ入れ替えた。** ブランチ画面は日常的に開くのに
// ホームの「フロー」から1段掘る必要があり（#1455）、逆に設定は毎日押すものではない。
// 設定はホームのヘッダー右上（`mobile-home-screen.tsx`の歯車）へ移した。
// `mscreen=settings`のURLはそのまま生きている。
//
// **「AI使用量」は#2631で足した。** AI使用量はスマホで一番見たいものが、ホームのメニューから
// 1段掘らないと開けない状態だった。あわせてホームのメニューからは外し（#2504で置いた行）、
// 押す場所を1か所に保っている——2か所に置くと、どちらを押しても同じ画面が開くのに導線だけが
// 増える。
//
// **「Issue」（id=`repos`。リポジトリ一覧）と「PR」は#2724で外した。** どちらも押す頻度が
// 低く、5枠で1枠78pxまで詰まっていた枠を3枠＝131pxへ戻す。**開く先の画面は消していない**——
// Pull Requestはホームの「Pull Request」の節から、リポジトリ一覧は同じくホームの「Issue」の
// 節に足した「リポジトリ」の行から開く（`mobile-home-screen.tsx`）。`mscreen=repos`・
// `mscreen=pull-requests`のURLもそのまま生きている。**フッターから外した画面ではどのタブを
// 点灯させるか**は`mobile-nav-tab.ts`が持つ（ホームからのドリルダウンとして「ホーム」）。
//
// **「リリース」（id=`release-history`）は#2811で足した。** AI使用量と同じ経緯で、スマホから
// 見たいものがホームのメニューを1段掘らないと開けなかった。置き場所は「ブランチ」の隣＝3枠目
// で、developへのマージ待ち→本番へ出た結果、というリリース周りの導線を隣り合わせにする。
// **ラベルは画面名（「リリース履歴」）ではなく「リリース」**——4枠になって1枠98pxまで詰まり、
// 6文字だと枠いっぱいで隣と接する。画面のタイトルとPCの左メニューは「リリース履歴」のまま。
// AI使用量と同じく、ホームのメニューからは外して押す場所を1か所に保っている
// （`mobile-home-screen.tsx`）。
const items = [
  { id: "home", label: "ホーム", icon: Home },
  { id: "flow", label: "ブランチ", icon: GitBranch },
  { id: "release-history", label: "リリース", icon: History },
  { id: "usage", label: "AI使用量", icon: Gauge },
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
 * スマホのフッター（#1436・#1638・#2724・#2811）。
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
  // アイコンに重ねるのは合計だけ（#2055）。1枠に内訳2つは収まらず、収めるには
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
              // **ラベルは折り返させない**（#2631）。折り返すとその枠だけ2行になり、
              // フッターの高さ（56px）が枠ごとに食い違う。収まらない場合は横にはみ出させて、
              // 詰まっていることが見えるようにする（#2724で3枠に戻して余裕はできたが、
              // 枠が増えたときに静かに崩れないよう指定は残す）。
              "flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 py-2 text-xs whitespace-nowrap text-muted-foreground",
              active === id && "text-foreground",
            )}
          >
            {/* バッジはアイコンの角に重ねるので、基準になる箱をアイコンだけに絞る。
                ボタン全体を基準にすると、枠の右上（＝隣のタブとの境目）へ飛ぶ */}
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
