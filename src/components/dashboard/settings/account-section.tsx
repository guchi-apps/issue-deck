"use client";

import { LogOut } from "lucide-react";

import { UserAvatar } from "@/components/dashboard/user-avatar";
import { Button } from "@/components/ui/button";
import { useAccountActions } from "@/hooks/use-account-actions";
import type { CurrentUser } from "@/types/user";

/**
 * 設定の「アカウント」区分（#1539）。以前は独立した`ProfileDialog`だったが、
 * 設定ダイアログの中からさらにダイアログを開く入れ子をやめてここへ展開した。
 * 区分の一覧には並べず、アカウント名の行を押して開く（#3744）。
 *
 * バージョン表示はここの末尾にあったが、この区分を開かないと見えなかったため、
 * 区分の外（`AppVersionButton`）へ移した（#1764）。
 */
export function AccountSection({ currentUser }: { currentUser: CurrentUser | null }) {
  const { handleLogout } = useAccountActions();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 rounded-lg border p-3">
        <UserAvatar
          login={currentUser?.login ?? "?"}
          image={currentUser?.image}
          className="size-10"
        />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {currentUser?.name ?? currentUser?.login}
          </p>
          <p className="truncate text-xs text-muted-foreground">@{currentUser?.login}</p>
        </div>
      </div>

      <Button variant="outline" className="justify-start" onClick={handleLogout}>
        <LogOut />
        ログアウト
      </Button>
    </div>
  );
}
