"use client";

import { useRouter } from "next/navigation";

import { createClient } from "@/lib/supabase/client";

export function useAccountActions() {
  const router = useRouter();

  async function handleLogout() {
    // iOS共有画面用トークンを失効させる（#4298）。ログアウト後の端末に有効なトークンを残さない。
    // 失敗してもログアウトは止めない（トークンは30日で切れ、アプリ側もログアウトを検知して消す）
    await fetch("/api/share/token", { method: "DELETE", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => undefined);
    const supabase = createClient();
    // Supabaseプロジェクトは他アプリと共有している。既定のglobalでは同じユーザーの
    // 全refresh tokenが失効するため、IssueDeckで使っているセッションだけを破棄する。
    await supabase.auth.signOut({ scope: "local" });
    router.push("/login");
    router.refresh();
  }

  async function handleDeleteAccount() {
    const res = await fetch("/api/account", { method: "DELETE" });
    // 削除に失敗したときはログイン状態を保ち、そのまま再試行できるようにする。
    if (!res.ok) return false;
    // アカウントごと消えるためトークンもCASCADEで消える。ここでの失効呼び出しは不要
    const supabase = createClient();
    // 共有Supabaseの他アプリのセッションを巻き込まないよう、IssueDeckのセッションだけ破棄する。
    await supabase.auth.signOut({ scope: "local" });
    router.push("/login");
    router.refresh();
    return true;
  }

  return { handleLogout, handleDeleteAccount };
}
