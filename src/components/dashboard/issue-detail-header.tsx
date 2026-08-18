"use client";

import type { ReactNode } from "react";

import { Archive, Lock } from "lucide-react";

import { UserAvatar } from "@/components/dashboard/user-avatar";
import { Badge } from "@/components/ui/badge";
import { formatDateTimeFull } from "@/lib/format-date-time";
import { formatRelativeDate } from "@/lib/format-relative-date";
import { closedStateLabel } from "@/lib/issue-state-reason";
import type { Issue } from "@/types/issue";

type IssueDetailHeaderProps = {
  issue: Issue;
  onSelectRepository: (repositoryFullName: string) => void;
  /** 操作ボタン列。中身（ダイアログ・状態）は親が持ち、ここは並べるだけ */
  actions: ReactNode;
};

/**
 * Issue詳細のヘッダー（#1577）。**スクロールしても上に残る。**
 *
 * コメントを読み進めるとタイトルが画面外へ出てしまい、どのIssueを読んでいるのか・いま何が
 * 起きているのかが分からなくなっていた。リポジトリ名・タイトル・状態・主操作をこの1枚へ集め、
 * スクロール領域の先頭でstickyにしている。
 *
 * **メタ情報は「状態・作成者・更新」だけに絞る**（#1577）。担当者・作成日は右のプロパティパネル
 * （`IssuePropertiesPanel`）にあり、両方へ出すと狭いペインで2行に折り返すだけの重複になる。
 */
export function IssueDetailHeader({ issue, onSelectRepository, actions }: IssueDetailHeaderProps) {
  return (
    <div className="sticky top-0 z-20 flex flex-col gap-2 border-b bg-background px-4 py-3">
      {/* 詳細ペインが狭いときやボタンが増えたときに「GitHubで開く」等が横へはみ出して
          見えなくならないよう、この行は折り返す（#998） */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
          <button
            type="button"
            onClick={() => onSelectRepository(issue.repositoryFullName)}
            className="truncate hover:text-foreground hover:underline"
            title="このリポジトリでフィルター"
          >
            {issue.repositoryFullName}
          </button>
          {issue.repositoryArchived && <Archive className="size-3.5" aria-label="アーカイブ済み" />}
          {issue.repositoryPrivate && <Lock className="size-3.5" aria-label="プライベート" />}
        </span>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{actions}</div>
      </div>

      <h1 className="line-clamp-2 text-lg font-semibold break-words">
        #{issue.number} {issue.title}
      </h1>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
        <Badge variant={issue.state === "open" ? "default" : "secondary"}>
          {issue.state === "open" ? "Open" : closedStateLabel(issue.stateReason)}
        </Badge>
        <span className="flex items-center gap-1.5">
          <UserAvatar login={issue.author.login} className="size-5" />
          {issue.author.login}
        </span>
        {/* 相対時刻にして1行へ収める。正確な日時はhoverで見せる */}
        <span title={formatDateTimeFull(issue.updatedAt)}>
          更新 {formatRelativeDate(issue.updatedAt)}
        </span>
      </div>
    </div>
  );
}
