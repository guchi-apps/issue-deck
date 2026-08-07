"use client";

import { GithubStatusList } from "@/components/dashboard/github-status-list";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { GithubStatusSummary } from "@/lib/github/status";

type GithubStatusDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: GithubStatusSummary | null;
  isLoading: boolean;
  error: string | null;
};

export function GithubStatusDialog({
  open,
  onOpenChange,
  data,
  isLoading,
  error,
}: GithubStatusDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>GitHub障害状況</DialogTitle>
        </DialogHeader>
        <GithubStatusList data={data} isLoading={isLoading} error={error} />
      </DialogContent>
    </Dialog>
  );
}
