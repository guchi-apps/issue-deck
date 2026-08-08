"use client";

import { useCallback } from "react";

import { usePersistedState } from "@/hooks/use-persisted-state";
import { getNavViewDefaultGroupByRepo } from "@/lib/nav-views";
import type { NavViewId } from "@/types/issue";

const STORAGE_KEY = "issue-deck:group-by-repo";

type GroupByRepoState = Partial<Record<NavViewId, boolean>>;

/**
 * リポジトリごとのグルーピング表示（#849）のON/OFFを、ビューごとにlocalStorageへ
 * 永続化するフック。ビューを切り替えても選択済みの状態を保てるよう、1つの
 * localStorageキーにビューID→booleanのマップとしてまとめて保存する
 * （usePersistedStateは固定キー1つを想定しており、ビュー切り替え時の初期値解決には
 * 個別のキーではなくこのマップが必要）。ユーザーが明示的に切り替えていないビューは
 * ビューごとの既定値（getNavViewDefaultGroupByRepo）にフォールバックする。
 */
export function useGroupByRepo(view: NavViewId) {
  const [state, setState] = usePersistedState<GroupByRepoState>(STORAGE_KEY, {});

  const groupByRepo = state[view] ?? getNavViewDefaultGroupByRepo(view);

  const setGroupByRepo = useCallback(
    (value: boolean) => {
      setState((prev) => ({ ...prev, [view]: value }));
    },
    [view, setState],
  );

  return [groupByRepo, setGroupByRepo] as const;
}
