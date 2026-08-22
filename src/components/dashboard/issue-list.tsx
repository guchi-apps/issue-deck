"use client";

import { useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  Archive,
  BadgeCheck,
  CheckSquare,
  CircleCheck,
  CircleCheckBig,
  CircleDot,
  CircleSlash,
  Clock,
  Compass,
  ExternalLink,
  ListChecks,
  Lock,
  MessageSquare,
  ScanSearch,
  ScrollText,
  Star,
} from "lucide-react";

import { BulkDispatchBar } from "@/components/dashboard/bulk-dispatch-bar";
import { ManualStepRunBadge } from "@/components/dashboard/manual-step-run-badge";
import { PullToRefreshIndicator } from "@/components/dashboard/pull-to-refresh-indicator";
import { UserAvatar } from "@/components/dashboard/user-avatar";
import { WorkflowStepBadge } from "@/components/dashboard/workflow-status-steps";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useDispatchState, type DispatchStateHandle } from "@/hooks/use-dispatch-state";
import { useIssueListScroll } from "@/hooks/use-issue-list-scroll";
import { useIssuesWorkflowRunning } from "@/hooks/use-issues-workflow-running";
import { useNow } from "@/hooks/use-now";
import { usePullToRefresh } from "@/hooks/use-pull-to-refresh";
import { describeAutoRefreshState, type AutoRefreshIntervalMs } from "@/lib/auto-refresh";
import { formatCheckUserListCount } from "@/lib/check-user-attention";
import {
  resolveIssueExecutionTarget,
  type IssueExecutionTarget,
} from "@/lib/dispatch/issue-execution-target";
import { bulkDispatchableIssues as listBulkDispatchableIssues } from "@/lib/dispatch/bulk-dispatch";
import { findSessionForIssue, summarizeIssueSession } from "@/lib/dispatch/issue-session";
import { findPlanRequestForIssue } from "@/lib/dispatch/session-plan-request";
import { shouldEmphasizeRemoteControl } from "@/lib/remote-control-attention";
import {
  isActiveManualStepRun,
  sortManualStepRunsForList,
} from "@/lib/manual-step-run-view";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import { formatDateTime, formatTimeOfDay } from "@/lib/format-date-time";
import { formatRelativeDate } from "@/lib/format-relative-date";
import { closedStateLabel } from "@/lib/issue-state-reason";
import { isStartImplementationOptionLabel } from "@/lib/github/start-implementation";
import { groupIssuesByRepository, type IssueRepositoryGroup } from "@/lib/issue-stats";
import { isProgressLabel } from "@/lib/issue-status";
import {
  formatManualStepListCount,
  type ManualStepReadiness,
  type ManualStepReadinessMap,
} from "@/lib/manual-step-attention";
import { getLabelBadgeStyle } from "@/lib/label-color";
import {
  formatQuestionListCount,
  resolveQuestionState,
  type QuestionState,
} from "@/lib/question-attention";
import { cn } from "@/lib/utils";
import type { Issue, IssueLabel, NavViewId } from "@/types/issue";

