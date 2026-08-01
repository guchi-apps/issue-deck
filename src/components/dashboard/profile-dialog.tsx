"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";

import { DeleteAccountDialog } from "@/components/dashboard/delete-account-dialog";
import { UserAvatar } from "@/components/dashboard/user-avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { useAccountActions } from "@/hooks/use-account-actions";
import { useGithubRateLimit } from "@/hooks/use-github-rate-limit";
import type { CurrentUser } from "@/types/user";

type ProfileDialogProps = {
  currentUser: CurrentUser | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function ProfileDialog({ currentUser, open, onOpenChange }: ProfileDialogProps) {
  const { handleDeleteAccount } = useAccountActions();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const { data: rateLimits, isLoading: rateLimitsLoading, error: rateLimitsError } = useGithubRateLimit(open);

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

          <div>
            <p className="mb-2 text-xs font-semibold text-muted-foreground">
              GitHub API使用量
            </p>
            {rateLimitsLoading && (
              <p className="text-xs text-muted-foreground">読み込み中...</p>
            )}
            {rateLimitsError && <p className="text-xs text-destructive">{rateLimitsError}</p>}
            {rateLimits && rateLimits.length === 0 && (
              <p className="text-xs text-muted-foreground">連携中のインストールがありません</p>
            )}
            {rateLimits && rateLimits.length > 0 && (
              <ul className="flex flex-col gap-2">
                {rateLimits.map((rateLimit) => (
                  <li key={rateLimit.accountLogin} className="rounded-lg border p-3">
                    <div className="mb-1.5 flex items-center justify-between text-xs">
                      <span className="font-medium">{rateLimit.accountLogin}</span>
                      <span className="text-muted-foreground">
                        残り {rateLimit.remaining} / {rateLimit.limit}
                      </span>
                    </div>
                    <Progress value={(rateLimit.remaining / rateLimit.limit) * 100} />
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      リセット:{" "}
                      {new Date(rateLimit.reset * 1000).toLocaleTimeString("ja-JP")}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <Button
            variant="destructive"
            className="justify-start"
            onClick={() => setDeleteDialogOpen(true)}
          >
            <Trash2 />
            アカウントを削除
          </Button>
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
