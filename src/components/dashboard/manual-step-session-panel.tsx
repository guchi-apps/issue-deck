"use client";

import { useState } from "react";
import { Asterisk, Check, Copy, Loader2, MessageSquareText, Monitor, SquareTerminal } from "lucide-react";

import {
  CLAUDE_LOCAL_MODEL_DEFAULT,
  CLAUDE_MODEL_FIT_LABELS,
  CODEX_LOCAL_MODEL_VALUES,
  CODEX_MODEL_FIT_LABELS,
  describeClaudeModel,
  describeCodexModel,
  type ClaudeLocalModel,
  type CodexLocalModel,
} from "@/lib/app-settings";
import { AgentChip, CodexLimitationsNotice, ModelChip } from "@/components/dashboard/agent-model-chips";
import { Button } from "@/components/ui/button";
import { IssueSessionStatus } from "@/components/dashboard/issue-session-status";
import { copyText } from "@/lib/copy-text";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import {
  describeDispatchJobStatus,
  describeDispatchAgent,
  describeManualStepExecutionRejection,
  describeManualStepSessionRejection,
  DEFAULT_DISPATCH_AGENT,
  findManualStepSessionJobForIssue,
  isActiveDispatchJobStatus,
  isDispatchAgentSelectable,
  resolveDefaultManualStepSessionHost,
  resolveManualStepHost,
  resolveManualStepSessionRejection,
  type DispatchAgent,
} from "@/lib/dispatch/dispatch-job";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import { findSessionForIssue } from "@/lib/dispatch/issue-session";
import { isManualStepIssue } from "@/lib/github/approval-labels";
import {
  buildManualStepSessionPlan,
  type ManualStepSessionPlan,
} from "@/lib/manual-step-session-plan";
import { splitShellCommandLines } from "@/lib/shell-command-lines";
import type { Issue } from "@/types/issue";
import { cn } from "@/lib/utils";

const MANUAL_STEP_SESSION_MODEL_ENTRIES: readonly ClaudeLocalModel[] = [
  "fable",
  "opus",
  "sonnet",
];

const MANUAL_STEP_SESSION_AGENT_ENTRIES = [
  { agent: "claude", icon: Asterisk },
  { agent: "codex", icon: SquareTerminal },
] as const;

