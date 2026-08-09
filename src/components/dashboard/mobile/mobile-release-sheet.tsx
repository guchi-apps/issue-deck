"use client";

import { useMemo, useState } from "react";

import { Rocket } from "lucide-react";

import { ReleaseProgress } from "@/components/dashboard/release-progress";
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
import type { ReleaseStatus } from "@/hooks/use-release-status";
import {
  formatDevelopVersionDisplay,
  formatMainVersionDisplay,
} from "@/lib/github/release-version-display";
import { DEVELOP_MERGED_LABEL_NAME } from "@/lib/github/workflow-status";
import type { Issue } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";

type MobileReleaseSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repository: ConnectedRepository;
  issues: Issue[];
  releaseStatus: ReleaseStatus | null;
  releaseStatusLoading: boolean;
  releaseStatusError: string | null;
  triggerRelease: () => Promise<boolean>;
  isTriggeringRelease: boolean;
};

export function MobileReleaseSheet({
  open,
  onOpenChange,
  repository,
  issues,
  releaseStatus,
  releaseStatusLoading,
  releaseStatusError,
  triggerRelease,
  isTriggeringRelease,
}: MobileReleaseSheetProps) {
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

  // Issueを起票せず直接developへ作られたPRの見落としに気づけるよう、develop向けの
  // その他のオープンPR（バンプPR自身を除く）を、参照Issue番号から画面に読み込み済みのIssueと
  // 突き合わせて一覧表示する(#977)。突き合わせはこの画面側で行うため追加のAPI呼び出しは無い。
  const otherPullRequestsWithIssue = useMemo(() => {
    const otherPullRequests =
      releaseStatus?.available && releaseStatus.otherPullRequests ? releaseStatus.otherPullRequests : [];
    const repoIssues = issues.filter((issue) => issue.repositoryFullName === repository.fullName);
    return otherPullRequests.map((pr) => ({
      ...pr,
      linkedIssue: repoIssues.find((issue) => pr.issueNumbers.includes(issue.number)) ?? null,
    }));
  }, [releaseStatus, issues, repository.fullName]);

  async function handleTriggerRelease() {
    const ok = await triggerRelease();
    if (ok) {
      setReleaseSuccessOpen(true);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto overscroll-contain">
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
          {otherPullRequestsWithIssue.length > 0 && (
            <div className="flex max-h-48 flex-col gap-1.5 overflow-y-auto rounded-md border p-2">
              <p className="text-xs font-medium text-muted-foreground">
                developへの未マージPR（今回のリリースには含まれません）
              </p>
              <ul className="flex flex-col gap-1 text-xs">
                {otherPullRequestsWithIssue.map((pr) => (
                  <li key={pr.number} className="flex flex-col gap-0.5">
                    <a
                      href={pr.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline"
                    >
                      #{pr.number} {pr.title}
                    </a>
                    {pr.linkedIssue ? (
                      <a
                        href={pr.linkedIssue.htmlUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="pl-3 text-muted-foreground hover:underline"
                      >
                        → #{pr.linkedIssue.number} {pr.linkedIssue.title}
                      </a>
                    ) : (
                      <span className="pl-3 text-muted-foreground">
                        紐づくIssueが見つかりませんでした（未起票の可能性があります）
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
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
