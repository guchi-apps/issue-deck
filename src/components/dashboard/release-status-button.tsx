"use client";

import { useMemo, useState } from "react";
import { Rocket } from "lucide-react";

import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useReleaseStatus } from "@/hooks/use-release-status";
import {
  useRepositoryReleaseStatuses,
  type RepositoryReleaseStatus,
} from "@/hooks/use-repository-release-statuses";
import { describeReleaseStatusBadge } from "@/lib/github/release-button-status";
import {
  formatDevelopVersionDisplay,
  formatMainVersionDisplay,
} from "@/lib/github/release-version-display";
import { isNextReleaseIssue, isReleasePendingIssue } from "@/lib/issue-progress";
import { cn } from "@/lib/utils";
import type { Issue } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";

type ReleaseStatusButtonProps = {
  repositories: ConnectedRepository[];
  selectedRepoFullName: string | null;
  issues: Issue[];
};

/**
 * PC画面のヘッダー常時表示（#979）。account-menu-dialogに埋もれていたリリース導線
 * （リポジトリごとのリリース進捗確認・起動）を、モバイル版のRocketボタンと同様に
 * リポジトリ横断で1つのアイコンとして常時見える場所に出す。develop→mainのPRが
 * オープン中（mainへのマージ待ち）、またはバンプPRがCI通過後も残っている（developへの
 * マージ待ち）リポジトリが1つでもあればバッジを表示する。
 */
