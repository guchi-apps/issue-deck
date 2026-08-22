"use client";

import { useEffect, useRef } from "react";

import { recordHistoryPush } from "@/lib/history-stack";

/**
 * 開いている間だけ履歴エントリを1つ積み、戻る操作でそのエントリが外れたら`onDismiss`を
 * 呼ぶ（#2065）。全画面の重ね表示（画像プレビュー）を、スマホの戻る操作・スワイプで
 * 閉じられるようにするためのもの。
 *
 * 積まないと、重ね表示中の戻る操作が**下の画面**へ効いてしまう。スマホでは全画面に出て
 * いるものを戻る操作で閉じるのが標準の振る舞いなので、Issue詳細ごと前の画面へ移動して
 * しまうと「閉じたつもりが現在地まで変わる」ことになる。
 *
 * 積んだエントリは自分で片付ける。閉じた（`open`がfalseになった）時点で`history.back()`を
 * 呼び、積む前の状態に戻す——バツボタンで閉じたあとに戻る操作が空振りしないようにするため。
 *
 * 深さの数え方は`history-stack.ts`に合わせる（積むときに`recordHistoryPush`、戻ったときの
 * `recordHistoryPop`は`use-history-navigation.ts`が張るタブ共通のpopstateリスナが呼ぶ）。
 *
 * 開いたままアンマウントされた場合はエントリを残す。片付けようとして`history.back()`を
 * 呼ぶと、画面遷移で消えた場合に遷移そのものを巻き戻してしまうため。残っても起きるのは
 * 戻る操作が1回余分に要ることだけで、`history-stack.ts`のとおりズレは安全側に倒れる。
 */
export function useHistoryDismiss(open: boolean, onDismiss: () => void): void {
  const pushedRef = useRef(false);
  const onDismissRef = useRef(onDismiss);

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (!open) {
      // 閉じたので、開いたときに積んだエントリを取り除く。
      if (pushedRef.current) {
        pushedRef.current = false;
        window.history.back();
      }
      return;
    }

    // Strict Modeの再マウントで二重に積まないよう、積んだかどうかはrefで見る。
    if (!pushedRef.current) {
      pushedRef.current = true;
      recordHistoryPush();
      window.history.pushState(null, "", window.location.href);
    }

    const handlePopState = () => {
      // 自分が積んだエントリが外れた（＝戻る操作）。片付けは不要なのでフラグだけ落とす。
      pushedRef.current = false;
      onDismissRef.current();
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [open]);
}
