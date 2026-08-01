"use client";

import { useState } from "react";
import { LogOut, ShieldCheck } from "lucide-react";

import { ProfileDialog } from "@/components/dashboard/profile-dialog";
import { UserAvatar } from "@/components/dashboard/user-avatar";
import { Button } from "@/components/ui/button";
import { useAccountActions } from "@/hooks/use-account-actions";
import { PRIVACY_POLICY_URL, TERMS_OF_SERVICE_URL } from "@/lib/legal-links";
import type { CurrentUser } from "@/types/user";

type MobileSettingsScreenProps = {
  currentUser: CurrentUser | null;
};

export function MobileSettingsScreen({ currentUser }: MobileSettingsScreenProps) {
  const { handleLogout } = useAccountActions();
  const [profileDialogOpen, setProfileDialogOpen] = useState(false);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="border-b p-4">
        <h1 className="text-base font-semibold">設定</h1>
      </header>

      <div className="flex flex-col gap-4 p-4">
        <button
          type="button"
          onClick={() => setProfileDialogOpen(true)}
          className="flex items-center gap-3 rounded-lg border p-3 text-left hover:bg-accent"
        >
          <UserAvatar
            login={currentUser?.login ?? "?"}
            image={currentUser?.image}
            className="size-10"
          />
          <div>
            <p className="text-sm font-medium">{currentUser?.name ?? currentUser?.login}</p>
            <p className="text-xs text-muted-foreground">@{currentUser?.login}</p>
          </div>
        </button>

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

        <Button variant="destructive" className="justify-start" onClick={handleLogout}>
          <LogOut />
          ログアウト
        </Button>
      </div>

      <ProfileDialog
        currentUser={currentUser}
        open={profileDialogOpen}
        onOpenChange={setProfileDialogOpen}
      />
    </div>
  );
}
