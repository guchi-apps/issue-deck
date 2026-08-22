"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { CodeReviewDialog } from "@/components/dashboard/code-review-dialog";
import { CrossRepoQuestionDialog } from "@/components/dashboard/cross-repo-question-dialog";
import { BranchFlowView } from "@/components/dashboard/branch-flow-view";
import {
  CheckUserToastViewport,
  type CheckUserToastItem,
} from "@/components/dashboard/check-user-toast-viewport";
import { CreateIssueDialog } from "@/components/dashboard/create-issue-dialog";
import { IssueOrderDialog } from "@/components/dashboard/issue-order-dialog";
import { ManualStepGuideDialog } from "@/components/dashboard/manual-step-guide-dialog";
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
import { PullRequestDetailDialog } from "@/components/dashboard/pull-request-detail-dialog";
import { PullRequestList } from "@/components/dashboard/pull-request-list";
import { ResizeHandle } from "@/components/dashboard/resize-handle";
import { SidebarNav } from "@/components/dashboard/sidebar-nav";
import { TopBar, type TopBarAiSearch } from "@/components/dashboard/topbar";
import { useBranchFlow } from "@/hooks/use-branch-flow";
import { useDeployStatus } from "@/hooks/use-deploy-status";
import { useDispatchState } from "@/hooks/use-dispatch-state";
import { useGroupByRepo } from "@/hooks/use-group-by-repo";
import { useCanGoBackInApp, useHistoryNavigation } from "@/hooks/use-history-navigation";
import { useIssueAiSearch } from "@/hooks/use-issue-ai-search";
import { useIssueFilters } from "@/hooks/use-issue-filters";
import { useIssuePolling } from "@/hooks/use-issue-polling";
import { useIssueOrderGuide } from "@/hooks/use-issue-order-guide";
import { useManualStepGuide } from "@/hooks/use-manual-step-guide";
import { useMobileScreen } from "@/hooks/use-mobile-screen";
import { useNow } from "@/hooks/use-now";
import { usePullRequests } from "@/hooks/use-pull-requests";
import { usePullRequestDetail } from "@/hooks/use-pull-request-detail";
import { usePersistedState } from "@/hooks/use-persisted-state";
import { useReferenceNavigation } from "@/hooks/use-reference-navigation";
import { useResizableWidth } from "@/hooks/use-resizable-width";
import type { ClaudeModel } from "@/lib/app-settings";
import {
  PULL_REQUEST_POLL_INTERVAL_MS,
  normalizeAutoRefreshInterval,
  shorterAutoRefreshInterval,
  type AutoRefreshIntervalMs,
} from "@/lib/auto-refresh";
import {
  buildBranchFlow,
  latestReleaseMergedAtByRepository,
  orderRepositoriesBySelection,
} from "@/lib/branch-flow";
import { selectCheckUserRunningIssueIds } from "@/lib/check-user-attention";
import {
  isMergeCheckUser,
  resolveCheckUserToasts,
  type PendingCheckUserToast,
} from "@/lib/check-user-notification";
import { buildPullRequestId, type GithubReference } from "@/lib/github-reference";
import { subscribeIssueCreated } from "@/lib/issue-broadcast";
import { buildFollowupIssueBodyPrefix } from "@/lib/github/followup-issue";
import {
  buildCodeReviewFindingIssueDraft,
  type CodeReviewFinding,
} from "@/lib/github/code-review";
import {
  buildInfraConfigIssueDraft,
  type InfraConfigTarget,
} from "@/lib/infra-config-repos";
import { appendPrerequisiteReference } from "@/lib/manual-step-prerequisites";
import { ISSUE_SEARCH_CANDIDATE_LIMIT } from "@/lib/claude/issue-search";
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
import { extractSearchTokens, parseSearchQuery } from "@/lib/search-query";
import { getNavViewLabel } from "@/lib/nav-views";
import {
  computeIssuePrerequisiteReadiness,
  computeManualStepAttention,
  computeManualStepReadiness,
} from "@/lib/manual-step-attention";
import { countUnconfirmedQuestions } from "@/lib/question-attention";
import {
  applyOptimisticMerges,
  computePullRequestNavCounts,
  filterPullRequestsByView,
  pullRequestsAwaitingUserMerge,
  pullRequestsWaitingForMergeChecks,
  resolvePullRequestHeader,
  type OptimisticMerge,
} from "@/lib/pull-request-list";
import type { Issue } from "@/types/issue";
import type { PullRequestSummary } from "@/types/pull-request";
import type { ConnectedRepository } from "@/types/repository";
import type { CurrentUser } from "@/types/user";

// 確認待ちトーストが積み上がりすぎないよう、直近分だけ表示する（#852）
const MAX_CHECK_USER_TOASTS = 4;

type IssueDeckShellProps = {
  currentUser: CurrentUser | null;
  repositories: ConnectedRepository[];
  issues: Issue[];
  autoRetryLimit: number;
  claudeModel: ClaudeModel;
  claudeModelAssist: ClaudeModel;
  dispatchConcurrency: number;
  /** `issues`をサーバー側で取った時刻（#1797）。一覧のヘッダーの「HH:MM時点」の初期値になる */
  issuesFetchedAt: string;
};

