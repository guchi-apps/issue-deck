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
  SlidersHorizontal,
} from "lucide-react";

import { AccountMenuDialog } from "@/components/dashboard/account-menu-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { UserAvatar } from "@/components/dashboard/user-avatar";
import type { IssueFilters } from "@/hooks/use-issue-filters";
import type { Issue } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";
import type { CurrentUser } from "@/types/user";

/** フィルターポップオーバー内の選択肢チップ（#944：ヘッダーが崩れないよう状態・担当者・
 * 並び順・表示切り替えを1つの「フィルター」ボタンにまとめた） */
function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button type="button" variant={active ? "default" : "outline"} size="xs" onClick={onClick}>
      {children}
    </Button>
  );
}

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

      <div className="flex flex-1 items-center gap-2">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="text-xs">
              <SlidersHorizontal className="size-3" />
              フィルター
              <ChevronDown className="size-3" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="space-y-4">
            <section>
              <h3 className="mb-1.5 text-xs font-semibold text-muted-foreground">{stateLabel}</h3>
              <div className="flex flex-wrap gap-1.5">
                <FilterChip active={filters.state === "all"} onClick={() => setFilter("state", "all")}>
                  すべて
                </FilterChip>
                <FilterChip active={filters.state === "open"} onClick={() => setFilter("state", "open")}>
                  Open
                </FilterChip>
                <FilterChip active={filters.state === "closed"} onClick={() => setFilter("state", "closed")}>
                  Closed
                </FilterChip>
              </div>
            </section>

            <section>
              <h3 className="mb-1.5 text-xs font-semibold text-muted-foreground">{assigneeLabel}</h3>
              <div className="flex flex-wrap gap-1.5">
                <FilterChip active={filters.assignee === null} onClick={() => setFilter("assignee", null)}>
                  すべて
                </FilterChip>
                <FilterChip
                  active={filters.assignee === "unassigned"}
                  onClick={() => setFilter("assignee", "unassigned")}
                >
                  未設定
                </FilterChip>
                {assigneeOptions.map((login) => (
                  <FilterChip
                    key={login}
                    active={filters.assignee === login}
                    onClick={() => setFilter("assignee", login)}
                  >
                    {login}
                  </FilterChip>
                ))}
              </div>
            </section>

            <section>
              <h3 className="mb-1.5 text-xs font-semibold text-muted-foreground">{sortLabel}</h3>
              {isCheckUserView ? (
                <p className="text-xs text-muted-foreground">
                  確認待ちビューでは確認が古い順に固定されます
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  <FilterChip active={filters.sort === "updated"} onClick={() => setFilter("sort", "updated")}>
                    更新日
                  </FilterChip>
                  <FilterChip active={filters.sort === "created"} onClick={() => setFilter("sort", "created")}>
                    作成日
                  </FilterChip>
                </div>
              )}
            </section>

            <section>
              <h3 className="mb-1.5 text-xs font-semibold text-muted-foreground">表示</h3>
              <FilterChip active={groupByRepo} onClick={() => onChangeGroupByRepo(!groupByRepo)}>
                <FolderTree className="size-3" />
                リポジトリ別
              </FilterChip>
            </section>
          </PopoverContent>
        </Popover>
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
