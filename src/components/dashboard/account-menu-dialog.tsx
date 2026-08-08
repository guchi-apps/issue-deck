"use client";

import { useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  KeyRound,
  RefreshCw,
  Rocket,
  Settings,
} from "lucide-react";

import packageJson from "../../../package.json";
import { ClaudeUsageCard } from "@/components/dashboard/claude-usage-card";
import { FineGrainedTokensDialog } from "@/components/dashboard/fine-grained-tokens-dialog";
import { GithubApiUsageList } from "@/components/dashboard/github-api-usage-list";
import { GithubRateLimitList } from "@/components/dashboard/github-rate-limit-list";
import { GithubStatusDialog } from "@/components/dashboard/github-status-dialog";
import { ProfileDialog } from "@/components/dashboard/profile-dialog";
import { ReleaseProgress } from "@/components/dashboard/release-progress";
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
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAccountActions } from "@/hooks/use-account-actions";
import { useClaudeUsage } from "@/hooks/use-claude-usage";
import { useFineGrainedTokens } from "@/hooks/use-fine-grained-tokens";
import { useGithubApiUsage } from "@/hooks/use-github-api-usage";
import { useGithubRateLimit } from "@/hooks/use-github-rate-limit";
import { useGithubStatus } from "@/hooks/use-github-status";
import { useIssueSync } from "@/hooks/use-issue-sync";
import { useNow } from "@/hooks/use-now";
import { useReleaseStatus } from "@/hooks/use-release-status";
import { useRepositorySync } from "@/hooks/use-repository-sync";
import {
  formatDevelopVersionDisplay,
  formatMainVersionDisplay,
} from "@/lib/github/release-version-display";
import { DEVELOP_MERGED_LABEL_NAME } from "@/lib/github/workflow-status";
import { getFineGrainedTokenStatus } from "@/lib/fine-grained-tokens";
import { PRIVACY_POLICY_URL, TERMS_OF_SERVICE_URL } from "@/lib/legal-links";
import type { Issue } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";
import type { CurrentUser } from "@/types/user";

type AccountMenuDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentUser: CurrentUser | null;
  selectedRepoFullName: string | null;
  repositories: ConnectedRepository[];
  issues: Issue[];
  onOpenAppSettings: () => void;
};

