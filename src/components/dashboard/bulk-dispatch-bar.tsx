"use client";

import { useState } from "react";
import { Loader2, Server } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import { useIssueMutations } from "@/hooks/use-issue-mutations";
import {
  describeDispatchEnqueueRejection,
  findBlockingSession,
  resolveDefaultDispatchHost,
  resolveDispatchTargetRejection,
} from "@/lib/dispatch/dispatch-job";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import { labelNamesWithLocal } from "@/lib/github/project-status-dispatch";
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
    // 積む順がそのまま実行順になるので、選択の並び（＝一覧の並び）のまま送る
    for (const issue of issues) {
      const hostView = dispatch.hosts.find((candidate) => candidate.name === host) ?? null;
      // **セッションの生存はここでも見る（#1311）。** 未完了ジョブと違い、こちらはAPI側に
      // 弾かれても「積めなかった理由」が1件ずつ返るだけで、押す前に分かる方が親切。
      // 最終判定はAPI側（`enqueueDispatchJob`）が行う点は未完了ジョブと同じ
      const blockingSession = findBlockingSession({
        sessions: dispatch.sessions,
        hosts: dispatch.hosts,
        repositoryFullName: issue.repositoryFullName,
        issueNumber: issue.number,
      });
      const rejection = resolveDispatchTargetRejection({
        host: hostView,
        repositoryFullName: issue.repositoryFullName,
        // 未完了ジョブの有無はAPI側が最終判定する（`activeKey`のunique制約）。ここでは
        // 「そのリポジトリを実行できるか」までを先に見る
        hasActiveJob: false,
        blockingSession,
      });
      if (rejection) {
        skipped.push(
          `#${issue.number}: ${describeDispatchEnqueueRejection(rejection, {
            hostName: host,
            repositoryFullName: issue.repositoryFullName,
            session: blockingSession,
          })}`,
        );
        continue;
      }

      const enqueued = await dispatch.enqueue({
        repositoryFullName: issue.repositoryFullName,
        issueNumber: issue.number,
        hostName: host,
      });
      if (!enqueued) {
        // 拒否理由は`dispatch.error`に入る。**積めなかったIssueには`11.local`を付けない**
        // （付けると無人実行までそのIssueに触れなくなる）
        skipped.push(`#${issue.number}: ${dispatch.error ?? "積めませんでした"}`);
        continue;
      }
      queued += 1;

      const nextNames = labelNamesWithLocal(issue.labels);
      if (nextNames) {
        await updateIssue({
          repositoryFullName: issue.repositoryFullName,
          number: issue.number,
          labels: nextNames,
        });
      }
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
