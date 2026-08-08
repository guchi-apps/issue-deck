"use client";

import { useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  KeyRound,
  LayoutDashboard,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  Settings,
} from "lucide-react";

import packageJson from "../../../package.json";
import { ClaudeUsageCard } from "@/components/dashboard/claude-usage-card";
import { FineGrainedTokensDialog } from "@/components/dashboard/fine-grained-tokens-dialog";
import { GithubApiUsageList } from "@/components/dashboard/github-api-usage-list";
import { GithubRateLimitList } from "@/components/dashboard/github-rate-limit-list";
import { GithubStatusDialog } from "@/components/dashboard/github-status-dialog";
import { ProfileDialog } from "@/components/dashboard/profile-dialog";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ReleaseProgress } from "@/components/dashboard/release-progress";
import { UserAvatar } from "@/components/dashboard/user-avatar";
import { useAccountActions } from "@/hooks/use-account-actions";
import { useClaudeUsage } from "@/hooks/use-claude-usage";
import { useFineGrainedTokens } from "@/hooks/use-fine-grained-tokens";
import { useGithubApiUsage } from "@/hooks/use-github-api-usage";
import { useGithubRateLimit } from "@/hooks/use-github-rate-limit";
import { useGithubStatus } from "@/hooks/use-github-status";
import type { IssueFilters } from "@/hooks/use-issue-filters";
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

type TopBarProps = {
  currentUser: CurrentUser | null;
  filters: IssueFilters;
  setFilter: <K extends keyof IssueFilters>(key: K, value: IssueFilters[K]) => void;
  assigneeOptions: string[];
  onCreateIssue: () => void;
  selectedRepoFullName: string | null;
  repositories: ConnectedRepository[];
  issues: Issue[];
  isSidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onOpenAppSettings: () => void;
};

