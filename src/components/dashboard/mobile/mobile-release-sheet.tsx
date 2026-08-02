"use client";

import { Rocket } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useReleaseStatus } from "@/hooks/use-release-status";
import type { ConnectedRepository } from "@/types/repository";

type MobileReleaseSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repository: ConnectedRepository;
};

export function MobileReleaseSheet({ open, onOpenChange, repository }: MobileReleaseSheetProps) {
  const {
    data: releaseStatus,
    isLoading: releaseStatusLoading,
    error: releaseStatusError,
    triggerRelease,
    isTriggering: isTriggeringRelease,
  } = useReleaseStatus(repository.fullName, open);

  async function handleTriggerRelease() {
    const ok = await triggerRelease();
    if (ok) {
      alert("リリースworkflowを起動しました。Pull Requestの作成状況はGitHub上で確認してください。");
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>リリース（{repository.fullName}）</SheetTitle>
        </SheetHeader>

        <div className="flex flex-col gap-4 p-4 pt-0">
          {releaseStatusLoading && <p className="text-sm text-muted-foreground">読み込み中...</p>}
          {releaseStatusError && <p className="text-sm text-destructive">{releaseStatusError}</p>}
          {releaseStatus && !releaseStatus.available && (
            <p className="text-sm text-muted-foreground">
              このリポジトリにはリリース用のworkflowが見つかりませんでした
            </p>
          )}
          {releaseStatus?.available && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">main</span>
                <span>{releaseStatus.mainVersion ? `v${releaseStatus.mainVersion}` : "-"}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">develop</span>
                <span>{releaseStatus.developVersion ? `v${releaseStatus.developVersion}` : "-"}</span>
              </div>
              {releaseStatus.bumpPullRequest && (
                <a
                  href={releaseStatus.bumpPullRequest.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate text-sm text-primary hover:underline"
                >
                  バンプPR #{releaseStatus.bumpPullRequest.number}: {releaseStatus.bumpPullRequest.title}
                </a>
              )}
              {releaseStatus.releasePullRequest && (
                <a
                  href={releaseStatus.releasePullRequest.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate text-sm text-primary hover:underline"
                >
                  develop→main PR #{releaseStatus.releasePullRequest.number}:{" "}
                  {releaseStatus.releasePullRequest.title}
                </a>
              )}
              <Button
                variant="outline"
                disabled={isTriggeringRelease}
                onClick={handleTriggerRelease}
                className="mt-1"
              >
                <Rocket className={isTriggeringRelease ? "animate-pulse" : undefined} />
                {isTriggeringRelease ? "起動中..." : "リリースworkflowを起動"}
              </Button>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
