"use client";

import { useState } from "react";
import { Loader2, MessageSquareText, Monitor } from "lucide-react";

import { Button } from "@/components/ui/button";
import { IssueSessionStatus } from "@/components/dashboard/issue-session-status";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import {
  describeDispatchJobStatus,
  describeManualStepSessionRejection,
  findManualStepSessionJobForIssue,
  isActiveDispatchJobStatus,
  resolveDefaultManualStepSessionHost,
  resolveManualStepHost,
  resolveManualStepSessionRejection,
} from "@/lib/dispatch/dispatch-job";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import { findSessionForIssue } from "@/lib/dispatch/issue-session";
import { isManualStepIssue } from "@/lib/github/approval-labels";
import type { Issue } from "@/types/issue";
import { cn } from "@/lib/utils";

/**
 * 手作業Issueを、サブPCのClaude Codeセッションと対話しながら進める入口（#2771）。
 *
 * 手作業アシスタントの代行実行（「承認してN件を自動実行」）は本文のコマンドをpollerが1件ずつ
 * 実行し、失敗したら出力を貼って診断する往復になる。こちらは**このIssue専用のセッションを
 * サブPCに1本立て**、手順を1つ実行するたびに結果を示して「次へ進む」を聞く。答える先は
 * Issue詳細の質問パネル（`QuestionAnswerPanel`）でも、Claude Codeアプリ（Remote Control）でもよい。
 *
 * **「自動で最後まで」は持たない。** 本文に無いコマンドまで実行体の判断で流れる形になり、
 * 代行実行が持つ「本文に書かれたコマンドしか実行しない」歯止め（`docs/multi-agent/gates.md`）を
 * プロンプトだけの担保に置き換えることになるため（計画レビューの指摘で落とした）。手順を自動で
 * 流したいときは既存の代行実行を使う。
 *
 * **PC・スマホで同じコンポーネントを使う**（アシスタントの他の部品と同じ方針）。置く場所は2つで、
 * アシスタントの最初の画面（承認パネルの下）とIssue詳細の手作業パネル。後者では
 * `IssueStatusCard`がセッションの行を出すので、こちらでは重ねて出さない（`showSessionStatus`）。
 *
 * 押せない理由は押す前に出す（`resolveManualStepSessionRejection`。投入側の`jobs.ts`と同じ判定）。
 */
export function ManualStepSessionPanel({
  issue,
  dispatch,
  showSessionStatus = false,
  className,
}: {
  issue: Pick<Issue, "repositoryFullName" | "number" | "labels">;
  dispatch: DispatchStateHandle;
  /** 生きているセッションの行（`IssueSessionStatus`）をこのパネルの中に出すか */
  showSessionStatus?: boolean;
  className?: string;
}) {
  const [error, setError] = useState<string | null>(null);

  // 起動先は**手作業セッションに対応したオンラインのホスト**。無ければ代行実行と同じ既定の
  // ホストを「理由を出す相手」として使う（申告が無い理由を、ホスト名つきで出せる）
  const host =
    resolveDefaultManualStepSessionHost(dispatch.hosts) ?? resolveManualStepHost(dispatch.hosts);
  const hostName = host?.name ?? "サブPC";
  const job = findManualStepSessionJobForIssue(
    dispatch.jobs,
    issue.repositoryFullName,
    issue.number,
  );
  const hasActiveJob = job !== null && isActiveDispatchJobStatus(job.status);
  const session = findSessionForIssue(dispatch.sessions, issue.repositoryFullName, issue.number);
  const aliveSession = session?.state === "ALIVE" ? session : null;
  const rejection = resolveManualStepSessionRejection({
    host,
    isManualStepIssue: isManualStepIssue(issue.labels),
    hasActiveJob,
    blockingSession: aliveSession,
  });

  async function handleStart() {
    if (!host) return;
    setError(null);
    const result = await dispatch.startManualStepSession({
      repositoryFullName: issue.repositoryFullName,
      issueNumber: issue.number,
      hostName: host.name,
    });
    if (!result.ok) setError(result.message);
  }

  return (
    <section
      className={cn(
        "flex flex-col gap-2 rounded-md border border-primary/30 bg-primary/5 p-2.5",
        className,
      )}
      aria-label="Claude Codeセッションで進める"
    >
      <h4 className="flex items-center gap-1.5 text-xs font-semibold">
        <Monitor className="size-3.5 shrink-0" aria-hidden />
        Claude Codeセッションで進める
      </h4>

      {aliveSession ? (
        <>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            この手作業のセッションが動いています。手順の結果は「質問の回答を待っています」から答え、
            相談は「Claude Codeアプリで開く」からそのまま送れます。
            {!showSessionStatus && "操作は上のセッションの行にあります。"}
          </p>
          {showSessionStatus && (
            <IssueSessionStatus session={aliveSession} dispatch={dispatch} align="start" />
          )}
        </>
      ) : (
        <>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {formatDispatchHostName(hostName)}
            にこのIssue専用のClaude Codeセッションを立てます。手順を1つ実行するたびに結果を示して
            「次へ進む」を聞き、この画面の質問パネルかClaude Codeアプリから答えられます。
            実行するコマンドは、実行する前に必ず全文を示して確認します。
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={rejection !== null || dispatch.isSubmitting}
              onClick={() => void handleStart()}
            >
              {dispatch.isSubmitting ? (
                <Loader2 className="animate-spin" />
              ) : (
                <MessageSquareText />
              )}
              セッションを起動
            </Button>
            {/* 押した操作がどこまで進んだか（pull型なので届くまで最大30秒ほど何も起きない） */}
            {job && hasActiveJob && (
              <span className="text-[11px] text-muted-foreground">
                {describeDispatchJobStatus(job.status, job.kind).label}
                （反映まで30秒ほどかかります）
              </span>
            )}
          </div>
          {/* 押せない理由は押す前に出す（#1180の「選べない理由は押す前に出す」と同じ立場）。
              未処理のジョブがある場合は、上の状態表示が同じことを言うので出さない */}
          {rejection !== null && rejection !== "already_queued" && (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {describeManualStepSessionRejection(rejection, { hostName })}
            </p>
          )}
          {job && !hasActiveJob && job.message && (
            <p
              className={cn(
                "text-[11px] leading-relaxed",
                describeDispatchJobStatus(job.status, job.kind).tone === "error"
                  ? "text-destructive"
                  : "text-muted-foreground",
              )}
            >
              {describeDispatchJobStatus(job.status, job.kind).label}: {job.message}
            </p>
          )}
          {error && <p className="text-[11px] text-destructive">{error}</p>}
        </>
      )}
    </section>
  );
}
