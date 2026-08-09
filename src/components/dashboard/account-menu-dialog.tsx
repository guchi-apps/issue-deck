"use client";

import { useState } from "react";
import { Activity, AlertTriangle, KeyRound, RefreshCw, Settings } from "lucide-react";

import packageJson from "../../../package.json";
import { ClaudeUsageCard } from "@/components/dashboard/claude-usage-card";
import { FineGrainedTokensDialog } from "@/components/dashboard/fine-grained-tokens-dialog";
import { GithubApiUsageList } from "@/components/dashboard/github-api-usage-list";
import { GithubRateLimitList } from "@/components/dashboard/github-rate-limit-list";
import { GithubStatusDialog } from "@/components/dashboard/github-status-dialog";
import { ProfileDialog } from "@/components/dashboard/profile-dialog";
import { UserAvatar } from "@/components/dashboard/user-avatar";
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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAccountActions } from "@/hooks/use-account-actions";
import { useClaudeUsage } from "@/hooks/use-claude-usage";
import { useFineGrainedTokens } from "@/hooks/use-fine-grained-tokens";
import { useGithubApiUsage } from "@/hooks/use-github-api-usage";
import { useGithubRateLimit } from "@/hooks/use-github-rate-limit";
import { useGithubStatus } from "@/hooks/use-github-status";
import { useIssueSync } from "@/hooks/use-issue-sync";
import { useNow } from "@/hooks/use-now";
import { useRepositorySync } from "@/hooks/use-repository-sync";
import { getFineGrainedTokenStatus } from "@/lib/fine-grained-tokens";
import type { CurrentUser } from "@/types/user";

type AccountMenuDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentUser: CurrentUser | null;
  onOpenAppSettings: () => void;
};

