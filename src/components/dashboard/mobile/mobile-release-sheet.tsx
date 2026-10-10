"use client";

import { useMemo, useState } from "react";

import { Rocket } from "lucide-react";

import { DeviceBuildInstructions } from "@/components/dashboard/device-build-instructions";
import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import { ReleaseChangeList } from "@/components/dashboard/release-change-list";
import { ReleaseProgress } from "@/components/dashboard/release-progress";
import { ReleaseReviewSections } from "@/components/dashboard/release-review-sections";
import { ReleaseRebuildButton } from "@/components/dashboard/release-rebuild-button";
import { IosTestflightStatus } from "@/components/dashboard/ios-testflight-status";
import { WebviewIosInstructions } from "@/components/dashboard/webview-ios-instructions";
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
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { getDeviceBuildRepository } from "@/lib/device-build-repos";
import type { ReleaseStatus } from "@/hooks/use-release-status";
import {
  formatDevelopVersionDisplay,
  formatMainVersionDisplay,
} from "@/lib/github/release-version-display";
import { RELEASE_BRANCH_PREFIX } from "@/lib/pull-request-list";
import { getWebviewIosRepository } from "@/lib/webview-ios-repos";
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
  triggerRelease: (bumpKind?: undefined, allowFailedDeploy?: boolean) => Promise<boolean>;
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
  const [allowFailedDeploy, setAllowFailedDeploy] = useState(false);
  const deployRun = releaseStatus?.available ? releaseStatus.deployWorkflowRun : null;
  const deployFailed = deployRun?.status === "completed" &&
    (deployRun.conclusion === "failure" || deployRun.conclusion === "timed_out");

  // iOSアプリを持つリポジトリだけの「iOSへの反映」欄（#3579）。対象リポジトリの固定リストは
  // `lib/device-build-repos.ts`（Xcodeで実機ビルド。mainへのマージもMacのスクリプトが行う）と
  // `lib/webview-ios-repos.ts`（WebView型。Web側はdeploy.ymlがそのまま反映する）の2種類で、
  // 同じリポジトリが両方に載ることは無い。
  const deviceBuild = getDeviceBuildRepository(repository.fullName);
  const webviewIos = getWebviewIosRepository(repository.fullName);

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
              <ReleaseProgress
                status={releaseStatus}
                repoFullName={repository.fullName}
                isDeviceBuild={deviceBuild !== null}
              />
              {/* リリースPRの3区分（個別PRレビュー／統合検証／全体レビュー。#4238） */}
              {releaseStatus.phase === "release_pr_open" && releaseStatus.releasePullRequest?.headRef && (
                <ReleaseReviewSections
                  repositoryFullName={repository.fullName}
                  pullRequestNumber={releaseStatus.releasePullRequest.number}
                  headRef={releaseStatus.releasePullRequest.headRef}
                  verification={releaseStatus.releasePullRequest.verification ?? null}
                />
              )}
              {/* リリースPRを出した後の修正は、凍結ブランチへ足さずバンプから作り直す（#3014）。
                  状態はこのシートのポーリングが拾うので、押した後の再取得は要らない */}
              {releaseStatus.phase === "release_pr_open" &&
                releaseStatus.releasePullRequest?.headRef?.startsWith(RELEASE_BRANCH_PREFIX) && (
                  <ReleaseRebuildButton
                    repositoryFullName={repository.fullName}
                    mainVersion={releaseStatus.mainVersion}
                    className="h-8 self-start"
                  />
                )}
              {deviceBuild ? (
                // Xcodeで実機へ反映するリポジトリでは「リリースする」を出さない（#3468と同じ理由。
                // バンプは`gh workflow run`で行う運用で、下の手順にも同じコマンドを出している）
                <DeviceBuildInstructions deviceBuild={deviceBuild} />
              ) : (
                <Button
                  variant="outline"
                  disabled={isTriggeringRelease}
                  onClick={() => setReleaseConfirmOpen(true)}
                  className="mt-1"
                >
                  <Rocket className={isTriggeringRelease ? "animate-pulse" : undefined} />
                  {isTriggeringRelease ? "起動中..." : "リリースworkflowを起動"}
                </Button>
              )}
              {webviewIos && (
                <IosTestflightStatus
                  owner={repository.fullName.split("/")[0]}
                  repo={repository.fullName.split("/")[1]}
                />
              )}
              {webviewIos && <WebviewIosInstructions repo={webviewIos} />}
            </div>
          )}
        </div>
      </SheetContent>

      <AlertDialog open={releaseConfirmOpen} onOpenChange={(open) => {
        setReleaseConfirmOpen(open);
        if (!open) setAllowFailedDeploy(false);
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>リリースworkflowを起動しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              {repository.fullName}のdevelopをmainへ反映するリリースworkflowを起動します。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ReleaseChangeList
            repositoryFullName={repository.fullName}
            enabled={releaseConfirmOpen}
            releasePullRequestNumber={
              releaseStatus?.available && releaseStatus.phase === "release_pr_open"
                ? (releaseStatus.releasePullRequest?.number ?? null)
                : null
            }
          />
          {deployFailed && (
            <label className="flex items-start gap-2 rounded-md border border-destructive/40 p-3 text-sm">
              <Checkbox
                checked={allowFailedDeploy}
                onCheckedChange={(checked) => setAllowFailedDeploy(checked === true)}
                disabled={isTriggeringRelease}
              />
              <span>本番デプロイの失敗を確認しました。developに取り込んだ修正をリリースするため、失敗中の起動を許可します。</span>
            </label>
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
            {/* 起動できたことは、閉じた先のこのシートの進捗（`ReleaseProgress`）で分かるため、
                「リリースを起動しました」のダイアログは出さない（#1590） */}
            <AlertDialogAction
              disabled={isTriggeringRelease || (deployFailed && !allowFailedDeploy)}
              onClick={() => void triggerRelease(undefined, deployFailed && allowFailedDeploy)}
            >起動する</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  );
}
