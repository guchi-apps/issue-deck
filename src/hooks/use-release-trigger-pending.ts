"use client";

import { useCallback } from "react";

import { useNow } from "@/hooks/use-now";
import { usePersistedState } from "@/hooks/use-persisted-state";
import { isReleaseTriggerPending } from "@/lib/release-trigger-guard";

/**
 * 「リリースする」を押してからバンプPRが現れるまでの「起動中」を、リポジトリ1件ぶんで持つ（#1955）。
 *
 * **起動を押したボタンと、畳んだ1行の両方が同じ状態を見るために切り出した。** 起動時刻は端末の
 * localStorageに置いているが（理由は`lib/release-trigger-guard.ts`）、同じキーで
 * `usePersistedState`を2か所から呼んでも互いの書き込みは伝わらない——ボタン側で押しても、
 * 畳んだ行のピルは次に画面を開き直すまで出なかった。呼ぶのはリポジトリの節で1回だけにして、
 * 判定と記録をそこから配る。
 *
 * 経過で自動的に「起動中」を抜けるよう、時刻は`useNow`で定期的に取り直す
 * （描画中に`Date.now()`を呼ばないため）。
 */
export function useReleaseTriggerPending(repositoryFullName: string) {
  const [triggeredAt, setTriggeredAt] = usePersistedState<string | null>(
    `issue-deck:release-triggered-at:${repositoryFullName}`,
    null,
  );
  const now = useNow(30_000);

  const markTriggered = useCallback(() => {
    setTriggeredAt(new Date().toISOString());
  }, [setTriggeredAt]);

  return {
    /** 直近の起動から「まだ起動中」とみなす期間内か。サーバー描画・マウント直前はfalse */
    isPending: now !== null && isReleaseTriggerPending(triggeredAt, now),
    /** 起動できた時点で呼ぶ。以後この端末では「起動中」として扱う */
    markTriggered,
  };
}
