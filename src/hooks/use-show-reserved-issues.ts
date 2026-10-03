"use client";

import { usePersistedState } from "@/hooks/use-persisted-state";

const STORAGE_KEY = "issue-deck:show-reserved-in-not-started";

/**
 * 未着手ビューに、予約実行へ積まれたIssueも表示するか（#3822）。標準はfalse（伏せる）。
 * 端末ごとにlocalStorageへ保存する（`useGroupByRepo`と同じ持ち方）。
 */
export function useShowReservedIssues() {
  return usePersistedState<boolean>(STORAGE_KEY, false);
}
