"use client";

import { useEffect, useState } from "react";
import {
  ArrowLeft,
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

import { DispatchQueueButton } from "@/components/dashboard/dispatch-queue-button";
import { NotificationButton } from "@/components/dashboard/notification-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { UserAvatar } from "@/components/dashboard/user-avatar";
import type { IssueFilters } from "@/hooks/use-issue-filters";
import type { NotificationTarget } from "@/lib/notifications";
import type { Issue } from "@/types/issue";
import type { PullRequestSummary } from "@/types/pull-request";
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
  /** 複数リポジトリ横断の質問（#1454）。単一リポジトリへの質問は新規作成ダイアログ側（#1641） */
  onAskCrossRepoQuestion: () => void;
  repositories: ConnectedRepository[];
  issues: Issue[];
  /** 通知ベル（#1614）に出すマージ待ちPR。画面が既に取得済みの一覧をそのまま使う */
  pullRequests: PullRequestSummary[];
  /** 通知ベルの項目を押したときの遷移 */
  onOpenNotificationTarget: (target: NotificationTarget) => void;
  /** 実行キューの行のタイトルを押したときの遷移（#1625）。通知ベルと同じくIssue詳細を開く */
  onOpenIssue: (issueId: string) => void;
  onOpenCheckUserView: () => void;
  onOpenFlow: () => void;
  isSidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
  /** アプリ内で巻き戻せる履歴があるか（#1771）。無ければ戻るボタンを押せない状態にする */
  canGoBack: boolean;
  /** 1つ前の画面へ戻る（#1771） */
  onBack: () => void;
};

export function TopBar({
  currentUser,
  filters,
  setFilter,
  groupByRepo,
  onChangeGroupByRepo,
  assigneeOptions,
  onCreateIssue,
  onAskCrossRepoQuestion,
  repositories,
  issues,
  pullRequests,
  onOpenNotificationTarget,
  onOpenIssue,
  onOpenCheckUserView,
  onOpenFlow,
  isSidebarCollapsed,
  onToggleSidebar,
  onOpenSettings,
  canGoBack,
  onBack,
}: TopBarProps) {

  // 検索欄はURL（filters.q）に直接バインドすると、1文字入力するたびにrouter.replaceによる
  // ナビゲーションが走り入力が遅く感じられる（#1024）。入力自体はローカルstateで即時反映し、
  // URLへの反映（＝一覧の絞り込み）はデバウンスして行う。
  const [searchInput, setSearchInput] = useState(filters.q);
  // ブラウザバック等、入力以外の経路でfilters.qが変わった場合はローカルstateを
  // 追随させる（レンダー中に比較・更新することでeffectでの同期に伴うカスケード再レンダーを避ける）。
  const [syncedFiltersQ, setSyncedFiltersQ] = useState(filters.q);
  if (filters.q !== syncedFiltersQ) {
    setSyncedFiltersQ(filters.q);
    setSearchInput(filters.q);
  }

  useEffect(() => {
    if (searchInput === filters.q) return;
    const timer = setTimeout(() => {
      setFilter("q", searchInput);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput, filters.q, setFilter]);

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

      {/* 1つ前の画面へ戻る（#1771）。**パソコンでアプリとして起動（PWA）するとブラウザの
          ツールバーごと戻る矢印が消え、戻る操作の手段が画面上に無くなる。** ブラウザの戻る矢印が
          あった位置とほぼ同じ、ウィンドウ左上へ置く。
          戻り先の判断は`useHistoryNavigation`の`goBackOrFallback`に集約してあり（#1396）、
          スマホのヘッダーの戻る・右スワイプと同じものを呼んでいる。
          **巻き戻せないときも隠さず、押せない状態で残す。** 消すとヘッダーの並びが左右にずれ、
          隣の「サイドバーを表示／非表示」を押そうとして位置が変わる。 */}
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0"
        onClick={onBack}
        disabled={!canGoBack}
        title="戻る"
        aria-label="戻る"
      >
        <ArrowLeft className="size-4" />
      </Button>

      {/* ヘッダーが狭いときに「Issue」「Deck」の2行へ折り返されないようにする（#1373） */}
      <div className="flex shrink-0 items-center gap-2 pr-4 text-sm font-semibold whitespace-nowrap">
        <LayoutDashboard className="size-5 text-primary" />
        Issue Deck
      </div>

      <div className="relative w-72">
        <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Issueを検索..."
          title='検索式が使えます（例: label:bug -label:wontfix is:open assignee:octocat）。トークン以外の文字列はタイトル・本文の部分一致になります。'
          className="pl-8"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
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

      {/* 単一リポジトリへの質問は「新規」の中（種別「質問」）へ移した（#1641）。
          ここに残すのは、実行先も参照範囲も別物の横断質問だけ */}
      <Button variant="outline" size="sm" className="text-xs" onClick={onAskCrossRepoQuestion}>
        <MessageCircleQuestion />
        横断質問
      </Button>

      <Button size="sm" className="text-xs" onClick={onCreateIssue}>
        <Plus />
        新規
      </Button>

      {/* サブPCで順に流すようにしたため、キュー全体を見る場所が要る（#1266） */}
      <DispatchQueueButton onOpenIssue={onOpenIssue} />

      {/* リリース専用のロケットボタンを置き換え、ユーザーの操作が必要なものをリポジトリ横断で
          1か所に集める（#1614）。リリースの起動・マージは「ブランチ」画面が持つ */}
      <NotificationButton
        repositories={repositories}
        issues={issues}
        pullRequests={pullRequests}
        onOpenTarget={onOpenNotificationTarget}
        onOpenCheckUserView={onOpenCheckUserView}
        onOpenFlow={onOpenFlow}
      />

      <button
        type="button"
        className="flex items-center gap-1 rounded-md p-1 hover:bg-accent"
        onClick={onOpenSettings}
        title="設定"
      >
        <UserAvatar
          login={currentUser?.login ?? "?"}
          image={currentUser?.image}
          className="size-7"
        />
        <ChevronDown className="size-3 text-muted-foreground" />
      </button>
    </header>
  );
}
