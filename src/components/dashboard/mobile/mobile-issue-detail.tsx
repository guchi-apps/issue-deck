"use client";

import { ArrowLeft, FolderGit2, MoreHorizontal, Plus, Share2 } from "lucide-react";

import { CommentThread } from "@/components/dashboard/comment-thread";
import { MarkdownBody } from "@/components/dashboard/markdown-body";
import { UserAvatar } from "@/components/dashboard/user-avatar";
import { Badge } from "@/components/ui/badge";
import { formatRelativeDate } from "@/lib/format-relative-date";
import { useIssueComments } from "@/hooks/use-issue-comments";
import type { Issue } from "@/types/issue";

type MobileIssueDetailProps = {
  issue: Issue;
  onBack: () => void;
};

export function MobileIssueDetail({ issue, onBack }: MobileIssueDetailProps) {
  const { comments, isLoading, error } = useIssueComments(issue);

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <header className="flex items-center gap-2 border-b p-4">
        <button type="button" onClick={onBack}>
          <ArrowLeft className="size-5" />
        </button>
        <span className="flex-1 text-sm font-semibold">Issue詳細</span>
        <Share2 className="size-4 text-muted-foreground" />
        <MoreHorizontal className="size-4 text-muted-foreground" />
      </header>

      <div className="flex flex-col gap-4 overflow-y-auto p-4 pb-20">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <FolderGit2 className="size-3.5" />
          {issue.repositoryFullName}
        </span>

        <h1 className="text-lg font-semibold">
          #{issue.number} {issue.title}
        </h1>

        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <Badge variant={issue.state === "open" ? "default" : "secondary"}>
            {issue.state === "open" ? "Open" : "Closed"}
          </Badge>
          <span>作成日 {new Date(issue.createdAt).toLocaleDateString("ja-JP")}</span>
          <span>{formatRelativeDate(issue.updatedAt)}に更新</span>
        </div>

        <div className="flex items-center gap-6">
          <div>
            <p className="mb-1 text-xs text-muted-foreground">作成者</p>
            <span className="flex items-center gap-1.5 text-sm">
              <UserAvatar login={issue.author.login} />
              {issue.author.login}
            </span>
          </div>
          <div>
            <p className="mb-1 text-xs text-muted-foreground">担当者</p>
            {issue.assignee ? (
              <span className="flex items-center gap-1.5 text-sm">
                <UserAvatar login={issue.assignee.login} />
                {issue.assignee.login}
              </span>
            ) : (
              <span className="text-sm text-muted-foreground">未設定</span>
            )}
          </div>
        </div>

        <div>
          <h2 className="mb-2 text-sm font-semibold">ラベル</h2>
          <div className="flex flex-wrap items-center gap-1.5">
            {issue.labels.map((label) => (
              <span
                key={label.name}
                className="rounded-full px-2 py-0.5 text-xs"
                style={{ backgroundColor: `${label.color}20`, color: label.color }}
              >
                {label.name}
              </span>
            ))}
            <button
              type="button"
              className="flex size-6 items-center justify-center rounded-full border text-muted-foreground"
            >
              <Plus className="size-3.5" />
            </button>
          </div>
        </div>

        <div>
          <h2 className="mb-2 text-sm font-semibold">説明</h2>
          <MarkdownBody content={issue.body} />
        </div>

        <div>
          <h2 className="mb-3 text-sm font-semibold">
            コメント <span className="text-muted-foreground">{issue.commentCount}</span>
          </h2>
          <CommentThread comments={comments} isLoading={isLoading} error={error} />
        </div>
      </div>

      <button
        type="button"
        className="absolute right-4 bottom-4 flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg"
      >
        <Plus className="size-5" />
      </button>
    </div>
  );
}
