"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { AppIconGlyph } from "@/lib/app-icon-glyph";
import {
  SLOW_LOADING_THRESHOLD_MS,
  loadingScreenMessage,
  type LoadingScreenMessage,
} from "@/lib/loading-screen-message";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * 経過時間ではなく「しきい値を過ぎたか」だけを持つ（#1978）。何秒経ったかは画面に
 * 出さないため、1秒ごとに再描画する必要がない。
 */
function useLoadingScreenMessage(): LoadingScreenMessage {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const timerId = window.setTimeout(() => setSlow(true), SLOW_LOADING_THRESHOLD_MS);
    return () => window.clearTimeout(timerId);
  }, []);

  return loadingScreenMessage(slow ? SLOW_LOADING_THRESHOLD_MS : 0);
}

function reloadPage() {
  window.location.reload();
}

/**
 * 読み込み中であることを示す往復するバー。どこまで進んだかはサーバー側から分からないので、
 * 進捗率は出さず、動き続けること自体を「アプリは生きている」の合図にする。
 */
function LoadingBar() {
  return (
    <div className="relative h-1 w-56 overflow-hidden rounded-full bg-muted">
      <div className="loading-bar-slide absolute inset-y-0 left-0 w-2/5 rounded-full bg-foreground" />
    </div>
  );
}

/**
 * 起動中・画面の切り替え中に出す全画面のローディング画面（#1978）。
 *
 * ホーム画面から起動したPWAにはタブもアドレスバーも無く、読み込み中なのか止まっているのかを
 * 画面の外から知る手段が無い。アイコンとアプリ名を出して「IssueDeckは起きている」ことを示し、
 * 長引いたら（`SLOW_LOADING_THRESHOLD_MS`）自分で読み込み直せるようにする。
 *
 * 読み込みが**失敗した**ときは`AppErrorScreen`（`app/error.tsx`）が同じ並びのまま
 * 文言と操作を差し替える。どちらも出ない白い画面を残さないことが、この2つの役目。
 */
export function AppLoadingScreen({ className }: { className?: string }) {
  const message = useLoadingScreenMessage();

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex h-full flex-1 flex-col items-center justify-center gap-4 bg-background p-6 text-center",
        className,
      )}
    >
      <div className="flex size-14 items-center justify-center rounded-2xl bg-foreground">
        <AppIconGlyph size={30} fill="var(--background)" />
      </div>
      <p className="text-lg font-semibold">IssueDeck</p>
      <LoadingBar />
      <p className={cn("text-sm text-muted-foreground", message.hint && "font-medium text-foreground")}>
        {message.status}
      </p>
      {message.hint && (
        <p className="max-w-[30ch] text-sm text-muted-foreground">{message.hint}</p>
      )}
      {message.showReload && (
        <Button variant="outline" size="sm" onClick={reloadPage}>
          再読み込み
        </Button>
      )}
    </div>
  );
}

/**
 * スケルトンの上に重ねる「読み込み中」の帯（#1978）。
 *
 * スケルトン（#226）は枠だけとはいえ画面の形が出ているため、**もう表示し終えた**ようにも
 * 見える。まだ待っている最中だと分かるように、動いている印と一言を重ねる。全画面の
 * ローディングと同じしきい値・同じ言い回しを使う（`loadingScreenMessage`）。
 */
export function LoadingStatusPill() {
  const message = useLoadingScreenMessage();

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute inset-x-0 top-14 z-10 flex justify-center md:top-12"
    >
      <div className="pointer-events-auto flex items-center gap-2 rounded-full border bg-background px-3 py-1.5 text-xs shadow-lg">
        <Loader2 className="size-3.5 animate-spin text-muted-foreground motion-reduce:animate-none" />
        <span className={cn(message.showReload && "font-medium")}>{message.status}</span>
        {message.showReload && (
          <>
            <span aria-hidden className="text-border">
              /
            </span>
            <button
              type="button"
              onClick={reloadPage}
              className="rounded-sm underline underline-offset-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              再読み込み
            </button>
          </>
        )}
      </div>
    </div>
  );
}