export function IssueDeckShell({
  currentUser,
  repositories: initialRepositories,
  issues: initialIssues,
  issuesFetchedAt,
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
    selectPullRequestModal,
    toggleLabel,
    toggleRepo,
  } = useIssueFilters();
  const { openIssue: openIssueUrl, openPullRequest: openPullRequestUrl } =
    useReferenceNavigation();
  const { goBackOrFallback } = useHistoryNavigation();
  // PC版ヘッダーの戻るボタンが押せるかどうか（#1771）
  const canGoBack = useCanGoBackInApp();
  const [groupByRepo, setGroupByRepo] = useGroupByRepo(filters.view);
  const [issues, setIssues] = useState<Issue[]>(initialIssues);
  const [repositories, setRepositories] = useState<ConnectedRepository[]>(initialRepositories);
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
  /**
   * いま画面に出ているIssue（#1884）。PR・ブランチのペインでは詳細を描かないため、
   * `selectedIssue`が残っていても「開いている画面のIssue」ではない。
   */
  const visibleIssue = filters.pane === "issues" ? selectedIssue : null;
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
    selectAllIssues,
    updateListFilters,
    goBack,
  } = useMobileScreen(issues, repositories);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createDialogRepo, setCreateDialogRepo] = useState<string | null>(null);
  const [createDialogBodyPrefix, setCreateDialogBodyPrefix] = useState<string | null>(null);
  const [createDialogTitle, setCreateDialogTitle] = useState<string | null>(null);
  const [createDialogBody, setCreateDialogBody] = useState<string | null>(null);
  /**
   * 設定変更Issueの切り出し元（#2021）。作成できた時点で、この手作業Issueの`## 前提条件`へ
   * 「作った方が先」と書き足すために覚えておく
   */
  const [configIssueOrigin, setConfigIssueOrigin] = useState<Issue | null>(null);
  const [crossQuestionDialogOpen, setCrossQuestionDialogOpen] = useState(false);
  const [crossQuestionDialogRepo, setCrossQuestionDialogRepo] = useState<string | null>(null);
  const [codeReviewDialogOpen, setCodeReviewDialogOpen] = useState(false);
  const [codeReviewDialogRepo, setCodeReviewDialogRepo] = useState<string | null>(null);
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
    clearConfigIssuePrefill();
    setCreateDialogOpen(true);
  }

  /** 前回の切り出し（#2021）の埋め込みを持ち越さない。他の入口から開くたびに落とす */
  function clearConfigIssuePrefill() {
    setCreateDialogTitle(null);
    setCreateDialogBody(null);
    setConfigIssueOrigin(null);
  }

  /**
   * 手作業の中の実機ファイル変更を、管理リポジトリのIssueとして切り出す（#2021）。
   *
   * **ここでは起票しない。** 対象リポジトリ・タイトル・本文を埋めた新規作成ダイアログを
   * 開くだけで、他リポジトリへ書くかどうかは中身を読んだ人が決める。
   */
  function openConfigChangeIssueDialog(issue: Issue, target: InfraConfigTarget) {
    const draft = buildInfraConfigIssueDraft({
      target,
      originRepositoryFullName: issue.repositoryFullName,
      originNumber: issue.number,
      originTitle: issue.title,
    });
    setCreateDialogRepo(draft.repositoryFullName);
    setCreateDialogTitle(draft.title);
    setCreateDialogBody(draft.body);
    setCreateDialogBodyPrefix(null);
    setConfigIssueOrigin(issue);
    setCreateDialogOpen(true);
  }

  // 単一リポジトリへの質問は新規作成ダイアログの「質問」種別に統合済みで、こちらは横断専用
  // （#1641）。回答するのがサブPCの質問セッションで、実行先の選択も要るため入口を分けている
  function openCrossRepoQuestionDialog(repositoryFullName?: string | null) {
    setCrossQuestionDialogRepo(repositoryFullName ?? null);
    setCrossQuestionDialogOpen(true);
  }

  /** リポジトリ全体のコードレビュー（#698）。対象は選び直せるので、文脈のリポジトリは初期値だけ */
  function openCodeReviewDialog(repositoryFullName?: string | null) {
    setCodeReviewDialogRepo(repositoryFullName ?? null);
    setCodeReviewDialogOpen(true);
  }

  /**
   * レビューの指摘を、対象リポジトリのIssueとして起票する（#698）。
   *
   * **ここでは起票しない**（`openConfigChangeIssueDialog`と同じ立場）。埋めた新規作成
   * ダイアログを開くだけで、立てるかどうかは指摘を読んだ人が決める。
   */
  function openCodeReviewFindingIssueDialog(issue: Issue, finding: CodeReviewFinding) {
    const draft = buildCodeReviewFindingIssueDraft({
      finding,
      repositoryFullName: issue.repositoryFullName,
      reviewNumber: issue.number,
    });
    setCreateDialogRepo(draft.repositoryFullName);
    setCreateDialogTitle(draft.title);
    setCreateDialogBody(draft.body);
    setCreateDialogBodyPrefix(null);
    setConfigIssueOrigin(null);
    setCreateDialogOpen(true);
  }

  // 既にマージ・クローズ済みのIssueは本文を直接編集できないため、続きの対応が必要な場合は
  // 元Issue番号を本文に記入した状態で新規Issueを作成できるようにする（#169）。
  // 元Issueの情報は入力欄ではなく固定接頭辞として渡し、入力欄は空のまま始める（#1322）。
  function openFollowupIssueDialog(issue: Issue) {
    setCreateDialogRepo(issue.repositoryFullName);
    setCreateDialogBodyPrefix(buildFollowupIssueBodyPrefix(issue));
    clearConfigIssuePrefill();
    setCreateDialogOpen(true);
  }

  function handleIssueCreated(issue: Issue) {
    // 作成直後にポーリングが先に反映済みの場合があり、単純な先頭追加だと
    // 同じIssueが重複表示される（#449）。既存分があれば更新、なければ先頭に追加する。
    setIssues((prev) => upsertIssue(prev, issue));
    // 設定変更Issueとして切り出したものは、手作業がそのPRのマージを待つ（#2021）
    if (configIssueOrigin) {
      void linkConfigIssueToManualStep(configIssueOrigin, issue);
      clearConfigIssuePrefill();
    }
    // PC・スマホのどちらの現在地も1回のURL更新で詳細画面へ進める（#192・#1396）。
    selectIssue(issue);
  }

  /**
   * 切り出した設定変更Issueを、手作業Issueの`## 前提条件`へ書き足す（#2021）。
   *
   * **実施順序を表す場所は本文の`## 前提条件`だけ**（docs/multi-agent/labels.md）。ここへ
   * 書いておくと、画面の「実施順序」にも一覧の橙の時計にも出て、PRがマージされるまで
   * 手作業が実行できないことが伝わる。
   *
   * 失敗しても切り出し自体は済んでいるので、握りつぶしてログだけ残す（作成し直させない）。
   */
  async function linkConfigIssueToManualStep(origin: Issue, created: Issue) {
    const reference = `${created.repositoryFullName}#${created.number}`;
    const body = appendPrerequisiteReference(origin.body, reference);
    if (body === origin.body) return;

    try {
      const response = await fetch("/api/issues", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repositoryFullName: origin.repositoryFullName,
          number: origin.number,
          body,
        }),
      });
      if (!response.ok) throw new Error("failed to update manual step prerequisites");
      const data = (await response.json()) as { issue?: Issue };
      if (data.issue) handleIssueUpdated(data.issue);
    } catch (error) {
      console.error("[issue-deck-shell] failed to link config issue", error);
    }
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
  // 取得する（マウント時と明示的な更新操作、およびPR画面を開いている間の自動更新のときだけ）。
  // **Issue一覧のポーリングより前に置く。** 確認待ちトーストの保留（#1709）が、検知した時点の
  // 取得時刻と再取得の要求のためにこの結果を読むため。
  const isPullRequestPaneActive =
    filters.pane === "pull-requests" || mobileScreen.kind === "pull-requests";
  // 「ブランチ」画面（#1455）。マージ済みPRとブランチの突き合わせ（削除漏れの検出）に
  // クローズ済みまで要るため、この画面を開いている間はPR一覧の母集団を`all`にする。
  const isFlowPaneActive = filters.pane === "flow" || mobileScreen.kind === "flow";
  // **PR画面（PCのペイン・スマホの画面）を開いている間は、ビューによらず10秒ごとに取り直す**
  // （#1531・#1947）。元は「マージ待ち」ビューだけだったが、ヘッダーの「更新」ボタンを外した
  // ため、開いている間ずっと新しくなり続けることが一覧の唯一の前提になった（Issue一覧と同じ）。
  //
  // **コストは「消費0」ではない。** 1巡は「リポジトリ数のREST（ETagの条件付きGETを通すので
  // 変化が無い間は304＝消費0）＋ draft以外のopen PRのCI状態（GraphQL。installationごとに
  // まとめて数回で、条件付きGETは効かないため毎回消費するが、PR件数には比例しない。#1962）」で、
  // 10秒間隔でもPR件数の増減に消費が引きずられにくい（上限5,000ポイント/時）。
  // 設定の「GitHub API使用量」（`pull_request_list`）で実際の消費を見られる。
  //
  // 歯止めは従来どおりで、**ペイン・画面を開いている間だけ**・裏に回ったタブでは取りに行かない
  // （`use-auto-refresh.ts`）。
  // 保留中の確認待ちトーストがある間も自動更新する（#1709）。CIが確定したかどうかは
  // PR一覧の`ciState`でしか分からないため、取り直さないと保留を解けない。
  const autoRefreshPullRequests = isPullRequestPaneActive || pendingCheckUserToasts.length > 0;
  // ブランチ画面の自動更新の間隔（#1767）。**既定は「自動更新しない」**で、選んだ間隔は
  // 端末のlocalStorageに残す。1巡でリポジトリ数ぶんのGraphQL（ブランチ状況）とPR一覧の
  // 取得をまとめて使うため、既定で回すとレート制限の消費が常時上がる。
  // 保存済みの値は選択肢のいずれかへ正規化する（`normalizeAutoRefreshInterval`）。
  const [storedFlowAutoRefreshIntervalMs, setFlowAutoRefreshIntervalMs] =
    usePersistedState<AutoRefreshIntervalMs>("issue-deck:flow-auto-refresh-interval", null);
  const flowAutoRefreshIntervalMs = normalizeAutoRefreshInterval(storedFlowAutoRefreshIntervalMs);
  // 母集団は「ブランチとPRの流れ」を開いている間だけ`all`。PRの状態別ビューはどれも
  // openなPRしか出さなくなったため（#1613）、PRペインでも`open`で足りる。
  // 自動更新の間隔は「PR画面（10秒）」と「ブランチ画面（ユーザーが選んだ間隔）」の
  // 短い方（#1767）。どちらの要求も無ければnull＝自動更新しない。
  const pullRequestAutoRefreshIntervalMs = shorterAutoRefreshInterval(
    autoRefreshPullRequests ? PULL_REQUEST_POLL_INTERVAL_MS : null,
    isFlowPaneActive ? flowAutoRefreshIntervalMs : null,
  );
  const openPullRequests = usePullRequests(
    isFlowPaneActive ? "all" : "open",
    pullRequestAutoRefreshIntervalMs,
  );

  // サブPCのディスパッチ状態（#1262の取り決めどおり**親で1回だけ呼んで配る**）。
  // ここで持つのは「確認待ちのIssueでエージェントがまだ動いているか」を判定するため（#2174）で、
  // 同じものをIssue一覧へも渡す——一覧が自前で持つと、同じ画面のために取得が2本走る。
  const dispatch = useDispatchState(true);
  // セッションの報告がどれだけ古いかを見るための現在時刻（`isSessionActivelyWorking`）。
  // **間隔は既定より粗い1分**——判定の境目は5分（`SESSION_ACTIVITY_STALE_MS`）なので分解能は
  // これで足り、時計が進むたびにこの画面全体が描き直されるのを抑える。
  // **`dispatch.fetchedAt`では代用しない。** 取得が失敗している間は進まないため、落ちた
  // セッションのIssueが確認待ちの件数から外れたまま戻らなくなる（数え漏らす側へは倒さない）。
  const now = useNow(60_000);

  const issuePolling = useIssuePolling((polledIssues) => {
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
    // 取り直すのはマージ待ちになりうるものが現れたときだけ（1回の取得でリポジトリ数ぶん
    // GitHub APIを消費するため）。計画の承認・質問への回答は待たせない。
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
        // エージェントがまだ動いている間は出さずに持つ（#2174）。左メニューの件数から
        // 外しているのと同じ判定で、**この場で求める**——`useMemo`の結果はこの周回より
        // 前の描画で作られたもので、いま届いた`reconciledIssues`を見ていない
        runningIssueIds: selectCheckUserRunningIssueIds(reconciledIssues, {
          pullRequests: openPullRequests.pullRequests,
          sessions: dispatch.sessions,
          now: detectedAt,
        }),
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
  }, issuesFetchedAt);

  function handleSelectCheckUserToastIssue(issue: Issue) {
    // PC・スマホのどちらの現在地も1回のURL更新で詳細画面へ進める（#192・#1396）。
    selectIssue(issue);
  }

  function handleDismissCheckUserToast(id: string) {
    setCheckUserToasts((prev) => prev.filter((toast) => toast.id !== id));
  }

  // AIあいまい検索（#1788）。押したときだけClaudeを呼び、選ばれたIssueのidをここへ持つ。
  // **URLへは載せない**——プラン枠を使って得た結果で、リロードや共有で勝手に再現されるものでは
  // ないため（`IssueFilters`はクエリパラメータと同期している）。
  const aiSearch = useIssueAiSearch();
  const { search: requestAiSearch, clearError: clearAiSearchError } = aiSearch;
  const [aiSearchResult, setAiSearchResult] = useState<{
    query: string;
    issueIds: string[];
    /** 候補の上限を超えて対象外にした件数（画面に注記を出すため） */
    droppedCandidateCount: number;
  } | null>(null);
  // 検索語を変えたら通常の検索へ戻す。レンダー中に比較して捨てるのはTopBarの入力同期と同じ形
  // （effectで消すと、1フレームだけ古いAI結果で絞られた一覧が出る）。
  const [aiSearchSyncedQuery, setAiSearchSyncedQuery] = useState(filters.q);
  if (filters.q !== aiSearchSyncedQuery) {
    setAiSearchSyncedQuery(filters.q);
    if (aiSearchResult) setAiSearchResult(null);
    clearAiSearchError();
  }

  const aiMatchedIds = useMemo(
    () => (aiSearchResult ? new Set(aiSearchResult.issueIds) : null),
    [aiSearchResult],
  );
  // 一覧・左メニューの件数・ラベルの件数がすべて同じ条件を通るよう、AI検索の結果もここで混ぜる
  // （#1689・#1750と同じ理由で、片方だけ素のfiltersを使うと数字が食い違う）。
  const filtersWithAiSearch = useMemo(
    () => ({ ...filters, aiMatchedIds }),
    [filters, aiMatchedIds],
  );

  // 表示中のビューで実際に適用する絞り込み（#1750）。「ユーザーの確認待ち」「ユーザーの
  // 作業待ち」「質問」はリポジトリ横断で全体を見る場所なので、ここで条件が空へ解決される。
  const viewFilters = useMemo(
    () => resolveFiltersForView(filtersWithAiSearch, filters.view),
    [filtersWithAiSearch, filters.view],
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

  // AI検索へ渡す自由語（`label:`等のトークンを除いた残り）。これが空ならボタンを出さない。
  const aiSearchKeyword = useMemo(() => parseSearchQuery(filters.q).keyword, [filters.q]);

  const runAiSearch = useCallback(async () => {
    if (!aiSearchKeyword) return;
    // **候補は「自由語以外の条件を満たすIssue」**。自由語で先に文字列一致をかけてしまうと、
    // AIに探させたいIssueが候補から落ちる（文字列一致で0件のときに押す機能のため、
    // 候補まで0件になる）。トークン（label:等）とビューの絞り込みはそのまま効かせる。
    const baseFilters = resolveFiltersForView(
      { ...filters, q: extractSearchTokens(filters.q), aiMatchedIds: null },
      filters.view,
    );
    const candidates = sortIssues(
      filterIssuesByView(
        applyIssueFilters(issues, baseFilters),
        filters.view,
        currentUserLogin,
        issues,
      ),
      filters.sort,
      filters.view,
    );
    // 上限を超える分は新しい順に切る（プロンプトが膨らむため。切った件数は画面に出す）
    const targets = candidates.slice(0, ISSUE_SEARCH_CANDIDATE_LIMIT);
    const issueIds = await requestAiSearch(aiSearchKeyword, targets);
    if (!issueIds) return;
    setAiSearchResult({
      query: filters.q,
      issueIds,
      droppedCandidateCount: candidates.length - targets.length,
    });
  }, [aiSearchKeyword, filters, issues, currentUserLogin, requestAiSearch]);

  const clearAiSearch = useCallback(() => {
    setAiSearchResult(null);
    clearAiSearchError();
  }, [clearAiSearchError]);

  const topBarAiSearch = useMemo<TopBarAiSearch>(
    () => ({
      canRun: aiSearchKeyword !== "",
      isSearching: aiSearch.isSearching,
      notConfigured: aiSearch.notConfigured,
      error: aiSearch.error,
      // 件数は一覧と同じ集合から数える（AIが返した件数ではない。ビューやラベルの絞り込みで
      // さらに減ることがあり、左メニューの数字と食い違わせないため）
      matchedCount: aiSearchResult ? filteredIssues.length : null,
      droppedCandidateCount: aiSearchResult?.droppedCandidateCount ?? 0,
      run: () => {
        void runAiSearch();
      },
      clear: clearAiSearch,
    }),
    [
      aiSearchKeyword,
      aiSearch.isSearching,
      aiSearch.notConfigured,
      aiSearch.error,
      aiSearchResult,
      filteredIssues,
      runAiSearch,
      clearAiSearch,
    ],
  );

  // 絞り込みを指定しているのに、いま見ているビューでは効かない状態か（#1750）。
  // 黙って無視すると件数が変わらない理由が読めないため、一覧のヘッダーに注記を出す。
  const filtersIgnored = useMemo(
    () => hasIgnoredIssueFilters(filters, filters.view),
    [filters],
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
  // 未確認（回答が届いていて未読）の質問の件数（#1796・#2070）。左メニュー・スマホのホームで
  // オレンジの丸を点けるかどうかと、吹き出しの内訳にだけ使う（**件数そのものは`navCounts`から
  // 引く**——画面側で数え直すと同じ行の数字と吹き出しが別の数え方になる）。
  // 「質問」も絞り込みを適用しないビュー（#1750）なので、母集団の解決は上の2つと同じ。
  const unconfirmedQuestionCount = useMemo(
    () =>
      countUnconfirmedQuestions(
        filterIssuesByView(
          applyIssueFilters(issues, resolveFiltersForView(filters, "question")),
          "question",
          currentUserLogin,
          issues,
        ),
      ),
    [issues, filters, currentUserLogin],
  );
  // 一覧の行に出す「いま実行できるか」（#1763）。母集団は絞り込み前の全Issue——
  // 「ユーザーの作業待ち」の一覧には手作業Issueしか並ばず、絞り込み後の集合では
  // 参照先のIssueを1件も引けない。
  const manualStepReadiness = useMemo(() => computeManualStepReadiness(issues), [issues]);
  // 一覧の行に出す前提待ちの印は、手作業Issue以外にも広げる（#2003）。手作業アシスタントと
  // 左メニューの件数は`manualStepReadiness`（手作業Issueだけ）のままにする——あちらは
  // 「いま手を動かせば盤面が進む手作業が何件あるか」を答えるもので、一般のIssueを混ぜると
  // 別の数になる
  const prerequisiteReadiness = useMemo(
    () => computeIssuePrerequisiteReadiness(issues),
    [issues],
  );
  // 手作業アシスタント（#1826）。PC・スマホのどちらの入口から開いても同じ状態を使うため、
  // 状態とダイアログはここに1つだけ置く
  const manualStepGuide = useManualStepGuide(issues, manualStepReadiness);
  // 「次にやること」（#1853）。手作業アシスタントと同じく、PC・スマホのどちらの入口から
  // 開いても同じ状態を使うため、状態とダイアログはここに1つだけ置く
  const issueOrderGuide = useIssueOrderGuide(issues);
  // スマホの絞り込みシートに出すラベルの選択肢。スマホはPC側の絞り込み（filters）とは別の
  // クエリ（mview/mlabels等）で動くため、絞り込み前の全Issueから求める。
  const labelSummary = useMemo(() => computeLabelSummary(issues), [issues]);
  // 左メニュー「ラベル」に出す一覧と件数（#1441）。TopBarの絞り込みに追随させる。
  const sidebarLabelSummary = useMemo(
    () => computeFilterLabelSummary(issues, filtersWithAiSearch, labelSummary),
    [issues, filtersWithAiSearch, labelSummary],
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
        // AI検索の結果で絞り込むと並ぶ行が変わるため、別の一覧として扱う（#1788）
        aiSearchResult ? "ai" : "",
      ]),
    [filters, aiSearchResult],
  );

  // Issue作成ダイアログのリポジトリ選択肢は、サイドメニューで非表示にしたリポジトリを
  // 除いたもの（メニューに表示中のリポジトリ一覧）に揃える（#367）。
  const visibleRepositories = useMemo(
    () => repositories.filter((repo) => !repo.hidden),
    [repositories],
  );

  // マージ直後はGitHub側の反映を待たずにマージ済みとして描く（#1756）。反映するのは
  // 「マージした時点の取得結果」に対してだけで、再取得（fetchedAtの更新）後は取得できた内容を
  // 正とする（マージできていなければまた一覧に現れる）。
  //
  // **以前はここで一覧から伏せていたが、伏せるのはPR一覧にとってしか正しくない**——同じ集合を
  // ブランチ画面がレーンの組み立てに使っているため、PRが消えるとレーンが「PR未作成」に化けていた。
  const [mergedPullRequests, setMergedPullRequests] = useState<{
    merges: OptimisticMerge[];
    fetchedAt: string | null;
  }>({ merges: [], fetchedAt: null });
  const optimisticMerges = useMemo(
    () =>
      mergedPullRequests.fetchedAt === openPullRequests.fetchedAt ? mergedPullRequests.merges : [],
    [mergedPullRequests, openPullRequests.fetchedAt],
  );

  // マージ済みとして反映したうえで、左メニューでリポジトリを絞り込んでいるときはPR一覧も同じ
  // 絞り込みに従わせた集合。状態別ビュー（#1312）を掛ける前のこれを、一覧と左メニューの件数
  // （#1389）の共通の母集団にする。Issue側のnavCountsと同じで、ここを揃えておかないと
  // メニューの件数と一覧に並ぶ件数が食い違う。
  const visiblePullRequests = useMemo(() => {
    const visible = applyOptimisticMerges(openPullRequests.pullRequests, optimisticMerges);
    return filters.repos.length === 0
      ? visible
      : visible.filter((pullRequest) => filters.repos.includes(pullRequest.repositoryFullName));
  }, [openPullRequests.pullRequests, filters.repos, optimisticMerges]);

  // リポジトリ横断で見る場所へ渡す母集団。**TopBarのリポジトリ絞り込みには従わせない。**
  // 渡す先はヘッダーの通知ベル（#1614）・「ユーザーの確認待ち」に並ぶマージ待ちPR・
  // ブランチ画面（#1750）の3つで、どれもリポジトリ横断で「いま人が動かないと止まるもの」を
  // 見る場所。Issue側（絞り込みを適用しないビュー）と揃えないと、絞り込んだ瞬間にPRだけ消えて
  // 件数の意味が変わる。マージ済みとして先に反映したぶん（#1756）だけは、こちらにも効かせる
  // ——ブランチ画面のマージボタンが消えるのはこの集合を通ってのことなので、外すと二度押せる。
  const crossRepositoryPullRequests = useMemo(
    () => applyOptimisticMerges(openPullRequests.pullRequests, optimisticMerges),
    [openPullRequests.pullRequests, optimisticMerges],
  );

  // 確認待ちのうち、まだエージェントが動いていて押せる操作が無いもの（#2174）。
  // **左メニューの件数・一覧のヘッダー・ベルが同じ集合を読む**ので、ここで1回だけ求めて配る。
  const checkUserRunningIssueIds = useMemo(
    () =>
      selectCheckUserRunningIssueIds(checkUserIssues, {
        pullRequests: crossRepositoryPullRequests,
        sessions: dispatch.sessions,
        now,
      }),
    [checkUserIssues, crossRepositoryPullRequests, dispatch.sessions, now],
  );

  // 左メニューの件数（#1689・#1750）。ビューごとに適用する絞り込みが違うため、
  // 絞り込み前の全Issueと条件を渡して中で解決させる（一覧と同じ関数を通す）。
  // 「ユーザーの確認待ち」だけは実行中のIssueを外した数にする（#2174）。
  const navCounts = useMemo(
    () =>
      computeNavCountsForFilters(
        issues,
        filtersWithAiSearch,
        currentUserLogin,
        issues,
        checkUserRunningIssueIds,
      ),
    [issues, filtersWithAiSearch, currentUserLogin, checkUserRunningIssueIds],
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

  // 上の一覧から外した「CI・判定の完了待ち」の件数（#2081）。**件数には足さず**、枠の下の
  // 1行にだけ出す。押せないPRを並べないぶん、あと何件来るのかは読めるようにしておく。
  const mergeCheckWaitingCount = useMemo(
    () => pullRequestsWaitingForMergeChecks(crossRepositoryPullRequests, checkUserIssues).length,
    [crossRepositoryPullRequests, checkUserIssues],
  );

  // 「ユーザーの確認待ち」に並ぶマージ待ちPRの取り直し（#2175）。PCの「更新」ボタンと、
  // スマホで一覧を下へ引っ張る操作が同じ入口を使う。**`refreshFromPull`を通す**のは、
  // 飛んでいる取得の完了を待って返し、失敗を画面に出すのがこのフックではこれだけのため
  // （#1947。`refresh`は同期の合図で、待っても取得の完了とは無関係に返る）。
  const refreshCheckUserPullRequests = openPullRequests.refreshFromPull;

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

  // ブランチ状況（#1455）。取得はこの画面を開いている間だけ。自動更新はユーザーが間隔を
  // 選んだときだけ回る（#1767。既定は自動更新しない）。
  const branchFlowStatus = useBranchFlow(isFlowPaneActive, flowAutoRefreshIntervalMs);

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
        // マージ直後のPRをマージ済みとして反映した集合（リポジトリ絞り込みは掛けない）
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

  // 詳細を開いているPR（#1087）。ヘッダーの材料を一覧と詳細のどちらから採るかは
  // `resolvePullRequestHeader`（#1578・#2149。確認待ちのモーダルと共用する）。
  const selectedPullRequest = useMemo(
    () =>
      resolvePullRequestHeader(
        filters.pr,
        filteredPullRequests,
        openPullRequests.fetchedAt,
        pullRequestDetail.detail,
      ),
    [filteredPullRequests, filters.pr, openPullRequests.fetchedAt, pullRequestDetail.detail],
  );

  // 「ユーザーの確認待ち」に並ぶマージ待ちPRを、その場に重ねて開く（#2149）。**PR一覧画面へ
  // 遷移しない**——確認待ちは上から順に片付ける場所で、1件開くたびに画面ごと移ると続きを
  // 見るのに毎回戻る操作が要る。開いているかどうかは`prmodal`クエリが正（`pr`と分ける理由と
  // 重ね表示をstateで持たない理由は`pull-request-detail-dialog.tsx`）。
  const modalPullRequestDetail = usePullRequestDetail(filters.prmodal);
  // ヘッダーの材料は、一覧に並んでいるものと同じ母集団（リポジトリ絞り込みを掛けない
  // `crossRepositoryPullRequests`）から引く。押した直後にヘッダーを描けるので、詳細の
  // 取得を待つのは本文とコメントだけになる。
  const modalPullRequest = useMemo(
    () =>
      resolvePullRequestHeader(
        filters.prmodal,
        crossRepositoryPullRequests,
        openPullRequests.fetchedAt,
        modalPullRequestDetail.detail,
      ),
    [
      filters.prmodal,
      crossRepositoryPullRequests,
      openPullRequests.fetchedAt,
      modalPullRequestDetail.detail,
    ],
  );

  function handlePullRequestMerged(pullRequest: PullRequestSummary) {
    const merge: OptimisticMerge = { id: pullRequest.id, mergedAt: new Date().toISOString() };
    setMergedPullRequests((prev) => ({
      merges: prev.fetchedAt === openPullRequests.fetchedAt ? [...prev.merges, merge] : [merge],
      fetchedAt: openPullRequests.fetchedAt,
    }));
    // マージしたPRの詳細は用済みなので閉じて一覧へ戻す（スマホでは一覧画面へ戻る）。
    if (filters.pr === pullRequest.id) selectPullRequest(null);
    // 確認待ちの一覧から重ねて開いていた場合も同じ（#2149）。マージすると一覧から外れるため、
    // 閉じないと「押せるものが無い詳細」が残る。
    if (filters.prmodal === pullRequest.id) selectPullRequestModal(null);
    openPullRequests.refresh();
  }

  /**
   * ブランチ画面からマージできたとき（#1756）。
   *
   * マージ済みとしての反映（＝同じPRを二度マージできないこと）は`handlePullRequestMerged`が
   * 担い、ここではこの画面が持つ他の2つの取得——ブランチ状況と本番デプロイ状況——も
   * 取り直す。ヘッダーの「更新」が3つまとめて取り直しているのと同じ組み合わせ。
   */
  function handleBranchFlowMerged(pullRequest: PullRequestSummary) {
    handlePullRequestMerged(pullRequest);
    branchFlowStatus.refresh();
    deployStatus.refresh();
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

  // 設定画面のように、フッターに対応するタブが無い画面ではnullになる（#1638）
  const activeBottomNavTab: MobileBottomNavTab | null = resolveBottomNavTab(mobileScreen);

  return (
    <GithubReferenceNavigationProvider openReference={openReference}>
      {/* 通知ベルの材料（#1772）。PCのトップバーとスマホの各画面のヘッダーが同じものを読む。
          リリース状況の取得を1本に保つため、ここで1回だけ用意して配る。
          ベルを開いている間の取り直し（#1909）もここが持つ取得口を使い回す——ベル専用の
          取得口を足すと、同じIssue・PRを2本のポーリングで取りに行くことになる */}
      <NotificationProvider
        repositories={repositories}
        issues={issues}
        pullRequests={crossRepositoryPullRequests}
        /* 実行中の確認待ちは「実行中」として弱く出す（#2174）。左メニューの件数と同じ集合 */
        checkUserRunningIssueIds={checkUserRunningIssueIds}
        onRefreshIssues={issuePolling.refresh}
        onRefreshPullRequests={openPullRequests.refreshInBackground}
        isRefreshingPullRequests={openPullRequests.isRefreshing}
      >
      <div className="flex h-full flex-col">
        <TopBar
          currentUser={currentUser}
          filters={filters}
          setFilter={setFilter}
          groupByRepo={groupByRepo}
          onChangeGroupByRepo={setGroupByRepo}
          assigneeOptions={assigneeOptions}
          /* 開いている画面に関連するリポジトリを初期値にする（#1884）。1つに絞り込んでいれば
             そのリポジトリ、絞り込んでいなければ**いま画面に出ている**Issueのリポジトリ。
             どちらも分からなければ渡さず、フォームで選ばせる。
             **`selectedIssue`だけを見てはいけない。** PR・ブランチのペインへ移っても
             `?issue=`は残るため（`use-issue-filters.ts`は`pr`しか畳まない）、Issue詳細が
             どこにも出ていない状態で「表示中のリポジトリ」と書くことになる */
          onCreateIssue={() =>
            openCreateDialog(
              filters.repos.length === 1
                ? filters.repos[0]
                : (visibleIssue?.repositoryFullName ?? null),
            )
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
          /* パソコンでアプリとして起動するとブラウザの戻る矢印が無くなるため、ヘッダーに
             戻る導線を置く（#1771）。戻り先の判断はスマホと同じ`goBackOrFallback`。
             巻き戻せる履歴が無いときはボタンを押せないのでフォールバックは実際には走らないが、
             万一走ったときに開いている詳細を閉じる（＝一覧へ戻る）ようにしておく。
             閉じる側は履歴を積まない（積むと戻る操作のたびに履歴が伸びる。#1396）。 */
          aiSearch={topBarAiSearch}
          canGoBack={canGoBack}
          onBack={() =>
            goBackOrFallback(() => {
              if (filters.pr) {
                selectPullRequest(null);
                return;
              }
              setFilter("issue", null, { history: "replace" });
            })
          }
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
                  unconfirmedQuestionCount={unconfirmedQuestionCount}
                  pullRequestNavCounts={pullRequestNavCounts}
                  onSelectQuickView={selectQuickView}
                  onSelectPullRequests={selectPullRequests}
                  onSelectFlow={() => selectTab("flow")}
                  favoriteRepositories={repositories.filter((repo) => repo.favorite)}
                  onSelectRepository={selectRepository}
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
                  isRefreshing={branchFlowStatus.isRefreshing || openPullRequests.isRefreshing}
                  error={branchFlowStatus.error ?? openPullRequests.error}
                  failedRepositories={branchFlowStatus.failedRepositories}
                  mergedPullRequestsLoaded={mergedPullRequestsLoaded}
                  autoRefreshIntervalMs={flowAutoRefreshIntervalMs}
                  deployAutoRefreshIntervalMs={
                    deployStatus.autoRefresh ? deployStatus.pollIntervalMs : null
                  }
                  onChangeAutoRefreshInterval={setFlowAutoRefreshIntervalMs}
                  onRefresh={() => {
                    branchFlowStatus.refresh();
                    openPullRequests.refresh();
                    deployStatus.refresh();
                  }}
                  onMerged={handleBranchFlowMerged}
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
                    autoRefreshIntervalMs={pullRequestAutoRefreshIntervalMs}
                    error={openPullRequests.error}
                    /* 引っ張って更新（#1947）。**`refresh`でも`refreshInBackground`でもなく
                       `refreshFromPull`。** `refresh`は取得effectを張り直すため引っ張った直後に
                       一覧が「読み込み中...」へ戻り、`refreshInBackground`は自動更新と重なると
                       空振りするうえ失敗も画面に出ない（`use-pull-requests.ts`） */
                    onRefresh={openPullRequests.refreshFromPull}
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
                  mergeCheckWaitingCount={mergeCheckWaitingCount}
                  /* 確認待ちのうちエージェントがまだ動いているもの（#2174）。ヘッダーの
                     件数の内訳に使う（左メニュー・ホームの数字からは外してある） */
                  checkUserRunningIssueIds={checkUserRunningIssueIds}
                  /* PR画面へ移らず、その場に重ねて開く（#2149）。戻る操作で閉じる */
                  onSelectPullRequest={(pullRequest) => selectPullRequestModal(pullRequest.id)}
                  onChangeView={(view) => updateListFilters({ view })}
                  onChangeFilters={(filters) => updateListFilters(filters)}
                  onSelectIssue={selectIssue}
                  onCreateIssue={() => openCreateDialog()}
                  onAskCrossRepoQuestion={() => openCrossRepoQuestionDialog()}
                  /* タブから直接開いたとき以外は戻る導線を出す（#525・#1951） */
                  onBack={mobileScreen.origin === "tab" ? undefined : goBack}
                  /* 一覧を下へ引っ張ったときの取り直し（#1893）。ポーリングと同じ
                     経路（reconcileIssues・確認待ちトーストの判定）を通す */
                  onRefresh={issuePolling.refresh}
                  /* 同じ操作で走らせるマージ待ちPRの取り直し（#2175）。呼ぶかどうかの
                     判定（確認待ちを見ているときだけ）は受け取った側が持つ */
                  onRefreshPullRequests={refreshCheckUserPullRequests}
                  fetchedAt={issuePolling.fetchedAt}
                  autoRefreshIntervalMs={issuePolling.pollIntervalMs}
                  onStartManualStepGuide={manualStepGuide.start}
                  onStartIssueOrder={
                    issueOrderGuide.notConfigured ? undefined : issueOrderGuide.start
                  }
                  onStartCodeReview={() => openCodeReviewDialog()}
                  issueOrderAutoStart={issueOrderGuide.autoStart}
                  issueOrderCount={issueOrderGuide.totalCount}
                />
              )}

              {mobileScreen.kind === "repos" && (
                <MobileReposScreen
                  repositories={repositories}
                  /* 検索窓の下の「すべてのリポジトリのIssue」の件数（#1951）。
                     左メニュー・ホームと同じ数え方にするため`navCounts`から引く */
                  allIssueCount={navCounts.all}
                  onSelectRepository={selectRepository}
                  onSelectAllIssues={selectAllIssues}
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
                  onRefresh={issuePolling.refresh}
                  fetchedAt={issuePolling.fetchedAt}
                  autoRefreshIntervalMs={issuePolling.pollIntervalMs}
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
                  onCreateConfigIssue={openConfigChangeIssueDialog}
                  onCreateCodeReviewFindingIssue={openCodeReviewFindingIssueDialog}
                  onStartCodeReview={openCodeReviewDialog}
                  onSelectRepository={selectRepositoryByFullName}
                  onStartManualStepGuide={manualStepGuide.start}
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
                unconfirmedQuestionCount={unconfirmedQuestionCount}
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
                className="hidden shrink-0 border-r md:flex"
                style={{ width: sidebarWidth.width, maxWidth: "50vw" }}
              />
              <ResizeHandle onDragStart={sidebarWidth.handleDragStart} className="hidden md:block" />
            </>
          )}

          {filters.pane === "flow" ? (
            /* PC: ブランチ（#1455）。中央〜右をこの画面だけで使い、その中を
               左（リポジトリ一覧）と右（選んだリポジトリの流れ図）に分ける（#2157）。
               IssueやPRを選ぶとそれぞれのペインへ遷移する */
            <BranchFlowView
              flow={branchFlow}
              fetchedAt={branchFlowStatus.fetchedAt}
              isLoading={branchFlowStatus.isLoading || openPullRequests.isLoading}
              /* 自動更新のぶんも回す（#1767）。ブランチ状況とPR一覧のどちらかが飛んでいれば回る */
              isRefreshing={branchFlowStatus.isRefreshing || openPullRequests.isRefreshing}
              error={branchFlowStatus.error ?? openPullRequests.error}
              failedRepositories={branchFlowStatus.failedRepositories}
              mergedPullRequestsLoaded={mergedPullRequestsLoaded}
              /* 絞り込みでは無く「展開して見せる」形にする（#1750） */
              expandedRepositoryFullNames={filters.repos}
              autoRefreshIntervalMs={flowAutoRefreshIntervalMs}
              /* デプロイが動いている間だけ回っているぶん（#1797）。既定が「自動更新しない」の
                 この画面で、デプロイの表示だけが勝手に進む理由を出す */
              deployAutoRefreshIntervalMs={
                deployStatus.autoRefresh ? deployStatus.pollIntervalMs : null
              }
              onChangeAutoRefreshInterval={setFlowAutoRefreshIntervalMs}
              onRefresh={() => {
                branchFlowStatus.refresh();
                openPullRequests.refresh();
                deployStatus.refresh();
              }}
              onMerged={handleBranchFlowMerged}
              /* 左右2ペイン（#2157）。幅が足りるかどうかは`BranchFlowView`が実測して決める */
              splitLayout
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
                autoRefreshIntervalMs={pullRequestAutoRefreshIntervalMs}
                error={openPullRequests.error}
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
                      waitingForChecksCount={mergeCheckWaitingCount}
                      /* PR一覧画面へ移らず、その場に重ねて開く（#2149） */
                      onSelectPullRequest={(pullRequest) =>
                        selectPullRequestModal(pullRequest.id)
                      }
                      /* PCは一覧を指で引けないため、ここから取り直す（#2175） */
                      onRefresh={() => void refreshCheckUserPullRequests()}
                      isRefreshing={openPullRequests.isRefreshing}
                    />
                  ) : undefined
                }
                // 一覧のヘッダーの件数も左メニューと同じ数え方にする（#1713）
                pinnedCount={
                  filters.view === "check-user" ? mergePendingPullRequests.length : 0
                }
                // いつ時点の内容かと自動更新の状態（#1797）。PR一覧・ブランチ画面と同じ並びで出す
                fetchedAt={issuePolling.fetchedAt}
                autoRefreshIntervalMs={issuePolling.pollIntervalMs}
                // 前提条件がそろっているかを行に出す（#1763・#2003）
                prerequisiteReadiness={prerequisiteReadiness}
                // 確認待ちのうちエージェントがまだ動いているもの（#2174）。左メニューの件数から
                // 外したぶんを、ヘッダーの内訳（`2件・実行中1件`）で説明する
                checkUserRunningIssueIds={checkUserRunningIssueIds}
                // ディスパッチの取得はこの画面で1本にまとめる（#1262の取り決め）
                dispatch={dispatch}
                // 溜まった手作業を1件ずつ案内する入口（#1826）
                onStartManualStepGuide={manualStepGuide.start}
                // 未着手の着手順をClaudeに決めさせる入口（#1853）
                onStartIssueOrder={issueOrderGuide.notConfigured ? undefined : issueOrderGuide.start}
                // リポジトリ全体のコードレビューを実行する入口（#698）
                onStartCodeReview={() =>
                  openCodeReviewDialog(filters.repos.length === 1 ? filters.repos[0] : null)
                }
                issueOrderAutoStart={issueOrderGuide.autoStart}
                issueOrderCount={issueOrderGuide.totalCount}
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
                  onCreateConfigIssue={openConfigChangeIssueDialog}
                  onCreateCodeReviewFindingIssue={openCodeReviewFindingIssueDialog}
                  onStartCodeReview={openCodeReviewDialog}
                  onSelectRepository={(repositoryFullName) =>
                    setFilters({ repos: [repositoryFullName] })
                  }
                  onStartManualStepGuide={manualStepGuide.start}
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

        {/* 「ユーザーの確認待ち」から重ねて開くPR詳細（#2149）。PC・スマホの入口が同じ1つを開く */}
        <PullRequestDetailDialog
          pullRequestId={filters.prmodal}
          pullRequest={modalPullRequest}
          detail={modalPullRequestDetail.detail}
          isLoading={modalPullRequestDetail.isLoading}
          error={modalPullRequestDetail.error}
          onRefresh={modalPullRequestDetail.refresh}
          onMerged={() => modalPullRequest && handlePullRequestMerged(modalPullRequest)}
          /* 開くときに履歴を積んでいるので、閉じるのは巻き戻し。共有URLで直接開いた場合だけ
             クエリを落とす（`goBackOrFallback`。他の閉じる導線と同じ扱い） */
          onClose={() => goBackOrFallback(() => selectPullRequestModal(null))}
        />

        {/* 「次にやること」（#1853）。PC・スマホの入口が同じ1つを開く */}
        <IssueOrderDialog guide={issueOrderGuide} onSelectIssue={(issue) => openIssueUrl(issue.id)} />

        {/* 手作業アシスタント（#1826）。PC・スマホの入口が同じ1つを開く */}
        <ManualStepGuideDialog
          queueIds={manualStepGuide.queueIds}
          issues={issues}
          open={manualStepGuide.open}
          onOpenChange={manualStepGuide.setOpen}
          onIssueUpdated={handleIssueUpdated}
        />

        <CreateIssueDialog
          open={createDialogOpen}
          onOpenChange={setCreateDialogOpen}
          repositories={visibleRepositories}
          defaultRepositoryFullName={createDialogRepo}
          defaultTitle={createDialogTitle}
          defaultBody={createDialogBody}
          bodyPrefix={createDialogBodyPrefix}
          issues={issues}
          onCreated={handleIssueCreated}
        />
        <CodeReviewDialog
          open={codeReviewDialogOpen}
          onOpenChange={setCodeReviewDialogOpen}
          repositories={visibleRepositories}
          defaultRepositoryFullName={codeReviewDialogRepo}
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
