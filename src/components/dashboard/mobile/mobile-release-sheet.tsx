"use client";

import { Rocket } from "lucide-react";

import { ReleaseProgress } from "@/components/dashboard/release-progress";
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
      alert("リリースを起動しました。進捗はこの画面に表示されます（マージが必要な段階ではマージ用リンクが出ます）。");
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
              <ReleaseProgress status={releaseStatus} />
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
