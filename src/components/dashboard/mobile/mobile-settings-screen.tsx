"use client";

import { useState } from "react";
import { LogOut, Mail, ShieldCheck, Trash2 } from "lucide-react";

import { DeleteAccountDialog } from "@/components/dashboard/delete-account-dialog";
import { UserAvatar } from "@/components/dashboard/user-avatar";
import { Button } from "@/components/ui/button";
import { useAccountActions } from "@/hooks/use-account-actions";
import { CONTACT_EMAIL, PRIVACY_POLICY_URL, TERMS_OF_SERVICE_URL } from "@/lib/legal-links";
import type { CurrentUser } from "@/types/user";

type MobileSettingsScreenProps = {
  currentUser: CurrentUser | null;
};

export function MobileSettingsScreen({ currentUser }: MobileSettingsScreenProps) {
  const { handleLogout, handleDeleteAccount } = useAccountActions();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

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

        <Button variant="outline" className="justify-start" asChild>
          <a href={TERMS_OF_SERVICE_URL} target="_blank" rel="noopener noreferrer">
            <ShieldCheck />
            利用規約
          </a>
        </Button>

        <Button variant="outline" className="justify-start" asChild>
          <a href={PRIVACY_POLICY_URL} target="_blank" rel="noopener noreferrer">
            <ShieldCheck />
            プライバシーポリシー
          </a>
        </Button>

        <Button variant="outline" className="justify-start" asChild>
          <a href={`mailto:${CONTACT_EMAIL}`}>
            <Mail />
            お問い合わせ
          </a>
        </Button>

        <Button
          variant="destructive"
          className="justify-start"
          onClick={() => setDeleteDialogOpen(true)}
        >
          <Trash2 />
          アカウントを削除
        </Button>
      </div>

      <DeleteAccountDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={handleDeleteAccount}
      />
    </div>
  );
}
