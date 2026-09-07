"use client";

import { useCallback } from "react";

import { usePersistedState } from "@/hooks/use-persisted-state";
import {
  POST_CREATE_DESTINATION_DEFAULT,
  POST_CREATE_DESTINATION_STORAGE_KEY,
  normalizePostCreateDestinationSetting,
  type PostCreateDestinationSetting,
} from "@/lib/post-create-destination";

/**
 * Issueを作った直後に開く画面の設定（#2862）を、端末ごとにlocalStorageへ保存する。
 *
 * 保存する場所の選び方は`use-issue-order-guide.ts`の自動開始と同じ（**端末ごとの都合で
 * 決まる設定はアプリ全体の`AppSetting`へ入れない**）。読み出した値は毎回正規化する——
 * 保存先は端末のブラウザで、古い版が書いた値や手で書き換えられた値が入りうる。
 */
export function usePostCreateDestination() {
  const [stored, setStored] = usePersistedState<PostCreateDestinationSetting>(
    POST_CREATE_DESTINATION_STORAGE_KEY,
    POST_CREATE_DESTINATION_DEFAULT,
  );

  const setting = normalizePostCreateDestinationSetting(stored);

  const setSetting = useCallback(
    (next: PostCreateDestinationSetting) => {
      setStored(normalizePostCreateDestinationSetting(next));
    },
    [setStored],
  );

  return { setting, setSetting } as const;
}