export function ReleaseStatusButton({
  repositories,
  selectedRepoFullName,
  issues,
}: ReleaseStatusButtonProps) {
  const releasableRepositories = useMemo(
    () => repositories.filter((repo) => repo.hasClaudeWorkflow),
    [repositories],
  );
  const [open, setOpen] = useState(false);
  const [releaseConfirmOpen, setReleaseConfirmOpen] = useState(false);
  const [releaseSuccessOpen, setReleaseSuccessOpen] = useState(false);
  const [releaseRepoFullName, setReleaseRepoFullName] = useState<string | null>(
    releasableRepositories.find((repo) => repo.fullName === selectedRepoFullName)?.fullName ??
      releasableRepositories[0]?.fullName ??
      null,
  );

  const {
    data: releaseStatuses,
    refetch: refetchPendingMerges,
  } = useRepositoryReleaseStatuses(releasableRepositories.length > 0);
  const releaseStatusByRepo = useMemo(() => {
    const map = new Map<string, RepositoryReleaseStatus>();
    (releaseStatuses ?? []).forEach((releaseStatus) =>
      map.set(releaseStatus.repoFullName, releaseStatus),
    );
    return map;
  }, [releaseStatuses]);
  // バッジの件数は「人の操作を待っているもの」だけを数える。実行中・失敗まで数に混ぜると
  // 「いくつマージすればよいか」が読めなくなるため（#1117で実行中も返すようになった）。
  const pendingMerges = useMemo(
    () => (releaseStatuses ?? []).filter((releaseStatus) => releaseStatus.pendingMerge != null),
    [releaseStatuses],
  );
  const pendingMergeCount = pendingMerges.length;
  const hasPendingMerges = pendingMergeCount > 0;
  // リポジトリごとに複数Issueが1つのバンプPR／リリースPRへまとめて乗る運用のため、
  // 「リリース待ちが何個あるか」はPR件数ではなくIssue件数で表す（#1214）。
  const releasePendingIssueCountByRepo = useMemo(() => {
    const map = new Map<string, number>();
    issues.forEach((issue) => {
      if (!isReleasePendingIssue(issue)) return;
      map.set(issue.repositoryFullName, (map.get(issue.repositoryFullName) ?? 0) + 1);
    });
    return map;
  }, [issues]);
  // CI失敗はマージ待ちより強い通知にする。ポップオーバーを開かずに気づけるのはこのドットだけのため、
  // 1件でも失敗があれば色を変える（#1059）。
  const hasCiFailure = pendingMerges.some(
    (releaseStatus) => releaseStatus.pendingMerge?.ciState === "failure",
  );

  const {
    data: releaseStatus,
    isLoading: releaseStatusLoading,
    error: releaseStatusError,
    triggerRelease,
    isTriggering: isTriggeringRelease,
  } = useReleaseStatus(releaseRepoFullName, open);

  // 誤タップでの起動を防ぐため確認ダイアログを挟む。今回developにマージ済みでmain未反映のIssueを
  // 「今回反映する内容」として一覧表示する（#426）。
  const pendingReleaseIssues = useMemo(
    () =>
      issues.filter(
        (issue) => issue.repositoryFullName === releaseRepoFullName && isNextReleaseIssue(issue),
      ),
    [issues, releaseRepoFullName],
  );

  // Issueを起票せず直接developへ作られたPRの見落としに気づけるよう、develop向けの
  // その他のオープンPR（バンプPR自身を除く）を、参照Issue番号から画面に読み込み済みのIssueと
  // 突き合わせて一覧表示する(#977)。突き合わせはこの画面側で行うため追加のAPI呼び出しは無い。
  const otherPullRequestsWithIssue = useMemo(() => {
    const otherPullRequests =
      releaseStatus?.available && releaseStatus.otherPullRequests ? releaseStatus.otherPullRequests : [];
    const repoIssues = issues.filter((issue) => issue.repositoryFullName === releaseRepoFullName);
    return otherPullRequests.map((pr) => ({
      ...pr,
      linkedIssue: repoIssues.find((issue) => pr.issueNumbers.includes(issue.number)) ?? null,
    }));
  }, [releaseStatus, issues, releaseRepoFullName]);

  async function handleTriggerRelease() {
    const ok = await triggerRelease();
    if (ok) {
      setReleaseSuccessOpen(true);
      void refetchPendingMerges();
    }
  }

  if (releasableRepositories.length === 0) return null;

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (nextOpen) {
            setReleaseRepoFullName((prev) =>
              prev && releasableRepositories.some((repo) => repo.fullName === prev)
                ? prev
                : (releasableRepositories.find((repo) => repo.fullName === selectedRepoFullName)
                    ?.fullName ??
                    releasableRepositories[0]?.fullName ??
                    null),
            );
            void refetchPendingMerges();
          }
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            className="relative flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-accent"
            title="リリース"
            aria-label="リリース"
          >
            <Rocket className="size-4" />
            {hasPendingMerges && (
              <span
                className={cn(
                  "absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium text-white",
                  hasCiFailure ? "bg-destructive" : "bg-amber-500",
                )}
              >
                {pendingMergeCount}
              </span>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 space-y-3">
          <div>
            <h3 className="mb-1.5 text-xs font-semibold text-muted-foreground">
              リリース{hasPendingMerges ? `（${pendingMergeCount}件）` : ""}
            </h3>
            <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
              {releasableRepositories.map((repo) => {
                const repoReleaseStatus = releaseStatusByRepo.get(repo.fullName);
                // 文言はモバイルのリポジトリ一覧と同じ純関数から得る（#1117）。
                const releaseBadge = repoReleaseStatus
                  ? describeReleaseStatusBadge({
                      status: repoReleaseStatus.status,
                      failedWorkflow: repoReleaseStatus.failedWorkflow,
                      mergeTarget: repoReleaseStatus.pendingMerge?.mergeTarget ?? null,
                      ciState: repoReleaseStatus.pendingMerge?.ciState ?? null,
                    })
                  : null;
                const issueCount = releasePendingIssueCountByRepo.get(repo.fullName) ?? 0;
                return (
                  <li key={repo.id}>
                    <button
                      type="button"
                      onClick={() => setReleaseRepoFullName(repo.fullName)}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent",
                        releaseRepoFullName === repo.fullName && "bg-accent",
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate">{repo.fullName}</span>
                        {issueCount > 0 && (
                          <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {issueCount}件
                          </span>
                        )}
                      </span>
                      {releaseBadge && (
                        <span
                          className={cn(
                            "shrink-0",
                            releaseBadge.tone === "error"
                              ? "text-destructive"
                              : releaseBadge.tone === "action"
                                ? "text-amber-700 dark:text-amber-400"
                                : "text-sky-700 dark:text-sky-400",
                          )}
                        >
                          {releaseBadge.label}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {releaseRepoFullName && (
            <div className="flex flex-col gap-2 border-t pt-3">
              {releaseStatusLoading && <p className="text-xs text-muted-foreground">読み込み中...</p>}
              {releaseStatusError && <p className="text-xs text-destructive">{releaseStatusError}</p>}
              {releaseStatus && !releaseStatus.available && (
                <p className="text-xs text-muted-foreground">
                  このリポジトリにはリリース用のworkflowが見つかりませんでした
                </p>
              )}
              {releaseStatus?.available && (
                <>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">main</span>
                    <span>
                      {formatMainVersionDisplay(
                        releaseStatus.mainVersion,
                        releaseStatus.developVersion,
                        releaseStatus.phase,
                      )}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">develop</span>
                    <span>
                      {formatDevelopVersionDisplay(
                        releaseStatus.developVersion,
                        releaseStatus.bumpPullRequest?.version ?? null,
                        releaseStatus.phase,
                      )}
                    </span>
                  </div>
                  <ReleaseProgress
                    status={releaseStatus}
                    compact
                    repoFullName={releaseRepoFullName}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isTriggeringRelease}
                    onClick={() => setReleaseConfirmOpen(true)}
                  >
                    <Rocket className={isTriggeringRelease ? "animate-pulse" : undefined} />
                    {isTriggeringRelease ? "起動中..." : "リリースworkflowを起動"}
                  </Button>
                </>
              )}
            </div>
          )}
        </PopoverContent>
      </Popover>

      <AlertDialog open={releaseConfirmOpen} onOpenChange={setReleaseConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>リリースworkflowを起動しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              {releaseRepoFullName}のdevelopをmainへ反映するリリースworkflowを起動します。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingReleaseIssues.length > 0 ? (
            <div className="flex max-h-48 flex-col gap-1.5 overflow-y-auto rounded-md border p-2">
              <p className="text-xs font-medium text-muted-foreground">今回反映する内容</p>
              <ul className="flex flex-col gap-1 text-xs">
                {pendingReleaseIssues.map((issue) => (
                  <li key={issue.id}>
                    <GithubReferenceLink href={issue.htmlUrl} className="hover:underline">
                      #{issue.number} {issue.title}
                    </GithubReferenceLink>
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
                    <GithubReferenceLink href={pr.url} className="hover:underline">
                      #{pr.number} {pr.title}
                    </GithubReferenceLink>
                    {pr.linkedIssue ? (
                      <GithubReferenceLink
                        href={pr.linkedIssue.htmlUrl}
                        className="pl-3 text-muted-foreground hover:underline"
                      >
                        → #{pr.linkedIssue.number} {pr.linkedIssue.title}
                      </GithubReferenceLink>
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
              進捗はこのメニューに表示されます（マージが必要な段階ではマージ用リンクが出ます）。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction className={buttonVariants({ variant: "default" })}>OK</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
