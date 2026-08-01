"use client";

import { useEffect } from "react";

/**
 * ブラウザのbfcache（back/forward cache）から/loginが復元されると、
 * ネットワークリクエストが発生せずmiddlewareを経由しないため、
 * ログイン済みでもログイン画面がそのまま表示されてしまう。
 * pageshowでbfcache復元を検知し、強制的にリロードしてmiddlewareの
 * リダイレクト判定を再度通す。
 */
export function LoginBfcacheReload() {
  useEffect(() => {
    function handlePageShow(event: PageTransitionEvent) {
      if (event.persisted) {
        window.location.reload();
      }
    }

    window.addEventListener("pageshow", handlePageShow);
    return () => window.removeEventListener("pageshow", handlePageShow);
  }, []);

  return null;
}
