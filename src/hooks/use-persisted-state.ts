"use client";

import { useEffect, useState } from "react";

// SSR/クライアントでの初期描画を一致させるため、初期状態は常にdefaultValueとし、
// マウント後のuseEffectでlocalStorageの値を反映する（読み込み前に書き込んでしまうと
// 保存済みの値を初期値で上書きしてしまうため、読み込み完了後のみ書き込みを行う）。
export function usePersistedState<T>(key: string, defaultValue: T) {
  const [value, setValue] = useState<T>(defaultValue);
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem(key);
    if (stored !== null) {
      try {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setValue(JSON.parse(stored) as T);
      } catch (error) {
        console.error(`[use-persisted-state] failed to parse stored value for "${key}"`, error);
      }
    }
    setIsHydrated(true);
  }, [key]);

  useEffect(() => {
    if (!isHydrated) return;
    window.localStorage.setItem(key, JSON.stringify(value));
  }, [key, value, isHydrated]);

  return [value, setValue] as const;
}
