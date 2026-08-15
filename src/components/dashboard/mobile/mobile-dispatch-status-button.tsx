"use client";

import { ListOrdered } from "lucide-react";

import {
  DispatchQueueBadge,
  DispatchQueueContent,
  describeDispatchQueueTitle,
} from "@/components/dashboard/dispatch-queue-content";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useDispatchState, type DispatchStateHandle } from "@/hooks/use-dispatch-state";
import { summarizeDispatchQueue } from "@/lib/dispatch/queue-summary";

/**
 * スマホのヘッダー右上に常設する実行状況（#1638）。
 *
 * **従来、サブPCの様子はホーム画面でしか見られなかった。** 実行キューを開くボタンはPCの
 * トップバー（`hidden md:flex`）にしかなく、スマホ向けにはホームへ「実行中のセッション」の節を
 * 置いて代用していた（#1567）ため、Issue一覧やPR画面を見ている最中に何が走っているかを
 * 確かめられなかった。中身はPCの実行キューと同じ`DispatchQueueContent`で、**押しやすい下から
 * 出す**ぶんだけが違う。
 *
 * **既に`useDispatchState`を呼んでいる画面は、その`dispatch`を渡す。** スマホの各画面は
 * `issue-deck-shell.tsx`が条件付きで1つだけmountするので置くだけならポーリングは1本だが、
 * Issue一覧は`IssueList`が実行先の解決のために自前で取っている（#1262）。同じ画面のために
 * 取得口を増やさないという取り決めに従い、渡された場合は自分では取りに行かない
 * （`dispatch-queue-button.tsx`と同じ形）。
 *
 * **申告しているホストが1台も無ければ何も出さない**（PCの実行キューのボタンと同じ判定）。
 * ディスパッチを使っていない環境で、押しても空のシートしか出ないアイコンを残さない。
 */
export function MobileDispatchStatusButton({
  dispatch: injected,
}: {
  dispatch?: DispatchStateHandle;
}) {
  const own = useDispatchState(injected === undefined);
  const dispatch = injected ?? own;
  const summary = summarizeDispatchQueue(dispatch.jobs, dispatch.concurrency);

  if (dispatch.hosts.length === 0) return null;

  return (
    <Sheet>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label="実行状況"
          className="relative flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ListOrdered className="size-5" />
          <DispatchQueueBadge summary={summary} />
        </button>
      </SheetTrigger>
      {/*
        ホストの様子とキューを合わせると縦に伸びるため、画面の高さの85%までにして中を
        スクロールさせる。`svh`なのはiOS SafariのアドレスバーぶんでSheetが画面外へ
        はみ出さないようにするため
      */}
      <SheetContent side="bottom" className="max-h-[85svh] gap-2 overflow-y-auto p-4 pb-8">
        <SheetHeader className="p-0">
          <SheetTitle className="text-sm">実行状況</SheetTitle>
          <SheetDescription className="text-xs">
            {describeDispatchQueueTitle(summary)}
          </SheetDescription>
        </SheetHeader>
        <DispatchQueueContent dispatch={dispatch} />
      </SheetContent>
    </Sheet>
  );
}
