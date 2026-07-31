"use client";

import { ExternalLink, MoreHorizontal, Star } from "lucide-react";

import { CommentThread } from "@/components/dashboard/comment-thread";
import { MarkdownBody } from "@/components/dashboard/markdown-body";
import { UserAvatar } from "@/components/dashboard/user-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { useIssueComments } from "@/hooks/use-issue-comments";
import type { Issue } from "@/types/issue";

type IssueDetailProps = {
  issue: Issue | null;
};

export function IssueDetail({ issue }: IssueDetailProps) {
  const { comments, isLoading, error } = useIssueComments(issue);

  if (!issue) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        左の一覧からIssueを選択してください
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex flex-col gap-4 p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-muted-foreground">{issue.repositoryFullName}</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <a href={issue.htmlUrl} target="_blank" rel="noreferrer">
                GitHubで開く
                <ExternalLink />
              </a>
            </Button>
            <Button variant="outline" size="icon">
              <Star />
            </Button>
            <Button variant="outline" size="icon">
              <MoreHorizontal />
            </Button>
          </div>
        </div>

        <h1 className="text-lg font-semibold">
          #{issue.number} {issue.title}
        </h1>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <Badge variant={issue.state === "open" ? "default" : "secondary"}>
            {issue.state === "open" ? "Open" : "Closed"}
          </Badge>
          <span className="flex items-center gap-1.5 text-muted-foreground">
            作成者 <UserAvatar login={issue.author.login} /> {issue.author.login}
          </span>
          <span className="flex items-center gap-1.5 text-muted-foreground">
            担当者{" "}
            {issue.assignee ? (
              <>
                <UserAvatar login={issue.assignee.login} /> {issue.assignee.login}
              </>
            ) : (
              "未設定"
            )}
          </span>
          <span className="text-muted-foreground">
            作成日 {new Date(issue.createdAt).toLocaleDateString("ja-JP")}
          </span>
          <span className="text-muted-foreground">
            更新日 {new Date(issue.updatedAt).toLocaleDateString("ja-JP")}
          </span>
        </div>

        <Separator />

        <div>
          <h2 className="mb-2 text-sm font-semibold">説明</h2>
          <MarkdownBody content={issue.body} />
        </div>

        <Separator />

        <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">
              コメント <span className="text-muted-foreground">{issue.commentCount}</span>
            </h2>
          </div>
          <CommentThread comments={comments} isLoading={isLoading} error={error} />

          <div className="mt-4 flex items-center gap-2">
            <Input placeholder="コメントを追加..." />
            <Button>コメント</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
