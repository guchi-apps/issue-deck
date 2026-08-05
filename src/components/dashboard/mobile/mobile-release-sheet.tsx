"use client";

import { useMemo, useState } from "react";

import { Rocket } from "lucide-react";

import { ReleaseDeployChecklist } from "@/components/dashboard/release-deploy-checklist";
import { isProductionDeployComplete, ReleaseProgress } from "@/components/dashboard/release-progress";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useReleaseStatus } from "@/hooks/use-release-status";
import {
  formatDevelopVersionDisplay,
  formatMainVersionDisplay,
} from "@/lib/github/release-version-display";
import { DEVELOP_MERGED_LABEL_NAME } from "@/lib/github/workflow-status";
import { filterIssuesByView } from "@/lib/issue-stats";
import type { DeployCheckStatus, Issue } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";

type MobileReleaseSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repository: ConnectedRepository;
  issues: Issue[];
  onSetIssueDeployCheck: (issue: Issue, status: DeployCheckStatus | null) => void;
};

export function MobileReleaseSheet({
  open,
  onOpenChange,
  repository,
  issues,
  onSetIssueDeployCheck,
}: MobileReleaseSheetProps) {
  const {
    data: releaseStatus,
    isLoading: releaseStatusLoading,
    error: releaseStatusError,
    triggerRelease,
    isTriggering: isTriggeringRelease,
  } = useReleaseStatus(repository.fullName, open);
  const [releaseConfirmOpen, setReleaseConfirmOpen] = useState(false);
  const [releaseSuccessOpen, setReleaseSuccessOpen] = useState(false);

  // 誤タップでの起動を防ぐため確認ダイアログを挟む。今回developにマージ済みでmain未反映のIssueを
  // 「今回反映する内容」として一覧表示する（#426）。
  const pendingReleaseIssues = useMemo(
    () =>
      issues.filter(
        (issue) =>
          issue.repositoryFullName === repository.fullName &&
          issue.labels.some((label) => label.name === DEVELOP_MERGED_LABEL_NAME),
      ),
    [issues, repository.fullName],
  );

  // 本番デプロイ成功後（release-progress.tsxの「本番デプロイ」段と同じ条件）にのみ、
  // 直近リリースでmainへ反映されたIssueの確認チェックリストを表示する（#534）。
  const deployCheckIssues = useMemo(() => {
    if (!releaseStatus?.available || !isProductionDeployComplete(releaseStatus)) return [];
    const repoIssues = issues.filter((issue) => issue.repositoryFullName === repository.fullName);
    return filterIssuesByView(repoIssues, "recently-merged", null);
  }, [issues, repository.fullName, releaseStatus]);

  async function handleTriggerRelease() {
    const ok = await triggerRelease();
    if (ok) {
      setReleaseSuccessOpen(true);
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
                <span>
                  {formatMainVersionDisplay(
                    releaseStatus.mainVersion,
                    releaseStatus.developVersion,
                    releaseStatus.phase,
                  )}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">develop</span>
                <span>
                  {formatDevelopVersionDisplay(
                    releaseStatus.developVersion,
                    releaseStatus.bumpPullRequest?.version ?? null,
                    releaseStatus.phase,
                  )}
                </span>
              </div>
              <ReleaseProgress status={releaseStatus} />
              <ReleaseDeployChecklist
                issues={deployCheckIssues}
                onSetDeployCheck={onSetIssueDeployCheck}
              />
              <Button
                variant="outline"
                disabled={isTriggeringRelease}
                onClick={() => setReleaseConfirmOpen(true)}
                className="mt-1"
              >
                <Rocket className={isTriggeringRelease ? "animate-pulse" : undefined} />
                {isTriggeringRelease ? "起動中..." : "リリースworkflowを起動"}
              </Button>
            </div>
          )}
        </div>
      </SheetContent>

      <AlertDialog open={releaseConfirmOpen} onOpenChange={setReleaseConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>リリースworkflowを起動しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              {repository.fullName}のdevelopをmainへ反映するリリースworkflowを起動します。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingReleaseIssues.length > 0 ? (
            <div className="flex max-h-48 flex-col gap-1.5 overflow-y-auto rounded-md border p-2">
              <p className="text-xs font-medium text-muted-foreground">今回反映する内容</p>
              <ul className="flex flex-col gap-1 text-xs">
                {pendingReleaseIssues.map((issue) => (
                  <li key={issue.id}>
                    <a
                      href={issue.htmlUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline"
                    >
                      #{issue.number} {issue.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              develop済みでmain未反映のIssueはありません。
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction onClick={handleTriggerRelease}>起動する</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={releaseSuccessOpen} onOpenChange={setReleaseSuccessOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>リリースを起動しました</AlertDialogTitle>
            <AlertDialogDescription>
              進捗はこの画面に表示されます（マージが必要な段階ではマージ用リンクが出ます）。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction className={buttonVariants({ variant: "default" })}>
              OK
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  );
}
