"use client";

import { useEffect, useState } from "react";

/**
 * カウントダウン表示の更新用に現在時刻(epoch ms)を返す。
 * サーバーレンダリング時とマウント直前はnullを返すため、呼び出し側で分岐すること。
 */
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    // 表示中だけ現在時刻を更新する。描画中にDate.now()を呼ばないための状態化であり、
    // ループや連鎖的な再レンダリングは発生しない。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return now;
}