type IssueListProps = {
  title: string;
  issues: Issue[];
  selectedIssueId: string | null;
  onSelectIssue: (issue: Issue) => void;
  className?: string;
  style?: CSSProperties;
  showSearch?: boolean;
  showHeader?: boolean;
  /** 画面右下に浮くFAB（新規Issue作成ボタン）と最後の項目が重ならないよう下部に余白を確保する */
  fabSpacing?: boolean;
  /** スマホのボトムナビ（フッター）と最後の項目が重ならないよう、フッターと同じ高さの空白を末尾に追加する（#677） */
  footerSpacing?: boolean;
  /**
   * スクロール位置を保存・復元する単位を表すキー（#773）。画面種別と絞り込み条件から作り、
   * 条件が変われば別の一覧として扱う。省略時は保存・復元を行わない。
   */
  scrollKey?: string | null;
  /**
   * リポジトリごとのグループヘッダーを挟んで表示するか（#849）。絞り込み結果に
   * リポジトリが1種類しかない場合はヘッダーを出さずフラット表示のまま扱う。
   */
  groupByRepo?: boolean;
  /**
   * 現在表示中のナビビュー。グループ化時の並び順の切り替え（#922）にのみ使う。
   * 「直近本番に反映した」ビューでは、最後に反映したリポジトリが上に来るよう
   * グループの並び順をrepositoryFullName昇順ではなくclosedAt降順にする。
   */
  view?: NavViewId;
  /**
   * 一覧の先頭（ヘッダーの下・スクロール領域の外）へ差し込む枠（#1613）。
   * 「ユーザーの確認待ち」でマージ待ちPRを並べるために使う。Issueが0件でも描く——
   * 確認すべきものが残っているのに「該当するIssueがありません」だけになると逆に読み違える。
   */
  pinnedSection?: ReactNode;
  /**
   * `pinnedSection`に並ぶ件数（#1713）。ヘッダーの「N件」へ合流させる。左メニューの
   * 「ユーザーの確認待ち」はIssueとマージ待ちPRを足した数を出しているため、ここで足さないと
   * メニューの件数と一覧の件数だけが食い違う。
   */
  pinnedCount?: number;
  /**
   * 手作業Issue（`71.manual-step`）が、いま実行できるかどうか（#1763）。
   * 行の右上へアイコンで出し、「ユーザーの作業待ち」ではヘッダーの件数にも使う。
   *
   * **絞り込み前の全Issueを母集団に作ったものを渡す。** 一覧が自分の`issues`だけで判定すると、
   * 手作業Issueしか並ばないこのビューでは参照先の通常Issueが手元に無く、全件が
   * 「状態不明＝実行できる」になる。省略した場合はアイコンを出さない。
   */
  prerequisiteReadiness?: ManualStepReadinessMap;
  /**
   * 確認待ち（`00.check-user`）のうち、まだエージェントが動いていて押せる操作が無いIssueのid
   * （#2174。判定は`lib/check-user-attention.ts`）。
   *
   * 左メニューの件数はこれを外した数を出すため、ヘッダーが行数のままだと数字だけが食い違う。
   * **一覧には今までどおり並べ**、ヘッダーの内訳（`2件・実行中1件`）で説明する。
   * 省略時は今までどおり行数を出す。
   */
  checkUserRunningIssueIds?: ReadonlySet<string>;
  /**
   * 手作業アシスタント（#1826）を開く。「ユーザーの作業待ち」でだけ使う。
   * 渡さない・実行できる手作業が1件も無い場合はボタンを出さない。
   *
   * `startIssueId`を渡すとそのIssueが案内の先頭になる（自動実行バッジの一覧から
   * 開くときに使う。#2119）。省略すると今までどおり`buildManualStepQueue`の並び順
   */
  onStartManualStepGuide?: (startIssueId?: string) => void;
  /**
   * 「次にやること」（#1853）を開く。「未着手」でだけ使う。
   * 渡さない・未着手が1件も無い場合はボタンを出さない。
   * `CLAUDE_CODE_OAUTH_TOKEN`が未設定の環境では親（`useIssueOrderGuide`の`notConfigured`）が
   * 渡すのをやめるので、押しても何も起きないボタンが残らない
   */
  onStartIssueOrder?: () => void;
  /**
   * コードレビュー（#698）を実行するダイアログを開く。「コードレビュー」ビューでだけ使う。
   *
   * **ヘッダーではなく一覧の上に置く**（手作業アシスタント・「次にやること」と同じ理由）。
   * このビューには他に起動の入口が無いので、**Issueが0件でも出す**——出さないと、最初の
   * 1件を作る手段が画面から無くなる。
   */
  onStartCodeReview?: () => void;
  /** 「次にやること」で1位を自動でサブPCへ積む設定か（#1853）。ボタンの文言が変わる */
  issueOrderAutoStart?: boolean;
  /**
   * 「次にやること」が判定の対象にする件数（#1853）。**この一覧の行数ではなく、
   * ユーザーの絞り込みを通していない「未着手」の総数**を渡す（`useIssueOrderGuide`）。
   * 一覧の行数を出すと、リポジトリで絞ったときに「N件あります」と実際に判定する件数がずれる
   */
  issueOrderCount?: number;
  /**
   * 絞り込みを指定しているのに、このビューでは適用されない状態か（#1750）。
   * 判定は`hasIgnoredIssueFilters`で行い、ここは受け取った結果を注記として出すだけ。
   * 黙って無視すると、キーワードやリポジトリを選んでも件数が変わらない理由が画面から読めない。
   */
  filtersIgnored?: boolean;
  /**
   * ディスパッチの状態（#1638）。**同じ画面で既に取っているなら渡す**（#1262の取り決め）。
   * スマホのIssue一覧はヘッダーの実行状況ボタンと一覧が同じものを見るため、画面側で1回
   * 取って両方へ配っている。省略時はこの一覧が自分で取りに行く（PCの一覧は従来どおり）。
   */
  dispatch?: DispatchStateHandle;
  /**
   * 一覧を下へ引っ張ったときに実行する更新（#1893）。**渡した画面でだけ有効になる。**
   * 引っ張るという操作はタッチにしか無く、PCの一覧は渡さないので今までどおり。
   */
  onPullToRefresh?: () => Promise<unknown> | void;
  /**
   * 最終取得時刻（ISO8601）。未取得・渡さない場合は出さない（#1797）。
   * PR一覧・ブランチ画面と同じ「◯件 ・ HH:MM時点」の形でヘッダーに出す。
   */
  fetchedAt?: string | null;
  /**
   * 自動更新の間隔（#1797）。`null`＝自動更新しない。**渡した一覧だけがヘッダーに状態を出す**
   * ——取り直しを持たない一覧（Issue詳細から開く小さな一覧など）に「手動更新のみ」と
   * 出しても、押す手段が無いことしか伝わらない。
   */
  autoRefreshIntervalMs?: AutoRefreshIntervalMs;
};

// 要対応ラベル（00.check-userと、その理由を表す01.check-*）と、廃止済みの進捗ラベル
// （01〜09番台。#991 Phase 5・#1010）が他リポジトリに残っていた場合は、カード右上の
// WorkflowStepBadgeが進捗と確認待ちの理由を表現するため、下部のラベル一覧からは除外する。
// **実装オプションのラベルも出さない**（#1915）。「実装を開始」ダイアログで選んだ走らせ方で、
// 盤面を眺めるときの手掛かりにならないうえ、ラベル行が2行に折り返してRemote Controlを
// 置く場所が無かった。付いているものをすべて見るのはIssue詳細の役割
function listCardLabels(labels: IssueLabel[]) {
  return labels.filter(
    (label) => !isProgressLabel(label.name) && !isStartImplementationOptionLabel(label.name),
  );
}

function IssueStateIcon({ issue }: { issue: Issue }) {
  if (issue.state === "open") {
    return <CircleDot className="size-3 shrink-0 text-green-600" aria-label="Open" />;
  }
  if (issue.stateReason === "not_planned") {
    return (
      <CircleSlash
        className="size-3 shrink-0 text-muted-foreground"
        aria-label={closedStateLabel(issue.stateReason)}
      />
    );
  }
  return (
    <CircleCheck
      className="size-3 shrink-0 text-purple-600"
      aria-label={closedStateLabel(issue.stateReason)}
    />
  );
}

