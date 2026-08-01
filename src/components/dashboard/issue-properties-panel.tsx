import { Archive, ChevronDown, Eye, FolderGit2, Lock, Plus, X } from "lucide-react";

import { LabelPicker } from "@/components/dashboard/label-picker";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useIssueMutations } from "@/hooks/use-issue-mutations";
import { useIssueRepoMeta } from "@/hooks/use-issue-repo-meta";
import { getLabelBadgeStyle } from "@/lib/label-color";
import type { Issue } from "@/types/issue";

type IssuePropertiesPanelProps = {
  issue: Issue;
  onIssueUpdated: (issue: Issue) => void;
};

export function IssuePropertiesPanel({ issue, onIssueUpdated }: IssuePropertiesPanelProps) {
  const { labels: repoLabels, assignees: repoAssignees, isLoading: isMetaLoading } =
    useIssueRepoMeta(issue.repositoryFullName);
  const { updateIssue, isSubmitting } = useIssueMutations();

  async function toggleLabel(name: string) {
    const current = issue.labels.map((label) => label.name);
    const next = current.includes(name)
      ? current.filter((label) => label !== name)
      : [...current, name];
    const updated = await updateIssue({
      repositoryFullName: issue.repositoryFullName,
      number: issue.number,
      labels: next,
    });
    if (updated) onIssueUpdated(updated);
  }

  async function handleAssigneeChange(login: string | null) {
    const updated = await updateIssue({
      repositoryFullName: issue.repositoryFullName,
      number: issue.number,
      assignee: login,
    });
    if (updated) onIssueUpdated(updated);
  }

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-4 text-sm">
      <section>
        <h3 className="mb-2 text-xs font-semibold text-muted-foreground">ラベル</h3>
        <div className="flex flex-wrap items-center gap-1.5">
          {issue.labels.map((label) => (
            <span
              key={label.name}
              className="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ring-1 ring-inset ring-border"
              style={getLabelBadgeStyle(label.color)}
            >
              {label.name}
              <button
                type="button"
                onClick={() => toggleLabel(label.name)}
                disabled={isSubmitting}
                aria-label={`${label.name}を削除`}
                className="rounded-full hover:opacity-70 disabled:opacity-50"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          <LabelPicker
            labels={repoLabels}
            selectedNames={issue.labels.map((label) => label.name)}
            onToggle={toggleLabel}
            isLoading={isMetaLoading}
            trigger={
              <button
                type="button"
                disabled={isSubmitting}
                className="flex size-6 items-center justify-center rounded-full border text-muted-foreground hover:bg-accent disabled:opacity-50"
              >
                <Plus className="size-3.5" />
              </button>
            }
          />
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold text-muted-foreground">担当者</h3>
        <Select
          value={issue.assignee?.login ?? "__none__"}
          onValueChange={(value) => handleAssigneeChange(value === "__none__" ? null : value)}
        >
          <SelectTrigger className="w-full" disabled={isMetaLoading || isSubmitting}>
            <SelectValue placeholder="担当者を選択" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">未設定</SelectItem>
            {repoAssignees.map((login) => (
              <SelectItem key={login} value={login}>
                {login}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
