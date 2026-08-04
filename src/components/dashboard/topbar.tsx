"use client";

import { useState } from "react";
import {
  ChevronDown,
  LayoutDashboard,
  Plus,
  RefreshCw,
  Rocket,
  Search,
} from "lucide-react";

import packageJson from "../../../package.json";
import { ClaudeUsageCard } from "@/components/dashboard/claude-usage-card";
import { GithubRateLimitList } from "@/components/dashboard/github-rate-limit-list";
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
import { Button } from "@/components/ui/button";
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
import { useGithubRateLimit } from "@/hooks/use-github-rate-limit";
import type { IssueFilters } from "@/hooks/use-issue-filters";
import { useIssueSync } from "@/hooks/use-issue-sync";
import { useReleaseStatus } from "@/hooks/use-release-status";
import { PRIVACY_POLICY_URL, TERMS_OF_SERVICE_URL } from "@/lib/legal-links";
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
};

export function TopBar({
  currentUser,
  filters,
  setFilter,
  assigneeOptions,
  onCreateIssue,
  selectedRepoFullName,
  repositories,
}: TopBarProps) {
  const { handleLogout } = useAccountActions();
  const { isSyncing, handleSync } = useIssueSync();
  const [profileDialogOpen, setProfileDialogOpen] = useState(false);
  const [syncConfirmOpen, setSyncConfirmOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  // アカウントメニューを開くたびに、直前に選んだリポジトリがまだ選択可能ならそれを維持し、
  // そうでなければIssue一覧で絞り込み中のリポジトリ・先頭のリポジトリにフォールバックする（#383）。
  const [releaseRepoFullName, setReleaseRepoFullName] = useState<string | null>(
    selectedRepoFullName ?? repositories[0]?.fullName ?? null,
  );
  const { data: rateLimits, isLoading: rateLimitsLoading, error: rateLimitsError } =
    useGithubRateLimit(accountMenuOpen);
  const {
    data: claudeUsage,
    isLoading: claudeUsageLoading,
    error: claudeUsageError,
    notConfigured: claudeUsageNotConfigured,
  } = useClaudeUsage(accountMenuOpen);
  const {
    data: releaseStatus,
    isLoading: releaseStatusLoading,
    error: releaseStatusError,
    triggerRelease,
    isTriggering: isTriggeringRelease,
  } = useReleaseStatus(releaseRepoFullName, accountMenuOpen);

  async function handleTriggerRelease() {
    const ok = await triggerRelease();
    if (ok) {
      alert("リリースを起動しました。進捗はこのメニューに表示されます（マージが必要な段階ではマージ用リンクが出ます）。");
    }
  }

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
  const sortLabel = filters.sort === "created" ? "並び順: 作成日" : "並び順: 更新日";

  return (
    <header className="hidden items-center gap-3 border-b px-4 py-2 md:flex">
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
            <Button variant="outline" size="sm" className="text-xs">
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
          <DropdownMenuSeparator />
          <DropdownMenuLabel>GitHub API使用量</DropdownMenuLabel>
          <div className="px-1.5 pb-1.5">
            <GithubRateLimitList
              data={rateLimits}
              isLoading={rateLimitsLoading}
              error={rateLimitsError}
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
            disabled={isSyncing}
            onSelect={(e) => {
              e.preventDefault();
              setSyncConfirmOpen(true);
            }}
          >
            <RefreshCw className={isSyncing ? "animate-spin" : undefined} />
            {isSyncing ? "再同期中..." : "今すぐ再同期"}
          </DropdownMenuItem>

          {repositories.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>リリース</DropdownMenuLabel>
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
                      <span>{releaseStatus.mainVersion ? `v${releaseStatus.mainVersion}` : "-"}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">develop</span>
                      <span>
                        {releaseStatus.developVersion ? `v${releaseStatus.developVersion}` : "-"}
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
                        handleTriggerRelease();
                      }}
                    >
                      <Rocket className={isTriggeringRelease ? "animate-pulse" : undefined} />
                      {isTriggeringRelease ? "起動中..." : "リリースworkflowを起動"}
                    </Button>
                  </div>
                )}
              </div>
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

      <AlertDialog open={syncConfirmOpen} onOpenChange={setSyncConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>今すぐ再同期しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              GitHub上の最新のIssue情報を取得し直します。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction onClick={handleSync}>再同期する</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </header>
  );
}