export function TopBar({
  currentUser,
  filters,
  setFilter,
  assigneeOptions,
  onCreateIssue,
  selectedRepoFullName,
  repositories,
  issues,
  isSidebarCollapsed,
  onToggleSidebar,
  onOpenAppSettings,
}: TopBarProps) {
  const { handleLogout } = useAccountActions();
  const { isSyncing: isIssueSyncing, handleSync: handleIssueSync } = useIssueSync();
  const { isSyncing: isRepositorySyncing, handleSync: handleRepositorySync } =
    useRepositorySync();
  const [profileDialogOpen, setProfileDialogOpen] = useState(false);
  const [issueSyncConfirmOpen, setIssueSyncConfirmOpen] = useState(false);
  const [repositorySyncConfirmOpen, setRepositorySyncConfirmOpen] = useState(false);
  const [releaseConfirmOpen, setReleaseConfirmOpen] = useState(false);
  const [releaseSuccessOpen, setReleaseSuccessOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [githubStatusDialogOpen, setGithubStatusDialogOpen] = useState(false);
  const [fineGrainedTokensDialogOpen, setFineGrainedTokensDialogOpen] = useState(false);
  // アカウントメニューを開くたびに、直前に選んだリポジトリがまだ選択可能ならそれを維持し、
  // そうでなければIssue一覧で絞り込み中のリポジトリ・先頭のリポジトリにフォールバックする（#383）。
  const [releaseRepoFullName, setReleaseRepoFullName] = useState<string | null>(
    selectedRepoFullName ?? repositories[0]?.fullName ?? null,
  );
  const { data: rateLimits, isLoading: rateLimitsLoading, error: rateLimitsError } =
    useGithubRateLimit(accountMenuOpen);
  const {
    data: apiUsage,
    isLoading: apiUsageLoading,
    error: apiUsageError,
  } = useGithubApiUsage(accountMenuOpen);
  const {
    data: claudeUsage,
    isLoading: claudeUsageLoading,
    error: claudeUsageError,
    notConfigured: claudeUsageNotConfigured,
  } = useClaudeUsage(accountMenuOpen);
  const {
    data: githubStatus,
    isLoading: githubStatusLoading,
    error: githubStatusError,
  } = useGithubStatus(accountMenuOpen);
  const {
    data: releaseStatus,
    isLoading: releaseStatusLoading,
    error: releaseStatusError,
    triggerRelease,
    isTriggering: isTriggeringRelease,
  } = useReleaseStatus(releaseRepoFullName, accountMenuOpen);
  const {
    data: fineGrainedTokens,
    isLoading: fineGrainedTokensLoading,
    error: fineGrainedTokensError,
    refetch: refetchFineGrainedTokens,
  } = useFineGrainedTokens(accountMenuOpen);
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

  const stateLabel =
    filters.state === "open"
      ? "状態: Open"
      : filters.state === "closed"
        ? "状態: Closed"
        : "状態: すべて";
  const assigneeLabel = filters.assignee
    ? filters.assignee === "unassigned"
      ? "担当者: 未設定"
      : `担当者: ${filters.assignee}`
    : "担当者";
  const isCheckUserView = filters.view === "check-user";
  const sortLabel = isCheckUserView
    ? "並び順: 確認が古い順"
    : filters.sort === "created"
      ? "並び順: 作成日"
      : "並び順: 更新日";

  return (
    <header className="hidden items-center gap-3 border-b px-4 py-2 md:flex">
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0"
        onClick={onToggleSidebar}
        title={isSidebarCollapsed ? "サイドバーを表示" : "サイドバーを非表示"}
      >
        {isSidebarCollapsed ? (
          <PanelLeftOpen className="size-4" />
        ) : (
          <PanelLeftClose className="size-4" />
        )}
      </Button>

      <div className="flex items-center gap-2 pr-4 text-sm font-semibold">
        <LayoutDashboard className="size-5 text-primary" />
        Issue Deck
      </div>

      <div className="relative w-72">
        <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Issueを検索..."
          title='検索式が使えます（例: label:bug -label:wontfix is:open assignee:octocat）。トークン以外の文字列はタイトル・本文の部分一致になります。'
          className="pl-8"
          value={filters.q}
          onChange={(e) => setFilter("q", e.target.value)}
        />
      </div>

      <div className="flex flex-1 flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="text-xs">
              {stateLabel}
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuRadioGroup
              value={filters.state}
              onValueChange={(value) =>
                setFilter(
                  "state",
                  value === "open" || value === "closed" ? value : "all",
                )
              }
            >
              <DropdownMenuRadioItem value="all">すべて</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="open">Open</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="closed">Closed</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="text-xs">
              {assigneeLabel}
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuRadioGroup
              value={filters.assignee ?? ""}
              onValueChange={(value) => setFilter("assignee", value || null)}
            >
              <DropdownMenuRadioItem value="">すべて</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="unassigned">未設定</DropdownMenuRadioItem>
              {assigneeOptions.map((login) => (
                <DropdownMenuRadioItem key={login} value={login}>
                  {login}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              disabled={isCheckUserView}
              title={isCheckUserView ? "確認待ちビューでは確認が古い順に固定されます" : undefined}
            >
              {sortLabel}
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuRadioGroup
              value={filters.sort}
              onValueChange={(value) => setFilter("sort", value === "created" ? "created" : "updated")}
            >
              <DropdownMenuRadioItem value="updated">更新日</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="created">作成日</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <Button size="sm" className="text-xs" onClick={onCreateIssue}>
        <Plus />
        新規Issue
      </Button>

      <DropdownMenu
        open={accountMenuOpen}
        onOpenChange={(open) => {
          setAccountMenuOpen(open);
          if (open) {
            setReleaseRepoFullName((prev) =>
              prev && repositories.some((repo) => repo.fullName === prev)
                ? prev
                : (selectedRepoFullName ?? repositories[0]?.fullName ?? null),
            );
          }
        }}
      >
        <DropdownMenuTrigger asChild>
          <button type="button" className="flex items-center gap-1 rounded-md p-1 hover:bg-accent">
            <UserAvatar
              login={currentUser?.login ?? "?"}
              image={currentUser?.image}
              className="size-7"
            />
            <ChevronDown className="size-3 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setProfileDialogOpen(true);
            }}
          >
            {currentUser?.name ?? currentUser?.login}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              onOpenAppSettings();
            }}
          >
            <Settings />
            アプリ設定
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setGithubStatusDialogOpen(true);
            }}
          >
            <Activity />
            GitHub障害状況
            {githubStatus && githubStatus.indicator !== "none" && (
              <AlertTriangle className="ml-auto size-4 text-destructive" />
            )}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setFineGrainedTokensDialogOpen(true);
            }}
          >
            <KeyRound />
            Fine-grained PAT管理
            {hasExpiringFineGrainedToken && (
              <AlertTriangle className="ml-auto size-4 text-destructive" />
            )}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>GitHub API使用量</DropdownMenuLabel>
          <div className="flex flex-col gap-2 px-1.5 pb-1.5">
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
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Claudeプラン使用量</DropdownMenuLabel>
          <div className="px-1.5 pb-1.5">
            <ClaudeUsageCard
              data={claudeUsage}
              isLoading={claudeUsageLoading}
              error={claudeUsageError}
              notConfigured={claudeUsageNotConfigured}
            />
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={isIssueSyncing}
            onSelect={(e) => {
              e.preventDefault();
              setIssueSyncConfirmOpen(true);
            }}
          >
            <RefreshCw className={isIssueSyncing ? "animate-spin" : undefined} />
            {isIssueSyncing ? "Issueを再同期中..." : "Issueを再同期"}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={isRepositorySyncing}
            onSelect={(e) => {
              e.preventDefault();
              setRepositorySyncConfirmOpen(true);
            }}
          >
            <RefreshCw className={isRepositorySyncing ? "animate-spin" : undefined} />
            {isRepositorySyncing ? "リポジトリを再同期中..." : "リポジトリを再同期"}
          </DropdownMenuItem>

          {repositories.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <Collapsible>
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between px-1.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground [&[data-state=open]>svg]:rotate-180"
                  >
                    リリース
                    <ChevronDown className="size-3 transition-transform" />
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="px-1.5 pb-1.5">
                    <Select
                      value={releaseRepoFullName ?? undefined}
                      onValueChange={setReleaseRepoFullName}
                    >
                      <SelectTrigger className="mb-2 w-full text-xs" size="sm">
                        <SelectValue placeholder="リポジトリを選択" />
                      </SelectTrigger>
                      <SelectContent>
                        {repositories.map((repo) => (
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
                          className="text-xs"
                          disabled={isTriggeringRelease}
                          onClick={(e) => {
                            e.preventDefault();
                            setReleaseConfirmOpen(true);
                          }}
                        >
                          <Rocket className={isTriggeringRelease ? "animate-pulse" : undefined} />
                          {isTriggeringRelease ? "起動中..." : "リリースworkflowを起動"}
                        </Button>
                      </div>
                    )}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </>
          )}

          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <a href={TERMS_OF_SERVICE_URL} target="_blank" rel="noopener noreferrer">
              利用規約
            </a>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href={PRIVACY_POLICY_URL} target="_blank" rel="noopener noreferrer">
              プライバシーポリシー
            </a>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={handleLogout}>
            ログアウト
          </DropdownMenuItem>
          <p className="pt-1 text-center text-xs text-muted-foreground">
            Issue Deck v{packageJson.version}
          </p>
        </DropdownMenuContent>
      </DropdownMenu>

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
    </header>
  );
}
