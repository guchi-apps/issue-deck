"use client";

import { useState } from "react";
import { Loader2, Server } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import { useIssueMutations } from "@/hooks/use-issue-mutations";
import { resolveDefaultDispatchHost } from "@/lib/dispatch/dispatch-job";
import { enqueueIssueToDefaultHost } from "@/lib/dispatch/enqueue-issue";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import type { Issue } from "@/types/issue";

/**
 * 選んだIssueをまとめてサブPCへ積むバー（#1266）。
 *
 * GitHub Actionsで並列に一括で流す使い方をやめた代わりに、**夜にまとめて積んで順に流す**
 * 手段が要る（#1261）。積んだぶんは`claimDispatchJob`が`createdAt`の昇順で払い出すので、
 * **選んだ順ではなく積んだ順に流れる**。
 *
 * オプション（`21.plan-required`等）はここでは選ばせない。**まとめて積む場面では、Issueごとに
 * 要否が違うものを一括で決める方が事故になる**ため、必要なIssueは個別に「実装を開始」から
 * 積む。既に付いているラベルはそのまま効く（ランチャーが読む）。
 */
export function BulkDispatchBar({
  issues,
  dispatch,
  onDone,
}: {
  /** 選択中のIssue */
  issues: Issue[];
  dispatch: DispatchStateHandle;
  /** 積み終えたら選択モードを抜ける */
  onDone: () => void;
}) {
  const { updateIssue } = useIssueMutations();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const host = resolveDefaultDispatchHost({
    hosts: dispatch.hosts,
    repositoryFullName: issues[0]?.repositoryFullName ?? "",
    // 個々のIssueの未完了ジョブ・セッションは下で1件ずつ見る。ここでは「そもそも積めるホストか」だけ
    hasActiveJob: false,
    blockingSession: null,
  });

  async function enqueueAll() {
    if (!host) return;
    setIsSubmitting(true);
    setResult(null);
    let queued = 0;
    const skipped: string[] = [];

    // **1件ずつ順に投げる。** まとめて投げると、拒否された理由がどのIssueのものか分からない。
    // 積む順がそのまま実行順になるので、選択の並び（＝一覧の並び）のまま送る。
    // 1件ぶんの手順は「次にやること」の自動開始（#1853）と共有する
    for (const issue of issues) {
      const outcome = await enqueueIssueToDefaultHost(issue, {
        hosts: dispatch.hosts,
        sessions: dispatch.sessions,
        enqueue: dispatch.enqueue,
        enqueueError: dispatch.error,
        updateIssue,
      });
      if (!outcome.ok) {
        skipped.push(`#${issue.number}: ${outcome.reason}`);
        continue;
      }
      queued += 1;
    }

    setIsSubmitting(false);
    if (skipped.length === 0) {
      onDone();
      return;
    }
    // **積めなかったぶんは黙って消さない。** 選択モードも維持して、何が残ったか分かるようにする
    setResult([`${queued}件を積みました。積めなかったもの:`, ...skipped].join("\n"));
  }

  return (
    <div className="flex flex-col gap-2 border-b bg-muted/40 px-4 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {issues.length === 0 ? "積むIssueを選んでください" : `${issues.length}件を選択中`}
        </p>
        <Button
          size="sm"
          disabled={issues.length === 0 || !host || isSubmitting}
          title={host ? undefined : "積める起動先がありません"}
          onClick={() => void enqueueAll()}
        >
          {isSubmitting ? <Loader2 className="animate-spin" /> : <Server />}
          {host ? `${formatDispatchHostName(host)}へ順に積む` : "積める起動先がありません"}
        </Button>
      </div>
      {result && <p className="whitespace-pre-wrap text-xs text-destructive">{result}</p>}
    </div>
  );
}
