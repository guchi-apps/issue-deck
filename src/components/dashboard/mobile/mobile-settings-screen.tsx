"use client";

import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";

import { UserAvatar } from "@/components/dashboard/user-avatar";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import type { CurrentUser } from "@/types/user";

type MobileSettingsScreenProps = {
  currentUser: CurrentUser | null;
};

export function MobileSettingsScreen({ currentUser }: MobileSettingsScreenProps) {
  const router = useRouter();

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="border-b p-4">
        <h1 className="text-base font-semibold">設定</h1>
      </header>

      <div className="flex flex-col gap-4 p-4">
        <div className="flex items-center gap-3 rounded-lg border p-3">
          <UserAvatar
            login={currentUser?.login ?? "?"}
            image={currentUser?.image}
            className="size-10"
          />
          <div>
            <p className="text-sm font-medium">{currentUser?.name ?? currentUser?.login}</p>
            <p className="text-xs text-muted-foreground">@{currentUser?.login}</p>
          </div>
        </div>

        <Button variant="outline" className="justify-start" onClick={handleLogout}>
          <LogOut />
          ログアウト
        </Button>
      </div>
    </div>
  );
}