export function AccountMenuDialog({
  open,
  onOpenChange,
  currentUser,
  selectedRepoFullName,
  repositories,
  issues,
  onOpenAppSettings,
}: AccountMenuDialogProps) {
  const { handleLogout } = useAccountActions();
  const { isSyncing: isIssueSyncing, handleSync: handleIssueSync } = useIssueSync();
  const { isSyncing: isRepositorySyncing, handleSync: handleRepositorySync } =
    useRepositorySync();
  const [profileDialogOpen, setProfileDialogOpen] = useState(false);
  const [issueSyncConfirmOpen, setIssueSyncConfirmOpen] = useState(false);
  const [repositorySyncConfirmOpen, setRepositorySyncConfirmOpen] = useState(false);
  const [releaseConfirmOpen, setReleaseConfirmOpen] = useState(false);
  const [releaseSuccessOpen, setReleaseSuccessOpen] = useState(false);
  const [githubStatusDialogOpen, setGithubStatusDialogOpen] = useState(false);
  const [fineGrainedTokensDialogOpen, setFineGrainedTokensDialogOpen] = useState(false);
  // リリース対象として選択できるのは、Issue-deckに登録済み（=claude-issue-dispatch.ymlの導入が
  // 確認できる）リポジトリに限定する。GitHub Appのインストールだけが済み、まだissue-deckの
  // 自動化を導入していないリポジトリは本番リリースもできないため選択肢から除く。
  const releasableRepositories = useMemo(
    () => repositories.filter((repo) => repo.hasClaudeWorkflow),
    [repositories],
  );
  // ダイアログを開くたびに、直前に選んだリポジトリがまだ選択可能ならそれを維持し、
  // そうでなければIssue一覧で絞り込み中のリポジトリ・先頭のリポジトリにフォールバックする（#383）。
  const [releaseRepoFullName, setReleaseRepoFullName] = useState<string | null>(
    releasableRepositories.find((repo) => repo.fullName === selectedRepoFullName)?.fullName ??
      releasableRepositories[0]?.fullName ??
      null,
  );
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
    data: releaseStatus,
    isLoading: releaseStatusLoading,
    error: releaseStatusError,
    triggerRelease,
    isTriggering: isTriggeringRelease,
  } = useReleaseStatus(releaseRepoFullName, open);
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

  async function handleTriggerRelease() {
    const ok = await triggerRelease();
    if (ok) {
      setReleaseSuccessOpen(true);
    }
  }

  // 誤タップでの起動を防ぐため確認ダイアログを挟む。今回developにマージ済みでmain未反映のIssueを
  // 「今回反映する内容」として一覧表示する（#426）。
  const pendingReleaseIssues = useMemo(
    () =>
      issues.filter(
        (issue) =>
          issue.repositoryFullName === releaseRepoFullName &&
          issue.labels.some((label) => label.name === DEVELOP_MERGED_LABEL_NAME),
      ),
    [issues, releaseRepoFullName],
  );

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          onOpenChange(nextOpen);
          if (nextOpen) {
            setReleaseRepoFullName((prev) =>
              prev && releasableRepositories.some((repo) => repo.fullName === prev)
                ? prev
                : (releasableRepositories.find((repo) => repo.fullName === selectedRepoFullName)
                    ?.fullName ??
                    releasableRepositories[0]?.fullName ??
                    null),
            );
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
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
              <p className="mb-2 text-xs font-medium text-muted-foreground">Claudeプラン使用量</p>
              <ClaudeUsageCard
                data={claudeUsage}
                isLoading={claudeUsageLoading}
                error={claudeUsageError}
                notConfigured={claudeUsageNotConfigured}
              />
            </div>

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

            {releasableRepositories.length > 0 && (
              <Collapsible className="rounded-md border p-3">
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between text-xs font-medium text-muted-foreground hover:text-foreground [&[data-state=open]>svg]:rotate-180"
                  >
                    リリース
                    <ChevronDown className="size-3 transition-transform" />
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="pt-2">
                    <Select
                      value={releaseRepoFullName ?? undefined}
                      onValueChange={setReleaseRepoFullName}
                    >
                      <SelectTrigger className="mb-2 w-full text-xs" size="sm">
                        <SelectValue placeholder="リポジトリを選択" />
                      </SelectTrigger>
                      <SelectContent>
                        {releasableRepositories.map((repo) => (
                          <SelectItem key={repo.id} value={repo.fullName}>
                            {repo.fullName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {releaseStatusLoading && (
                      <p className="text-xs text-muted-foreground">読み込み中...</p>
                    )}
                    {releaseStatusError && (
                      <p className="text-xs text-destructive">{releaseStatusError}</p>
                    )}
                    {releaseStatus && !releaseStatus.available && (
                      <p className="text-xs text-muted-foreground">
                        このリポジトリにはリリース用のworkflowが見つかりませんでした
                      </p>
                    )}
                    {releaseStatus?.available && (
                      <div className="flex flex-col gap-2">
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
                        <ReleaseProgress status={releaseStatus} compact />
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={isTriggeringRelease}
                          onClick={() => setReleaseConfirmOpen(true)}
                        >
                          <Rocket className={isTriggeringRelease ? "animate-pulse" : undefined} />
                          {isTriggeringRelease ? "起動中..." : "リリースworkflowを起動"}
                        </Button>
                      </div>
                    )}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}

            <div className="flex flex-col gap-1">
              <Button variant="outline" className="justify-start" asChild>
                <a href={TERMS_OF_SERVICE_URL} target="_blank" rel="noopener noreferrer">
                  利用規約
                </a>
              </Button>
              <Button variant="outline" className="justify-start" asChild>
                <a href={PRIVACY_POLICY_URL} target="_blank" rel="noopener noreferrer">
                  プライバシーポリシー
                </a>
              </Button>
            </div>

            <Button variant="destructive" className="justify-start" onClick={handleLogout}>
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
              進捗はこのメニューに表示されます（マージが必要な段階ではマージ用リンクが出ます）。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction className={buttonVariants({ variant: "default" })}>
              OK
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
