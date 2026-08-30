"use client";

import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import { useIssueMutations } from "@/hooks/use-issue-mutations";
import type { DispatchAgent } from "@/lib/dispatch/dispatch-job";
import { LOCAL_LABEL_NAME } from "@/lib/github/project-status-dispatch";
import type { Issue } from "@/types/issue";

/**
 * サブPCの実装セッションを起動する操作（#1830）。
 *
 * **新規に始める（「サブPCで開始」・`start-local-session-button.tsx`）のと、終了したセッションを
 * 呼び戻す（「セッションを復旧」・`session-recovery-button.tsx`）のは、積むジョブが同じ`LAUNCH`で
 * まったく同じ手順**になる。違うのはボタンの文言と出す場所だけなので、手順はここへ寄せる。
 * 2か所に持つと、`11.local`を付ける順番のような細部が片方だけずれる。
 *
 * 前回の会話を引き継ぐかどうかを決めるのは**サブPCのランチャーだけ**（worktreeを再利用した
 * ときは`claude --continue`。#1541）で、issue-deck側は「もう一度起動する」以上のことをしない。
 */
export function useLocalSessionLaunch({
  issue,
  dispatch,
  onIssueUpdated,
}: {
  issue: Issue;
  dispatch: DispatchStateHandle;
  onIssueUpdated: (issue: Issue) => void;
}) {
  const { updateIssue, isSubmitting, error } = useIssueMutations();

  /**
   * 起動前に`11.local`を付ける。**失敗しても起動自体は妨げない**
   * （起動できないより、ラベルが遅れる方が軽い）。
   */
  async function ensureLocalLabel() {
    const labelNames = issue.labels.map((label) => label.name);
    if (labelNames.includes(LOCAL_LABEL_NAME)) return;
    const updated = await updateIssue({
      repositoryFullName: issue.repositoryFullName,
      number: issue.number,
      labels: [...labelNames, LOCAL_LABEL_NAME],
    });
    if (updated) onIssueUpdated(updated);
  }

  /**
   * 起動ジョブを積み、積めたときだけ`11.local`を付ける。
   * **拒否されたのにラベルだけ残ると、無人実行までそのIssueに触れなくなる。**
   *
   * `agent`（#2505）を省略すると既定のClaude Codeで立つ。**「サブPCで開始」ボタンと
   * 「セッションを復旧」は省略する**——エージェントを選ばせるのは「実装を開始」ダイアログ
   * だけにして、同じ選択をメニューの階層でも持たない。
   */
  async function launch(hostName: string, agent?: DispatchAgent): Promise<boolean> {
    const enqueued = await dispatch.enqueue({
      repositoryFullName: issue.repositoryFullName,
      issueNumber: issue.number,
      hostName,
      agent,
    });
    if (enqueued) await ensureLocalLabel();
    return enqueued;
  }

  return {
    launch,
    /** ラベル付与とジョブの積み込みのどちらかが進行中か */
    isSubmitting: isSubmitting || dispatch.isSubmitting,
    /** ラベル付与に失敗した理由（ジョブ側の失敗は`dispatch.error`） */
    error,
  };
}
