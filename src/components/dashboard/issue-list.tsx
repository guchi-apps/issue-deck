"use client";

import { useMemo, useRef } from "react";
import type { CSSProperties } from "react";
import { Archive, CircleCheck, CircleDot, CircleSlash, Lock, MessageSquare, Star } from "lucide-react";

import { UserAvatar } from "@/components/dashboard/user-avatar";
import { WorkflowStepBadge } from "@/components/dashboard/workflow-status-steps";
import { Input } from "@/components/ui/input";
import { useIssueListScroll } from "@/hooks/use-issue-list-scroll";
import { useIssuesWorkflowRunning } from "@/hooks/use-issues-workflow-running";
import { closedStateLabel } from "@/lib/issue-state-reason";
import { isAttentionLabel, matchStatusStep } from "@/lib/issue-status";
import { getLabelBadgeStyle } from "@/lib/label-color";
import { cn } from "@/lib/utils";
import type { Issue, IssueLabel } from "@/types/issue";

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
};

function formatRelativeDate(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) return "今日";
  if (diffDays === 1) return "1日前";
  return `${diffDays}日前`;
}

// 進捗系ラベル（00.check-user、01.planning〜09.main）はカード右上のWorkflowStepBadgeで
// 既に表現されているため、下部のラベル一覧からは除外する
function nonStatusLabels(labels: IssueLabel[]) {
  return labels.filter((label) => !isAttentionLabel(label.name) && matchStatusStep(label.name) === null);
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
}: IssueListProps) {
  const runningByIssueId = useIssuesWorkflowRunning(issues);
  const itemRefs = useRef(new Map<string, HTMLLIElement>());
  const listRef = useRef<HTMLUListElement>(null);
  const issueIds = useMemo(() => issues.map((issue) => issue.id), [issues]);

  // 一覧が再マウントされた直後（Issue詳細から戻ってきた等）に、直前まで見ていた位置へ戻す。
  // scrollIntoView()は祖先のoverflow-hiddenコンテナ（ヘッダー等を含む）まで巻き込んで
  // スクロールさせてしまうため使わず、<ul>自身のscrollTopのみを直接操作する。
  useIssueListScroll({ scrollKey, issueIds, selectedIssueId, listRef, itemRefs });

  return (
    <div className={cn("flex h-full flex-col", className)} style={style}>
      {showSearch && (
        <div className="border-b p-3">
          <Input placeholder="キーワードで検索" />
        </div>
      )}

      {showHeader && (
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">{title}</h2>
            <p className="text-xs text-muted-foreground">{issues.length}件</p>
          </div>
          <Star className="size-4 text-muted-foreground" />
        </div>
      )}

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
          {issues.map((issue) => (
            <li
              key={issue.id}
              ref={(el) => {
                if (el) itemRefs.current.set(issue.id, el);
                else itemRefs.current.delete(issue.id);
              }}
            >
              <button
                type="button"
                onClick={() => onSelectIssue(issue)}
                className={cn(
                  "flex w-full flex-col gap-1.5 border-b border-l-4 border-l-transparent px-4 py-3 text-left hover:bg-accent",
                  selectedIssueId === issue.id && "border-l-primary bg-accent",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                    <IssueStateIcon issue={issue} />
                    <span className="truncate">{issue.repositoryFullName.split("/")[1]}</span>
                    {issue.repositoryArchived && (
                      <Archive className="size-3 shrink-0" aria-label="アーカイブ済み" />
                    )}
                    {issue.repositoryPrivate && (
                      <Lock className="size-3 shrink-0" aria-label="プライベート" />
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <WorkflowStepBadge
                      labels={issue.labels}
                      running={runningByIssueId[issue.id]}
                      qaAnswerPending={Boolean(issue.qaAnswerPendingAt)}
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
          ))}
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
