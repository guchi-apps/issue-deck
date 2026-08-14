"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect } from "react";

import { canGoBackInApp, recordHistoryPop, recordHistoryPush } from "@/lib/history-stack";

/**
 * URLクエリの更新で履歴を積むか（`push`）積まないか（`replace`）。
 *
 * 積むのは現在地が変わる操作だけにする（#1396）。絞り込み条件まで積むと、戻る操作を何度
 * 押しても条件が1つずつ巻き戻るだけで画面が変わらない。特にキーワード検索は1文字ごとに
 * エントリが増えるため、戻る操作が実質使えなくなる。
 */
export type HistoryMode = "push" | "replace";

// popstateの購読はタブに1つだけにする。URL更新を行うフック（use-issue-filters・
// use-mobile-screen・use-reference-navigation）が同じ画面に同居しており、フックごとに
// 購読すると1回の戻る操作で深さを複数回減らしてしまう。
let popStateListenerAttached = false;

function ensurePopStateListener() {
  if (popStateListenerAttached || typeof window === "undefined") return;
  popStateListenerAttached = true;
  window.addEventListener("popstate", recordHistoryPop);
}

/**
 * 画面の現在地を持つURLクエリを更新するための共通の入口（#1396）。
 *
 * このアプリの現在地（スマホの画面・PCのペイン・選択中のIssue/PR・絞り込み条件）はすべて
 * URLクエリが正なので、履歴を積むかどうかもここに集約する。
 */
export function useHistoryNavigation() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(ensurePopStateListener, []);

  /**
   * 現在のクエリを起点に`mutate`で書き換えて遷移する。
   *
   * 結果が現在のURLと同じなら何もしない。同じURLを積むと、戻る操作を2回押さないと画面が
   * 変わらなくなるため。`wrap`には`startTransition`のような遷移のラッパーを渡せる。
   */
  const navigateParams = useCallback(
    (
      mutate: (params: URLSearchParams) => void,
      options: { history: HistoryMode; wrap?: (run: () => void) => void },
    ) => {
      const params = new URLSearchParams(searchParams.toString());
      const before = params.toString();
      mutate(params);
      const after = params.toString();
      if (after === before) return;

      const url = after ? `${pathname}?${after}` : pathname;
      const run =
        options.history === "push"
          ? () => {
              recordHistoryPush();
              router.push(url, { scroll: false });
            }
          : () => router.replace(url, { scroll: false });

      if (options.wrap) options.wrap(run);
      else run();
    },
    [router, pathname, searchParams],
  );

  /**
   * アプリ内の「戻る」操作。自分が積んだ履歴があれば巻き戻し、無ければ`fallback`で
   * 戻り先へ遷移する。共有URLで深い画面をいきなり開いた場合にも`router.back()`を呼ぶと
   * アプリの外へ出てしまうため、その判別を挟む。
   */
  const goBackOrFallback = useCallback(
    (fallback: () => void) => {
      if (canGoBackInApp()) {
        router.back();
        return;
      }
      fallback();
    },
    [router],
  );

  return { navigateParams, goBackOrFallback };
}
