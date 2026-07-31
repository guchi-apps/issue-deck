"use client";

import { useRouter } from "next/navigation";

import { createClient } from "@/lib/supabase/client";

export function useAccountActions() {
  const router = useRouter();

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  async function handleDeleteAccount() {
    await fetch("/api/account", { method: "DELETE" });
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return { handleLogout, handleDeleteAccount };
}
