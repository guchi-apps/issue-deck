"use client";

import { useCallback, useMemo, useState } from "react";

import { useIssueMutations } from "@/hooks/use-issue-mutations";
import { countTaskListItems, toggleTaskListLine } from "@/lib/markdown-task-list";
import type { Issue } from "@/types/issue";

/**
 * Issue本文のタスクリスト（`- [ ]`）を画面からチェックできるようにする（#1486）。
 *
 * チェックの実体はIssue本文そのもので、トグルすると本文を`PATCH /api/issues`で書き換える。
 * 専用のAPIもDBの列も増やさないので、GitHub側でチェックしても画面でチェックしても同じ状態になる。
 *
 * 主な用途は手作業Issue（`71.manual-step`）の「やること」を消し込みながら実行すること。
 * PC・モバイルの両方のIssue詳細で同じ挙動にするため、状態をここへまとめている。
 */
export function useIssueTaskList(issue: Issue | null, onIssueUpdated: (issue: Issue) => void) {
  const { updateIssue, error, setError } = useIssueMutations();
  const [isToggling, setIsToggling] = useState(false);
  // 応答を待つ間もチェックが付いて見えるようにする楽観表示。`base`（送信時点の本文）を
  // 一緒に持ち、**GitHub側の本文がそれと変わった時点で捨てる**。反映が返ってきた後も、
  // 別経路で本文が書き換わった後も、画面に古い本文を残さないための条件になる
  const [pending, setPending] = useState<{ key: string; base: string; body: string } | null>(null);

  const issueKey = issue ? `${issue.repositoryFullName}#${issue.number}` : "";
  const body =
    issue && pending && pending.key === issueKey && pending.base === issue.body
      ? pending.body
      : (issue?.body ?? "");

  const progress = useMemo(() => countTaskListItems(body), [body]);

  const toggleTask = useCallback(
    async (line: number, checked: boolean) => {
      if (!issue || isToggling) return;

      const nextBody = toggleTaskListLine(body, line, checked);
      // 指定行がタスク行でない＝画面を開いてから本文が変わっている。無関係な行を壊さない
      if (nextBody === body) return;

      setIsToggling(true);
      setError(null);
      setPending({ key: issueKey, base: issue.body, body: nextBody });

      const updated = await updateIssue({
        repositoryFullName: issue.repositoryFullName,
        number: issue.number,
        body: nextBody,
      });

      setIsToggling(false);
      if (updated) {
        onIssueUpdated(updated);
        return;
      }
      // 失敗したらチェックを元に戻す（理由は`error`として画面に出る）
      setPending(null);
    },
    [issue, isToggling, body, issueKey, updateIssue, setError, onIssueUpdated],
  );

  return { body, progress, isToggling, error, toggleTask };
}
