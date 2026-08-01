"use client";

import { MessageSquare, Star } from "lucide-react";

import { UserAvatar } from "@/components/dashboard/user-avatar";
import { Input } from "@/components/ui/input";
import { getLabelBadgeStyle } from "@/lib/label-color";
import { cn } from "@/lib/utils";
import type { Issue } from "@/types/issue";

type IssueListProps = {
  title: string;
  issues: Issue[];
  selectedIssueId: string | null;
  onSelectIssue: (issue: Issue) => void;
  className?: string;
  showSearch?: boolean;
  showHeader?: boolean;
};

function formatRelativeDate(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) return "今日";
  if (diffDays === 1) return "1日前";
  return `${diffDays}日前`;
}

export function IssueList({
  title,
  issues,
  selectedIssueId,
  onSelectIssue,
  className,
  showSearch = true,
  showHeader = true,
}: IssueListProps) {
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
        <ul className="flex-1 overflow-y-auto">
          {issues.map((issue) => (
            <li key={issue.id}>
              <button
                type="button"
                onClick={() => onSelectIssue(issue)}
                className={cn(
                  "flex w-full flex-col gap-1.5 border-b border-l-4 border-l-transparent px-4 py-3 text-left hover:bg-accent",
                  selectedIssueId === issue.id && "border-l-primary bg-accent",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs text-muted-foreground">
                    {issue.repositoryFullName.split("/")[1]}
                  </span>
                  <UserAvatar login={issue.assignee?.login ?? issue.author.login} />
                </div>
                <p className="line-clamp-2 text-sm font-medium">
                  #{issue.number} {issue.title}
                </p>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <div className="flex flex-wrap gap-1">
                    {issue.labels.map((label) => (
                      <span
                        key={label.name}
                        className="rounded-full px-1.5 py-0.5 text-[10px] ring-1 ring-inset ring-border"
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
        </ul>
      )}
    </div>
  );
}
