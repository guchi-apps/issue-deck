"use client";

import { RotateCw } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

/**
 * スマホのホーム画面ヘッダーに置く「画面を更新」（#1681）。
 *
 * **ホーム画面から起動したPWA（`app/manifest.ts`の`display: "standalone"`）にはブラウザの
 * ツールバーが無く、ユーザーがページをリロードする手段が残っていない。** 表示が古いまま
 * 固まったときや新しいビルドへ追従したいときに、アプリを一度終了させるしかなかった。
 * `app-update-checker.tsx`は新しいバージョンを検知したときだけ動くもので、任意のタイミングで
 * 押せるものではない。
 *
 * **置くのはホームのヘッダーだけにしてある。** ブランチ（`branch-flow-view.tsx`）のヘッダーには
 * **その画面のデータを取り直す**別物の「更新」があり、同じ円形矢印のアイコンを並べると押す側
 * からは役割の違いが分からない。Issue一覧とPR一覧（#1947）は下へ引っ張って更新する側へ寄せて
 * あり、こちらもページ全体のリロードと混ざるため置かない。ホーム以外の画面からは
 * 「ホームタブ →更新」の2タップで届く。
 *
 * **ホームには引っ張って更新も入ったが（#2182）、このボタンは残す。** 引っ張る方が取り直すのは
 * 画面に出ている数字（Issue・PR・リリース状況・実行状況）だけで、読み込み済みのJavaScriptは
 * そのまま。新しいビルドへ追従する手段は依然としてこのボタンしか無く、どちらか一方では
 * 「表示が古い」と「アプリが古い」の片方しか直せない。
 *
 * **PWAかどうかでは出し分けない。** `display-mode: standalone`・`navigator.standalone`の判定は
 * 実機差があり、外すと「PWAなのにボタンが出ない」＝要求そのものが満たされない状態になる。
 * ブラウザで見ているときも、スクロールで隠れたツールバーを出し直す手間が省ける。ホーム画面
 * 自体がモバイルレイアウト（`issue-deck-shell.tsx`の`md:hidden`）の中にしか描かれないため、
 * PCには出ない。
 */
export function MobileReloadButton({
  /**
   * リロードの実行。既定はページ全体の再読み込み（ブラウザの再読み込みと同じ）。
   * jsdomでは`window.location`を差し替えられないため、テストから確かめられるように
   * 呼び出し口だけを外に出している。
   */
  onReload = () => window.location.reload(),
}: {
  onReload?: () => void;
} = {}) {
  const [isReloading, setIsReloading] = useState(false);

  return (
    <button
      type="button"
      // リロードが始まるまでの間、押した手応えが無いままにならないよう回しておく。
      // 併せて二重押しも弾く
      disabled={isReloading}
      onClick={() => {
        setIsReloading(true);
        onReload();
      }}
      title="画面を更新"
      aria-label="画面を更新"
      className="flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <RotateCw className={cn("size-5", isReloading && "animate-spin")} />
    </button>
  );
}
