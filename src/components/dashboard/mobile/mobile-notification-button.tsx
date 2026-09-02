"use client";

import { Bell } from "lucide-react";
import { useState } from "react";

import {
  describeNotificationTitle,
  NotificationBadge,
  NotificationContent,
} from "@/components/dashboard/notification-content";
import { NotificationRefreshButton } from "@/components/dashboard/notification-refresh-button";
import { useNotificationState } from "@/components/dashboard/notification-state";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useMobileScreen } from "@/hooks/use-mobile-screen";
import { useReferenceNavigation } from "@/hooks/use-reference-navigation";
import type { NotificationItem } from "@/lib/notifications";

/**
 * スマホのヘッダーに常設する通知ベル（#1772）。
 *
 * **従来、対応が必要なものを横断で見る場所はPCにしか無かった。** ベルを置いている`TopBar`は
 * `hidden md:flex`で、スマホでは確認待ち・マージ待ちPR・手作業待ちを画面ごとに探して回る
 * しかなかった。**中身はPCのベルと同じ**（`notification-content.tsx`）で、押しやすい
 * 下から出すぶんだけが違う——実行状況（`mobile-dispatch-status-button.tsx`）と同じ形。
 *
 * 置き場所は**実行状況の右隣**。PCのトップバー（実行キュー → ベル → アバター）と同じ順序に
 * なる。実行状況を置いている画面すべてに置く。
 *
 * **遷移先は自分で決め、propsで配ってもらわない。** このボタンはヘッダーを持つ画面すべてに
 * 置くので、配ると渡し忘れた画面だけ押せないという食い違いが生まれる
 * （`mobile-dispatch-status-button.tsx`と同じ理由）。**PCと遷移先が違う**のもここで吸収する。
 * PCは`pane`を切り替えれば済むが、スマホは`mscreen`を進めないと画面が変わらない。
 *
 * ただし**フックを呼ぶのはシートの中身（`SheetBody`）だけ**にしてある。あちらはルーターを
 * 要求する（`useRouter`）ので、常に描かれる側で呼ぶと、このボタンを含む画面のテストがすべて
 * ルーターのマウントを求められる。開いていないシートの中身はRadixが描かない。
 */
export function MobileNotificationButton() {
  const { badgeCount, countLabel, hasError } = useNotificationState();
  const [open, setOpen] = useState(false);

  return (
    // 開いた時点の取り直しと、開いている間の自動更新は中身の側が持つ
    // （`notification-refresh-button.tsx`。#1909）
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label="対応が必要なもの"
          title={describeNotificationTitle(badgeCount)}
          className="relative flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Bell className="size-5" />
          {/* 指で押せる大きさ（size-11）のぶんだけ、PCより内側へ寄せてアイコンの角に重ねる。
              数えるのは手作業待ちを除いたぶん（#1936）でPCのベルと同じ */}
          <NotificationBadge count={badgeCount} hasError={hasError} className="top-1.5 right-1.5" />
        </button>
      </SheetTrigger>
      {/*
        件数が多いと縦に伸びるため、画面の高さの85%までにして中をスクロールさせる。
        `svh`なのはiOS Safariのアドレスバーぶんでシートが画面外へはみ出さないようにするため
        （実行状況のシートと同じ）
      */}
      <SheetContent side="bottom" className="max-h-[85svh] gap-2 overflow-y-auto p-0 pb-8">
        <SheetHeader className="p-3 pb-0">
          {/* シートの閉じるボタン（`sheet.tsx`の`absolute top-3 right-3`、44×44px）は
              ヘッダーの上から56px（top: 12px + size: 44px）の高さを占有する。タイトル・件数・
              更新ボタンはすべてこの高さの範囲に収まるため、重なりを避けるにはすべての行が
              右側に余白を取る必要がある（#1909、mobile-issue-filter-sheet.tx のパターン参照） */}
          <SheetTitle className="pr-8 text-sm">対応が必要なもの</SheetTitle>
          <div className="flex items-center justify-between gap-2 pr-8">
            {/* バッジに数えていない手作業待ちがあれば内訳が付く（#1936） */}
            <SheetDescription className="text-xs">{countLabel}</SheetDescription>
            <NotificationRefreshButton />
          </div>
        </SheetHeader>
        <SheetBody onClose={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}

/**
 * シートの中身。**開いている間しか描かれない**ので、ここでルーターを要求するフック
 * （`useReferenceNavigation`・`useMobileScreen`）を呼ぶ。閉じている側で呼ぶと、このボタンを
 * 置いた画面すべてのテストがルーターのマウントを求めることになる。
 */
function SheetBody({ onClose }: { onClose: () => void }) {
  const { items, groups, issues, repositories } = useNotificationState();
  const { openIssue, openPullRequest } = useReferenceNavigation();
  const { selectTab, selectQuickView } = useMobileScreen(issues, repositories);

  // 開いたまま後ろの画面だけが変わると何が起きたのか分からないので、閉じてから遷移する
  function navigate(run: () => void) {
    onClose();
    run();
  }

  function handleSelect(item: NotificationItem) {
    if (item.target.kind === "issue") {
      const { issueId } = item.target;
      navigate(() => openIssue(issueId));
      return;
    }
    if (item.target.kind === "pull-request") {
      const { pullRequestId } = item.target;
      navigate(() => openPullRequest(pullRequestId));
      return;
    }
    navigate(() => selectTab("flow"));
  }

  return (
    <NotificationContent
      items={items}
      groups={groups}
      onSelect={handleSelect}
      // PCの「確認待ちビュー」に当たるのはスマホではIssue一覧の同ビュー（ホーム経由と同じ遷移）
      onOpenCheckUserView={() => navigate(() => selectQuickView("check-user"))}
      onOpenFlow={() => navigate(() => selectTab("flow"))}
      // 高さの上限はシート側（85svh）が持つので、ここでは頭打ちにしない
      listClassName=""
    />
  );
}
