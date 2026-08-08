"use client";

import { useState } from "react";
import {
  ChevronDown,
  FolderTree,
  LayoutDashboard,
  MessageCircleQuestion,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
} from "lucide-react";

import { AccountMenuDialog } from "@/components/dashboard/account-menu-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { UserAvatar } from "@/components/dashboard/user-avatar";
import type { IssueFilters } from "@/hooks/use-issue-filters";
import type { Issue } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";
import type { CurrentUser } from "@/types/user";

type TopBarProps = {
  currentUser: CurrentUser | null;
  filters: IssueFilters;
  setFilter: <K extends keyof IssueFilters>(key: K, value: IssueFilters[K]) => void;
  /** リポジトリごとのグルーピング表示（#849）のON/OFF */
  groupByRepo: boolean;
  onChangeGroupByRepo: (value: boolean) => void;
  assigneeOptions: string[];
  onCreateIssue: () => void;
  onAskQuestion: () => void;
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
  groupByRepo,
  onChangeGroupByRepo,
  assigneeOptions,
  onCreateIssue,
  onAskQuestion,
  selectedRepoFullName,
  repositories,
  issues,
  isSidebarCollapsed,
  onToggleSidebar,
  onOpenAppSettings,
}: TopBarProps) {
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);

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

        <Button
          variant={groupByRepo ? "default" : "outline"}
          size="sm"
          className="text-xs"
          onClick={() => onChangeGroupByRepo(!groupByRepo)}
          title="リポジトリごとに分けて表示"
          aria-pressed={groupByRepo}
        >
          <FolderTree className="size-3" />
          リポジトリ別
        </Button>
      </div>

      <Button variant="outline" size="sm" className="text-xs" onClick={onAskQuestion}>
        <MessageCircleQuestion />
        質問する
      </Button>

      <Button size="sm" className="text-xs" onClick={onCreateIssue}>
        <Plus />
        新規Issue
      </Button>

      <button
        type="button"
        aria-label="アカウントメニュー"
        className="flex items-center gap-1 rounded-md p-1 hover:bg-accent"
        onClick={() => setAccountMenuOpen(true)}
      >
        <UserAvatar
          login={currentUser?.login ?? "?"}
          image={currentUser?.image}
          className="size-7"
        />
        <ChevronDown className="size-3 text-muted-foreground" />
      </button>

      <AccountMenuDialog
        open={accountMenuOpen}
        onOpenChange={setAccountMenuOpen}
        currentUser={currentUser}
        selectedRepoFullName={selectedRepoFullName}
        repositories={repositories}
        issues={issues}
        onOpenAppSettings={onOpenAppSettings}
      />
    </header>
  );
}
