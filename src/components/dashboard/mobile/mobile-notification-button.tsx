"use client";

import { Bell } from "lucide-react";
import { useState } from "react";

import {
  describeNotificationTitle,
  NotificationBadge,
  NotificationContent,
} from "@/components/dashboard/notification-content";
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
  const { items, hasError, refetch } = useNotificationState();
  const [open, setOpen] = useState(false);

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        // 開いた時点の状態で判断できるよう取り直す（バックグラウンドの再取得は5分間隔のため）
        if (nextOpen) refetch();
      }}
    >
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label="対応が必要なもの"
          title={describeNotificationTitle(items.length)}
          className="relative flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Bell className="size-5" />
          {/* 指で押せる大きさ（size-11）のぶんだけ、PCより内側へ寄せてアイコンの角に重ねる */}
          <NotificationBadge count={items.length} hasError={hasError} className="top-1.5 right-1.5" />
        </button>
      </SheetTrigger>
      {/*
        件数が多いと縦に伸びるため、画面の高さの85%までにして中をスクロールさせる。
        `svh`なのはiOS Safariのアドレスバーぶんでシートが画面外へはみ出さないようにするため
        （実行状況のシートと同じ）
      */}
      <SheetContent side="bottom" className="max-h-[85svh] gap-2 overflow-y-auto p-0 pb-8">
        <SheetHeader className="p-3 pb-0">
          <SheetTitle className="text-sm">対応が必要なもの</SheetTitle>
          <SheetDescription className="text-xs">{items.length}件</SheetDescription>
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
