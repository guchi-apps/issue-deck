"use client";

import { useCallback } from "react";

import { useNow } from "@/hooks/use-now";
import { usePersistedState } from "@/hooks/use-persisted-state";
import {
  DEPLOY_TRIGGER_PENDING_MS,
  RELEASE_TRIGGER_PENDING_MS,
  isTriggerPending,
} from "@/lib/trigger-pending-guard";

/**
 * 起動してから結果が画面に現れるまでの「起動中」を、リポジトリ1件ぶんで持つ
 * （#1955でリリース向けに切り出し、#2020で本番デプロイと共有した）。
 *
 * **起動を押したボタンと、畳んだ1行の両方が同じ状態を見るために切り出した。** 起動時刻は端末の
 * localStorageに置いているが（理由は`lib/trigger-pending-guard.ts`）、同じキーで
 * `usePersistedState`を2か所から呼んでも互いの書き込みは伝わらない——ボタン側で押しても、
 * 畳んだ行のピルは次に画面を開き直すまで出なかった。呼ぶのはリポジトリの節で1回だけにして、
 * 判定と記録をそこから配る。
 *
 * 経過で自動的に「起動中」を抜けるよう、時刻は`useNow`で定期的に取り直す
 * （描画中に`Date.now()`を呼ばないため）。**取り直すのは起動時刻が入っている間だけ**にする——
 * この画面は畳んでいるぶんも含めてリポジトリ全件でこのhookを持つため、既定のまま呼ぶと
 * 起動していない普段の状態でも全件でタイマーが回り続ける（#1955の計画レビュー指摘2）。
 */
const TRIGGER_KINDS = {
  release: { storagePrefix: "issue-deck:release-triggered-at:", pendingMs: RELEASE_TRIGGER_PENDING_MS },
  deploy: { storagePrefix: "issue-deck:deploy-triggered-at:", pendingMs: DEPLOY_TRIGGER_PENDING_MS },
} as const;

export type TriggerKind = keyof typeof TRIGGER_KINDS;

/**
 * localStorageに置いた起動時刻を、hookの外から読む（#2020）。
 *
 * **デプロイ状況のポーリング（`use-deploy-status.ts`）が、押した直後もしばらく取り直しを
 * 続けるために要る。** 起動しても実行が現れるまでは数秒あり、その間は「まだ本番へ出ていない」
 * 材料が応答側に何も無いためポーリングが止まってしまう。押した記録を持っているのはこのhookなので、
 * 読み方（キーの作り方とJSONの解き方）もここに置いて、キーの文字列を2か所へ散らさない。
 */
export function readTriggeredAt(kind: TriggerKind, repositoryFullName: string): string | null {
  if (typeof window === "undefined") return null;
  const stored = window.localStorage.getItem(
    `${TRIGGER_KINDS[kind].storagePrefix}${repositoryFullName}`,
  );
  if (stored === null) return null;
  try {
    const parsed: unknown = JSON.parse(stored);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function useTriggerPending(kind: TriggerKind, repositoryFullName: string) {
  const { storagePrefix, pendingMs } = TRIGGER_KINDS[kind];
  const [triggeredAt, setTriggeredAt] = usePersistedState<string | null>(
    `${storagePrefix}${repositoryFullName}`,
    null,
  );
  // **起動していない間はタイマーを張らない。** この画面はリポジトリの数だけこのhookを
  // 常時マウントするため、既定のまま呼ぶと普段から全件で30秒ごとの再描画が走る。
  const now = useNow(30_000, triggeredAt !== null);

  const markTriggered = useCallback(() => {
    setTriggeredAt(new Date().toISOString());
  }, [setTriggeredAt]);

  return {
    /** 直近の起動から「まだ起動中」とみなす期間内か。サーバー描画・マウント直前はfalse */
    isPending: now !== null && isTriggerPending(triggeredAt, now, pendingMs),
    /** 起動できた時点で呼ぶ。以後この端末では「起動中」として扱う */
    markTriggered,
  };
}
