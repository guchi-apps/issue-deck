"use client";

import { useEffect, useMemo, useState } from "react";

import { CrossRepoQuestionDialog } from "@/components/dashboard/cross-repo-question-dialog";
import { BranchFlowView } from "@/components/dashboard/branch-flow-view";
import {
  CheckUserToastViewport,
  type CheckUserToastItem,
} from "@/components/dashboard/check-user-toast-viewport";
import { CreateIssueDialog } from "@/components/dashboard/create-issue-dialog";
import type { AppSettingsValues } from "@/components/dashboard/settings/execution-settings-section";
import { SettingsDialog } from "@/components/dashboard/settings/settings-dialog";
import { EditIssueDialog } from "@/components/dashboard/edit-issue-dialog";
import { GithubReferenceNavigationProvider } from "@/components/dashboard/github-reference-navigation";
import { IssueDetail } from "@/components/dashboard/issue-detail";
import { IssueList } from "@/components/dashboard/issue-list";
import { MergePendingPullRequests } from "@/components/dashboard/merge-pending-pull-requests";
import { NotificationProvider } from "@/components/dashboard/notification-state";
import { IssuePropertiesPanel } from "@/components/dashboard/issue-properties-panel";
import {
  MobileBottomNav,
  type MobileBottomNavTab,
} from "@/components/dashboard/mobile-bottom-nav";
import { MobileFlowScreen } from "@/components/dashboard/mobile/mobile-flow-screen";
import { MobileHomeScreen } from "@/components/dashboard/mobile/mobile-home-screen";
import { MobileIssueDetail } from "@/components/dashboard/mobile/mobile-issue-detail";
import { MobileIssuesScreen } from "@/components/dashboard/mobile/mobile-issues-screen";
import { MobileRepoIssuesScreen } from "@/components/dashboard/mobile/mobile-repo-issues-screen";
import { MobileReposScreen } from "@/components/dashboard/mobile/mobile-repos-screen";
import { MobilePullRequestDetailScreen } from "@/components/dashboard/mobile/mobile-pull-request-detail-screen";
import { MobilePullRequestsScreen } from "@/components/dashboard/mobile/mobile-pull-requests-screen";
import { MobileSettingsScreen } from "@/components/dashboard/mobile/mobile-settings-screen";
import { PullRequestDetail } from "@/components/dashboard/pull-request-detail";
import { PullRequestList } from "@/components/dashboard/pull-request-list";
import { QuickFilterDialog } from "@/components/dashboard/quick-filter-dialog";
import { ResizeHandle } from "@/components/dashboard/resize-handle";
import { SidebarNav } from "@/components/dashboard/sidebar-nav";
import { TopBar } from "@/components/dashboard/topbar";
import { useBranchFlow } from "@/hooks/use-branch-flow";
import { useDeployStatus } from "@/hooks/use-deploy-status";
import { useGroupByRepo } from "@/hooks/use-group-by-repo";
import { useHistoryNavigation } from "@/hooks/use-history-navigation";
import { useIssueFilters } from "@/hooks/use-issue-filters";
import { useIssuePolling } from "@/hooks/use-issue-polling";
import { useMobileScreen } from "@/hooks/use-mobile-screen";
import { usePullRequests } from "@/hooks/use-pull-requests";
import { usePullRequestDetail } from "@/hooks/use-pull-request-detail";
import { usePersistedState } from "@/hooks/use-persisted-state";
import { useReferenceNavigation } from "@/hooks/use-reference-navigation";
import { useResizableWidth } from "@/hooks/use-resizable-width";
import type { ClaudeModel } from "@/lib/app-settings";
import {
  buildBranchFlow,
  latestReleaseMergedAtByRepository,
  orderRepositoriesBySelection,
} from "@/lib/branch-flow";
import {
  isMergeCheckUser,
  resolveCheckUserToasts,
  type PendingCheckUserToast,
} from "@/lib/check-user-notification";
import { buildPullRequestId, type GithubReference } from "@/lib/github-reference";
import { subscribeIssueCreated } from "@/lib/issue-broadcast";
import { buildFollowupIssueBodyPrefix } from "@/lib/github/followup-issue";
import { buildIssueListScrollKey } from "@/lib/issue-list-scroll";
import type { NotificationTarget } from "@/lib/notifications";
import {
  applyIssueFilters,
  computeFilterLabelSummary,
  computeLabelSummary,
  computeNavCountsForFilters,
  computeOverviewStats,
  detectNewlyCheckUserIssues,
  filterIssuesByView,
  getAssigneeOptions,
  hasIgnoredIssueFilters,
  reconcileIssues,
  resolveFiltersForView,
  sortIssues,
  upsertIssue,
} from "@/lib/issue-stats";
import { resolveBottomNavTab } from "@/lib/mobile-nav-tab";
import { getNavViewLabel } from "@/lib/nav-views";
import { computeManualStepAttention } from "@/lib/manual-step-attention";
import {
  computePullRequestNavCounts,
  filterPullRequestsByView,
  pullRequestsAwaitingUserMerge,
} from "@/lib/pull-request-list";
import type { Issue } from "@/types/issue";
import type { PullRequestSummary } from "@/types/pull-request";
import type { QuickFilter } from "@/types/quick-filter";
import type { ConnectedRepository } from "@/types/repository";
import type { CurrentUser } from "@/types/user";

// 確認待ちトーストが積み上がりすぎないよう、直近分だけ表示する（#852）
const MAX_CHECK_USER_TOASTS = 4;

type IssueDeckShellProps = {
  currentUser: CurrentUser | null;
  repositories: ConnectedRepository[];
  issues: Issue[];
  quickFilters: QuickFilter[];
  autoRetryLimit: number;
  claudeModel: ClaudeModel;
  claudeModelAssist: ClaudeModel;
  dispatchConcurrency: number;
};

