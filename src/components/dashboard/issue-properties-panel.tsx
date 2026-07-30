import { ChevronDown, Eye, FolderGit2, Plus } from "lucide-react";

import { UserAvatar } from "@/components/dashboard/user-avatar";
import { Progress } from "@/components/ui/progress";
import type { MockIssue } from "@/types/issue";

type IssuePropertiesPanelProps = {
  issue: MockIssue;
};

export function IssuePropertiesPanel({ issue }: IssuePropertiesPanelProps) {
  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-4 text-sm">
      <section>
        <h3 className="mb-2 text-xs font-semibold text-muted-foreground">ラベル</h3>
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
            className="flex size-6 items-center justify-center rounded-full border text-muted-foreground hover:bg-accent"
          >
            <Plus className="size-3.5" />
          </button>
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold text-muted-foreground">担当者</h3>
        {issue.assignee ? (
          <div className="flex items-center gap-2">
            <UserAvatar login={issue.assignee.login} />
            {issue.assignee.login}
          </div>
        ) : (
          <span className="text-muted-foreground">未設定</span>
        )}
      </section>

      {issue.milestone && (
        <section>
          <h3 className="mb-2 text-xs font-semibold text-muted-foreground">マイルストーン</h3>
          <div className="flex items-center justify-between text-sm">
            <span>{issue.milestone.name}</span>
            <span className="text-xs text-muted-foreground">{issue.milestone.progressPercent}%</span>
          </div>
          <Progress value={issue.milestone.progressPercent} className="mt-1.5 h-1.5" />
        </section>
      )}

      <section>
        <h3 className="mb-2 text-xs font-semibold text-muted-foreground">関連するリポジトリ</h3>
        <div className="flex items-center gap-2">
          <FolderGit2 className="size-4 text-muted-foreground" />
          {issue.repositoryFullName}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold text-muted-foreground">通知を受け取る</h3>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs hover:bg-accent"
        >
          <Eye className="size-3.5" />
          ウォッチ中
          <ChevronDown className="size-3" />
        </button>
      </section>

      {issue.activity.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold text-muted-foreground">アクティビティ</h3>
          <ul className="flex flex-col gap-2 text-xs">
            {issue.activity.map((activity) => (
              <li key={activity.id} className="flex items-center justify-between gap-2">
                <span className="truncate text-muted-foreground">
                  <span className="font-medium text-foreground">{activity.actorLogin}</span>
                  {activity.description}
                </span>
                <span className="shrink-0 text-muted-foreground">{activity.createdAtLabel}</span>
              </li>
            ))}
          </ul>
          <button type="button" className="mt-2 text-xs text-primary hover:underline">
            すべてのアクティビティを表示
          </button>
        </section>
      )}
    </div>
  );
}
