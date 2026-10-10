"use client";

import { usePersistedState } from "@/hooks/use-persisted-state";

const STORAGE_KEY = "issue-deck:check-user-toast-enabled";

/**
 * 画面下部に「確認待ちになりました」のトーストを出すか（#4262）。標準はfalse（出さない）。
 * 端末ごとにlocalStorageへ保存する（`useShowReservedIssues`と同じ持ち方）。
 */
export function useCheckUserToastEnabled() {
  return usePersistedState<boolean>(STORAGE_KEY, false);
}
