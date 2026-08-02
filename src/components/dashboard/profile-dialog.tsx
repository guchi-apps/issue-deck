"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";

import packageJson from "../../../package.json";
import { DeleteAccountDialog } from "@/components/dashboard/delete-account-dialog";
import { UserAvatar } from "@/components/dashboard/user-avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAccountActions } from "@/hooks/use-account-actions";
import type { CurrentUser } from "@/types/user";

type ProfileDialogProps = {
  currentUser: CurrentUser | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function ProfileDialog({ currentUser, open, onOpenChange }: ProfileDialogProps) {
  const { handleDeleteAccount } = useAccountActions();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>プロフィール</DialogTitle>
          </DialogHeader>

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

          <Button
            variant="destructive"
            className="justify-start"
            onClick={() => setDeleteDialogOpen(true)}
          >
            <Trash2 />
            アカウントを削除
          </Button>

          <p className="text-center text-xs text-muted-foreground">
            Issue Deck v{packageJson.version}
          </p>
        </DialogContent>
      </Dialog>

      <DeleteAccountDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={handleDeleteAccount}
      />
    </>
  );
}