export function IssueDeckShell({
  currentUser,
  repositories: initialRepositories,
  issues: initialIssues,
  quickFilters: initialQuickFilters,
  autoRetryLimit: initialAutoRetryLimit,
  claudeModel: initialClaudeModel,
  claudeModelAssist: initialClaudeModelAssist,
  dispatchConcurrency: initialDispatchConcurrency,
}: IssueDeckShellProps) {
  const {
    filters,
    setFilter,
    setFilters,
    selectView,
    selectPullRequestView,
    selectFlowPane,
    selectPullRequest,
    toggleLabel,
    toggleRepo,
  } = useIssueFilters();
  const { openIssue: openIssueUrl, openPullRequest: openPullRequestUrl } =
    useReferenceNavigation();
  const { goBackOrFallback } = useHistoryNavigation();
  const [groupByRepo, setGroupByRepo] = useGroupByRepo(filters.view);
  const [issues, setIssues] = useState<Issue[]>(initialIssues);
  const [repositories, setRepositories] = useState<ConnectedRepository[]>(initialRepositories);
  const [quickFilters, setQuickFilters] = useState<QuickFilter[]>(initialQuickFilters);
  // PC版の選択中Issueは`issue`クエリ（missueと同じ識別子＝String(githubIssueId)）が正で、
  // 表示するIssueはそこからの派生値（#1396）。stateで持つとIssueを開く操作が履歴に載らず、
  // 戻る操作でアプリの外へ出てしまうため移した。ポーリングや編集でissuesが更新されれば
  // ここも自動で追従する。
  // `?issue=<id>`付きで直接開けるのは以前から（#688。無人実行のスクリーンショット撮影
  // scripts/capture-issue-screenshots.shが承認待ち等のIssueをPC版で開くのに使う）。
  const selectedIssue = useMemo<Issue | null>(
    () => (filters.issue ? (issues.find((item) => item.id === filters.issue) ?? null) : null),
    [issues, filters.issue],
  );
  const [quickFilterDialogOpen, setQuickFilterDialogOpen] = useState(false);
  const [autoRetryLimit, setAutoRetryLimit] = useState(initialAutoRetryLimit);
  const [claudeModel, setClaudeModel] = useState<ClaudeModel>(initialClaudeModel);
  const [claudeModelAssist, setClaudeModelAssist] =
    useState<ClaudeModel>(initialClaudeModelAssist);
  const [dispatchConcurrency, setDispatchConcurrency] = useState(initialDispatchConcurrency);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);

  // PC（SettingsDialog）とスマホ（MobileSettingsScreen）のどちらから保存されても
  // 同じstateへ反映する（#1539）
  function handleAppSettingsUpdated(next: AppSettingsValues) {
    setAutoRetryLimit(next.autoRetryLimit);
    setClaudeModel(next.claudeModel);
    setClaudeModelAssist(next.claudeModelAssist);
    setDispatchConcurrency(next.dispatchConcurrency);
  }

  const {
    mobileScreen,
    selectTab,
    selectPullRequests,
    // PC側（useIssueFilters）にも同名の関数があるため別名にする。こちらはスマホのPR画面内の
    // タブ切り替えで、履歴を積まない（#1436）
    selectPullRequestView: selectMobilePullRequestView,
    selectSettings: selectMobileSettings,
    selectRepository,
    selectRepositoryByFullName,
    selectIssue,
    selectQuickView,
    updateListFilters,
    goBack,
  } = useMobileScreen(issues, repositories);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createDialogRepo, setCreateDialogRepo] = useState<string | null>(null);
  const [createDialogBodyPrefix, setCreateDialogBodyPrefix] = useState<string | null>(null);
  const [crossQuestionDialogOpen, setCrossQuestionDialogOpen] = useState(false);
  const [crossQuestionDialogRepo, setCrossQuestionDialogRepo] = useState<string | null>(null);
  const [editingIssue, setEditingIssue] = useState<Issue | null>(null);
  const [checkUserToasts, setCheckUserToasts] = useState<CheckUserToastItem[]>([]);
  // 対応PRのCIが確定するまで出さずに持っておく確認待ち（#1709）。判定は
  // `resolveCheckUserToasts`が行い、ここは検知した順に積むだけ。
  const [pendingCheckUserToasts, setPendingCheckUserToasts] = useState<PendingCheckUserToast[]>(
    [],
  );

  // PC向け4カラムレイアウトの表示調整（#381）。左メニューは手動で開閉でき、
  // サイドバー・Issue一覧・プロパティパネルの3カラムはドラッグで幅を調整できる。
  // いずれもlocalStorageに永続化し、次回アクセス時に復元する。
  const [isSidebarCollapsed, setIsSidebarCollapsed] = usePersistedState(
    "issue-deck:sidebar-collapsed",
    false,
  );
  const sidebarWidth = useResizableWidth({
    storageKey: "issue-deck:sidebar-width",
    defaultWidth: 240,
    minWidth: 180,
    maxWidth: 400,
    handleSide: "right",
  });
  const issueListWidth = useResizableWidth({
    storageKey: "issue-deck:issue-list-width",
    defaultWidth: 384,
    minWidth: 280,
    maxWidth: 600,
    handleSide: "right",
  });
  const pullRequestListWidth = useResizableWidth({
    storageKey: "issue-deck:pull-request-list-width",
    defaultWidth: 420,
    minWidth: 320,
    maxWidth: 640,
    handleSide: "right",
  });
  const propertiesPanelWidth = useResizableWidth({
    storageKey: "issue-deck:properties-panel-width",
    defaultWidth: 288,
    minWidth: 220,
    maxWidth: 480,
    handleSide: "left",
  });

  const currentUserLogin = currentUser?.login ?? null;

  function openCreateDialog(defaultRepositoryFullName?: string | null) {
    setCreateDialogRepo(defaultRepositoryFullName ?? null);
    setCreateDialogBodyPrefix(null);
    setCreateDialogOpen(true);
  }

  // 単一リポジトリへの質問は新規作成ダイアログの「質問」種別に統合済みで、こちらは横断専用
  // （#1641）。回答するのがサブPCの質問セッションで、実行先の選択も要るため入口を分けている
  function openCrossRepoQuestionDialog(repositoryFullName?: string | null) {
    setCrossQuestionDialogRepo(repositoryFullName ?? null);
    setCrossQuestionDialogOpen(true);
  }

  // 既にマージ・クローズ済みのIssueは本文を直接編集できないため、続きの対応が必要な場合は
  // 元Issue番号を本文に記入した状態で新規Issueを作成できるようにする（#169）。
  // 元Issueの情報は入力欄ではなく固定接頭辞として渡し、入力欄は空のまま始める（#1322）。
  function openFollowupIssueDialog(issue: Issue) {
    setCreateDialogRepo(issue.repositoryFullName);
    setCreateDialogBodyPrefix(buildFollowupIssueBodyPrefix(issue));
    setCreateDialogOpen(true);
  }

  function handleIssueCreated(issue: Issue) {
    // 作成直後にポーリングが先に反映済みの場合があり、単純な先頭追加だと
    // 同じIssueが重複表示される（#449）。既存分があれば更新、なければ先頭に追加する。
    setIssues((prev) => upsertIssue(prev, issue));
    // PC・スマホのどちらの現在地も1回のURL更新で詳細画面へ進める（#192・#1396）。
    selectIssue(issue);
  }

  function handleIssueUpdated(issue: Issue) {
    setIssues((prev) => prev.map((item) => (item.id === issue.id ? issue : item)));
  }

  // 別ウィンドウ（`/issues/new`）で作られたIssueを一覧へ加える（#1728）。
  // **選択中のIssueは動かさない**——別ウィンドウで書いているのはこの画面を見ながら書くためで、
  // 作成のたびに見ていた画面が切り替わると目的と逆になる。
  useEffect(() => subscribeIssueCreated((issue) => setIssues((prev) => upsertIssue(prev, issue))), []);

  // 削除したIssueはissuesから消えた時点で選択中Issueの解決に失敗するため、URLは触らない。
  // 触ると、スマホの削除直後の戻る操作（MobileIssueDetailがonBackを続けて呼ぶ）と
  // 遷移が二重になる。
  function handleIssueDeleted(issue: Issue) {
    setIssues((prev) => prev.filter((item) => item.id !== issue.id));
  }

  // PC・スマホどちらで開いていても、現在表示中のIssueを検知して既読化する
  // （URLの`missue`クエリを直接開いた場合＝リロード・共有リンクもmobileScreen経由でカバーされる）
  const displayedIssueId =
    selectedIssue?.id ?? (mobileScreen.kind === "issue-detail" ? mobileScreen.issue.id : null);

  useEffect(() => {
    if (!displayedIssueId) return;
    const issue = issues.find((item) => item.id === displayedIssueId);
    if (!issue || !issue.hasUnreadComments) return;

    let cancelled = false;

    fetch("/api/issues/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId: issue.id, readCommentCount: issue.commentCount }),
    })
      .then((response) => {
        if (!response.ok || cancelled) return;
        setIssues((prev) =>
          prev.map((item) =>
            item.id === issue.id
              ? { ...item, hasUnreadComments: false, readCommentCount: item.commentCount }
              : item,
          ),
        );
      })
      .catch((error) => {
        console.error("[issue-deck-shell] failed to mark issue comments as read", error);
      });

    return () => {
      cancelled = true;
    };
  }, [displayedIssueId, issues]);

  // PR一覧（#1058）。Issue一覧と違いDBキャッシュを持たず都度GitHub APIから取得するが、
  // 左メニューに件数を出すため（#1389）PRペイン（PC）・PR画面（スマホ）を開いていなくても
  // 取得する（マウント時と明示的な更新操作、および「完了したPR」ビューの自動更新のときだけ）。
  // **Issue一覧のポーリングより前に置く。** 確認待ちトーストの保留（#1709）が、検知した時点の
  // 取得時刻と再取得の要求のためにこの結果を読むため。
  const isPullRequestPaneActive =
    filters.pane === "pull-requests" || mobileScreen.kind === "pull-requests";
  // 「ブランチ」画面（#1455）。マージ済みPRとブランチの突き合わせ（削除漏れの検出）に
  // クローズ済みまで要るため、この画面を開いている間はPR一覧の母集団を`all`にする。
  const isFlowPaneActive = filters.pane === "flow" || mobileScreen.kind === "flow";
  // 「完了したPR」を表示している間だけ10秒ごとに取り直す（#1531）。CIが確定してマージ待ちに
  // なったPRが載る画面で、気づくのに更新ボタンを押させないため。他のビューとペイン外を対象外に
  // しているのは、取得1回のコストが「リポジトリ数 + draft以外のopen PR数」だから。
  // 「完了したPR」は左メニューから外した（#1613）が、`prview=completed`のURLは生きており
  // 自動更新もそのまま。既定の「すべてのPR」へ広げるとペインを開いている間ずっと10秒間隔で
  // 叩き続けることになり、GitHub APIのレート制限に触れるため広げていない。
  // 保留中の確認待ちトーストがある間も自動更新する（#1709）。CIが確定したかどうかは
  // PR一覧の`ciState`でしか分からないため、取り直さないと保留を解けない。
  const autoRefreshPullRequests =
    (isPullRequestPaneActive && filters.prview === "completed") ||
    pendingCheckUserToasts.length > 0;
  // 母集団は「ブランチとPRの流れ」を開いている間だけ`all`。PRの状態別ビューはどれも
  // openなPRしか出さなくなったため（#1613）、PRペインでも`open`で足りる。
  const openPullRequests = usePullRequests(
    isFlowPaneActive ? "all" : "open",
    autoRefreshPullRequests,
  );

  useIssuePolling((polledIssues) => {
    const reconciledIssues = reconcileIssues(issues, polledIssues);

    // 画面を開いている間に、新たに00.check-userラベルが付与されたIssueをトーストで知らせる
    // （画面下部にポコッと表示する方式。#852）。初回マウント時の直前状態（initialIssues）
    // との比較にも同じロジックが使えるため、既に付与済みの確認待ちで毎回通知される問題は
    // 特別分岐なしに回避できる。
    //
    // **検知しても即座には出さず、いったん保留の列へ積む**（#1709）。マージを求める確認待ちは
    // 対応PRのCIが確定するまで出さない（判定は`resolveCheckUserToasts`）。積むと同時に
    // PR一覧を取り直すのは、作られたばかりのPRが手元の取得結果にまだ載っていないため。
    const newlyCheckUserIssues = detectNewlyCheckUserIssues(issues, reconciledIssues);
    // 取り直すのはマージ待ちになりうるものが現れたときだけ（1回の取得で「リポジトリ数 +
    // draft以外のopen PR数」ぶんGitHub APIを消費するため）。計画の承認・質問への回答は待たせない。
    if (newlyCheckUserIssues.some(isMergeCheckUser)) openPullRequests.refresh();
    const detectedAt = Date.now();
    const pending = [
      ...pendingCheckUserToasts,
      ...newlyCheckUserIssues.map((issue) => ({
        id: `${issue.id}:${issue.checkUserLabeledAt}`,
        issue,
        pullRequestsFetchedAt: openPullRequests.fetchedAt,
        detectedAt,
      })),
    ].slice(-MAX_CHECK_USER_TOASTS);

    // 保留の振り分けはこのポーリング（10秒ごと）でだけ行う。効果（useEffect）に置くと
    // 効果の中でのsetStateになるため、外から来た変化を受け取るこの場所へまとめている。
    // PR一覧の自動更新もこの間隔なので、CIが確定してから最大でも次の周回には出る。
    if (pending.length > 0) {
      const { ready, held } = resolveCheckUserToasts(pending, {
        issues: reconciledIssues,
        pullRequests: openPullRequests.pullRequests,
        pullRequestsFetchedAt: openPullRequests.fetchedAt,
        now: detectedAt,
      });
      if (ready.length > 0) {
        setCheckUserToasts((prev) =>
          [...prev, ...ready.map(({ id, issue }) => ({ id, issue }))].slice(
            -MAX_CHECK_USER_TOASTS,
          ),
        );
      }
      setPendingCheckUserToasts(held);
    }

    setIssues(reconciledIssues);
  });

  function handleSelectCheckUserToastIssue(issue: Issue) {
    // PC・スマホのどちらの現在地も1回のURL更新で詳細画面へ進める（#192・#1396）。
    selectIssue(issue);
  }

  function handleDismissCheckUserToast(id: string) {
    setCheckUserToasts((prev) => prev.filter((toast) => toast.id !== id));
  }

  // 表示中のビューで実際に適用する絞り込み（#1750）。「ユーザーの確認待ち」「ユーザーの
  // 作業待ち」「質問」はリポジトリ横断で全体を見る場所なので、ここで条件が空へ解決される。
  const viewFilters = useMemo(
    () => resolveFiltersForView(filters, filters.view),
    [filters],
  );

  // TopBarの絞り込み（キーワード・リポジトリ・状態・ラベル・担当者）を適用した集合。
  const viewFilteredIssues = useMemo(
    () => applyIssueFilters(issues, viewFilters),
    [issues, viewFilters],
  );

  const filteredIssues = useMemo(
    () =>
      sortIssues(
        // 「最新リリース」の基準時刻は絞り込み前の全Issueから求める（キーワード検索などで
        // 基準がずれて古いリリース分が現れないようにする）。
        filterIssuesByView(viewFilteredIssues, filters.view, currentUserLogin, issues),
        filters.sort,
        filters.view,
      ),
    [viewFilteredIssues, issues, filters.view, filters.sort, currentUserLogin],
  );

  // 絞り込みを指定しているのに、いま見ているビューでは効かない状態か（#1750）。
  // 黙って無視すると件数が変わらない理由が読めないため、一覧のヘッダーに注記を出す。
  const filtersIgnored = useMemo(
    () => hasIgnoredIssueFilters(filters, filters.view),
    [filters],
  );

  // 左メニューの件数（#1689・#1750）。ビューごとに適用する絞り込みが違うため、
  // 絞り込み前の全Issueと条件を渡して中で解決させる（一覧と同じ関数を通す）。
  const navCounts = useMemo(
    () => computeNavCountsForFilters(issues, filters, currentUserLogin),
    [issues, filters, currentUserLogin],
  );
  // 「ユーザーの確認待ち」に並ぶIssue（#1613）。マージ待ちPRの重複除去に使うため、
  // どのビューを表示していても求める。絞り込みを適用しないビュー（#1750）なので、
  // 母集団は絞り込み前の全Issue。
  const checkUserIssues = useMemo(
    () =>
      filterIssuesByView(
        applyIssueFilters(issues, resolveFiltersForView(filters, "check-user")),
        "check-user",
        currentUserLogin,
        issues,
      ),
    [issues, filters, currentUserLogin],
  );
  // 「ユーザーの作業待ち」の内訳（#1613）。こちらも絞り込みを適用しないビューで、
  // 起点Issueを引くための母集団も絞り込み前の全Issue。
  const manualStepAttention = useMemo(
    () =>
      computeManualStepAttention(
        applyIssueFilters(issues, resolveFiltersForView(filters, "manual-step")),
        issues,
      ),
    [issues, filters],
  );
  // スマホの絞り込みシートに出すラベルの選択肢。スマホはPC側の絞り込み（filters）とは別の
  // クエリ（mview/mlabels等）で動くため、絞り込み前の全Issueから求める。
  const labelSummary = useMemo(() => computeLabelSummary(issues), [issues]);
  // 左メニュー「ラベル」に出す一覧と件数（#1441）。TopBarの絞り込みに追随させる。
  const sidebarLabelSummary = useMemo(
    () => computeFilterLabelSummary(issues, filters, labelSummary),
    [issues, filters, labelSummary],
  );
  const assigneeOptions = useMemo(() => getAssigneeOptions(issues), [issues]);

  // PC版Issue一覧のスクロール位置を保存・復元する単位（#773）。絞り込み条件が変われば
  // 別の一覧として扱い、先頭から表示する。
  const issueListScrollKey = useMemo(
    () =>
      buildIssueListScrollKey([
        "pc",
        filters.view,
        filters.q,
        filters.repos.join(","),
        filters.state,
        filters.labels.join(","),
        filters.assignee,
        filters.sort,
      ]),
    [filters],
  );

  // Issue作成ダイアログのリポジトリ選択肢は、サイドメニューで非表示にしたリポジトリを
  // 除いたもの（メニューに表示中のリポジトリ一覧）に揃える（#367）。
  const visibleRepositories = useMemo(
    () => repositories.filter((repo) => !repo.hidden),
    [repositories],
  );

  // マージ直後はGitHub側の反映を待たずに一覧から消したいので、ローカルで伏せる。ただし伏せるのは
  // 「伏せた時点の取得結果」に対してだけで、再取得（fetchedAtの更新）後は取得できた内容を正とする
  // （マージできていなければまた一覧に現れる）。
  const [mergedPullRequests, setMergedPullRequests] = useState<{
    ids: string[];
    fetchedAt: string | null;
  }>({ ids: [], fetchedAt: null });
  const hiddenPullRequestIds = useMemo(
    () =>
      mergedPullRequests.fetchedAt === openPullRequests.fetchedAt ? mergedPullRequests.ids : [],
    [mergedPullRequests, openPullRequests.fetchedAt],
  );

  // マージ済みで伏せたPRを除き、左メニューでリポジトリを絞り込んでいるときはPR一覧も同じ
  // 絞り込みに従わせた集合。状態別ビュー（#1312）を掛ける前のこれを、一覧と左メニューの件数
  // （#1389）の共通の母集団にする。Issue側のnavCountsと同じで、ここを揃えておかないと
  // メニューの件数と一覧に並ぶ件数が食い違う。
  const visiblePullRequests = useMemo(() => {
    const visible = openPullRequests.pullRequests.filter(
      (pullRequest) => !hiddenPullRequestIds.includes(pullRequest.id),
    );
    return filters.repos.length === 0
      ? visible
      : visible.filter((pullRequest) => filters.repos.includes(pullRequest.repositoryFullName));
  }, [openPullRequests.pullRequests, filters.repos, hiddenPullRequestIds]);

  // リポジトリ横断で見る場所へ渡す母集団。**TopBarのリポジトリ絞り込みには従わせない。**
  // 渡す先はヘッダーの通知ベル（#1614）・「ユーザーの確認待ち」に並ぶマージ待ちPR・
  // ブランチ画面（#1750）の3つで、どれもリポジトリ横断で「いま人が動かないと止まるもの」を
  // 見る場所。Issue側（絞り込みを適用しないビュー）と揃えないと、絞り込んだ瞬間にPRだけ消えて
  // 件数の意味が変わる。伏せたPR（マージ済みで消したもの）だけは除く。
  const crossRepositoryPullRequests = useMemo(
    () =>
      openPullRequests.pullRequests.filter(
        (pullRequest) => !hiddenPullRequestIds.includes(pullRequest.id),
      ),
    [openPullRequests.pullRequests, hiddenPullRequestIds],
  );

  const filteredPullRequests = useMemo(
    () => filterPullRequestsByView(visiblePullRequests, filters.prview),
    [visiblePullRequests, filters.prview],
  );

  // 左メニュー「Pull Request」セクションの件数（#1389）。取得前に0を出さないよう、
  // 1度でも取得できたか（fetchedAt）を渡す。
  const pullRequestNavCounts = useMemo(
    () => computePullRequestNavCounts(visiblePullRequests, openPullRequests.fetchedAt !== null),
    [visiblePullRequests, openPullRequests.fetchedAt],
  );

  // 「ユーザーの確認待ち」へ一緒に出すマージ待ちPR（#1613）。対応Issueが同じ一覧に並ぶものは
  // 二重に出さないため、確認待ちのIssue一覧を渡して除く。**リポジトリ絞り込みは掛けない**
  // （#1750）——並ぶ先が絞り込みを適用しないビューなので、掛けると同じ一覧の中でIssueだけ
  // 全体・PRだけ絞られた状態になる。
  const mergePendingPullRequests = useMemo(
    () => pullRequestsAwaitingUserMerge(crossRepositoryPullRequests, checkUserIssues),
    [crossRepositoryPullRequests, checkUserIssues],
  );

  // スマホのホーム画面の先頭に出す3枚（#1690）。件数は数え直さず`navCounts`から引くので、
  // すぐ下に並ぶメニューの行と必ず同じ数字になる。
  const overviewStats = useMemo(
    () => computeOverviewStats(navCounts, mergePendingPullRequests.length),
    [navCounts, mergePendingPullRequests.length],
  );

  // ブランチ画面のリリースの束が組み立てられる状態か（#1711）。**要求した`scope`ではなく、
  // 手元にある取得結果の母集団で判断する。** ブランチ画面を開いた直後は`open`のときの結果が
  // 残っており、そこにはマージ済みのPRが1件も無いため、揃ったものとして描くと直前に本番へ
  // 出した版ごと画面から消える。
  const mergedPullRequestsLoaded = openPullRequests.loadedScope === "all";

  // ブランチ状況（#1455）。取得はこの画面を開いている間だけで、自動ポーリングは持たない。
  const branchFlowStatus = useBranchFlow(isFlowPaneActive);

  // 本番デプロイ状況（#1579）。**デプロイが動いている間だけ**30秒ごとに取り直す。
  // まだ本番へ出ていないかの判定には直近のリリースのマージ時刻が要るので、PR一覧から
  // その1点だけを渡す（フック側が自分でポーリングの要否を決める）。
  // 母集団はブランチ画面と揃える（#1750）。全リポジトリを出す画面なのにデプロイ状況だけ
  // 絞られると、行によって出たり出なかったりする。
  const latestReleaseMergedAt = useMemo(
    () => latestReleaseMergedAtByRepository(crossRepositoryPullRequests),
    [crossRepositoryPullRequests],
  );
  const deployStatus = useDeployStatus(isFlowPaneActive, latestReleaseMergedAt);

  // Issue・ブランチ・PRを1本の流れへ束ねたモデル（#1455）。PRとIssueは既存の取得結果を
  // そのまま使い、新しくGitHubへ問い合わせるのはブランチ状況だけにしている。
  const branchFlow = useMemo(
    () =>
      buildBranchFlow({
        // **リポジトリ絞り込みは適用しない**（#1750）。この画面はリポジトリ横断で流れを俯瞰
        // する場所なので、選択中のリポジトリは絞り込む代わりに先頭へ寄せ、展開して見せる。
        repositories: orderRepositoriesBySelection(
          visibleRepositories.filter((repo) => !repo.archived),
          filters.repos,
        ),
        // マージ直後に伏せたPRだけを除いた集合（リポジトリ絞り込みは掛けない）
        pullRequests: crossRepositoryPullRequests,
        // 本文とラベルは手作業Issue（71.manual-step）の紐づけに使う（#1510）。
        // どちらもDBキャッシュ由来で、渡すのに追加の取得は要らない
        issues: issues.map((issue) => ({
          ...issue,
          labels: issue.labels.map((label) => label.name),
        })),
        branchStatuses: branchFlowStatus.branchStatuses,
        deployStatuses: deployStatus.deployStatuses,
      }),
    [
      visibleRepositories,
      filters.repos,
      crossRepositoryPullRequests,
      issues,
      branchFlowStatus.branchStatuses,
      deployStatus.deployStatuses,
    ],
  );

  const pullRequestDetail = usePullRequestDetail(filters.pr);

  // 詳細を開いているPR（#1087）。一覧に載っていれば一覧の項目を使い（CI状態まで揃っていて
  // 即座に描ける）、載っていない場合は詳細APIが返す`summary`で補う。後者は画面内のリンクから
  // マージ済み・クローズ済みのPRを開いた場合の経路（#1260）。
  //
  // **両方あるときは取得が新しい方を採る**（#1578）。一覧は「完了したPR」ビューを見ている間しか
  // 自動更新されず、詳細ヘッダーの更新ボタンは詳細しか取り直さない。一覧を無条件に優先すると、
  // 更新を押してCIが通ったことを取り直しても、一覧を開いた時点の「CI失敗」が出たまま消えなかった。
  const selectedPullRequest = useMemo(() => {
    if (!filters.pr) return null;
    const fromList = filteredPullRequests.find((pullRequest) => pullRequest.id === filters.pr);
    // 取得中・別のPRへ切り替えた直後に前のPRのヘッダーが残らないよう、idの一致を確認する。
    const detail =
      pullRequestDetail.detail?.id === filters.pr ? pullRequestDetail.detail : null;
    if (!detail) return fromList ?? null;
    if (!fromList) return detail.summary;
    return openPullRequests.fetchedAt && openPullRequests.fetchedAt > detail.fetchedAt
      ? fromList
      : detail.summary;
  }, [filteredPullRequests, filters.pr, openPullRequests.fetchedAt, pullRequestDetail.detail]);

  function handlePullRequestMerged(pullRequest: PullRequestSummary) {
    setMergedPullRequests((prev) => ({
      ids:
        prev.fetchedAt === openPullRequests.fetchedAt
          ? [...prev.ids, pullRequest.id]
          : [pullRequest.id],
      fetchedAt: openPullRequests.fetchedAt,
    }));
    // マージしたPRの詳細は用済みなので閉じて一覧へ戻す（スマホでは一覧画面へ戻る）。
    if (filters.pr === pullRequest.id) selectPullRequest(null);
    openPullRequests.refresh();
  }

  /**
   * 画面内のIssue・PRリンクをIssueDeckの中で開く（#1260）。
   *
   * GitHubは`/issues/<番号>`でPRも開けるため（Issueとの番号空間が共通）、`kind`が`issue`でも
   * 実際はPRのことがある。まずDBキャッシュのIssueから探し、見つからない場合はPRとして
   * 開き直す。連携していないリポジトリなど本当に開けない参照は、PR詳細がエラーを出す。
   */
  function openReference(reference: GithubReference) {
    if (reference.kind === "issue") {
      const issue = issues.find(
        (item) =>
          item.repositoryFullName === reference.repositoryFullName &&
          item.number === reference.number,
      );
      if (issue) {
        openIssueUrl(issue.id);
        return;
      }
    }
    openPullRequestUrl(buildPullRequestId(reference.repositoryFullName, reference.number));
  }

  /** ヘッダーの通知ベル（#1614）の項目を押したときの遷移 */
  function openNotificationTarget(target: NotificationTarget) {
    if (target.kind === "issue") {
      openIssueUrl(target.issueId);
      return;
    }
    if (target.kind === "pull-request") {
      openPullRequestUrl(target.pullRequestId);
      return;
    }
    selectFlowPane();
  }

  async function handleSetRepositoryHidden(repository: ConnectedRepository, hidden: boolean) {
    setRepositories((prev) =>
      prev.map((repo) => (repo.id === repository.id ? { ...repo, hidden } : repo)),
    );

    try {
      const response = await fetch("/api/repositories/hidden", {
        method: hidden ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repositoryId: repository.id }),
      });
      if (!response.ok) throw new Error("failed to update hidden repository");
    } catch (error) {
      console.error("[issue-deck-shell] failed to update hidden repository", error);
      setRepositories((prev) =>
        prev.map((repo) => (repo.id === repository.id ? { ...repo, hidden: !hidden } : repo)),
      );
    }
  }

  /**
   * 設定の「表示」区分の「すべて表示」「すべて非表示」（#1552）。
   *
   * 1件ずつのトグルを人数分投げると連携数ぶんのリクエストになるため、一括専用の`PUT`へ
   * まとめる。渡ってくるのは`selectRepositoriesToToggle`が絞った**実際に変わる行だけ**。
   */
  async function handleSetRepositoriesHidden(targets: ConnectedRepository[], hidden: boolean) {
    if (targets.length === 0) return;
    const targetIds = targets.map((repository) => repository.id);

    setRepositories((prev) =>
      prev.map((repo) => (targetIds.includes(repo.id) ? { ...repo, hidden } : repo)),
    );

    try {
      const response = await fetch("/api/repositories/hidden", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repositoryIds: targetIds, hidden }),
      });
      if (!response.ok) throw new Error("failed to update hidden repositories");
    } catch (error) {
      console.error("[issue-deck-shell] failed to update hidden repositories", error);
      setRepositories((prev) =>
        prev.map((repo) => (targetIds.includes(repo.id) ? { ...repo, hidden: !hidden } : repo)),
      );
    }
  }

  async function handleSetRepositoryFavorite(repository: ConnectedRepository, favorite: boolean) {
    setRepositories((prev) =>
      prev.map((repo) => (repo.id === repository.id ? { ...repo, favorite } : repo)),
    );

    try {
      const response = await fetch("/api/repositories/favorites", {
        method: favorite ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repositoryId: repository.id }),
      });
      if (!response.ok) throw new Error("failed to update favorite repository");
    } catch (error) {
      console.error("[issue-deck-shell] failed to update favorite repository", error);
      setRepositories((prev) =>
        prev.map((repo) => (repo.id === repository.id ? { ...repo, favorite: !favorite } : repo)),
      );
    }
  }

  async function handleSetIssueFavorite(issue: Issue, favorite: boolean) {
    function applyFavorite(target: boolean) {
      setIssues((prev) =>
        prev.map((item) => (item.id === issue.id ? { ...item, favorite: target } : item)),
      );
    }

    applyFavorite(favorite);

    try {
      const response = await fetch("/api/issues/favorites", {
        method: favorite ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueId: issue.id }),
      });
      if (!response.ok) throw new Error("failed to update favorite issue");
    } catch (error) {
      console.error("[issue-deck-shell] failed to update favorite issue", error);
      applyFavorite(!favorite);
    }
  }

  // 保存したフィルター（左メニュー）を適用する。スマホのホーム画面からも呼んでいたが、
  // ホームから節ごと外したためPCだけの経路になった（#1690）。
  function handleSelectQuickFilter(quickFilter: QuickFilter) {
    setFilters({
      view: quickFilter.view,
      q: quickFilter.q,
      repos: quickFilter.repos,
      state: quickFilter.state,
      labels: quickFilter.labels,
      assignee: quickFilter.assignee,
      sort: quickFilter.sort,
      // 保存したフィルターはIssueの絞り込み条件なので、PRペインを開いていればIssueへ戻す。
      pane: "issues",
      // 一覧の中身が入れ替わるので選択中Issueも畳む（1回のURL更新にまとめる）。
      issue: null,
    });
  }

  async function handleDeleteQuickFilter(quickFilter: QuickFilter) {
    setQuickFilters((prev) => prev.filter((item) => item.id !== quickFilter.id));

    try {
      const response = await fetch(`/api/quick-filters/${quickFilter.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("failed to delete quick filter");
    } catch (error) {
      console.error("[issue-deck-shell] failed to delete quick filter", error);
      setQuickFilters((prev) => [...prev, quickFilter]);
    }
  }

  // 設定画面のように、フッターに対応するタブが無い画面ではnullになる（#1638）
  const activeBottomNavTab: MobileBottomNavTab | null = resolveBottomNavTab(mobileScreen);

  return (
    <GithubReferenceNavigationProvider openReference={openReference}>
      {/* 通知ベルの材料（#1772）。PCのトップバーとスマホの各画面のヘッダーが同じものを読む。
          リリース状況の取得を1本に保つため、ここで1回だけ用意して配る */}
      <NotificationProvider
        repositories={repositories}
        issues={issues}
        pullRequests={crossRepositoryPullRequests}
      >
      <div className="flex h-full flex-col">
        <TopBar
          currentUser={currentUser}
          filters={filters}
          setFilter={setFilter}
          groupByRepo={groupByRepo}
          onChangeGroupByRepo={setGroupByRepo}
          assigneeOptions={assigneeOptions}
          onCreateIssue={() =>
            openCreateDialog(filters.repos.length === 1 ? filters.repos[0] : null)
          }
          onAskCrossRepoQuestion={() =>
            openCrossRepoQuestionDialog(filters.repos.length === 1 ? filters.repos[0] : null)
          }
          onOpenNotificationTarget={openNotificationTarget}
          /* 実行キューの行のタイトルからIssue詳細を開く（#1625） */
          onOpenIssue={openIssueUrl}
          onOpenCheckUserView={() => selectView("check-user")}
          onOpenFlow={selectFlowPane}
          isSidebarCollapsed={isSidebarCollapsed}
          onToggleSidebar={() => setIsSidebarCollapsed((prev) => !prev)}
          onOpenSettings={() => setSettingsDialogOpen(true)}
        />

        <div className="flex flex-1 flex-col overflow-hidden md:flex-row">
          {/* スマホ: 画面遷移型（4タブ + ドリルダウン） */}
          <div className="flex flex-1 flex-col overflow-hidden md:hidden">
            <div className="flex-1 overflow-hidden">
              {mobileScreen.kind === "home" && (
                <MobileHomeScreen
                  overviewStats={overviewStats}
                  navCounts={navCounts}
                  checkUserPullRequestCount={mergePendingPullRequests.length}
                  manualStepAttention={manualStepAttention}
                  pullRequestNavCounts={pullRequestNavCounts}
                  onSelectQuickView={selectQuickView}
                  onSelectPullRequests={selectPullRequests}
                  onSelectFlow={() => selectTab("flow")}
                  favoriteRepositories={repositories.filter((repo) => repo.favorite)}
                  onSelectRepository={selectRepository}
                  /* サブPCのカードのセッション行からIssue詳細を開く（#1625） */
                  onOpenIssue={openIssueUrl}
                  onCreateIssue={() => openCreateDialog()}
                  onAskCrossRepoQuestion={() => openCrossRepoQuestionDialog()}
                  onOpenSettings={selectMobileSettings}
                />
              )}

              {mobileScreen.kind === "flow" && (
                <MobileFlowScreen
                  flow={branchFlow}
                  fetchedAt={branchFlowStatus.fetchedAt}
                  isLoading={branchFlowStatus.isLoading || openPullRequests.isLoading}
                  error={branchFlowStatus.error ?? openPullRequests.error}
                  failedRepositories={branchFlowStatus.failedRepositories}
                  mergedPullRequestsLoaded={mergedPullRequestsLoaded}
                  onRefresh={() => {
                    branchFlowStatus.refresh();
                    openPullRequests.refresh();
                    deployStatus.refresh();
                  }}
                />
              )}

              {mobileScreen.kind === "pull-requests" &&
                // PRを選んでいる間は同じ画面枠をPR詳細に差し替える。PR一覧はスマホの
                // ボトムナビにタブを持たないドリルダウン画面のため、一覧→詳細も
                // mscreenを増やさず選択状態（prクエリ）だけで切り替える（#1087）。
                // 判定に使うのは選択中PRそのものではなくprクエリ。一覧に無いPRを
                // リンクから開いた場合、summaryが届くまで一覧へ戻ってしまうため（#1260）。
                (filters.pr ? (
                  <MobilePullRequestDetailScreen
                    pullRequest={selectedPullRequest}
                    detail={pullRequestDetail.detail}
                    isLoading={pullRequestDetail.isLoading}
                    error={pullRequestDetail.error}
                    onRefresh={pullRequestDetail.refresh}
                    onMerged={() =>
                      selectedPullRequest && handlePullRequestMerged(selectedPullRequest)
                    }
                    // 積んだ履歴があれば巻き戻す。無ければPRの選択を解除して一覧へ戻す（#1396）。
                    onBack={() => goBackOrFallback(() => selectPullRequest(null))}
                  />
                ) : (
                  <MobilePullRequestsScreen
                    view={filters.prview}
                    navCounts={pullRequestNavCounts}
                    origin={mobileScreen.origin}
                    onChangeView={selectMobilePullRequestView}
                    pullRequests={filteredPullRequests}
                    failedRepositories={openPullRequests.failedRepositories}
                    fetchedAt={openPullRequests.fetchedAt}
                    isLoading={openPullRequests.isLoading}
                    error={openPullRequests.error}
                    onRefresh={openPullRequests.refresh}
                    onBack={goBack}
                    onSelectPullRequest={(pullRequest) => selectPullRequest(pullRequest.id)}
                    onMerged={handlePullRequestMerged}
                  />
                ))}

              {mobileScreen.kind === "issues" && (
                <MobileIssuesScreen
                  issues={issues}
                  currentUserLogin={currentUserLogin}
                  labelSummary={labelSummary}
                  assigneeOptions={assigneeOptions}
                  selectedIssueId={mobileScreen.returnToIssueId}
                  view={mobileScreen.view}
                  labels={mobileScreen.labels}
                  state={mobileScreen.state}
                  assignee={mobileScreen.assignee}
                  sort={mobileScreen.sort}
                  /* ホーム画面の「要対応」が数に含めているのと同じ配列を渡す（#1713）。
                     数だけ足して中身を出さないと、押して開いた一覧が空に見える */
                  mergePendingPullRequests={mergePendingPullRequests}
                  onSelectPullRequest={(pullRequest) => openPullRequestUrl(pullRequest.id)}
                  onChangeView={(view) => updateListFilters({ view })}
                  onChangeFilters={(filters) => updateListFilters(filters)}
                  onSelectIssue={selectIssue}
                  onCreateIssue={() => openCreateDialog()}
                  onAskCrossRepoQuestion={() => openCrossRepoQuestionDialog()}
                  onBack={mobileScreen.origin === "home" ? goBack : undefined}
                />
              )}

              {mobileScreen.kind === "repos" && (
                <MobileReposScreen
                  repositories={repositories}
                  onSelectRepository={selectRepository}
                  onSetRepositoryFavorite={handleSetRepositoryFavorite}
                />
              )}

              {mobileScreen.kind === "settings" && (
                <MobileSettingsScreen
                  onBack={goBack}
                  currentUser={currentUser}
                  autoRetryLimit={autoRetryLimit}
                  claudeModel={claudeModel}
                  claudeModelAssist={claudeModelAssist}
                  dispatchConcurrency={dispatchConcurrency}
                  repositories={repositories}
                  onSetRepositoryHidden={handleSetRepositoryHidden}
                  onSetRepositoriesHidden={handleSetRepositoriesHidden}
                  onUpdated={handleAppSettingsUpdated}
                />
              )}

              {mobileScreen.kind === "repo-detail" && (
                <MobileRepoIssuesScreen
                  repository={mobileScreen.repository}
                  issues={issues}
                  currentUserLogin={currentUserLogin}
                  selectedIssueId={mobileScreen.returnToIssueId}
                  view={mobileScreen.view}
                  labels={mobileScreen.labels}
                  state={mobileScreen.state}
                  assignee={mobileScreen.assignee}
                  sort={mobileScreen.sort}
                  onChangeView={(view) => updateListFilters({ view })}
                  onChangeFilters={(filters) => updateListFilters(filters)}
                  onSelectIssue={selectIssue}
                  onBack={goBack}
                  onCreateIssue={() => openCreateDialog(mobileScreen.repository.fullName)}
                  onAskCrossRepoQuestion={() =>
                    openCrossRepoQuestionDialog(mobileScreen.repository.fullName)
                  }
                />
              )}

              {mobileScreen.kind === "issue-detail" && (
                <MobileIssueDetail
                  issue={mobileScreen.issue}
                  issues={issues}
                  repositories={visibleRepositories}
                  currentUserLogin={currentUserLogin}
                  onBack={goBack}
                  onEdit={setEditingIssue}
                  onIssueUpdated={handleIssueUpdated}
                  onIssueDeleted={handleIssueDeleted}
                  onToggleFavorite={(issue) => handleSetIssueFavorite(issue, !issue.favorite)}
                  onCreateIssue={(repositoryFullName) => openCreateDialog(repositoryFullName)}
                  onCreateFollowupIssue={openFollowupIssueDialog}
                  onSelectRepository={selectRepositoryByFullName}
                />
              )}
            </div>

            <MobileBottomNav active={activeBottomNavTab} onSelect={selectTab} />
          </div>

          {/* PC: 左カラム（ナビゲーション）。手動で開閉・幅調整ができる（#381） */}
          {!isSidebarCollapsed && (
            <>
              <SidebarNav
                activeView={filters.view}
                onSelectView={selectView}
                activePane={filters.pane}
                activePullRequestView={filters.prview}
                onSelectPullRequestView={selectPullRequestView}
                onSelectFlow={selectFlowPane}
                navCounts={navCounts}
                checkUserPullRequestCount={mergePendingPullRequests.length}
                manualStepAttention={manualStepAttention}
                pullRequestNavCounts={pullRequestNavCounts}
                repositories={repositories}
                selectedRepoFullNames={filters.repos}
                onSelectRepository={(repo) => toggleRepo(repo.fullName)}
                onClearRepository={() => setFilter("repos", [])}
                onHideRepository={(repo) => handleSetRepositoryHidden(repo, true)}
                onShowRepository={(repo) => handleSetRepositoryHidden(repo, false)}
                onSetRepositoryFavorite={handleSetRepositoryFavorite}
                labelSummary={sidebarLabelSummary}
                selectedLabels={filters.labels}
                onSelectLabel={(label) => toggleLabel(label.name)}
                onClearLabels={() => setFilter("labels", [])}
                quickFilters={quickFilters}
                onSelectQuickFilter={handleSelectQuickFilter}
                onDeleteQuickFilter={handleDeleteQuickFilter}
                onSaveQuickFilter={() => setQuickFilterDialogOpen(true)}
                className="hidden shrink-0 border-r md:flex"
                style={{ width: sidebarWidth.width, maxWidth: "50vw" }}
              />
              <ResizeHandle onDragStart={sidebarWidth.handleDragStart} className="hidden md:block" />
            </>
          )}

          {filters.pane === "flow" ? (
            /* PC: ブランチ（#1455）。一覧と詳細に分かれないため、中央〜右を
               1カラムで使う。IssueやPRを選ぶとそれぞれのペインへ遷移する */
            <BranchFlowView
              flow={branchFlow}
              fetchedAt={branchFlowStatus.fetchedAt}
              isLoading={branchFlowStatus.isLoading || openPullRequests.isLoading}
              error={branchFlowStatus.error ?? openPullRequests.error}
              failedRepositories={branchFlowStatus.failedRepositories}
              mergedPullRequestsLoaded={mergedPullRequestsLoaded}
              /* 絞り込みでは無く「展開して見せる」形にする（#1750） */
              expandedRepositoryFullNames={filters.repos}
              onRefresh={() => {
                branchFlowStatus.refresh();
                openPullRequests.refresh();
                deployStatus.refresh();
              }}
              className="hidden flex-1 md:flex"
            />
          ) : filters.pane === "pull-requests" ? (
            /* PC: PR一覧（中央）とPR詳細（右）。Issue一覧・詳細と同じ2カラム構成に
               揃えている（#1058・#1087） */
            <>
              <PullRequestList
                view={filters.prview}
                pullRequests={filteredPullRequests}
                failedRepositories={openPullRequests.failedRepositories}
                fetchedAt={openPullRequests.fetchedAt}
                isLoading={openPullRequests.isLoading}
                error={openPullRequests.error}
                onRefresh={openPullRequests.refresh}
                selectedPullRequestId={filters.pr}
                onSelectPullRequest={(pullRequest) => selectPullRequest(pullRequest.id)}
                onMerged={handlePullRequestMerged}
                className="hidden shrink-0 border-r md:flex"
                style={{ width: pullRequestListWidth.width, maxWidth: "50vw" }}
              />
              <ResizeHandle
                onDragStart={pullRequestListWidth.handleDragStart}
                className="hidden md:block"
              />
              <PullRequestDetail
                pullRequest={selectedPullRequest}
                detail={pullRequestDetail.detail}
                isLoading={pullRequestDetail.isLoading}
                error={pullRequestDetail.error}
                onRefresh={pullRequestDetail.refresh}
                onMerged={() =>
                  selectedPullRequest && handlePullRequestMerged(selectedPullRequest)
                }
                className="hidden flex-1 md:flex"
              />
            </>
          ) : (
            <>
              {/* PC: 中央カラム（Issue一覧）。幅は手動で調整できる（#381） */}
              <IssueList
                title={getNavViewLabel(filters.view)}
                issues={filteredIssues}
                selectedIssueId={selectedIssue?.id ?? null}
                // Issueを開く操作も履歴に積み、戻る操作で1つ前のIssue・画面へ戻れるように
                // する（#1396）。PC・スマホ両方の現在地を1回のURL更新で進める（#1260）。
                onSelectIssue={(issue) => openIssueUrl(issue.id)}
                showSearch={false}
                scrollKey={issueListScrollKey}
                groupByRepo={groupByRepo}
                view={filters.view}
                // ユーザーがマージするしかないPRは、確認待ちの一覧の先頭に出す（#1613）
                pinnedSection={
                  filters.view === "check-user" ? (
                    <MergePendingPullRequests
                      pullRequests={mergePendingPullRequests}
                      onSelectPullRequest={(pullRequest) => openPullRequestUrl(pullRequest.id)}
                    />
                  ) : undefined
                }
                // 一覧のヘッダーの件数も左メニューと同じ数え方にする（#1713）
                pinnedCount={
                  filters.view === "check-user" ? mergePendingPullRequests.length : 0
                }
                // 絞り込みを指定していても効かないビューであることを件数の隣に出す（#1750）
                filtersIgnored={filtersIgnored}
                className="hidden shrink-0 border-r md:flex"
                style={{ width: issueListWidth.width, maxWidth: "50vw" }}
              />
              <ResizeHandle onDragStart={issueListWidth.handleDragStart} className="hidden md:block" />

              {/* PC: 右カラム（Issue詳細 + プロパティパネル） */}
              <div className="hidden flex-1 overflow-hidden md:flex">
                <IssueDetail
                  issue={selectedIssue}
                  issues={issues}
                  repositories={visibleRepositories}
                  currentUserLogin={currentUserLogin}
                  onEdit={setEditingIssue}
                  onIssueUpdated={handleIssueUpdated}
                  onIssueDeleted={handleIssueDeleted}
                  onToggleFavorite={(issue) => handleSetIssueFavorite(issue, !issue.favorite)}
                  onCreateFollowupIssue={openFollowupIssueDialog}
                  onSelectRepository={(repositoryFullName) =>
                    setFilters({ repos: [repositoryFullName] })
                  }
                />
              </div>
              {selectedIssue && (
                <>
                  <ResizeHandle
                    onDragStart={propertiesPanelWidth.handleDragStart}
                    className="hidden xl:block"
                  />
                  <div
                    className="hidden shrink-0 border-l xl:block"
                    style={{ width: propertiesPanelWidth.width, maxWidth: "50vw" }}
                  >
                    <IssuePropertiesPanel
                      issue={selectedIssue}
                      repositories={visibleRepositories}
                      onIssueUpdated={handleIssueUpdated}
                    />
                  </div>
                </>
              )}
            </>
          )}
        </div>

        <CreateIssueDialog
          open={createDialogOpen}
          onOpenChange={setCreateDialogOpen}
          repositories={visibleRepositories}
          defaultRepositoryFullName={createDialogRepo}
          bodyPrefix={createDialogBodyPrefix}
          issues={issues}
          onCreated={handleIssueCreated}
        />
        <CrossRepoQuestionDialog
          open={crossQuestionDialogOpen}
          onOpenChange={setCrossQuestionDialogOpen}
          repositories={visibleRepositories}
          defaultRepositoryFullName={crossQuestionDialogRepo}
          issues={issues}
          onCreated={handleIssueCreated}
        />
        <QuickFilterDialog
          open={quickFilterDialogOpen}
          onOpenChange={setQuickFilterDialogOpen}
          // 保存対象はIssueの絞り込み条件だけ。表示中のペイン（filters.pane）は絞り込み条件では
          // ないため、QuickFilterには含めない。
          filters={{
            view: filters.view,
            q: filters.q,
            repos: filters.repos,
            state: filters.state,
            labels: filters.labels,
            assignee: filters.assignee,
            sort: filters.sort,
          }}
          onCreated={(quickFilter) => setQuickFilters((prev) => [...prev, quickFilter])}
        />
        <SettingsDialog
          open={settingsDialogOpen}
          onOpenChange={setSettingsDialogOpen}
          currentUser={currentUser}
          autoRetryLimit={autoRetryLimit}
          claudeModel={claudeModel}
          claudeModelAssist={claudeModelAssist}
          dispatchConcurrency={dispatchConcurrency}
          repositories={repositories}
          onSetRepositoryHidden={handleSetRepositoryHidden}
          onSetRepositoriesHidden={handleSetRepositoriesHidden}
          onUpdated={handleAppSettingsUpdated}
        />
        <EditIssueDialog
          open={editingIssue !== null}
          onOpenChange={(open) => {
            if (!open) setEditingIssue(null);
          }}
          issue={editingIssue}
          issues={issues}
          onUpdated={handleIssueUpdated}
        />
        <CheckUserToastViewport
          toasts={checkUserToasts}
          onSelectIssue={handleSelectCheckUserToastIssue}
          onDismiss={handleDismissCheckUserToast}
        />
      </div>
      </NotificationProvider>
    </GithubReferenceNavigationProvider>
  );
}
