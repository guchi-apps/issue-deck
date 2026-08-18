"use client";

import { useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  Archive,
  CheckSquare,
  CircleCheck,
  CircleCheckBig,
  CircleDot,
  CircleSlash,
  Clock,
  Compass,
  ExternalLink,
  ListChecks,
  Loader2,
  Lock,
  MessageSquare,
  Star,
} from "lucide-react";

import { BulkDispatchBar } from "@/components/dashboard/bulk-dispatch-bar";
import { UserAvatar } from "@/components/dashboard/user-avatar";
import { WorkflowStepBadge } from "@/components/dashboard/workflow-status-steps";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useDispatchState, type DispatchStateHandle } from "@/hooks/use-dispatch-state";
import { useIssueListScroll } from "@/hooks/use-issue-list-scroll";
import { useIssuesWorkflowRunning } from "@/hooks/use-issues-workflow-running";
import { useNow } from "@/hooks/use-now";
import {
  resolveIssueExecutionTarget,
  type IssueExecutionTarget,
} from "@/lib/dispatch/issue-execution-target";
import { findSessionForIssue, summarizeIssueSession } from "@/lib/dispatch/issue-session";
import { isActiveManualStepRun } from "@/lib/manual-step-run-view";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
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
  manualStepReadiness?: ManualStepReadinessMap;
  /**
   * 手作業アシスタント（#1826）を開く。「ユーザーの作業待ち」でだけ使う。
   * 渡さない・実行できる手作業が1件も無い場合はボタンを出さない
   */
  onStartManualStepGuide?: () => void;
  /**
   * 「次にやること」（#1853）を開く。「未着手」でだけ使う。
   * 渡さない・未着手が1件も無い場合はボタンを出さない。
   * `CLAUDE_CODE_OAUTH_TOKEN`が未設定の環境では親（`useIssueOrderGuide`の`notConfigured`）が
   * 渡すのをやめるので、押しても何も起きないボタンが残らない
   */
  onStartIssueOrder?: () => void;
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
 * 手作業Issueの前提条件がそろっているか（#1763）。Issue詳細の「前提条件の状況」（#1705）と
 * 同じ判定・同じ配色（emerald／amber）で、一覧のまま「どれをいま実行できるか」が分かるようにする。
 *
 * 説明は`title`（PCのホバー）と`aria-label`に持たせる。スマホはホバーできないため、
 * 内訳はヘッダーの件数（`formatManualStepListCount`）とIssue詳細が担う。
 */
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
  manualStepReadiness,
  onStartManualStepGuide,
  onStartIssueOrder,
  issueOrderAutoStart = false,
  issueOrderCount = 0,
  filtersIgnored = false,
  dispatch: injectedDispatch,
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
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const itemRefs = useRef(new Map<string, HTMLLIElement>());
  const listRef = useRef<HTMLUListElement>(null);
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
  // 他のビューは今までどおり並んでいる行数。
  const listedCount = issues.length + pinnedCount;
  const countLabel =
    (view === "manual-step" && manualStepReadiness
      ? formatManualStepListCount(issues, manualStepReadiness)
      : null) ??
    (view === "question" ? formatQuestionListCount(issues, listedCount) : null) ??
    `${listedCount}件`;

  // アシスタントが案内できるのは「いま実行できる」手作業だけ（`buildManualStepQueue`）。
  // 1件も無いときにボタンを出すと、押しても何も案内されない画面が開く
  const guidableManualStepCount =
    view === "manual-step" && manualStepReadiness
      ? issues.filter((issue) => manualStepReadiness.get(issue.id)?.ready === true).length
      : 0;

  // 走っている自動実行（#1882）。**入口に出すのはこの一覧に居る手作業の分だけ**——
  // 別のビューを見ているときに手作業の進捗を割り込ませない（進み具合は実行キューでも見られる）
  const activeManualStepRun =
    view === "manual-step"
      ? ((dispatch.manualStepRuns ?? []).find(
          (run) =>
            isActiveManualStepRun(run.status) &&
            issues.some(
              (issue) =>
                issue.repositoryFullName === run.repositoryFullName &&
                issue.number === run.issueNumber,
            ),
        ) ?? null)
      : null;

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
    return (
      <li
        key={issue.id}
        ref={(el) => {
          if (el) itemRefs.current.set(issue.id, el);
          else itemRefs.current.delete(issue.id);
        }}
        className={cn(
          "relative border-b border-l-4 border-l-transparent hover:bg-accent",
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
              <ManualStepReadinessIcon readiness={manualStepReadiness?.get(issue.id)} />
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
              {/* 走っているセッションを一覧から開く（#1915）。**ラベル行の右端に置く**——
                  カードの下へ1行足すと、セッションのあるカードだけ高さが変わって一覧が
                  不揃いになる。文言は「Remote」まで詰め、全文は`title`・`aria-label`に持たせる */}
              {remoteControlUrl && (
                <Button variant="outline" size="xs" asChild className="pointer-events-auto">
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
          <div>
            <h2 className="text-sm font-semibold">{title}</h2>
            <p className="text-xs text-muted-foreground">
              {countLabel}
              {filtersIgnored && (
                <span title="このビューはリポジトリ横断で全体を表示します（#1750）。キーワード・リポジトリ・状態・ラベル・担当者の絞り込みは適用しません。">
                  {" ・ 絞り込みは適用外"}
                </span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* 夜にまとめて積んで順に流すための入口（#1266） */}
            <button
              type="button"
              aria-label={isSelecting ? "選択をやめる" : "まとめて選択"}
              title={isSelecting ? "選択をやめる" : "まとめてサブPCへ積む"}
              onClick={() => (isSelecting ? exitSelecting() : setIsSelecting(true))}
              className={cn(
                "rounded-md p-1 hover:bg-accent",
                isSelecting ? "text-primary" : "text-muted-foreground",
              )}
            >
              <CheckSquare className="size-4" />
            </button>
            <Star className="size-4 text-muted-foreground" />
          </div>
        </div>
      )}

      {isSelecting && (
        <BulkDispatchBar
          issues={issues.filter((issue) => selectedIds.has(issue.id))}
          dispatch={dispatch}
          onDone={exitSelecting}
        />
      )}

      {/* 溜まった手作業を1件ずつ案内する入口（#1826）。**ヘッダーではなく一覧の上に置く**——
          スマホの一覧はこのコンポーネントのヘッダーを出さず（`showHeader={false}`）、
          画面側のヘッダーには操作を足さない決まりのため（#1646）。ここならPC・スマホの
          どちらにも同じ位置で出る */}
      {onStartManualStepGuide && (guidableManualStepCount > 0 || activeManualStepRun !== null) && (
        <div className="flex items-center gap-2 border-b bg-violet-500/5 px-4 py-2">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            いま実行できる手作業が
            <span className="font-medium text-foreground tabular-nums">
              {guidableManualStepCount}件
            </span>
            あります。
          </p>
          {/* 走っている自動実行があることを入口に出す（#1882）。**閉じても進んでいる**ので、
              戻ってこられる目印がここに要る（押すとアシスタントが開く） */}
          {activeManualStepRun !== null && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-700 tabular-nums dark:text-amber-300">
              {activeManualStepRun.status === "RUNNING" && (
                <Loader2 className="size-3 animate-spin" aria-hidden />
              )}
              自動実行 {activeManualStepRun.done} / {activeManualStepRun.total}
            </span>
          )}
          <Button size="xs" className="shrink-0" onClick={onStartManualStepGuide}>
            <ListChecks />
            順番に進める
          </Button>
        </div>
      )}

      {/* 未着手のIssueの着手順をClaudeに決めさせる入口（#1853）。手作業アシスタントと同じく
          ヘッダーではなく一覧の上に置くことで、PC・スマホのどちらにも同じ位置で出る。
          **自動開始が有効なら文言でそう伝える**——押した瞬間に実装セッションが積まれるので、
          「順番を決める」としか書いていないと、始まったことが押した本人から見えない */}
      {onStartIssueOrder && view === "not-started" && issueOrderCount > 0 && (
        <div className="flex items-center gap-2 border-b bg-sky-500/5 px-4 py-2">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            未着手のIssueが
            <span className="font-medium tabular-nums text-foreground">{issueOrderCount}件</span>
            あります。
          </p>
          <Button size="xs" className="shrink-0" onClick={onStartIssueOrder}>
            <Compass />
            {issueOrderAutoStart ? "順番を決めて開始" : "順番を決める"}
          </Button>
        </div>
      )}

      {pinnedSection}

      {/* 一覧のoverscroll-containは、端まで到達したあとの慣性スクロールが
          ドキュメント側へ伝播してヘッダー・フッターごと動くのを防ぐ（#607） */}
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
        <ul
          ref={listRef}
          className={cn(
            "relative flex-1 overflow-y-auto overscroll-contain",
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
  );
}