/**
 * 手作業Issueを、サブPCのAIエージェントセッションと対話しながら進める入口（#2771）。
 *
 * 手作業アシスタントの代行実行（「承認してN件を自動実行」）は本文のコマンドをpollerが1件ずつ
 * 実行し、失敗したら出力を貼って診断する往復になる。こちらは**このIssue専用のセッションを
 * サブPCに1本立て**、止まるところまで手順を流す。答える先は
 * Issue詳細の質問パネルか、選択したエージェントのセッションから進める。
 *
 * セッションは本文の手順を出発点に、**本文に書かれていない調査・修正・確認も含めて**目的の達成まで
 * 自律実行する（#3870）。ユーザー本人の操作・秘密値・未確定の不可逆な変更だけを質問に戻す。
 *
 * 本文から抽出できる既知の手順は押す前に一覧にする。ただし一覧は実行範囲の上限ではなく、
 * セッションが追加で行う調査・修正・確認はここには載らない。
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
  const [agent, setAgent] = useState<DispatchAgent>(DEFAULT_DISPATCH_AGENT);
  // 手作業の内容を見て人が選ぶ入口なので、「設定に従う」は置かない。どのモデルで始まるかを
  // 起動前に明示するため、通常の実装開始と同じ3候補から既定のSonnetを選んだ状態で始める。
  const [claudeModel, setClaudeModel] = useState<ClaudeLocalModel>(CLAUDE_LOCAL_MODEL_DEFAULT);
  const [codexModel, setCodexModel] = useState<CodexLocalModel>("gpt-5.6-terra");

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
    agent,
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
      agent,
      model: agent === "codex" ? codexModel : claudeModel,
    });
    if (!result.ok) setError(result.message);
  }

  return (
    <section
      className={cn(
        "flex flex-col gap-2 rounded-md border border-primary/30 bg-primary/5 p-2.5",
        className,
      )}
      aria-label="AIセッションで進める"
    >
      <h4 className="flex items-center gap-1.5 text-xs font-semibold">
        <Monitor className="size-3.5 shrink-0" aria-hidden />
        AIセッションで進める
      </h4>

      {aliveSession ? (
        <>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {aliveSession.answerInApp ? (
              <>
                この手作業のセッションが動いています。
                <strong className="font-medium text-foreground">
                  手順の結果と質問は起動したセッションで受け取ります
                </strong>
                。この画面で答えたいときは「アプリで答える」をOFFに戻してください。
              </>
            ) : (
              <>
                この手作業のセッションが動いています。あなたが実行する手順・失敗で止まったときは
                「質問の回答を待っています」に出るので、そこから答えると続きが自動で流れます。
                相談は起動したセッションからそのまま送れます。
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
            にこのIssue専用の{describeDispatchAgent(agent)}セッションを立て、本文の目的に必要な作業を
            <strong className="font-semibold text-foreground">自動で実行します</strong>。
            本文の記載が不足していても、調査・修正・確認を自律して進めます。実施済みの本文の
            <code>- [ ]</code> にはチェックを付け、
            <strong className="font-semibold text-foreground">
              秘密値・本人操作・未確定の不可逆な変更が必要なとき
            </strong>
            に手を止めて聞きます。Codexを選んだ場合の画面連携の制約は下に表示します。
            出力はセッションの中だけに留め、Issueには書きません。
          </p>

          <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold">エージェント</p>
            <div role="radiogroup" aria-label="エージェント" className="grid grid-cols-2 gap-2">
              {MANUAL_STEP_SESSION_AGENT_ENTRIES.map((entry) => (
                <AgentChip
                  key={entry.agent}
                  icon={entry.icon}
                  label={describeDispatchAgent(entry.agent)}
                  isDefault={entry.agent === DEFAULT_DISPATCH_AGENT}
                  selected={agent === entry.agent}
                  disabled={entry.agent === "codex" && !isDispatchAgentSelectable(host)}
                  onSelect={() => setAgent(entry.agent)}
                />
              ))}
            </div>
            {agent === "codex" && <CodexLimitationsNotice />}
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold">モデル</p>
            <div role="radiogroup" aria-label="モデル" className={cn("grid gap-2", agent === "codex" ? "grid-cols-2" : "grid-cols-3")}>
              {agent === "codex"
                ? CODEX_LOCAL_MODEL_VALUES.map((entry) => (
                    <ModelChip key={entry} label={describeCodexModel(entry)} fit={CODEX_MODEL_FIT_LABELS[entry]} selected={codexModel === entry} onSelect={() => setCodexModel(entry)} />
                  ))
                : MANUAL_STEP_SESSION_MODEL_ENTRIES.map((entry) => (
                    <ModelChip key={entry} label={describeClaudeModel(entry)} fit={CLAUDE_MODEL_FIT_LABELS[entry]} selected={claudeModel === entry} onSelect={() => setClaudeModel(entry)} />
                  ))}
            </div>
          </div>

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
              セッションを起動して実行を開始
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
 * 本文から読み取れた既知の手順の一覧。
 *
 * **畳まずに全部出す。** 一覧は本文の記載から得られる候補であり、セッションが実際に実行する
 * 作業の上限ではない。目的の達成に必要な調査・修正・確認は、本文に無くても自動で追加する。
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
        <span className="text-violet-700 dark:text-violet-300">本文から実行可能 {plan.auto}件</span>
        <span className="font-normal text-muted-foreground">／</span>
        <span className="text-amber-700 dark:text-amber-400">本人操作が必要そう {plan.user}件</span>
        <span className="ml-auto font-mono text-[11px] font-normal text-muted-foreground">
          {hostName}
        </span>
      </div>

      <ManualStepUserCommands
        entries={plan.entries.filter((entry) => !entry.checked && entry.rejection !== null)}
        hostName={hostName}
      />

      <ol className="flex flex-col border-t">
        {plan.entries.filter((entry) => entry.checked || entry.rejection === null).map((entry) => (
          <li
            key={entry.line}
            className={cn(
              "flex flex-wrap items-baseline gap-x-2 gap-y-1 border-t px-2.5 py-2 first:border-t-0",
              entry.checked && "opacity-60",
            )}
          >
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
              {entry.kind === "step" ? entry.order : "確認"}
            </span>
            <span className="min-w-0 flex-1 basis-[60%] text-xs">{entry.text}</span>
            <span className="ml-auto flex shrink-0 flex-wrap justify-end gap-1">
              {/* 端末は**それが理由のときだけ**出す。コマンドが1つに定まらない手順に
                  「サブPC」と付けると、端末のせいで代行できないように読める */}
              {entry.checked ? (
                <Badge tone="done">
                  <Check className="size-3" aria-hidden />
                  実行済み
                </Badge>
              ) : (
                <Badge tone="auto">自動</Badge>
              )}
            </span>
            {entry.command !== null && !entry.checked && (
              <pre className="w-full overflow-x-auto rounded border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">
                {entry.command}
              </pre>
            )}
          </li>
        ))}
      </ol>

      <p className="border-t bg-muted/20 px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
        本文に無い調査・修正・確認も自動で行います。秘密値・本人操作・未確定の不可逆な変更だけを
        質問に戻し、クローズは最後に聞きます。
      </p>
    </div>
  );
}