export function AccountMenuDialog({
  open,
  onOpenChange,
  currentUser,
  onOpenAppSettings,
}: AccountMenuDialogProps) {
  const { handleLogout } = useAccountActions();
  const { isSyncing: isIssueSyncing, handleSync: handleIssueSync } = useIssueSync();
  const { isSyncing: isRepositorySyncing, handleSync: handleRepositorySync } =
    useRepositorySync();
  const [profileDialogOpen, setProfileDialogOpen] = useState(false);
  const [issueSyncConfirmOpen, setIssueSyncConfirmOpen] = useState(false);
  const [repositorySyncConfirmOpen, setRepositorySyncConfirmOpen] = useState(false);
  const [githubStatusDialogOpen, setGithubStatusDialogOpen] = useState(false);
  const [fineGrainedTokensDialogOpen, setFineGrainedTokensDialogOpen] = useState(false);
  const { data: rateLimits, isLoading: rateLimitsLoading, error: rateLimitsError } =
    useGithubRateLimit(open);
  const {
    data: apiUsage,
    isLoading: apiUsageLoading,
    error: apiUsageError,
  } = useGithubApiUsage(open);
  const {
    data: claudeUsage,
    isLoading: claudeUsageLoading,
    error: claudeUsageError,
    notConfigured: claudeUsageNotConfigured,
  } = useClaudeUsage(open);
  const {
    data: githubStatus,
    isLoading: githubStatusLoading,
    error: githubStatusError,
  } = useGithubStatus(open);
  const {
    data: fineGrainedTokens,
    isLoading: fineGrainedTokensLoading,
    error: fineGrainedTokensError,
    refetch: refetchFineGrainedTokens,
  } = useFineGrainedTokens(open);
  const now = useNow();
  const hasExpiringFineGrainedToken =
    now !== null &&
    (fineGrainedTokens ?? []).some(
      (token) => getFineGrainedTokenStatus(token.expiresAt, now) !== "active",
    );

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="sr-only">アカウントメニュー</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <button
              type="button"
              onClick={() => setProfileDialogOpen(true)}
              className="flex items-center gap-3 rounded-md border p-2 text-left hover:bg-accent"
            >
              <UserAvatar
                login={currentUser?.login ?? "?"}
                image={currentUser?.image}
                className="size-9"
              />
              <span className="text-sm font-medium">
                {currentUser?.name ?? currentUser?.login}
              </span>
            </button>

            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" className="justify-start" onClick={onOpenAppSettings}>
                <Settings />
                アプリ設定
              </Button>

              <Button
                variant="outline"
                className="justify-start"
                onClick={() => setGithubStatusDialogOpen(true)}
              >
                <Activity />
                GitHub障害状況
                {githubStatus && githubStatus.indicator !== "none" && (
                  <AlertTriangle className="ml-auto size-4 text-destructive" />
                )}
              </Button>

              <Button
                variant="outline"
                className="justify-start"
                onClick={() => setFineGrainedTokensDialogOpen(true)}
              >
                <KeyRound />
                Fine-grained PAT管理
                {hasExpiringFineGrainedToken && (
                  <AlertTriangle className="ml-auto size-4 text-destructive" />
                )}
              </Button>

              <Button
                variant="outline"
                className="justify-start"
                disabled={isIssueSyncing}
                onClick={() => setIssueSyncConfirmOpen(true)}
              >
                <RefreshCw className={isIssueSyncing ? "animate-spin" : undefined} />
                {isIssueSyncing ? "Issueを再同期中..." : "Issueを再同期"}
              </Button>

              <Button
                variant="outline"
                className="justify-start"
                disabled={isRepositorySyncing}
                onClick={() => setRepositorySyncConfirmOpen(true)}
              >
                <RefreshCw className={isRepositorySyncing ? "animate-spin" : undefined} />
                {isRepositorySyncing ? "リポジトリを再同期中..." : "リポジトリを再同期"}
              </Button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-2 rounded-md border p-3">
                <p className="text-xs font-medium text-muted-foreground">GitHub API使用量</p>
                <GithubRateLimitList
                  data={rateLimits}
                  isLoading={rateLimitsLoading}
                  error={rateLimitsError}
                />
                <GithubApiUsageList
                  data={apiUsage}
                  isLoading={apiUsageLoading}
                  error={apiUsageError}
                />
              </div>

              <div className="rounded-md border p-3">
                <p className="mb-2 text-xs font-medium text-muted-foreground">
                  Claudeプラン使用量
                </p>
                <ClaudeUsageCard
                  data={claudeUsage}
                  isLoading={claudeUsageLoading}
                  error={claudeUsageError}
                  notConfigured={claudeUsageNotConfigured}
                />
              </div>
            </div>

            <Button variant="destructive" onClick={handleLogout}>
              ログアウト
            </Button>

            <p className="text-center text-xs text-muted-foreground">
              Issue Deck v{packageJson.version}
            </p>
          </div>
        </DialogContent>
      </Dialog>

      <ProfileDialog
        currentUser={currentUser}
        open={profileDialogOpen}
        onOpenChange={setProfileDialogOpen}
      />

      <GithubStatusDialog
        open={githubStatusDialogOpen}
        onOpenChange={setGithubStatusDialogOpen}
        data={githubStatus}
        isLoading={githubStatusLoading}
        error={githubStatusError}
      />

      <FineGrainedTokensDialog
        open={fineGrainedTokensDialogOpen}
        onOpenChange={setFineGrainedTokensDialogOpen}
        data={fineGrainedTokens}
        isLoading={fineGrainedTokensLoading}
        error={fineGrainedTokensError}
        onChanged={refetchFineGrainedTokens}
      />

      <AlertDialog open={issueSyncConfirmOpen} onOpenChange={setIssueSyncConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Issueを再同期しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              GitHub上の最新のIssue情報を取得し直します。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction onClick={handleIssueSync}>再同期する</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={repositorySyncConfirmOpen} onOpenChange={setRepositorySyncConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>リポジトリを再同期しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              GitHub上の最新のリポジトリ情報（対応状況を含む）を取得し直します。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction onClick={handleRepositorySync}>再同期する</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
