import { Archive, ChevronDown, Eye, FolderGit2, Lock, Plus } from "lucide-react";

import { UserAvatar } from "@/components/dashboard/user-avatar";
import { Progress } from "@/components/ui/progress";
import { getLabelBadgeStyle } from "@/lib/label-color";
import type { Issue } from "@/types/issue";

type IssuePropertiesPanelProps = {
  issue: Issue;
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
              className="rounded-full px-2 py-0.5 text-xs ring-1 ring-inset ring-border"
              style={getLabelBadgeStyle(label.color)}
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
          {issue.repositoryArchived && (
            <Archive className="size-3.5 text-muted-foreground" aria-label="アーカイブ済み" />
          )}
          {issue.repositoryPrivate && (
            <Lock className="size-3.5 text-muted-foreground" aria-label="プライベート" />
          )}
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
    </div>
  );
}
