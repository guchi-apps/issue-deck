"use client";

import { ListOrdered } from "lucide-react";
import { useState } from "react";

import {
  DispatchQueueBadge,
  DispatchQueueContent,
  describeDispatchQueueTitle,
} from "@/components/dashboard/dispatch-queue-content";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useDispatchState, type DispatchStateHandle } from "@/hooks/use-dispatch-state";
import { describeDispatchQueueLoad, summarizeDispatchQueue } from "@/lib/dispatch/queue-summary";

/**
 * PCのトップバーに出す実行キュー（#1266）。
 *
 * GitHub Actionsで並列に一括で流す使い方をやめ、**サブPCで順に流す**形にしたため（#1261）、
 * 「今どこまで進んでいて、あと何本待っているか」を1か所で見られる必要が出た。従来はジョブの
 * 状態がIssue詳細のボタンの下にしか出ず、**キュー全体を見る場所が無かった**。
 *
 * **中身は`dispatch-queue-content.tsx`にあり、スマホのヘッダー（`mobile-dispatch-status-button.tsx`）と
 * 共有する**（#1638）。ここが持つのはトリガーのボタンとポップオーバーの器だけ。
 *
 * **そのタイトルはIssue詳細への導線でもある**（#1625）。ここに出ているIssueを開くのに一覧へ
 * 戻って探し直す必要があった。押したらポップオーバーを閉じてから遷移するので、
 * **`open`を自分で持つ**（通知ベル`notification-button.tsx`と同じ形）。
 */
export function DispatchQueueButton({
  dispatch: injected,
  onOpenIssue,
}: {
  dispatch?: DispatchStateHandle;
  /** 行のタイトルからIssue詳細を開く（#1625）。渡さなければタイトルはただの文字列のまま */
  onOpenIssue?: (issueId: string) => void;
}) {
  const own = useDispatchState(injected === undefined);
  const dispatch = injected ?? own;
  const [open, setOpen] = useState(false);
  const summary = summarizeDispatchQueue(dispatch.jobs, dispatch.concurrency, dispatch.hosts);

  // 申告しているホストが1台も無ければ、キューという概念自体が無い
  if (dispatch.hosts.length === 0) return null;

  // Issueへ飛ぶ操作は、開いたまま後ろの画面だけが変わると何が起きたのか分からないので閉じる
  const openIssue = onOpenIssue
    ? (issueId: string) => {
        setOpen(false);
        onOpenIssue(issueId);
      }
    : undefined;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="relative flex items-center gap-1 rounded-md p-1.5 hover:bg-accent"
          aria-label="実行キュー"
          title={`実行キュー（${describeDispatchQueueTitle(summary)}）`}
        >
          <ListOrdered className="size-4" />
          <DispatchQueueBadge summary={summary} />
        </button>
      </PopoverTrigger>
      {/*
        ホストの様子（#1567）を足したぶん縦に伸びるため、`w-96`へ広げて画面からはみ出す
        ぶんはポップオーバーの中でスクロールさせる。セッション上限（既定12本）まで並ぶと
        キューの節が画面外へ出る
      */}
      <PopoverContent
        align="end"
        className="max-h-[70vh] w-96 max-w-[calc(100vw-2rem)] overflow-y-auto"
      >
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium">実行キュー</p>
          <p className="text-xs text-muted-foreground">{describeDispatchQueueLoad(summary)}</p>
        </div>

        <div className="mt-2">
          <DispatchQueueContent dispatch={dispatch} onOpenIssue={openIssue} />
        </div>
      </PopoverContent>
    </Popover>
  );
}