/**
 * 前提条件がそろっているか（#1763。#2003で手作業Issue以外にも出すようにした）。
 * Issue詳細の「前提条件の状況」（#1705）と同じ判定・同じ配色（emerald／amber）で、
 * 一覧のまま「どれをいま進められるか」が分かるようにする。
 *
 * **前提を書いていないIssueには何も出ない**（`computeIssuePrerequisiteReadiness`が載せない）。
 * 全行にアイコンが並ぶと、前提待ちの橙が埋もれる。
 *
 * 説明は`title`（PCのホバー）と`aria-label`に持たせる。スマホはホバーできないため、
 * 内訳はヘッダーの件数（`formatManualStepListCount`）とIssue詳細が担う。
 */
/**
 * 完了の確認コマンドが定期巡回で通った印（#2008）。
 *
 * **前提条件の印（`ManualStepReadinessIcon`）とは別に出す。** あちらは「いま実行してよいか」、
 * こちらは「もう実行し終えているかもしれない」で、答えている問いが違う。手作業Issueの色である
 * violet（`71.manual-step`ラベルと同じ）を使い、前提の緑・橙と読み違えないようにする。
 */
function ManualStepVerifiedIcon({ verifiedAt }: { verifiedAt: string | null }) {
  if (!verifiedAt) return null;
  const label = `完了済みの可能性（${formatDateTime(verifiedAt)}の巡回で確認コマンドがすべて成功）`;
  return (
    <span title={label} className="flex shrink-0 items-center">
      <BadgeCheck
        className="size-3.5 text-violet-600 dark:text-violet-400"
        aria-label={label}
      />
    </span>
  );
}

function ManualStepReadinessIcon({ readiness }: { readiness: ManualStepReadiness | undefined }) {
  if (!readiness) return null;
  const Icon = readiness.ready ? CircleCheckBig : Clock;
  return (
    <span title={readiness.message} className="flex shrink-0 items-center">
      <Icon
        className={cn(
          "size-3.5",
          readiness.ready
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-amber-600 dark:text-amber-400",
        )}
        aria-label={readiness.ready ? "前提条件がそろっている" : "前提条件の完了待ち"}
      />
    </span>
  );
}

/**
 * 質問Issueの状態ラベル（#1796）。**「質問」ビューに限らず、質問Issueが並ぶ行すべてに出す。**
 * 状態はIssue自体の性質で、どのビューから見ても同じものだから。
 *
 * 読み終わったもの（`confirmed`）と質問以外（null）には何も出さない——一覧の大半を占める
 * 通常のIssueにまでラベルが増えると、隣に並ぶGitHubのラベルが読めなくなる。
 */
function QuestionStateBadge({ state }: { state: QuestionState | null }) {
  if (state !== "unconfirmed" && state !== "waiting") return null;
  const unconfirmed = state === "unconfirmed";
  return (
    <span
      title={
        unconfirmed
          ? "回答が届いていますが、まだ開いていません"
          : "質問を投げたところで、まだ回答が届いていません"
      }
      className={cn(
        "flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset",
        unconfirmed
          ? "bg-amber-500/15 text-amber-700 ring-amber-500 dark:text-amber-400"
          : "bg-blue-500/15 text-blue-700 ring-blue-500 dark:text-blue-400",
      )}
    >
      {unconfirmed ? "未確認" : "回答待ち"}
    </span>
  );
}

// グループ表示中は各行のリポジトリ名表示がヘッダーと重複するため省略する（#849）
function GroupHeader({ group }: { group: IssueRepositoryGroup }) {
  return (
    <div className="flex items-center gap-1.5 border-b bg-muted/50 px-4 py-2 text-xs font-semibold text-muted-foreground">
      <span className="truncate">{group.repositoryFullName.split("/")[1]}</span>
      {group.repositoryArchived && <Archive className="size-3 shrink-0" aria-label="アーカイブ済み" />}
      {group.repositoryPrivate && <Lock className="size-3 shrink-0" aria-label="プライベート" />}
      <span className="ml-auto shrink-0">{group.issues.length}件</span>
    </div>
  );
}

/**
 * 一覧の上に並ぶ「〜が n件あります。」の入口バー（手作業アシスタント・「次にやること」・
 * まとめて実行）で共有する見た目。
 *
 * **入りきらないときは折り返す**（#2107）。以前は1行固定の`flex`で、右のバッジ・ボタンだけに
 * `shrink-0`が付いていた。中央カラムは手で狭められる（#381）ため、縮められるものが左の
 * `flex-1`のテキストしか無くなり、幅0まで潰れて1文字ずつ縦に並ぶ。右が「自動実行 n / m」
 * バッジとボタンの2つになる手作業のバーで最初に起きる。
 *
 * - `flex-wrap`＋テキストの`basis-48`（12rem）で、テキストが読める幅を切ったらボタン側が
 *   次の行へ落ちる。**基準幅を与えるのが肝**で、`flex-1`（`basis-0%`）のままだと
 *   テキストは幅0まで縮むだけで折り返しの合図にならない
 * - 伸ばす指定は`flex-1`ではなく`grow`にする。`flex-1`は`flex`ショートハンドなので
 *   `basis-48`と同じ`flex-basis`を奪い合い、どちらが勝つかがTailwindのCSS出力順に依存する
 *   （いまの版は`basis-*`が後に出るので効くが、順が変われば黙って1文字ずつに戻る）。
 *   `grow`は`flex-grow`だけを触るので競合しない
 * - 落ちたボタン側は`ml-auto`で右端に残す。左端に来ると本文と縦に並び、押す場所が読みにくい
 * - 幅に余裕があるときの見た目は従来どおり（1行・テキスト左・ボタン右）
 */
const COUNT_BAR_CLASS = "flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b px-4 py-2";
const COUNT_BAR_TEXT_CLASS = "min-w-0 grow basis-48 text-xs text-muted-foreground";
const COUNT_BAR_ACTIONS_CLASS = "ml-auto flex shrink-0 items-center gap-2";

