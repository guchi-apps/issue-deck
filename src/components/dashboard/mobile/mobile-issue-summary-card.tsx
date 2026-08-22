"use client";

import { Archive, CircleAlert, FolderGit2, Lock, MessageSquare } from "lucide-react";

import { UserAvatar } from "@/components/dashboard/user-avatar";
import { Badge } from "@/components/ui/badge";
import { formatRelativeDate } from "@/lib/format-relative-date";
import {
  CHECK_USER_REASON_TEXT,
  checkUserReason,
  isApprovalPending,
} from "@/lib/github/approval-labels";
import { getProgressStatusDef, resolveProgressStatus } from "@/lib/issue-progress";
import { closedStateLabel } from "@/lib/issue-state-reason";
import { selectSummaryLabels } from "@/lib/issue-summary-labels";
import { getLabelBadgeStyle } from "@/lib/label-color";
import type { Issue } from "@/types/issue";

type MobileIssueSummaryCardProps = {
  issue: Issue;
  onSelectRepository: (repositoryFullName: string) => void;
};

/**
 * スマホのIssue詳細の一番上に置く「この1枚で状況が分かる」カード（#1646）。
 *
 * 以前はリポジトリ名・タイトル・状態・作成者・担当者・ラベルがそれぞれ独立したブロックとして
 * 縦に6段積まれ、**本題である説明とコメントが初期表示から押し出されていた**。ここへ畳むことで、
 * 指を動かす前に「どのIssueが・いまどの段階で・誰の担当で・何件やり取りがあるか」まで読める。
 *
 * **編集の口はここに置かない。** 進捗の変更・担当者の変更・ラベルの追加削除は
 * `MobileIssuePropertiesSection`（折りたたみ）が持つ。読むための面と編集するための面を混ぜると、
 * 見るだけのときも編集UIの場所代を払うことになり、元の状態に戻る。**ここに出る進捗は読むだけ**で、
 * 変えられる場所は折りたたみの行（`進捗 実装中 ・ 担当 …`）が指す（#1920）。
 */
export function MobileIssueSummaryCard({ issue, onSelectRepository }: MobileIssueSummaryCardProps) {
  // Projectへ未登録（`projectStatus`がnull）は「未着手」と偽らず、進捗そのものを出さない。
  // 盤面に載っていないIssueに段階は無い（PCのプロパティパネルと同じ扱い）
  const progress = issue.projectStatus ? getProgressStatusDef(resolveProgressStatus(issue)) : null;
  const ProgressIcon = progress?.icon ?? null;
  const approvalPending = isApprovalPending(issue.labels);
  // 何を求められているかまで出す（#1490）。理由ラベルが配られていないリポジトリではnullになる
  const reason = checkUserReason(issue.labels);
  // 確認待ちのバッジを出しているあいだは、同じことを言う`00.check-user`・`01.check-*`を
  // ラベル欄から外す（#2057）。上のバッジが日本語で言っているものを機械語で繰り返すために
  // 上限3件の枠を2件使い、分類ラベルを「+N」の裏へ押し出していた
  const { visible: visibleLabels, hiddenCount } = selectSummaryLabels(issue.labels, {
    excludeAttention: approvalPending,
  });

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onSelectRepository(issue.repositoryFullName)}
          className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground active:text-foreground"
        >
          <FolderGit2 className="size-3.5 shrink-0" />
          <span className="truncate">{issue.repositoryFullName}</span>
        </button>
        {issue.repositoryArchived && (
          <Archive className="size-3 shrink-0 text-muted-foreground" aria-label="アーカイブ済み" />
        )}
        {issue.repositoryPrivate && (
          <Lock className="size-3 shrink-0 text-muted-foreground" aria-label="プライベート" />
        )}
        <Badge
          variant={issue.state === "open" ? "default" : "secondary"}
          className="ml-auto shrink-0"
        >
          {issue.state === "open" ? "Open" : closedStateLabel(issue.stateReason)}
        </Badge>
      </div>

      <h1 className="text-base leading-snug font-semibold break-words">
        #{issue.number} {issue.title}
      </h1>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
        {approvalPending ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 font-medium text-amber-700 ring-1 ring-inset ring-amber-500 dark:text-amber-400">
            <CircleAlert className="size-3" />
            確認待ち{reason ? `・${CHECK_USER_REASON_TEXT[reason]}` : ""}
          </span>
        ) : (
          progress &&
          ProgressIcon && (
            <span className="inline-flex items-center gap-1 text-foreground">
              <ProgressIcon className="size-3.5 text-muted-foreground" />
              {progress.label}
            </span>
          )
        )}
        <span className="inline-flex items-center gap-1">
          <UserAvatar login={issue.assignee?.login ?? issue.author.login} className="size-4" />
          {issue.assignee?.login ?? issue.author.login}
        </span>
        <span className="inline-flex items-center gap-1">
          <MessageSquare className="size-3.5" />
          {issue.commentCount}
        </span>
        <span>{formatRelativeDate(issue.updatedAt)}に更新</span>
      </div>

      {visibleLabels.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {visibleLabels.map((label) => (
            <span
              key={label.name}
              className="rounded-full px-2 py-0.5 text-[11px] ring-1 ring-inset ring-border"
              style={getLabelBadgeStyle(label.color)}
            >
              {label.name}
            </span>
          ))}
          {hiddenCount > 0 && (
            <span className="text-[11px] text-muted-foreground">+{hiddenCount}</span>
          )}
        </div>
      )}
    </div>
  );
}
