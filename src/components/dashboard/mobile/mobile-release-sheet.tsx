"use client";

import { useMemo, useState } from "react";
import { isLegacyReleaseCandidateHeadRef, isRcReleaseCandidateHeadRef } from "@/lib/release-branch";
import { useReleaseRc } from "@/hooks/use-release-rc";
import { useReleaseStartMode } from "@/hooks/use-release-start-mode";
import { ReleaseRcFinalizePanel } from "@/components/dashboard/release-rc-finalize";
import { ReleaseRcVerificationEvidence } from "@/components/dashboard/release-rc-evidence";
import { ReleaseRcIdentity, ReleaseRcLegacyNotice } from "@/components/dashboard/release-rc-identity";

import { Rocket } from "lucide-react";

import { DeviceBuildInstructions } from "@/components/dashboard/device-build-instructions";
import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import { ReleaseChangeList } from "@/components/dashboard/release-change-list";
import { ReleaseProgress } from "@/components/dashboard/release-progress";
import { ConnectedReleaseReviewSections } from "@/components/dashboard/release-review-sections";
import { useReleasePreparation } from "@/hooks/use-release-preparation";
import { PREP_OVERRIDE_CONFIRM_TEXT } from "@/lib/release-prep-state";
import { ReleasePreparationAlert } from "@/components/dashboard/release-preparation-alert";
import { ReleaseRebuildHistoryPanel } from "@/components/dashboard/release-rebuild-history-panel";
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
  // 準備中・準備失敗は灰色に見せるが、確認のうえ起動できる（#4421。PCの個別ボタンと同じ挙動）
  const preparation = useReleasePreparation(repository.fullName, open);
  const prepUnknown = preparation.prepState === "unknown";
  const prepBlocked = preparation.prepState === "running" || preparation.prepState === "failed";
  const [allowPrepOverride, setAllowPrepOverride] = useState(false);
  // 新方式（候補を作成して検証）か旧方式かはcallerの対応で決まる（#4604。PCの個別ボタンと同じ判定）
  const startMode = useReleaseStartMode(repository.fullName, open);
  const candidateMode = startMode?.mode === "candidate";
  const startUnknown = startMode?.mode === "unknown";
  const startLoading = startMode === null;
  // リリース候補（#4495）の識別・公開準備。PCの本番PR詳細と同じ並びで出す（#4560）
  const releasePr = releaseStatus?.available && releaseStatus.phase === "release_pr_open" ? releaseStatus.releasePullRequest : null;
  const rc = useReleaseRc(repository.fullName, releasePr?.number ?? 0, open && releasePr !== null);
  const rcCandidate = releasePr && isRcReleaseCandidateHeadRef(releasePr.headRef ?? "") ? (rc.overview?.candidate ?? null) : null;
  const rcLegacy = releasePr && rc.overview?.legacy?.prNumber === releasePr.number ? rc.overview.legacy : null;
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
              <ReleasePreparationAlert repositoryFullName={repository.fullName} preparation={preparation} />
              {rcCandidate && <ReleaseRcIdentity candidate={rcCandidate} />}
              {rcCandidate && rc.overview?.finalization && (
                <ReleaseRcFinalizePanel
                  candidate={rcCandidate}
                  finalization={rc.overview.finalization}
                  repositoryFullName={repository.fullName}
                  onChanged={rc.reload}
                />
              )}
              {rc.overview && rcLegacy && (
                <ReleaseRcLegacyNotice overview={rc.overview} legacy={rcLegacy} repositoryFullName={repository.fullName} onChanged={rc.reload} />
              )}
              <ReleaseProgress
                status={releaseStatus}
                repoFullName={repository.fullName}
                isDeviceBuild={deviceBuild !== null}
              />
              {/* リリースPRの3区分（全体レビュー／統合検証／個別PRレビュー。#4238・#4277）。進捗を追うため
                  シートのポーリングとは別に、区分の状態は部品自身が短い間隔で取り直す */}
              {releaseStatus.phase === "release_pr_open" && releaseStatus.releasePullRequest?.headRef && (
                <ConnectedReleaseReviewSections
                  repositoryFullName={repository.fullName}
                  pullRequestNumber={releaseStatus.releasePullRequest.number}
                  headRef={releaseStatus.releasePullRequest.headRef}
                />
              )}
              {rcCandidate && (
                <ReleaseRcVerificationEvidence candidate={rcCandidate} finalization={rc.overview?.finalization?.current ?? null} />
              )}
              {/* リリースPRを出した後の修正は、凍結ブランチへ足さずバンプから作り直す（#3014）。
                  状態はこのシートのポーリングが拾うので、押した後の再取得は要らない */}
              {releaseStatus.phase === "release_pr_open" &&
                isLegacyReleaseCandidateHeadRef(releaseStatus.releasePullRequest?.headRef ?? "") && (
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
                  disabled={isTriggeringRelease || prepUnknown || startUnknown || startLoading}
                  onClick={() => setReleaseConfirmOpen(true)}
                  className={prepBlocked || prepUnknown ? "mt-1 bg-muted text-muted-foreground" : "mt-1"}
                >
                  <Rocket className={isTriggeringRelease ? "animate-pulse" : undefined} />
                  {isTriggeringRelease
                    ? "起動中..."
                    : prepUnknown
                      ? "準備状態を確認中"
                    : startLoading
                      ? "開始方式を確認中"
                      : preparation.prepState === "running"
                      ? "リリース準備中"
                      : preparation.prepState === "failed"
                        ? "準備に失敗"
                        : candidateMode
                          ? "候補を作成して検証"
                          : "リリースworkflowを起動"}
                </Button>
              )}
              {!deviceBuild && startMode && startMode.mode !== "candidate" && (
                <p className="text-xs text-muted-foreground">{startMode.label}</p>
              )}
              {!deviceBuild && preparation.prepState === "running" && (
                <p className="text-xs text-muted-foreground">CIとバージョン更新が自動で実行されます。操作せずお待ちください</p>
              )}
              {!deviceBuild && preparation.prepState === "failed" && (
                <p className="text-xs text-muted-foreground">リリース準備に失敗しています。上の赤い帯で原因を確認し、「再開」してください</p>
              )}
              {webviewIos && (
                <IosTestflightStatus
                  owner={repository.fullName.split("/")[0]}
                  repo={repository.fullName.split("/")[1]}
                />
              )}
              {webviewIos && <WebviewIosInstructions repo={webviewIos} />}
              {/* 作り直しの履歴（#4359）は、現在の検証と操作の後ろに置く（#4428） */}
              <ReleaseRebuildHistoryPanel repositoryFullName={repository.fullName} />
            </div>
          )}
        </div>
      </SheetContent>

      <AlertDialog open={releaseConfirmOpen} onOpenChange={(open) => {
        setReleaseConfirmOpen(open);
        if (!open) {
          setAllowFailedDeploy(false);
          setAllowPrepOverride(false);
        }
      }}>
        <AlertDialogContent className="flex flex-col gap-4 overflow-hidden">
          <AlertDialogHeader>
            <AlertDialogTitle>{candidateMode ? "リリース候補を作成して検証しますか？" : "リリースworkflowを起動しますか？"}</AlertDialogTitle>
            <AlertDialogDescription>
              {candidateMode
                ? `${repository.fullName}のdevelopの先端を候補（release-rc/*）として固定し、全体レビュー・統合検証へ進めます。正式な版は合格後の「公開準備」で初めて上げます。`
                : `${repository.fullName}のdevelopをmainへ反映するリリースworkflowを起動します。`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
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
          {prepBlocked && (
            <label className="flex items-start gap-2 rounded-md border border-amber-500/40 p-3 text-sm">
              <Checkbox
                checked={allowPrepOverride}
                onCheckedChange={(checked) => setAllowPrepOverride(checked === true)}
                disabled={isTriggeringRelease}
              />
              <span>{PREP_OVERRIDE_CONFIRM_TEXT[preparation.prepState]}</span>
            </label>
          )}
          {otherPullRequestsWithIssue.length > 0 && (
            <div className="flex flex-col gap-1.5 rounded-md border p-2">
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
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            {/* 起動できたことは、閉じた先のこのシートの進捗（`ReleaseProgress`）で分かるため、
                「リリースを起動しました」のダイアログは出さない（#1590） */}
            <AlertDialogAction
              disabled={isTriggeringRelease || prepUnknown || startLoading || startUnknown || (deployFailed && !allowFailedDeploy) || (prepBlocked && !allowPrepOverride)}
              onClick={() => void triggerRelease(undefined, deployFailed && allowFailedDeploy)}
            >{candidateMode ? "候補を作成する" : "起動する"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  );
}
