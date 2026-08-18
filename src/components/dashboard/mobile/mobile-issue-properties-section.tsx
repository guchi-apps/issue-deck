"use client";

import { CircleAlert, Plus, X } from "lucide-react";

import { IssueDetailSection } from "@/components/dashboard/issue-detail-section";
import { IssueProgressSelect } from "@/components/dashboard/issue-progress-select";
import { LabelPicker } from "@/components/dashboard/label-picker";
import { UserAvatar } from "@/components/dashboard/user-avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useIssueRepoMeta } from "@/hooks/use-issue-repo-meta";
import { getProgressStatusDef, resolveProgressStatus } from "@/lib/issue-progress";
import { isAttentionLabel, matchStatusStep, STATUS_STEP_MAX } from "@/lib/issue-status";
import { getLabelBadgeStyle } from "@/lib/label-color";
import type { Issue } from "@/types/issue";

type MobileIssuePropertiesSectionProps = {
  issue: Issue;
  /** Issueの更新中か（担当者・ラベルの操作を止める） */
  isSubmitting: boolean;
  onToggleLabel: (name: string) => void;
  onAssigneeChange: (login: string | null) => void;
  /** 進捗を変えられたときに親の`issue`を差し替える（#1920） */
  onIssueUpdated: (issue: Issue) => void;
};

/**
 * スマホのIssue詳細で、担当者・ラベル・日付をまとめて畳んでおくセクション（#1646）。
 *
 * どれも「開いたときに読む情報」ではなく「変えたいときに触る入力欄」なのに、詳細の上部を
 * 常時占有して説明を画面外へ押し出していた。PCが右のプロパティパネル
 * （`issue-properties-panel.tsx`）へ寄せているのと同じ整理を、スマホでは折りたたみで行う。
 *
 * **進捗（Project Status）を変える口もここに置く**（#1920）。以前は「同じ値の表示が増える」ことを
 * 避けてスマホには変更の口を置かず、進捗はサマリーカードと実行状況カードが読む専用で出すだけ
 * だった。しかしそのせいで**スマホからは進捗をまったく動かせず**、PCを開くかGitHubのカンバンを
 * 触るしかなかった。中身・並び・注記はPCのパネルと同じ`IssueProgressSelect`を使い、
 * **どちらかの画面にだけ挙動を足さない。**
 *
 * 畳んだ行のsummaryにも進捗を出す。**これで進捗を読める場所は最大3つになる**——サマリーカード
 * （`mobile-issue-summary-card.tsx`）と、`Planning`〜`Done`のときだけ出る実行状況カードの
 * ステップ表示（`workflow-status-steps.tsx`）と、この行。増やしてなお出すのは、**残り2つは
 * どちらも読む専用で、「変えられる場所がここにある」と示せるのがこの行だけ**だから。
 * 出さないと、進捗を変えたい人は「プロパティ」を当てずっぽうで開くことになる。
 * `ready`・`closed`ではステップ表示自体が出ないので、そこでは2か所に収まる。
 */
export function MobileIssuePropertiesSection({
  issue,
  isSubmitting,
  onToggleLabel,
  onAssigneeChange,
  onIssueUpdated,
}: MobileIssuePropertiesSectionProps) {
  const {
    labels: repoLabels,
    assignees: repoAssignees,
    isLoading: isMetaLoading,
  } = useIssueRepoMeta(issue.repositoryFullName);
  // Projectへ未登録なら畳んだ行にも出さない（「未着手」と偽らない。セレクト側と同じ判定）
  const progress = issue.projectStatus ? getProgressStatusDef(resolveProgressStatus(issue)) : null;

  return (
    <IssueDetailSection
      id="properties"
      title="プロパティ"
      summary={
        <span className="truncate text-xs text-muted-foreground">
          {progress && `進捗 ${progress.label} ・ `}
          担当 {issue.assignee?.login ?? "未設定"}
          {issue.labels.length > 0 && ` ・ ラベル ${issue.labels.length}`}
        </span>
      }
    >
      <div className="flex flex-col gap-4">
        <IssueProgressSelect issue={issue} onIssueUpdated={onIssueUpdated} />

        <div>
          <h3 className="mb-1.5 text-xs font-semibold text-muted-foreground">担当者</h3>
          <Select
            value={issue.assignee?.login ?? "__none__"}
            onValueChange={(value) => onAssigneeChange(value === "__none__" ? null : value)}
          >
            <SelectTrigger className="w-full" disabled={isMetaLoading || isSubmitting}>
              <SelectValue placeholder="担当者を選択">
                <span className="flex items-center gap-1.5">
                  {issue.assignee && <UserAvatar login={issue.assignee.login} className="size-4" />}
                  {issue.assignee?.login ?? "未設定"}
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">未設定</SelectItem>
              {repoAssignees.map((login) => (
                <SelectItem key={login} value={login}>
                  <UserAvatar login={login} className="size-4" />
                  {login}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <h3 className="mb-1.5 text-xs font-semibold text-muted-foreground">ラベル</h3>
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
                  {/* 指で押せる大きさ（44px）を、チップを膨らませずに`after`の当たり判定で確保する */}
                  <button
                    type="button"
                    onClick={() => onToggleLabel(label.name)}
                    disabled={isSubmitting}
                    aria-label={`${label.name}を削除`}
                    className="relative -m-1.5 rounded-full p-1.5 after:absolute after:-inset-2.5 hover:opacity-70 disabled:opacity-50"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              );
            })}
            <LabelPicker
              labels={repoLabels}
              selectedNames={issue.labels.map((label) => label.name)}
              onToggle={onToggleLabel}
              isLoading={isMetaLoading}
              trigger={
                <button
                  type="button"
                  disabled={isSubmitting}
                  aria-label="ラベルを追加"
                  className="flex size-11 items-center justify-center rounded-full border text-muted-foreground disabled:opacity-50"
                >
                  <Plus className="size-4" />
                </button>
              }
            />
          </div>
        </div>

        <div>
          <h3 className="mb-1.5 text-xs font-semibold text-muted-foreground">日付・作成者</h3>
          <dl className="flex flex-col gap-1 text-sm">
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">作成者</dt>
              <dd className="flex items-center gap-1.5">
                <UserAvatar login={issue.author.login} className="size-4" />
                {issue.author.login}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">作成日</dt>
              <dd>{new Date(issue.createdAt).toLocaleString("ja-JP")}</dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">更新日</dt>
              <dd>{new Date(issue.updatedAt).toLocaleString("ja-JP")}</dd>
            </div>
          </dl>
        </div>
      </div>
    </IssueDetailSection>
  );
}
