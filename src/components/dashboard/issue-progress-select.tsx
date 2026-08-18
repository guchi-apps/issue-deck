"use client";

import { useState } from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import type { Issue } from "@/types/issue";

type IssueProgressSelectProps = {
  issue: Issue;
  /** 書き込みに成功したときに親の`issue`を差し替える（カンバン・一覧をその場で追随させる） */
  onIssueUpdated: (issue: Issue) => void;
};

/**
 * 人が進捗（GitHub Projects v2のStatus）を直接動かすセレクト（#1350・#1920）。
 *
 * **PCの右パネル（`issue-properties-panel.tsx`）とスマホのプロパティ折りたたみ
 * （`mobile/mobile-issue-properties-section.tsx`）が同じものを使う。** 見出し・注記・失敗時の
 * 戻し方まで含めてここに閉じており、**片方の画面にだけ挙動を足さない**——足すと「選ぶと何が
 * 起きるのか」の答えが端末によって変わる。
 *
 * **変更しても実行は起動しない。** 書き込み経路がissue-deckのGitHub App自身なので、
 * GitHub Projectsのカンバンでカードをドラッグした場合と違い、`projects_v2_item` Webhook起点の
 * `@claude`コメント投稿（`lib/github/project-status-dispatch.ts`）は走らない。起動の入口は
 * 「実装を開始」ボタンのままにする（プルダウンの選択だけで無人実行が始まると誤操作の影響が
 * 大きいため）。
 */
export function IssueProgressSelect({ issue, onIssueUpdated }: IssueProgressSelectProps) {
  const { setProgressStatus } = useProgressStatusMutation();
  // 往復の間だけ選択した値を出す。応答が返ったら親の`issue`が正になるのでnullへ戻す
  const [pendingProgress, setPendingProgress] = useState<ProgressStatusKey | null>(null);
  const [progressError, setProgressError] = useState<string | null>(null);

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

  return (
    <div>
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
    </div>
  );
}