export function IssueList({
  title,
  issues,
  selectedIssueId,
  onSelectIssue,
  className,
  style,
  showSearch = true,
  showHeader = true,
  fabSpacing = false,
  footerSpacing = false,
  scrollKey = null,
  groupByRepo = false,
  view,
  pinnedSection,
  pinnedCount = 0,
  prerequisiteReadiness,
  checkUserRunningIssueIds,
  onStartManualStepGuide,
  onStartIssueOrder,
  onStartCodeReview,
  issueOrderAutoStart = false,
  issueOrderCount = 0,
  filtersIgnored = false,
  dispatch: injectedDispatch,
  onPullToRefresh,
  fetchedAt = null,
  autoRefreshIntervalMs,
}: IssueListProps) {
  // 実行先の解決（#1262）。`GET /api/dispatch`は一覧ぶんをまとめて返すので、Issueの件数に
  // 関わらず取得は1本で足りる。**Actionsの実行を期待できないIssueをポーリングから外す**ため、
  // ポーリングのフックより先に求める必要がある。
  const ownDispatch = useDispatchState(injectedDispatch === undefined);
  const dispatch = injectedDispatch ?? ownDispatch;
  const executionTargetByIssueId = useMemo(() => {
    const map = new Map<string, IssueExecutionTarget>();
    for (const issue of issues) {
      map.set(
        issue.id,
        resolveIssueExecutionTarget({
          repositoryFullName: issue.repositoryFullName,
          issueNumber: issue.number,
          labels: issue.labels,
          jobs: dispatch.jobs,
          sessions: dispatch.sessions,
        }),
      );
    }
    return map;
  }, [issues, dispatch.jobs, dispatch.sessions]);
  // セッション（#1264）。添える文言（入力待ち・終了・異常終了）と、バッジの外周を回すかどうか
  // （#1439）の両方をバッジ側がここから決める
  const sessionByIssueId = useMemo(() => {
    const map = new Map<string, DispatchSessionView>();
    for (const issue of issues) {
      const session = findSessionForIssue(
        dispatch.sessions,
        issue.repositoryFullName,
        issue.number,
      );
      if (session) map.set(issue.id, session);
    }
    return map;
  }, [issues, dispatch.sessions]);
  // 計画への返事待ち（#2061）。**待っている行だけ「計画を承認」を出す**ための集合で、
  // 押した先はアプリの中（そのIssueを開くと上部に計画パネルが出る）
  const planPendingIssueIds = useMemo(() => {
    const ids = new Set<string>();
    // **テストの差し込みや古い応答では欠けうる**ので、無ければ「待っているものは無い」として読む
    const requests = dispatch.planRequests ?? [];
    if (requests.length === 0) return ids;
    for (const issue of issues) {
      const request = findPlanRequestForIssue(
        requests,
        issue.repositoryFullName,
        issue.number,
      );
      if (request?.status === "WAITING") ids.add(issue.id);
    }
    return ids;
  }, [issues, dispatch.planRequests]);
  const actionsUnexpectedIssueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, target] of executionTargetByIssueId) {
      if (!target.expectsActionsRun) ids.add(id);
    }
    return ids;
  }, [executionTargetByIssueId]);
  const runningByIssueId = useIssuesWorkflowRunning(issues, actionsUnexpectedIssueIds);
  // セッションの報告が途絶えたまま回り続けるのを止めるための現在時刻（#1439）。
  // 30秒ごとに更新されれば足りる（判定のしきい値は5分）
  const now = useNow();
  // 押した行を即座にハイライトするための楽観表示（#1597）。選択の正はURLクエリ
  // （`?issue=`）で、その更新はReactのトランジション＝低優先度の更新として入るため、
  // 右カラム（IssueDetail・プロパティパネル）の再描画が終わるまでハイライトが動かない。
  // ここは行のクリックで直接（緊急の更新として）持ち、正の選択が追いついたら捨てる。
  const [optimisticSelectedId, setOptimisticSelectedId] = useState<string | null>(null);
  // 正の選択が変わったら楽観表示は用済み。別経路（確認待ちトースト・本文中のIssueリンク）で
  // 選択が変わった場合も、こちらが古い行を指し続けないようここで揃える。effectで同期すると
  // 描画が1回余分に走るため、レンダー中に比較して更新する（topbar.tsxの検索欄と同じ形）。
  const [syncedSelectedIssueId, setSyncedSelectedIssueId] = useState(selectedIssueId);
  if (selectedIssueId !== syncedSelectedIssueId) {
    setSyncedSelectedIssueId(selectedIssueId);
    setOptimisticSelectedId(null);
  }
  const highlightedIssueId = optimisticSelectedId ?? selectedIssueId;

  // まとめてサブPCへ積むための選択（#1266）。**既定はオフ**で、行のクリックは従来どおり
  // Issueを開く。選択モードのときだけチェックボックスを出す
  const [isSelecting, setIsSelecting] = useState(false);
  // 入口のバーを出すかどうかの判定（#1993）。**押しても何も起きない件数を出さない**ため、
  // closeしたIssueと既に走っている（積んである）Issueは数えない
  // GitHub Actionsで走っている最中のIssueも数えない（#2032）。材料はこの一覧が既に
  // ポーリングしている実行状況（`runningByIssueId`）で、GitHub APIは追加で叩かない
  const actionsRunningIssueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, state] of Object.entries(runningByIssueId)) {
      if (state?.isRunning) ids.add(id);
    }
    return ids;
  }, [runningByIssueId]);
  const bulkDispatchableIssues = useMemo(
    () =>
      listBulkDispatchableIssues(issues, {
        hosts: dispatch.hosts,
        jobs: dispatch.jobs,
        sessions: dispatch.sessions,
        actionsRunningIssueIds,
      }),
    [issues, dispatch.hosts, dispatch.jobs, dispatch.sessions, actionsRunningIssueIds],
  );
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const itemRefs = useRef(new Map<string, HTMLLIElement>());
  const listRef = useRef<HTMLUListElement>(null);
  // 引っ張って更新（#1893）。タッチを受けるのは一覧を包む枠で、スクロール位置は<ul>から見る
  // （0件のときは<ul>ごと消えるため、<ul>に直接付けると空の一覧で引っ張れなくなる）
  const pullContainerRef = useRef<HTMLDivElement>(null);
  const pull = usePullToRefresh({
    containerRef: pullContainerRef,
    scrollRef: listRef,
    onRefresh: onPullToRefresh,
  });
  const issueIds = useMemo(() => issues.map((issue) => issue.id), [issues]);

  // 一覧が再マウントされた直後（Issue詳細から戻ってきた等）に、直前まで見ていた位置へ戻す。
  // scrollIntoView()は祖先のoverflow-hiddenコンテナ（ヘッダー等を含む）まで巻き込んで
  // スクロールさせてしまうため使わず、<ul>自身のscrollTopのみを直接操作する。
  useIssueListScroll({ scrollKey, issueIds, selectedIssueId, listRef, itemRefs });

  // リポジトリが1種類しかない場合（絞り込みで単一リポジトリのときなど）はヘッダーを
  // 出す意味がないため、フラット表示のまま扱う。
  const repoGroups = useMemo(
    () =>
      groupByRepo
        ? groupIssuesByRepository(issues, { sortByLatestClosedAt: view === "recently-merged" })
        : null,
    [groupByRepo, issues, view],
  );
  const isGrouped = Boolean(repoGroups && repoGroups.length > 1);

  // 「ユーザーの作業待ち」だけは、左メニューと同じ「いま実行できる件数」を先に出し、
  // 差である前提待ちを添える（#1763）。「質問」は総数に未確認の内訳を添える（#1796。
  // 左メニューの数字は総数のままで、色でしか未確認の有無が出ないため）。
  // 「ユーザーの確認待ち」も同じ形で、実行中のぶんを差として添える（#2174）。
  // 他のビューは今までどおり並んでいる行数。
  const listedCount = issues.length + pinnedCount;
  const checkUserRunningCount =
    view === "check-user" && checkUserRunningIssueIds
      ? issues.filter((issue) => checkUserRunningIssueIds.has(issue.id)).length
      : 0;
  const countLabel =
    (view === "manual-step" && prerequisiteReadiness
      ? formatManualStepListCount(issues, prerequisiteReadiness)
      : null) ??
    (view === "question" ? formatQuestionListCount(issues, listedCount) : null) ??
    formatCheckUserListCount(listedCount, checkUserRunningCount) ??
    `${listedCount}件`;

  // アシスタントが案内できるのは「いま実行できる」手作業だけ（`buildManualStepQueue`）。
  // 1件も無いときにボタンを出すと、押しても何も案内されない画面が開く
  const guidableManualStepCount =
    view === "manual-step" && prerequisiteReadiness
      ? issues.filter((issue) => prerequisiteReadiness.get(issue.id)?.ready === true).length
      : 0;

  // 走っている自動実行（#1882）。**入口に出すのはこの一覧に居る手作業の分だけ**——
  // 別のビューを見ているときに手作業の進捗を割り込ませない。
  // **#2073で実行キューの節を撤去したので、進み具合が出る常設の場所はここだけ**
  // （ここはバッジで、中断できるのはアシスタントの中）
  // **拾うのは走っている全件**（#2119）。`.find`で先頭1件しか見ていなかったため、
  // 複数走っていても1件ぶんの進捗しか出ず、2本目以降は画面のどこにも出ていなかった
  const activeManualStepRuns =
    view === "manual-step"
      ? sortManualStepRunsForList(
          (dispatch.manualStepRuns ?? []).filter(
            (run) =>
              isActiveManualStepRun(run.status) &&
              issues.some(
                (issue) =>
                  issue.repositoryFullName === run.repositoryFullName &&
                  issue.number === run.issueNumber,
              ),
          ),
        )
      : [];

  function toggleSelected(issueId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(issueId)) next.delete(issueId);
      else next.add(issueId);
      return next;
    });
  }

  function exitSelecting() {
    setIsSelecting(false);
    setSelectedIds(new Set());
  }

  function renderIssueRow(issue: Issue, showRepoName: boolean) {
    // 一覧から直接開く出口（#1915）。**出す条件はIssue詳細（`IssueSessionStatus`）と同じ**で、
    // 判定は`summarizeIssueSession`に任せる。終了したセッション・まだ開始していないセッションの
    // URLは開いても意味が無く、そこで同じ分岐をここに書き足すと片方だけ古くなる
    const remoteControlUrl = (() => {
      const session = sessionByIssueId.get(issue.id);
      return session ? summarizeIssueSession(session).remoteControlUrl : null;
    })();
    // 押さないと先へ進まない行を見分けられるようにする（#1964）。**出す条件とは別物**で、
    // 判定は`shouldEmphasizeRemoteControl`に置いてある
    // 計画への返事を画面から送れる行（#2061）。**ここが主導線になり、Remote Controlは
    // 通常の枠線へ戻る**（`shouldEmphasizeRemoteControl`が`false`を返す）
    const planPending = planPendingIssueIds.has(issue.id);
    const emphasizeRemoteControl = shouldEmphasizeRemoteControl({
      labels: issue.labels,
      session: sessionByIssueId.get(issue.id) ?? null,
      planDecisionPending: planPending,
    });
    return (
      <li
        key={issue.id}
        ref={(el) => {
          if (el) itemRefs.current.set(issue.id, el);
          else itemRefs.current.delete(issue.id);
        }}
        className={cn(
          // isolateで行の中に重なり順を閉じ込める（#1945）。下のz-0/z-10は当たり判定と本文の
          // 前後だけを決めたいもので、これが無いと一覧の外にある要素（右下の丸ボタンなど）と
          // 同じ土俵で比較され、z-indexを持たない側が一覧の後ろへ回ってしまう
          "relative isolate border-b border-l-4 border-l-transparent hover:bg-accent",
          highlightedIssueId === issue.id && !isSelecting && "border-l-primary bg-accent",
          isSelecting && selectedIds.has(issue.id) && "border-l-primary bg-accent",
        )}
      >
        {/* 行を選ぶ当たり判定（#1915）。**本文を包む`<button>`にしない。** ラベル行へ足した
            Remote Controlはリンク（`<a>`）で、ボタンの中に置くと不正なHTMLになり、押したときに
            Issueの選択まで走る。カード全面へ敷いたこのボタンを本文の下に置き、本文側は
            ポインタを透過させることで、見た目を変えずに「カードのどこを押しても選択」を保つ */}
        <button
          type="button"
          aria-label={`#${issue.number} ${issue.title}`}
          onClick={() => {
            if (isSelecting) {
              toggleSelected(issue.id);
              return;
            }
            setOptimisticSelectedId(issue.id);
            onSelectIssue(issue);
          }}
          className="absolute inset-0 z-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        />
        <div className="pointer-events-none relative z-10 flex w-full flex-col gap-1.5 px-4 py-3 text-left">
          <div className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              {isSelecting && (
                <Checkbox
                  checked={selectedIds.has(issue.id)}
                  aria-label={`#${issue.number}を選択`}
                  className="mr-1"
                  // 行のonClickが選択を切り替えるので、二重に反応させない
                  onClick={(event) => event.preventDefault()}
                />
              )}
              <IssueStateIcon issue={issue} />
              {showRepoName && (
                <>
                  <span className="truncate">{issue.repositoryFullName.split("/")[1]}</span>
                  {issue.repositoryArchived && (
                    <Archive className="size-3 shrink-0" aria-label="アーカイブ済み" />
                  )}
                  {issue.repositoryPrivate && (
                    <Lock className="size-3 shrink-0" aria-label="プライベート" />
                  )}
                </>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              <ManualStepVerifiedIcon verifiedAt={issue.manualStepVerifiedAt} />
              <ManualStepReadinessIcon readiness={prerequisiteReadiness?.get(issue.id)} />
              <WorkflowStepBadge
                labels={issue.labels}
                projectStatus={issue.projectStatus}
                running={runningByIssueId[issue.id]}
                qaAnswerPending={Boolean(issue.qaAnswerPendingAt)}
                executionTarget={executionTargetByIssueId.get(issue.id)}
                session={sessionByIssueId.get(issue.id) ?? null}
                now={now}
              />
              {issue.favorite && (
                <Star
                  className="size-3.5 fill-yellow-400 text-yellow-400"
                  aria-label="お気に入り"
                />
              )}
              <UserAvatar login={issue.assignee?.login ?? issue.author.login} />
            </span>
          </div>
          <p
            className={cn(
              "flex items-start gap-1.5 text-sm",
              issue.hasUnreadComments ? "font-semibold" : "font-medium",
            )}
          >
            {issue.hasUnreadComments && (
              <span
                className="mt-1.5 size-1.5 shrink-0 rounded-full bg-blue-500"
                aria-label="未読コメントあり"
              />
            )}
            <span className="line-clamp-2 min-w-0 break-words">
              #{issue.number} {issue.title}
            </span>
          </p>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <div className="flex flex-wrap items-center gap-1">
              <QuestionStateBadge state={resolveQuestionState(issue)} />
              {listCardLabels(issue.labels).map((label) => (
                <span
                  key={label.name}
                  className="flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] ring-1 ring-inset ring-border"
                  style={getLabelBadgeStyle(label.color)}
                >
                  {label.name}
                </span>
              ))}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {/* 計画の承認へ入る（#2061）。**行き先はアプリの中**で、押すとそのIssueが開き、
                  上部に計画パネル（「計画の承認を待っています」）が出る。ここを出す間は
                  Remote Controlの強調を下ろすので、行の中でオレンジは1つに保たれる。
                  **`<a>`ではなく`<button>`**——外部へ出る導線ではないため */}
              {planPending && (
                <Button
                  variant="outline"
                  size="xs"
                  className="pointer-events-auto border-amber-500 text-amber-700 hover:text-amber-700 dark:border-amber-500 dark:text-amber-400 dark:hover:text-amber-400"
                  title="計画を承認する"
                  aria-label={`#${issue.number}の計画を承認する`}
                  onClick={(event) => {
                    // 行そのものの当たり判定（カード全面のボタン）へ伝わらないようにする。
                    // 開く先は同じだが、二重に走らせない
                    event.stopPropagation();
                    setOptimisticSelectedId(issue.id);
                    onSelectIssue(issue);
                  }}
                >
                  <ScrollText />
                  計画を承認
                </Button>
              )}
              {/* 走っているセッションを一覧から開く（#1915）。**ラベル行の右端に置く**——
                  カードの下へ1行足すと、セッションのあるカードだけ高さが変わって一覧が
                  不揃いになる。文言は「Remote」まで詰め、全文は`title`・`aria-label`に持たせる */}
              {remoteControlUrl && (
                <Button
                  variant="outline"
                  size="xs"
                  asChild
                  className={cn(
                    "pointer-events-auto",
                    // 回答を待っている行だけ枠線と文字をamberにする（#1964）。**中は塗らない**——
                    // 同じ形の行が縦に続く画面で、塗りつぶしたボタンは1つあるだけで視線を奪う。
                    // 面（背景）とホバーの挙動はoutlineのまま変えず、差は枠線と文字色だけにする。
                    // 色は右上のバッジ（`WorkflowStepBadge`）の確認待ちと同じamberを借りる。同じ行で
                    // 同じ意味に別の色を当てない。**回転・点滅はさせない**（あちらも承認待ちでは
                    // 意図的に回転を止めている。待っているのは人であって処理ではない）
                    emphasizeRemoteControl &&
                      "border-amber-500 text-amber-700 hover:text-amber-700 dark:border-amber-500 dark:text-amber-400 dark:hover:text-amber-400",
                  )}
                >
                  <a
                    href={remoteControlUrl}
                    target="_blank"
                    rel="noreferrer"
                    title="Remote Controlで開く"
                    aria-label={`#${issue.number}のRemote Controlで開く`}
                  >
                    <ExternalLink />
                    Remote
                  </a>
                </Button>
              )}
              {issue.commentCount > 0 && (
                <span className="flex items-center gap-0.5">
                  <MessageSquare className="size-3" />
                  {issue.commentCount}
                </span>
              )}
              {/* 一覧はサーバーでも描かれるため、現在時刻は描画中に読まず`useNow`から受ける
                  （#1891）。分単位で刻むようになったぶん、サーバーで描いた時刻と
                  ハイドレーション時刻が分の境界をまたぐと表示が食い違う。マウント前
                  （`now === null`）は出しようがないので出さない */}
              <span>{now === null ? null : formatRelativeDate(issue.updatedAt, now)}</span>
            </div>
          </div>
        </div>
      </li>
    );
  }

  return (
    // min-h-0が無いと、この要素を`flex-1`で縦に並べたとき（スマホのIssue一覧）に
    // Issue件数ぶんの高さまで縮まなくなる（#1665）。flexアイテムの`min-height: auto`は
    // 「中身の最小サイズ」に解決され、内側の`<ul>`がoverflow-y-autoでも外側のこの要素は
    // overflowがvisibleなので0まで縮まない。結果、下に並ぶ兄弟（下端の絞り込み行）が
    // 親のoverflow-hiddenの外へ押し出され、件数が多いときだけ消えて見えた。
    // PullRequestListが同じ症状を出さないのは、ルートにoverflow-hiddenがあるため。
    <div className={cn("flex h-full min-h-0 flex-col", className)} style={style}>
      {showSearch && (
        <div className="border-b p-3">
          <Input placeholder="キーワードで検索" />
        </div>
      )}

      {showHeader && (
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{title}</h2>
            <p className="truncate text-xs text-muted-foreground">
              {countLabel}
              {filtersIgnored && (
                <span title="このビューはリポジトリ横断で全体を表示します（#1750）。キーワード・リポジトリ・状態・ラベル・担当者の絞り込みは適用しません。">
                  {" ・ 絞り込みは適用外"}
                </span>
              )}
              {/* いつ時点の内容かと、自動更新の状態（#1797）。PR一覧・ブランチ画面と同じ並び・
                  同じ文言にそろえる。この一覧は開いている間ずっと10秒間隔で取り直しているが、
                  その形跡が画面に無く、止まっていても正常時と見分けが付かなかった */}
              {fetchedAt && <span>{` ・ ${formatTimeOfDay(fetchedAt)}時点`}</span>}
              {autoRefreshIntervalMs !== undefined && (
                <span>{` ・ ${describeAutoRefreshState(autoRefreshIntervalMs)}`}</span>
              )}
            </p>
          </div>
          <Star className="size-4 shrink-0 text-muted-foreground" />
        </div>
      )}

      {/* 溜まった手作業を1件ずつ案内する入口（#1826）。**ヘッダーではなく一覧の上に置く**——
          スマホの一覧はこのコンポーネントのヘッダーを出さず（`showHeader={false}`）、
          画面側のヘッダーには操作を足さない決まりのため（#1646）。ここならPC・スマホの
          どちらにも同じ位置で出る */}
      {onStartManualStepGuide &&
        (guidableManualStepCount > 0 || activeManualStepRuns.length > 0) && (
          <div className={cn(COUNT_BAR_CLASS, "bg-violet-500/5")}>
            <p className={COUNT_BAR_TEXT_CLASS}>
              いま実行できる手作業が
              <span className="font-medium text-foreground tabular-nums">
                {guidableManualStepCount}件
              </span>
              あります。
            </p>
            <div className={COUNT_BAR_ACTIONS_CLASS}>
              {/* 走っている自動実行があることを入口に出す（#1882）。**閉じても進んでいる**ので、
                  戻ってこられる目印がここに要る。押すと走っている実行が全部並び、行から
                  そのIssueのアシスタントを開ける（#2119） */}
              <ManualStepRunBadge
                runs={activeManualStepRuns}
                onOpenRun={(run) => {
                  // `run.issueId`は引けないことがあるので、並んでいるIssueから引き直す
                  const issue = issues.find(
                    (candidate) =>
                      candidate.repositoryFullName === run.repositoryFullName &&
                      candidate.number === run.issueNumber,
                  );
                  onStartManualStepGuide(issue?.id ?? run.issueId ?? undefined);
                }}
              />
              <Button size="xs" className="shrink-0" onClick={() => onStartManualStepGuide()}>
                <ListChecks />
                順番に進める
              </Button>
            </div>
          </div>
        )}

      {/* 未着手のIssueの着手順をClaudeに決めさせる入口（#1853）。手作業アシスタントと同じく
          ヘッダーではなく一覧の上に置くことで、PC・スマホのどちらにも同じ位置で出る。
          **自動開始が有効なら文言でそう伝える**——押した瞬間に実装セッションが積まれるので、
          「順番を決める」としか書いていないと、始まったことが押した本人から見えない */}
      {onStartIssueOrder && view === "not-started" && issueOrderCount > 0 && (
        <div className={cn(COUNT_BAR_CLASS, "bg-sky-500/5")}>
          <p className={COUNT_BAR_TEXT_CLASS}>
            未着手のIssueが
            <span className="font-medium tabular-nums text-foreground">{issueOrderCount}件</span>
            あります。
          </p>
          <div className={COUNT_BAR_ACTIONS_CLASS}>
            <Button size="xs" className="shrink-0" onClick={onStartIssueOrder}>
              <Compass />
              {issueOrderAutoStart ? "順番を決めて開始" : "順番を決める"}
            </Button>
          </div>
        </div>
      )}

      {/* リポジトリ全体のコードレビューを実行する入口（#698）。**このビュー唯一の起動口**なので、
          並んでいるIssueが0件でも出す */}
      {onStartCodeReview && view === "code-review" && (
        <div className={cn(COUNT_BAR_CLASS, "bg-emerald-500/5")}>
          <p className={COUNT_BAR_TEXT_CLASS}>
            リポジトリ全体を読ませて、指摘を受け取れます。
          </p>
          <div className={COUNT_BAR_ACTIONS_CLASS}>
            <Button size="xs" className="shrink-0" onClick={onStartCodeReview}>
              <ScanSearch />
              レビューを実行
            </Button>
          </div>
        </div>
      )}

      {/* 選んだIssueをまとめて実行する入口（#1266・#1993）。**ヘッダーではなく一覧の上に置く**——
          スマホの一覧はこのコンポーネントのヘッダーを出さない（`showHeader={false}`）ため、
          ヘッダーに置くとPCからしか押せない（手作業アシスタント・「次にやること」と同じ理由）。
          **出すのは積めるIssueが2件以上あるときだけ**で、1件しか無いなら個別の「実装を開始」で足りる */}
      {isSelecting ? (
        <BulkDispatchBar
          issues={issues.filter((issue) => selectedIds.has(issue.id))}
          dispatch={dispatch}
          actionsRunningIssueIds={actionsRunningIssueIds}
          onClose={exitSelecting}
        />
      ) : (
        bulkDispatchableIssues.length >= 2 && (
          <div className={cn(COUNT_BAR_CLASS, "bg-muted/40")}>
            <p className={COUNT_BAR_TEXT_CLASS}>
              まとめて実行できるIssueが
              <span className="font-medium text-foreground tabular-nums">
                {bulkDispatchableIssues.length}件
              </span>
              あります。
            </p>
            <div className={COUNT_BAR_ACTIONS_CLASS}>
              <Button
                size="xs"
                variant="outline"
                className="shrink-0"
                onClick={() => setIsSelecting(true)}
              >
                <CheckSquare />
                まとめて実行
              </Button>
            </div>
          </div>
        )
      )}

      {/* 一覧のoverscroll-containは、端まで到達したあとの慣性スクロールが
          ドキュメント側へ伝播してヘッダー・フッターごと動くのを防ぐ（#607） */}
      {/* 引っ張って更新（#1893）のタッチを受ける枠。**0件のときも枠は残す**——<ul>は0件で
          消えるため、<ul>に直接付けると「該当するIssueがありません」の一覧を更新できない */}
      {/* **`pinnedSection`もこの枠の中に入れる**（#2175）。確認待ちの先頭に固定している
          マージ待ちPull Request（#1613）は画面の上半分を占めることがあり、枠の外に置くと
          そこを下へなぞってもタッチが届かず「引っ張っても何も起きない」ことになる */}
      <div ref={pullContainerRef} className="relative flex min-h-0 flex-1 flex-col">
        <PullToRefreshIndicator pull={pull} />

        {/* 引っ張りに追従して下がるのは<ul>だけでなく固定セクションも含めた中身全体。
            片方だけ下げると、引いている最中に固定セクションと一覧の境目が割れて見える */}
        <div
          className="flex min-h-0 flex-1 flex-col"
          style={{
            transform: pull.distance > 0 ? `translateY(${pull.distance}px)` : undefined,
            transition: pull.isDragging ? "none" : "transform 0.2s ease-out",
          }}
        >
          {pinnedSection}

          {issues.length === 0 ? (
            <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
              該当するIssueがありません
            </div>
          ) : (
            // relativeは各行のoffsetTopの基準を<ul>自身にするために必要（#773）。付けないと
            // offsetParentが外側の要素（スマホならMobileIssueListScreenのルート）になり、
            // offsetTopにヘッダー・タブの高さが含まれてしまう（実測で145pxずれる）。
            // アンカーによる復元は保存時との差分を取るためこのずれが相殺されるが、保存済み位置が
            // 無いときの中央寄せ（computeCenteredIssueListScrollTop）は生のoffsetTopを使うため、
            // 基準を揃えないと同じ分だけ下にずれる。
            // flex-1・min-h-0は、包む枠（引っ張って更新のタッチを受ける枠）の中でも件数ぶんの
            // 高さまで伸びず、残りを埋めるだけにするために要る（#1665と同じ理由）。
            // 引っ張りに追従するtransformは1つ外の枠が持つ（#2175）。transformはoffsetTopに
            // 影響しないため、追従は上の2つと両立する。
            <ul
              ref={listRef}
              className={cn(
                "relative min-h-0 flex-1 overflow-y-auto overscroll-contain",
                fabSpacing && "pb-20",
              )}
            >
              {isGrouped
                ? repoGroups!.flatMap((group) => [
                    <li key={`group-${group.repositoryFullName}`}>
                      <GroupHeader group={group} />
                    </li>,
                    ...group.issues.map((issue) => renderIssueRow(issue, false)),
                  ])
                : issues.map((issue) => renderIssueRow(issue, true))}
              {/* MobileBottomNavのnav（min-h-14）と同じ高さの空白。ボトムナビは通常フローの
                  兄弟要素で本来重ならないはずだが、実機では末尾のIssueがフッターに隠れて
                  見えない事象が報告されたため、スクロールで確実に隠れずに表示できるよう
                  保険として同じ高さの空白ボックスを追加する（#677） */}
              {footerSpacing && <li aria-hidden className="h-14 shrink-0" />}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
