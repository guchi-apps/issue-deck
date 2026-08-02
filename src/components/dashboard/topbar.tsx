"use client";

import { useState } from "react";
import { ChevronDown, LayoutDashboard, Plus, RefreshCw, Search } from "lucide-react";

import { ProfileDialog } from "@/components/dashboard/profile-dialog";
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
import { Progress } from "@/components/ui/progress";
import { UserAvatar } from "@/components/dashboard/user-avatar";
import { useAccountActions } from "@/hooks/use-account-actions";
import { useGithubRateLimit } from "@/hooks/use-github-rate-limit";
import type { IssueFilters } from "@/hooks/use-issue-filters";
import { useIssueSync } from "@/hooks/use-issue-sync";
import { PRIVACY_POLICY_URL, TERMS_OF_SERVICE_URL } from "@/lib/legal-links";
import type { CurrentUser } from "@/types/user";

type TopBarProps = {
  currentUser: CurrentUser | null;
  filters: IssueFilters;
  setFilter: <K extends keyof IssueFilters>(key: K, value: IssueFilters[K]) => void;
  assigneeOptions: string[];
  onCreateIssue: () => void;
};

export function TopBar({
  currentUser,
  filters,
  setFilter,
  assigneeOptions,
  onCreateIssue,
}: TopBarProps) {
  const { handleLogout } = useAccountActions();
  const { isSyncing, handleSync } = useIssueSync();
  const [profileDialogOpen, setProfileDialogOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const { data: rateLimits, isLoading: rateLimitsLoading, error: rateLimitsError } =
    useGithubRateLimit(accountMenuOpen);

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

      <DropdownMenu open={accountMenuOpen} onOpenChange={setAccountMenuOpen}>
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
            {rateLimitsLoading && (
              <p className="text-xs text-muted-foreground">読み込み中...</p>
            )}
            {rateLimitsError && <p className="text-xs text-destructive">{rateLimitsError}</p>}
            {rateLimits && rateLimits.length === 0 && (
              <p className="text-xs text-muted-foreground">連携中のインストールがありません</p>
            )}
            {rateLimits && rateLimits.length > 0 && (
              <ul className="flex flex-col gap-2">
                {rateLimits.map((rateLimit) => (
                  <li key={rateLimit.accountLogin} className="rounded-lg border p-2">
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span className="font-medium">{rateLimit.accountLogin}</span>
                      <span className="text-muted-foreground">
                        残り {rateLimit.remaining} / {rateLimit.limit}
                      </span>
                    </div>
                    <Progress value={(rateLimit.remaining / rateLimit.limit) * 100} />
                    <p className="mt-1 text-xs text-muted-foreground">
                      リセット:{" "}
                      {new Date(rateLimit.reset * 1000).toLocaleTimeString("ja-JP")}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={isSyncing}
            onSelect={(e) => {
              e.preventDefault();
              handleSync();
            }}
          >
            <RefreshCw className={isSyncing ? "animate-spin" : undefined} />
            {isSyncing ? "再同期中..." : "今すぐ再同期"}
          </DropdownMenuItem>
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
        </DropdownMenuContent>
      </DropdownMenu>

      <ProfileDialog
        currentUser={currentUser}
        open={profileDialogOpen}
        onOpenChange={setProfileDialogOpen}
      />
    </header>
  );
}
