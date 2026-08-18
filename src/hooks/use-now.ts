"use client";

import { useEffect, useState } from "react";

/**
 * カウントダウン表示の更新用に現在時刻(epoch ms)を返す。
 * サーバーレンダリング時とマウント直前はnullを返すため、呼び出し側で分岐すること。
 *
 * `enabled`にfalseを渡すとタイマーを張らず、常にnullを返す（#1955）。**時刻が要るのが
 * ごく一部のときだけ、という呼び出し側のために持つ**——ブランチ画面のように同じ部品を
 * リポジトリの数だけ常時マウントする場所では、要らない時計まで全件で回り続けてしまう。
 */
export function useNow(intervalMs = 30_000, enabled = true) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      // 止めたときは値も落とす（古い時刻のまま残すと、再開まで過去の判定が生き続ける）
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setNow(null);
      return;
    }
    // 表示中だけ現在時刻を更新する。描画中にDate.now()を呼ばないための状態化であり、
    // ループや連鎖的な再レンダリングは発生しない。
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, enabled]);

  return now;
}
