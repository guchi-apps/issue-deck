import { Archive, ArrowRightLeft, CircleAlert, FolderGit2, Lock, Plus, X } from "lucide-react";
import { useState } from "react";

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
import {
  progressChangeErrorMessage,
  useProgressStatusMutation,
} from "@/hooks/use-progress-status-mutation";
import {
  getProgressStatusDef,
  parseProgressStatusKey,
  PROGRESS_STATUSES,
  resolveProgressStatus,
  type ProgressStatusKey,
} from "@/lib/issue-progress";
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
  const { setProgressStatus } = useProgressStatusMutation();
  const [isMoveDialogOpen, setIsMoveDialogOpen] = useState(false);
  // 往復の間だけ選択した値を出す。応答が返ったら親の`issue`が正になるのでnullへ戻す
  const [pendingProgress, setPendingProgress] = useState<ProgressStatusKey | null>(null);
  const [progressError, setProgressError] = useState<string | null>(null);
  const canMove = moveDestinationRepositories(repositories, issue.repositoryFullName).length > 0;

  // Projectへ未登録（`projectStatus`がnull）は「未着手」と偽らずplaceholderの「未設定」を出す。
  // 一覧・ステップ表示が未登録を「未着手」として扱う（resolveProgressStatus）のとは意図的に別で、
  // ここは変更のための入力欄なので、盤面に載っていないことが見えている必要がある
  const currentProgress = issue.projectStatus ? resolveProgressStatus(issue) : null;
  const selectedProgress = pendingProgress ?? currentProgress;

  async function handleProgressChange(value: string) {
    const status = parseProgressStatusKey(value);
    if (!status) return;

    setProgressError(null);
    setPendingProgress(status);
    const result = await setProgressStatus({
      repositoryFullName: issue.repositoryFullName,
      number: issue.number,
      status,
    });
    setPendingProgress(null);

    // 書けなかった場合は選択を元へ戻す（pendingを外した時点で`issue`の値に戻る）。
    // `unchanged`は失敗ではないためメッセージが無く、成功と同じく確定させる
    const message = progressChangeErrorMessage(result);
    if (message) {
      setProgressError(message);
      return;
    }
    onIssueUpdated({ ...issue, projectStatus: getProgressStatusDef(status).projectStatus });
  }

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
      {/* 進捗（GitHub Projects v2のStatus）。**変更しても実行は起動しない**（#1350）。
          書き込み経路はissue-deckのGitHub App自身なので、カンバンのドラッグと違って
          `projects_v2_item` Webhook起点の`@claude`コメント投稿（project-status-dispatch.ts）は
          走らない。起動の入口は「実装を開始」ボタンのままにする */}
      <section>
        <h3 className="mb-2 text-xs font-semibold text-muted-foreground">進捗</h3>
        <Select value={selectedProgress ?? ""} onValueChange={handleProgressChange}>
          <SelectTrigger className="w-full" aria-label="進捗" disabled={pendingProgress !== null}>
            <SelectValue placeholder="未設定" />
          </SelectTrigger>
          <SelectContent>
            {PROGRESS_STATUSES.map((status) => {
              const StatusIcon = status.icon;
              return (
                <SelectItem key={status.key} value={status.key}>
                  <StatusIcon className="size-3.5 text-muted-foreground" />
                  {status.label}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        <p className="mt-1.5 text-xs text-muted-foreground">
          進捗の状態だけを変更します。実装などの実行は開始しません。
        </p>
        {progressError && <p className="mt-1.5 text-xs text-destructive">{progressError}</p>}
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
            <dd>{new Date(issue.createdAt).toLocaleString("ja-JP")}</dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">更新日</dt>
            <dd>{new Date(issue.updatedAt).toLocaleString("ja-JP")}</dd>
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
