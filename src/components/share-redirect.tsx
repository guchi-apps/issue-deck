"use client";

import { useEffect } from "react";

/** 人が`/share/...`を直接開いたとき、従来の`/dashboard?...`（ログイン・権限チェックあり）へ移す */
export function ShareRedirect({ to }: { to: string }) {
  useEffect(() => {
    window.location.replace(to);
  }, [to]);
  return null;
}
