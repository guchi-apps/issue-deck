"use client";

import { useSyncExternalStore } from "react";

/**
 * CSSのメディアクエリが今一致しているか。サーバー描画では`false`（#3744）。
 * ポータルで`md:hidden`などの外へ描画されるものを、幅で出し分けるために使う。
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
