"use client";

import { useState } from "react";
import { LogOut, Trash2 } from "lucide-react";

import packageJson from "../../../../package.json";
import { DeleteAccountDialog } from "@/components/dashboard/delete-account-dialog";
import { UserAvatar } from "@/components/dashboard/user-avatar";
import { Button } from "@/components/ui/button";
import { useAccountActions } from "@/hooks/use-account-actions";
import type { CurrentUser } from "@/types/user";

/**
 * 設定の「アカウント」区分（#1539）。以前は独立した`ProfileDialog`だったが、
 * 設定ダイアログの中からさらにダイアログを開く入れ子をやめてここへ展開した。
 */
export function AccountSection({ currentUser }: { currentUser: CurrentUser | null }) {
  const { handleLogout, handleDeleteAccount } = useAccountActions();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

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

      <div className="flex flex-col gap-1.5 border-t pt-4">
        <Button
          variant="destructive"
          className="justify-start"
          onClick={() => setDeleteDialogOpen(true)}
        >
          <Trash2 />
          アカウントを削除
        </Button>
        <p className="text-xs text-muted-foreground">
          このアプリに保存したアカウント情報を削除してログアウトします。GitHub側のIssueや
          リポジトリには影響しません。
        </p>
      </div>

      <p className="text-center text-xs text-muted-foreground">
        Issue Deck v{packageJson.version}
      </p>

      <DeleteAccountDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={handleDeleteAccount}
      />
    </div>
  );
}
