"use client";

import { CornerLeftUp } from "lucide-react";

import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import { getProgressStatusDef } from "@/lib/issue-progress";
import {
  resolveSubIssueProgress,
  resolveSubIssueRepositoryLabel,
  summarizeSubIssueProgress,
} from "@/lib/sub-issue-progress";
import { cn } from "@/lib/utils";
import type { SubIssue, SubIssueRelations } from "@/types/issue";

/**
 * 親子関係にあるIssueと、子Issueの進捗の内訳を表示する。
 *
 * 親Issueを開いたときに「子が何件あって、どこまで終わったのか」が一目で分かることが目的
 * （#1246）。関係が無いIssue（大多数）では**何も描かない**。
 */

type SubIssueProgressProps = {
  relations: SubIssueRelations;
  /**
   * 開いているIssueのリポジトリ（`owner/repo`）。**これと違うリポジトリの親子にだけ**
   * リポジトリ名を添える（#1722）。渡さない場合はどの行にも添えない。
   */
  baseRepositoryFullName?: string;
  /**
   * 「子Issue N」の見出しと完了率のバーを自分で描くか（既定: true）。
   *
   * PCの詳細（#1577）は折りたたみセクションの見出し行に件数と完了率を出しており、開いた中で
   * 同じものを繰り返さないためにfalseを渡す。スマホの詳細は従来どおり自分で描く。
   */
  showHeading?: boolean;
};

/**
 * 別リポジトリの親子であることを示すバッジ（#1722）。**同じリポジトリの行には出さない**——
 * 全行に並ぶと、見分けるべき別リポジトリの子が埋もれる。
 */
function RepositoryBadge({ issue, base }: { issue: SubIssue; base?: string }) {
  const label = base ? resolveSubIssueRepositoryLabel(issue, base) : null;
  if (!label) return null;
  return (
    <span
      className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground"
      title={issue.repositoryFullName}
    >
      {label}
    </span>
  );
}

/** 1件ぶんの行。番号・タイトル・進捗を並べ、クリックでそのIssueをIssueDeck内で開く */
function SubIssueRow({ issue, base }: { issue: SubIssue; base?: string }) {
  const statusKey = resolveSubIssueProgress(issue);
  const def = getProgressStatusDef(statusKey);
  const Icon = def.icon;
  const isDone = statusKey === "done";

  return (
    <GithubReferenceLink
      href={issue.htmlUrl}
      className="flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted"
    >
      <RepositoryBadge issue={issue} base={base} />
      <span className="shrink-0 font-mono text-muted-foreground">#{issue.number}</span>
      <span className={cn("min-w-0 flex-1 truncate", isDone && "text-muted-foreground line-through")}>
        {issue.title}
      </span>
      <span
        className={cn(
          "flex shrink-0 items-center gap-1 text-[10px]",
          isDone ? "text-muted-foreground" : "text-primary",
        )}
      >
        <Icon className="size-3" aria-hidden="true" />
        {def.label}
      </span>
    </GithubReferenceLink>
  );
}

export function SubIssueProgress({
  relations,
  baseRepositoryFullName,
  showHeading = true,
}: SubIssueProgressProps) {
  const { parent, children, childCount } = relations;
  if (!parent && children.length === 0) return null;

  const summary = summarizeSubIssueProgress(children);
  // GitHub上の件数と取得できた件数がずれるのは、1回に取る上限を超えた場合だけ
  const truncated = childCount > children.length ? childCount - children.length : 0;

  return (
    <div className="space-y-3">
      {parent && (
        <div>
          <h2 className={cn("mb-2 font-semibold", showHeading ? "text-sm" : "text-xs text-muted-foreground")}>
            親Issue
          </h2>
          <GithubReferenceLink
            href={parent.htmlUrl}
            className="flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted"
          >
            <CornerLeftUp className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
            <RepositoryBadge issue={parent} base={baseRepositoryFullName} />
            <span className="shrink-0 font-mono text-muted-foreground">#{parent.number}</span>
            <span className="min-w-0 flex-1 truncate">{parent.title}</span>
          </GithubReferenceLink>
        </div>
      )}

      {children.length > 0 && (
        <div>
          {/* 見出しと完了率は、折りたたみセクションで使うときはセクション側が出す（#1577） */}
          {showHeading && (
            <>
              <div className="mb-2 flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">
                  子Issue <span className="text-muted-foreground">{childCount}</span>
                </h2>
                <span className="text-xs text-muted-foreground">
                  {summary.done} / {summary.total} 完了
                </span>
              </div>

              <div
                className="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-valuenow={summary.percent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="子Issueの完了率"
              >
                <div className="h-full bg-primary" style={{ width: `${summary.percent}%` }} />
              </div>
            </>
          )}

          <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
            {summary.buckets.map((bucket) => (
              <span key={bucket.key}>
                {getProgressStatusDef(bucket.key).label} {bucket.count}
              </span>
            ))}
          </div>

          <div className="space-y-0.5">
            {/* キーはリポジトリ込み。**番号だけだと、別リポジトリの同番号の子で衝突する**（#1722） */}
            {children.map((child) => (
              <SubIssueRow
                key={`${child.repositoryFullName}#${child.number}`}
                issue={child}
                base={baseRepositoryFullName}
              />
            ))}
          </div>

          {truncated > 0 && (
            <p className="mt-1 px-1.5 text-[10px] text-muted-foreground">
              ほか{truncated}件（表示上限を超えたためGitHubで確認してください）
            </p>
          )}
        </div>
      )}
    </div>
  );
}
