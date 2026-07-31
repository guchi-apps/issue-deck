import { MoreHorizontal, ThumbsUp } from "lucide-react";

import { UserAvatar } from "@/components/dashboard/user-avatar";
import { Skeleton } from "@/components/ui/skeleton";
import type { IssueComment } from "@/types/issue";

type CommentThreadProps = {
  comments: IssueComment[];
  isLoading?: boolean;
  error?: string | null;
};

export function CommentThread({ comments, isLoading, error }: CommentThreadProps) {
  if (isLoading) {
    return (
      <div className="flex flex-col gap-4">
        {[0, 1].map((i) => (
          <div key={i} className="flex gap-2">
            <Skeleton className="mt-0.5 size-7 shrink-0 rounded-full" />
            <Skeleton className="h-16 flex-1 rounded-lg" />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return <p className="text-sm text-destructive">コメントの取得に失敗しました: {error}</p>;
  }

  if (comments.length === 0) {
    return <p className="text-sm text-muted-foreground">まだコメントはありません</p>;
  }

  return (
    <ul className="flex flex-col gap-4">
      {comments.map((comment) => (
        <li key={comment.id} className="flex gap-2">
          <UserAvatar login={comment.author.login} className="mt-0.5 size-7" />
          <div className="flex-1 rounded-lg border p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium">{comment.author.login}</span>
                <span className="text-xs text-muted-foreground">{comment.createdAtLabel}</span>
              </div>
              <MoreHorizontal className="size-4 text-muted-foreground" />
            </div>
            <p className="mt-1 text-sm leading-relaxed">{comment.body}</p>
            {comment.reactionCount > 0 && (
              <span className="mt-2 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                <ThumbsUp className="size-3" />
                {comment.reactionCount}
              </span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
