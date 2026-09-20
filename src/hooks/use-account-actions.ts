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
    await fetch("/api/account", { method: "DELETE" });
    const supabase = createClient();
    // アカウント削除では残っているセッションを利用可能なままにしない。
    await supabase.auth.signOut({ scope: "global" });
    router.push("/login");
    router.refresh();
  }

  return { handleLogout, handleDeleteAccount };
}
