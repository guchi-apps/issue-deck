"use client";

import type { ReactNode } from "react";

import { Archive, Lock } from "lucide-react";

import { IssueAgentBadge } from "@/components/dashboard/issue-agent-badge";
import { UserAvatar } from "@/components/dashboard/user-avatar";
import { Badge } from "@/components/ui/badge";
import type { IssueImplementationAgent } from "@/lib/dispatch/issue-session";
import { formatDateTimeFull } from "@/lib/format-date-time";
import { formatRelativeDate } from "@/lib/format-relative-date";
import { closedStateLabel } from "@/lib/issue-state-reason";
import type { Issue } from "@/types/issue";

type IssueDetailHeaderProps = {
  issue: Issue;
  onSelectRepository: (repositoryFullName: string) => void;
  /** 操作ボタン列。中身（ダイアログ・状態）は親が持ち、ここは並べるだけ */
  actions: ReactNode;
  /**
   * 操作の前に読ませたい注釈（#2866）。いまは「次の5時間枠に積まれています」だけが使う。
   *
   * **ヘッダーの中に置く**——押す直前に読めないと意味が無く、本文側へ置くとスクロールで
   * 流れてしまう。無ければ何も描かず、ヘッダーの高さも変わらない。
   */
  notice?: ReactNode;
};

/**
 * Issue詳細の短い固定ヘッダー（#1577・#4440）。**スクロールしても上に残る。**
 *
 * コメントを読み進めるとタイトルが画面外へ出てしまい、どのIssueを読んでいるのかが分からなく
 * なっていた。そのためリポジトリ名・番号・1行に省略したタイトル・主操作だけをここに残す。
 * 以前は正式タイトル（2行）と状態・作成者・更新もここにあり、固定領域が厚くて本文の表示域を
 * 削っていたため、それらは本文先頭の`IssueDetailTitle`へ移した（承認済み案 #4425）。
 */
export function IssueDetailHeader({
  issue,
  onSelectRepository,
  actions,
  notice,
}: IssueDetailHeaderProps) {
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
        {/* 番号とタイトルは1行に省略する。全文は本文先頭の正式タイトルで読む */}
        <span
          className="min-w-0 flex-1 basis-40 truncate text-sm font-semibold"
          title={`#${issue.number} ${issue.title}`}
        >
          #{issue.number} {issue.title}
        </span>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{actions}</div>
      </div>

      {notice}
    </div>
  );
}

/**
 * Issue詳細の正式タイトル（#4440）。固定ヘッダーの下、本文の先頭に置き、全文を折り返して出す。
 *
 * **メタ情報は「状態・実装エージェント・作成者・更新」だけに絞る**（#1577）。担当者・作成日は
 * プロパティパネル（`IssuePropertiesPanel`）にあり、両方へ出すと重複になる。
 */
export function IssueDetailTitle({
  issue,
  implementationAgent,
}: {
  issue: Issue;
  implementationAgent: IssueImplementationAgent | null;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-xl leading-snug font-semibold break-words text-balance">
        #{issue.number} {issue.title}
      </h1>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
        <Badge variant={issue.state === "open" ? "default" : "secondary"}>
          {issue.state === "open" ? "Open" : closedStateLabel(issue.stateReason)}
        </Badge>
        {implementationAgent && <IssueAgentBadge agent={implementationAgent} />}
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
