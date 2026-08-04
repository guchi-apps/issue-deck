"use client";

import { useEffect, useRef } from "react";
import {
  Archive,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleSlash,
  Loader2,
  Lock,
  MessageSquare,
  Star,
} from "lucide-react";

import { UserAvatar } from "@/components/dashboard/user-avatar";
import { WorkflowStepBadge } from "@/components/dashboard/workflow-status-steps";
import { Input } from "@/components/ui/input";
import { useIssuesWorkflowRunning } from "@/hooks/use-issues-workflow-running";
import { closedStateLabel } from "@/lib/issue-state-reason";
import { isAttentionLabel, matchStatusStep, STATUS_STEP_MAX } from "@/lib/issue-status";
import { getLabelBadgeStyle } from "@/lib/label-color";
import { cn } from "@/lib/utils";
import type { Issue, IssueLabel } from "@/types/issue";

type IssueListProps = {
  title: string;
  issues: Issue[];
  selectedIssueId: string | null;
  onSelectIssue: (issue: Issue) => void;
  className?: string;
  showSearch?: boolean;
  showHeader?: boolean;
  /** 画面右下に浮くFAB（新規Issue作成ボタン）と最後の項目が重ならないよう下部に余白を確保する */
  fabSpacing?: boolean;
};

function formatRelativeDate(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) return "今日";
  if (diffDays === 1) return "1日前";
  return `${diffDays}日前`;
}

// 要対応フラグ→進行ステップ→その他ラベルの順に並べ、状況が一目でわかるよう左詰めにする
function statusSortRank(labelName: string) {
  if (isAttentionLabel(labelName)) return -1;
  return matchStatusStep(labelName) ?? STATUS_STEP_MAX + 1;
}

function sortLabelsByStatus(labels: IssueLabel[]) {
  return [...labels].sort((a, b) => statusSortRank(a.name) - statusSortRank(b.name));
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
  showSearch = true,
  showHeader = true,
  fabSpacing = false,
}: IssueListProps) {
  const runningByIssueId = useIssuesWorkflowRunning(issues);
  const itemRefs = useRef(new Map<string, HTMLLIElement>());
  const listRef = useRef<HTMLUListElement>(null);

  // 一覧が再マウントされた直後（Issue詳細から戻ってきた等）に、直前まで表示していた
  // Issue行が見えるようスクロールする。以降の選択変更では追従しない（空配列deps）。
  // scrollIntoView()は祖先のoverflow-hiddenコンテナ（ヘッダー等を含む）まで巻き込んで
  // スクロールさせてしまうため使わず、<ul>自身のscrollTopのみを直接操作する。
  useEffect(() => {
    if (!selectedIssueId) return;
    const list = listRef.current;
    const target = itemRefs.current.get(selectedIssueId);
    if (!list || !target) return;
    list.scrollTop = target.offsetTop - list.clientHeight / 2 + target.clientHeight / 2;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={cn("flex h-full flex-col", className)}>
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

      {issues.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
          該当するIssueがありません
        </div>
      ) : (
        <ul ref={listRef} className={cn("flex-1 overflow-y-auto", fabSpacing && "pb-20")}>
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
                    {runningByIssueId[issue.id]?.isRunning && (
                      <span className="flex items-center gap-1">
                        {runningByIssueId[issue.id]?.currentStep && (
                          <span
                            className="max-w-[7rem] truncate text-[10px] text-muted-foreground"
                            title={runningByIssueId[issue.id]?.currentStep ?? undefined}
                          >
                            {runningByIssueId[issue.id]?.currentStep}
                          </span>
                        )}
                        <Loader2
                          className="size-3.5 animate-spin text-primary"
                          aria-label="GitHub Actions実行中"
                        />
                      </span>
                    )}
                    <WorkflowStepBadge labels={issue.labels} />
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
                    {sortLabelsByStatus(issue.labels).map((label) => {
                      const step = matchStatusStep(label.name);
                      const attention = isAttentionLabel(label.name);
                      return (
                        <span
                          key={label.name}
                          className="flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] ring-1 ring-inset ring-border"
                          style={getLabelBadgeStyle(label.color)}
                          title={step ? `${label.name}（ステップ${step}/${STATUS_STEP_MAX}）` : undefined}
                        >
                          {attention && <CircleAlert className="size-3 shrink-0" aria-hidden="true" />}
                          {step && (
                            <span
                              className="h-1.5 w-5 overflow-hidden rounded-full bg-border"
                              aria-hidden="true"
                            >
                              <span
                                className="block h-full rounded-full"
                                style={{
                                  width: `${(step / STATUS_STEP_MAX) * 100}%`,
                                  backgroundColor: label.color,
                                }}
                              />
                            </span>
                          )}
                          {label.name}
                        </span>
                      );
                    })}
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
        </ul>
      )}
    </div>
  );
}
