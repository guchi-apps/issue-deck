"use client";

import { useState } from "react";
import { Check, Loader2, MessageSquareText, Monitor } from "lucide-react";

import { Button } from "@/components/ui/button";
import { IssueSessionStatus } from "@/components/dashboard/issue-session-status";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import {
  describeDispatchJobStatus,
  describeManualStepExecutionRejection,
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
import {
  buildManualStepSessionPlan,
  type ManualStepSessionPlan,
} from "@/lib/manual-step-session-plan";
import type { Issue } from "@/types/issue";
import { cn } from "@/lib/utils";

/**
 * 手作業Issueを、サブPCのClaude Codeセッションと対話しながら進める入口（#2771）。
 *
 * 手作業アシスタントの代行実行（「承認してN件を自動実行」）は本文のコマンドをpollerが1件ずつ
 * 実行し、失敗したら出力を貼って診断する往復になる。こちらは**このIssue専用のセッションを
 * サブPCに1本立て**、止まるところまで手順を流す。答える先は
 * Issue詳細の質問パネル（`QuestionAnswerPanel`）でも、Claude Codeアプリ（Remote Control）でもよい。
 *
 * **本文に書かれた手順は、押した1回で最後まで流す**（#2830）。#2771では手順ごとに
 * 「実行しますか？」「次へ進みますか？」と2回ずつ聞いていたが、5手順のIssueで10回答えることになり、
 * 「チェックする必要がないなら自動で実行してほしい」という要望を受けて線を引き直した。
 * 歯止めは**本文に書かれたコマンドかどうか**で、本文に無いコマンド（失敗の調査・修正案）は
 * これまでどおり毎回承認を取る（`docs/multi-agent/gates.md`の例外5）。
 *
 * そのため、**押す1回で何が流れるのかを押す前に並べる**。振り分けの判定は
 * `buildManualStepSessionPlan`＝代行実行と同じ関数で、理由の文言も
 * `describeManualStepExecutionRejection`から取る。
 *
 * **ただし、並べたものと実際に流れるものが一致する保証は無い。** 代行実行の照合2回・
 * `body_changed`・5分の失効に当たるものはセッションに無く、起動後に自分で本文を読み直す。
 * ここは押す前に射程を見せるためのもので、代行実行の担保を移したものではない。
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
  showRunPlan = true,
  className,
}: {
  issue: Pick<Issue, "repositoryFullName" | "number" | "labels" | "body">;
  dispatch: DispatchStateHandle;
  /** 生きているセッションの行（`IssueSessionStatus`）をこのパネルの中に出すか */
  showSessionStatus?: boolean;
  /**
   * 起動前の実行計画（#2830）を、このパネルの中に並べるか。
   *
   * **手作業アシスタントの最初の画面では出さない。** すぐ上の承認パネル
   * （`ManualStepAutoRunPanel`）が同じコマンドを同じ形で並べており、2つ重ねると
   * 同じ一覧が画面に2回出る。Issue詳細の手作業パネルには並べる相手が居ないので出す。
   */
  showRunPlan?: boolean;
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
  const isManualStep = isManualStepIssue(issue.labels);
  const rejection = resolveManualStepSessionRejection({
    host,
    isManualStepIssue: isManualStep,
    hasActiveJob,
    blockingSession: aliveSession,
  });

  // 本文の解析は毎レンダー行う（`parseManualStepGuide`は文字列を1回走査するだけで、
  // 手作業パネルの他の部品も同じことをしている）
  const plan = buildManualStepSessionPlan(issue.body, { isManualStepIssue: isManualStep });

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
            {aliveSession.answerInApp ? (
              <>
                この手作業のセッションが動いています。
                <strong className="font-medium text-foreground">
                  手順の結果と質問はClaude Codeアプリで受け取ります
                </strong>
                。この画面で答えたいときは「アプリで答える」をOFFに戻してください。
              </>
            ) : (
              <>
                この手作業のセッションが動いています。あなたが実行する手順・失敗で止まったときは
                「質問の回答を待っています」に出るので、そこから答えると続きが自動で流れます。
                相談は「Claude Codeアプリで開く」からそのまま送れます。
              </>
            )}
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
            にこのIssue専用のClaude Codeセッションを立て、本文の手順を上から順に
            <strong className="font-semibold text-foreground">自動で実行します</strong>。
            終了コード0のときだけ本文の <code>- [ ]</code> にチェックを付けて次へ進み、
            <strong className="font-semibold text-foreground">
              あなたが実行する手順・失敗したとき・本文に無いコマンドが要るとき
            </strong>
            に手を止めて聞きます。答える先はこの画面の質問パネルかClaude Codeアプリです。
            出力はセッションの中だけに留め、Issueには書きません。
          </p>

          {/* 手作業Issueでなければ並べない。**同じ理由が手順の数だけ並ぶ**だけで、
              押せない理由は下に1回出ている */}
          {showRunPlan && isManualStep && (
            <ManualStepSessionRunPlan plan={plan} hostName={hostName} />
          )}

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
              {plan.auto > 0 ? `セッションを起動して${plan.auto}件を自動実行` : "セッションを起動"}
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

/**
 * 起動を押した1回で何が流れるのかの一覧（#2830）。
 *
 * **畳まずに全部出す。** 見せる対象は「本文の手順」ではなく「これから実行される文字列」で、
 * 人に頼む手順もその理由とともに同じ並びへ出す——飛ばされないことが分かっていないと、
 * 自分が実行する手順を待たずにセッションが先へ進むと誤解する。
 */
function ManualStepSessionRunPlan({
  plan,
  hostName,
}: {
  plan: ManualStepSessionPlan;
  hostName: string;
}) {
  // 手順に割れていない本文（テンプレートどおりでないもの）では並べるものが無い。
  // セッションは本文をそのまま読んで進めるので、ここは黙って出さない
  if (plan.entries.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-md border bg-background">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b bg-muted/40 px-2.5 py-1.5 text-[11.5px] font-semibold">
        <span className="text-violet-700 dark:text-violet-300">自動で実行 {plan.auto}件</span>
        <span className="font-normal text-muted-foreground">／</span>
        <span className="text-amber-700 dark:text-amber-400">あなたが実行 {plan.user}件</span>
        <span className="ml-auto font-mono text-[11px] font-normal text-muted-foreground">
          {hostName}
        </span>
      </div>

      <ol className="flex flex-col">
        {plan.entries.map((entry) => (
          <li
            key={entry.line}
            className={cn(
              "flex flex-wrap items-baseline gap-x-2 gap-y-1 border-t px-2.5 py-2 first:border-t-0",
              entry.checked && "opacity-60",
              !entry.checked && entry.rejection !== null && "bg-amber-500/5",
            )}
          >
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
              {entry.kind === "step" ? entry.order : "確認"}
            </span>
            <span className="min-w-0 flex-1 basis-[60%] text-xs">{entry.text}</span>
            <span className="ml-auto flex shrink-0 flex-wrap justify-end gap-1">
              {/* 端末は**それが理由のときだけ**出す。コマンドが1つに定まらない手順に
                  「サブPC」と付けると、端末のせいで代行できないように読める */}
              {!entry.checked && entry.rejection === "device_not_subpc" && entry.device !== null && (
                <Badge tone="device">{entry.device}</Badge>
              )}
              {entry.checked ? (
                <Badge tone="done">
                  <Check className="size-3" aria-hidden />
                  実行済み
                </Badge>
              ) : entry.rejection === null ? (
                <Badge tone="auto">自動</Badge>
              ) : (
                <Badge tone="user">あなたが実行</Badge>
              )}
            </span>
            {entry.command !== null && !entry.checked && (
              <pre className="w-full overflow-x-auto rounded border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">
                {entry.command}
              </pre>
            )}
            {!entry.checked && entry.rejection !== null && (
              <p className="w-full text-[11px] leading-relaxed text-muted-foreground">
                {describeManualStepExecutionRejection(entry.rejection, {
                  hostName,
                  device: entry.device,
                  interactiveCommand: entry.interactiveCommand,
                  placeholder: entry.placeholder,
                })}
              </p>
            )}
          </li>
        ))}
      </ol>

      <p className="border-t bg-muted/20 px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
        本文に無いコマンド（失敗の原因調べ・手順の直し）を実行するときは、自動実行の途中でも
        全文を示して毎回聞きます。クローズも最後に聞きます。
      </p>
    </div>
  );
}

/** 一覧の印。**同じ形・同じ位置**で並べる（行ごとに大きさが変わると読み飛ばしにくい） */
function Badge({
  tone,
  children,
}: {
  tone: "auto" | "user" | "device" | "done";
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-px text-[10.5px] font-semibold whitespace-nowrap",
        tone === "auto" &&
          "border-violet-500/40 bg-violet-500/5 text-violet-700 dark:text-violet-300",
        tone === "user" && "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
        tone === "device" && "font-medium text-muted-foreground",
        tone === "done" &&
          "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      )}
    >
      {children}
    </span>
  );
}
