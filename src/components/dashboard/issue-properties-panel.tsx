import { Archive, ArrowRightLeft, CircleAlert, FolderGit2, Lock, Plus, X } from "lucide-react";
import { useState } from "react";

import { IssueProgressSelect } from "@/components/dashboard/issue-progress-select";
import { LabelPicker } from "@/components/dashboard/label-picker";
import {
  moveDestinationRepositories,
  MoveIssueDialog,
} from "@/components/dashboard/move-issue-dialog";
import { Button } from "@/components/ui/button";
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
import { formatDateTimeFull } from "@/lib/format-date-time";
import { isAttentionLabel, matchStatusStep, STATUS_STEP_MAX } from "@/lib/issue-status";
import { getLabelBadgeStyle } from "@/lib/label-color";
import type { Issue } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";

type IssuePropertiesPanelProps = {
  issue: Issue;
  repositories: ConnectedRepository[];
  onIssueUpdated: (issue: Issue) => void;
};

export function IssuePropertiesPanel({
  issue,
  repositories,
  onIssueUpdated,
}: IssuePropertiesPanelProps) {
  const { labels: repoLabels, assignees: repoAssignees, isLoading: isMetaLoading } =
    useIssueRepoMeta(issue.repositoryFullName);
  const { updateIssue, isSubmitting } = useIssueMutations();
  const [isMoveDialogOpen, setIsMoveDialogOpen] = useState(false);
  const canMove = moveDestinationRepositories(repositories, issue.repositoryFullName).length > 0;

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
      {/* 進捗（GitHub Projects v2のStatus）。中身と注記は`IssueProgressSelect`が持ち、
          スマホのプロパティ折りたたみと同じものを使う（#1350・#1920） */}
      <section>
        <IssueProgressSelect issue={issue} onIssueUpdated={onIssueUpdated} />
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold text-muted-foreground">ラベル</h3>
        <div className="flex flex-wrap items-center gap-1.5">
          {issue.labels.map((label) => {
            const step = matchStatusStep(label.name);
            const attention = isAttentionLabel(label.name);
            return (
              <span
                key={label.name}
                className="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ring-1 ring-inset ring-border"
                style={getLabelBadgeStyle(label.color)}
                title={step ? `${label.name}（ステップ${step}/${STATUS_STEP_MAX}）` : undefined}
              >
                {attention && <CircleAlert className="size-3 shrink-0" aria-hidden="true" />}
                {step && (
                  <span
                    className="h-1.5 w-5 overflow-hidden rounded-full bg-border"
                    aria-hidden="true"
                  >
                    <span
                      className="block h-full rounded-full"
                      style={{
                        width: `${(step / STATUS_STEP_MAX) * 100}%`,
                        backgroundColor: label.color,
                      }}
                    />
                  </span>
                )}
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
            );
          })}
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

      {/* 詳細のヘッダーからは日付を外し、ここへ集約した（#1577）。両方に出すと狭いペインで
          メタ情報が2行に折り返すだけの重複になる。ヘッダーには相対時刻の「更新」だけが残る */}
      <section>
        <h3 className="mb-2 text-xs font-semibold text-muted-foreground">日付</h3>
        <dl className="flex flex-col gap-1 text-sm">
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">作成日</dt>
            <dd>{formatDateTimeFull(issue.createdAt)}</dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">更新日</dt>
            <dd>{formatDateTimeFull(issue.updatedAt)}</dd>
          </div>
        </dl>
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
        <div className="flex items-center justify-between gap-2">
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
          {canMove && (
            <Button
              variant="outline"
              size="xs"
              onClick={() => setIsMoveDialogOpen(true)}
            >
              <ArrowRightLeft />
              移動
            </Button>
          )}
        </div>
      </section>

      <MoveIssueDialog
        open={isMoveDialogOpen}
        onOpenChange={setIsMoveDialogOpen}
        issue={issue}
        repositories={repositories}
        onMoved={onIssueUpdated}
      />
    </div>
  );
}
