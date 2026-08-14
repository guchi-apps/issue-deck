import { GitPullRequest } from "lucide-react";

import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import type { PullRequestLink } from "@/lib/github/pull-request-link";
import { cn } from "@/lib/utils";

type PullRequestLinkBadgeProps = {
  link: PullRequestLink | null;
  /** trueの場合、ユーザーの確認待ち（00.check-user）であることを併せて示す */
  approvalPending: boolean;
};

/** コメントから抽出した対応PRへのリンクと、ユーザーの確認要否をカード上部に表示する */
export function PullRequestLinkBadge({ link, approvalPending }: PullRequestLinkBadgeProps) {
  if (!link) return null;

  return (
    <GithubReferenceLink
      href={link.url}
      className={cn(
        "inline-flex min-h-11 w-fit items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset transition-colors hover:opacity-80 md:min-h-0 md:px-2.5",
        approvalPending
          ? "bg-amber-500/15 text-amber-600 ring-amber-500 dark:text-amber-400"
          : "bg-muted text-muted-foreground ring-border",
      )}
    >
      <GitPullRequest className="size-3" />
      対応PR #{link.number}
      {approvalPending && "・要確認"}
    </GithubReferenceLink>
  );
}