/**
 * 人が端末・ブラウザで行うコマンドを、コピーできる単位でまとめて出す（#3303）。
 *
 * `splitShellCommandLines`の結果は表示・コピー専用であり、セッションの実行へ渡さない。
 * そのため、ここで改行や`&&`を分けても本文照合と実行の単位は変わらない。
 */
function ManualStepUserCommands({
  entries,
  hostName,
}: {
  entries: ManualStepSessionPlan["entries"];
  hostName: string;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const commands = entries.flatMap((entry) =>
    entry.filledCommand === null
      ? []
      : splitShellCommandLines(entry.filledCommand).map((command) => ({ entry, command })),
  );
  const allCommands = commands.map(({ command }) => command).join("\n");

  async function handleCopy(key: string, text: string) {
    if (await copyText(text)) setCopied(key);
  }

  if (entries.length === 0) return null;

  return (
    <section className="border-b border-amber-500/30 bg-amber-500/5" aria-labelledby="manual-step-user-commands">
      <div className="flex flex-wrap items-center gap-2 px-2.5 py-2">
        <div className="min-w-0 flex-1">
          <p id="manual-step-user-commands" className="text-xs font-semibold text-amber-800 dark:text-amber-300">
            本人操作が必要そう {entries.length}件
          </p>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            PCではまとめて、スマホでは1行ずつコピーして実行できます。
          </p>
        </div>
        {commands.length > 0 && (
          <Button variant="outline" size="xs" onClick={() => void handleCopy("all", allCommands)}>
            {copied === "all" ? <Check /> : <Copy />}
            {copied === "all" ? "コピーしました" : `${commands.length}行をまとめてコピー`}
          </Button>
        )}
      </div>
      <ol className="flex flex-col border-t border-amber-500/20">
        {entries.map((entry) => {
          const entryCommands = commands.filter((item) => item.entry.line === entry.line);
          return (
            <li key={entry.line} className="border-t border-amber-500/20 px-2.5 py-2 first:border-t-0">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                  {entry.kind === "step" ? entry.order : "確認"}
                </span>
                <span className="min-w-0 flex-1 text-xs">{entry.text}</span>
                {entry.rejection === "device_not_runnable" && entry.device !== null && (
                  <Badge tone="device">{entry.device}</Badge>
                )}
              </div>
              {entryCommands.map(({ command }, index) => {
                const key = `${entry.line}:${index}`;
                return (
                  <div key={key} className="mt-1.5 flex items-start gap-1.5">
                    <code className="min-w-0 flex-1 overflow-x-auto rounded border bg-background px-2 py-1.5 font-mono text-[11px] leading-relaxed">
                      {command}
                    </code>
                    <Button
                      variant="outline"
                      size="xs"
                      className="shrink-0"
                      onClick={() => void handleCopy(key, command)}
                    >
                      {copied === key ? <Check /> : <Copy />}
                      {copied === key ? "コピーしました" : "コピー"}
                    </Button>
                  </div>
                );
              })}
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                {describeManualStepExecutionRejection(entry.rejection!, {
                  hostName,
                  device: entry.device,
                  interactiveCommand: entry.interactiveCommand,
                  placeholder: entry.placeholder,
                })}
              </p>
            </li>
          );
        })}
      </ol>
      <span role="status" aria-live="polite" className="sr-only">
        {copied === null ? "" : "コマンドをコピーしました"}
      </span>
    </section>
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
