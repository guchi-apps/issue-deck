"use client";

import { useEffect, useState } from "react";

/**
 * 返事待ちの残り時間（ms）。**1秒ごとに描き直す。**
 *
 * 状態のポーリングは5秒間隔で、そこに合わせると数字が飛んで「動いていない」ように見える。
 * 期限そのものはサーバーが持っている（`expiresAt`）ので、ここは表示だけを進める。
 *
 * 計画の承認パネル（#2061）と質問の回答パネル（#2189）が同じものを出すため、
 * **カウントダウンの実装はここ1か所に置く**（片方だけ直して表示が食い違うのを防ぐ）。
 */
export function useRemainingMs(expiresAt: string): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timerId = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timerId);
  }, []);
  return Math.max(0, new Date(expiresAt).getTime() - now);
}

/** `12:34`。分は繰り上げず、そのまま何分何秒かを出す */
export function formatRemaining(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
