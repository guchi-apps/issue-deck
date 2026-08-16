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
  Lock,
  MessageSquare,
  Star,
} from "lucide-react";

import { BulkDispatchBar } from "@/components/dashboard/bulk-dispatch-bar";
import { UserAvatar } from "@/components/dashboard/user-avatar";
import { WorkflowStepBadge } from "@/components/dashboard/workflow-status-steps";
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
import { findSessionForIssue } from "@/lib/dispatch/issue-session";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import { closedStateLabel } from "@/lib/issue-state-reason";
import { groupIssuesByRepository, type IssueRepositoryGroup } from "@/lib/issue-stats";
import { isProgressLabel } from "@/lib/issue-status";
import {
  formatManualStepListCount,
  type ManualStepReadiness,
  type ManualStepReadinessMap,
} from "@/lib/manual-step-attention";
import { getLabelBadgeStyle } from "@/lib/label-color";
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

function formatRelativeDate(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) return "今日";
  if (diffDays === 1) return "1日前";
  return `${diffDays}日前`;
}

// 要対応ラベル（00.check-userと、その理由を表す01.check-*）と、廃止済みの進捗ラベル
// （01〜09番台。#991 Phase 5・#1010）が他リポジトリに残っていた場合は、カード右上の
// WorkflowStepBadgeが進捗と確認待ちの理由を表現するため、下部のラベル一覧からは除外する
function nonStatusLabels(labels: IssueLabel[]) {
  return labels.filter((label) => !isProgressLabel(label.name));
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
  // 差である前提待ちを添える（#1763）。他のビューは今までどおり並んでいる行数。
  const countLabel =
    (view === "manual-step" && manualStepReadiness
      ? formatManualStepListCount(issues, manualStepReadiness)
      : null) ?? `${issues.length + pinnedCount}件`;

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
    return (
      <li
        key={issue.id}
        ref={(el) => {
          if (el) itemRefs.current.set(issue.id, el);
          else itemRefs.current.delete(issue.id);
        }}
      >
        <button
          type="button"
          onClick={() => {
            if (isSelecting) {
              toggleSelected(issue.id);
              return;
            }
            setOptimisticSelectedId(issue.id);
            onSelectIssue(issue);
          }}
          className={cn(
            "flex w-full flex-col gap-1.5 border-b border-l-4 border-l-transparent px-4 py-3 text-left hover:bg-accent",
            highlightedIssueId === issue.id && !isSelecting && "border-l-primary bg-accent",
            isSelecting && selectedIds.has(issue.id) && "border-l-primary bg-accent",
          )}
        >
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
              {nonStatusLabels(issue.labels).map((label) => (
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
              {issue.commentCount > 0 && (
                <span className="flex items-center gap-0.5">
                  <MessageSquare className="size-3" />
                  {issue.commentCount}
                </span>
              )}
              <span>{formatRelativeDate(issue.updatedAt)}</span>
            </div>
          </div>
        </button>
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
