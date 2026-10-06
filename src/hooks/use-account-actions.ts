"use client";

import { useRouter } from "next/navigation";

import { createClient } from "@/lib/supabase/client";

export function useAccountActions() {
  const router = useRouter();

  async function handleLogout() {
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
    const supabase = createClient();
    // 共有Supabaseの他アプリのセッションを巻き込まないよう、IssueDeckのセッションだけ破棄する。
    await supabase.auth.signOut({ scope: "local" });
    router.push("/login");
    router.refresh();
    return true;
  }

  return { handleLogout, handleDeleteAccount };
}
