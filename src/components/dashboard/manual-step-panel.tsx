"use client";

import { BadgeCheck, Check, Copy, GitBranch, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { IssueDependents } from "@/components/dashboard/issue-dependents";
import { ManualStepPrerequisites } from "@/components/dashboard/manual-step-prerequisites";
import { Button } from "@/components/ui/button";
import { formatDateTime, formatDateTimeFull } from "@/lib/format-date-time";
import { ManualStepSessionPanel } from "@/components/dashboard/manual-step-session-panel";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import type { IssueDependent } from "@/lib/issue-dependents";
import type { Issue, IssueComment } from "@/types/issue";
import type { InfraConfigTarget } from "@/lib/infra-config-repos";
import { copyText } from "@/lib/copy-text";
import {
  findLatestManualStepInvestigation,
  findLatestManualStepVerification,
  type ManualStepInvestigation,
  type ManualStepVerificationRecord,
} from "@/lib/manual-step-investigation";
import { buildManualStepSessionPlan } from "@/lib/manual-step-session-plan";
import { isManualStepIssue } from "@/lib/github/approval-labels";
import type {
  ManualStepPrerequisite,
  ManualStepPrerequisiteSummary,
} from "@/lib/manual-step-prerequisites";
import { cn } from "@/lib/utils";

/**
 * 手作業Issue（`71.manual-step`）の詳細画面に出す、AI主導の作業状況と判断材料（#4315）。
 *
 * 以前は「順番に進める」（手順ウィザード）と「手作業を完了してクローズ」「実施せずクローズ」が
 * 主導線で、ユーザーが順番に実行し、自己申告で完了させる前提だった。**AIが調査・実行・検証できる
 * 範囲を進める**運用（#2830・#3870）に統一したため、この3つは持たない。完了はセッションが
 * 検証コマンドを流した結果（`manual-step-verification`コメント）だけで判定し、画面は結果と
 * 証跡を見せる。中止・失敗・未実施を完了と混同しない。
 *
 * 出すのは「作業の状況」（目的・AI実施済み・自動実行できる・あなたの操作）、前提条件、
 * このIssueを待っているIssue、完了検証の結果、セッションの入口。**番号・順番の進捗は出さない**。
 * 実際に必要な技術的依存は、前提条件（不足前提・待機理由）として残す。
 *
 * 配色にamberを使わないのは、amberが「ユーザーの確認待ち」（`00.check-user`）の色として
 * 使われているため（sidebar-nav・workflow-status-steps）。violetは`71.manual-step`
 * ラベル自体の色（`d876e3`、cross-repo-setup-guide.md）に合わせている。
 */
export function ManualStepPanel({
  isSubmitting,
  prerequisites,
  prerequisiteSummary,
  dependents,
  verifiedAt,
  comments,
  configTargets,
  onCreateConfigIssue,
  repositoryFullName,
  sessionIssue,
  dispatch,
  className,
}: {
  isSubmitting: boolean;
  /**
   * 待っている相手（先に完了している必要があるIssue・PR）の状況（#1705）。
   * **PC・スマホのどちらの詳細からも渡すこと**——片方だけだと答えが画面で食い違う。
   */
  prerequisites?: ManualStepPrerequisite[];
  /** 参照が1件も無ければnull。そのときは前提条件のブロックごと出さない */
  prerequisiteSummary?: ManualStepPrerequisiteSummary | null;
  /** このIssueの完了を待っているIssue（#2003） */
  dependents?: IssueDependent[];
  /** 定期巡回で`## 完了の確認方法`のコマンドがすべて通った日時（ISO8601。#2008） */
  verifiedAt?: string | null;
  /** Issueのコメント。セッションの事前調査・完了検証の報告を読む（#4315） */
  comments?: readonly IssueComment[];
  /** 実機のファイルを書き換える手順のうち、管理リポジトリで管理されているもの（#2021） */
  configTargets?: InfraConfigTarget[];
  /** 上記を対象リポジトリのIssueとして切り出す。渡さない場合は案内ごと出さない */
  onCreateConfigIssue?: (target: InfraConfigTarget) => void;
  repositoryFullName?: string;
  /**
   * 手作業セッション（#2771）の入口を出すためのIssueとディスパッチの状態。**両方揃ったときだけ出す**
   */
  sessionIssue?: Pick<Issue, "repositoryFullName" | "number" | "labels" | "body">;
  dispatch?: DispatchStateHandle;
  className?: string;
}) {
  const investigation = comments ? findLatestManualStepInvestigation(comments) : null;
  const verification = comments ? findLatestManualStepVerification(comments) : null;

  return (
    <section className={cn("flex flex-col gap-2", className)} aria-label="手作業の状況">
      {sessionIssue && (
        <ManualStepStatusBlock
          investigation={investigation}
          verification={verification}
          body={sessionIssue.body}
          labels={sessionIssue.labels}
        />
      )}
      {/* 待っている相手の状況（#1705）。不足前提・待機理由として出す */}
      {prerequisiteSummary && prerequisites && prerequisites.length > 0 && repositoryFullName && (
        <ManualStepPrerequisites
          prerequisites={prerequisites}
          summary={prerequisiteSummary}
          repositoryFullName={repositoryFullName}
        />
      )}
      {dependents && dependents.length > 0 && repositoryFullName && (
        <IssueDependents dependents={dependents} repositoryFullName={repositoryFullName} />
      )}
      {/* 実機を直接書き換える手順は、リポジトリ経由へ寄せられる（#2021） */}
      {onCreateConfigIssue && configTargets && configTargets.length > 0 && (
        <InfraConfigNotice
          targets={configTargets}
          onCreate={onCreateConfigIssue}
          isSubmitting={isSubmitting}
        />
      )}
      {verifiedAt && !verification?.passed && <ManualStepVerifiedNotice verifiedAt={verifiedAt} />}
      {/* 手作業セッション（#2771）。セッションの行は`IssueStatusCard`が出すので、ここは入口だけ */}
      {sessionIssue && dispatch && <ManualStepSessionPanel issue={sessionIssue} dispatch={dispatch} />}
    </section>
  );
}

/**
 * 作業の状況（#4315）。セッションの事前調査報告があればそれを、無ければ本文の静的な解析を
 * 「未確認」として出す。**未確認と調査済みを取り違えない**ため、静的な内訳には必ず
 * 「未確認」の印を付ける。
 */
function ManualStepStatusBlock({
  investigation,
  verification,
  body,
  labels,
}: {
  investigation: ManualStepInvestigation | null;
  verification: ManualStepVerificationRecord | null;
  body: string | null;
  labels: Issue["labels"];
}) {
  const plan = investigation ? null : buildManualStepSessionPlan(body, { isManualStepIssue: isManualStepIssue(labels) });
  return (
    <section
      className="rounded-md border border-violet-500/40 bg-background p-2.5"
      aria-labelledby="manual-step-status-title"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="manual-step-status-title" className="text-xs font-medium">
          作業の状況
        </h3>
        <StatusPill investigation={investigation} verification={verification} />
      </div>
      {investigation ? (
        <div className="mt-2 flex flex-col gap-2">
          {investigation.purpose && (
            <p className="text-xs text-muted-foreground">目的：{investigation.purpose}</p>
          )}
          <div className="grid gap-2 sm:grid-cols-3">
            <StatusList title="AIが実施済み" items={investigation.done} />
            <StatusList title="これから自動実行" items={investigation.auto} />
            <StatusList title="あなたの操作" items={investigation.user.map((u) => u.text)} />
          </div>
          {investigation.user.map((action, i) =>
            action.command ? <CommandLine key={i} command={action.command} /> : null,
          )}
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          {plan
            ? `未確認：セッションの事前調査はまだ報告されていません。本文からの見込みは、自動実行${plan.auto}件・あなたの操作${plan.user}件です（調査で変わることがあります）。`
            : "未確認：セッションの事前調査はまだ報告されていません。"}
        </p>
      )}
      {verification && <VerificationResult verification={verification} />}
    </section>
  );
}

function StatusPill({
  investigation,
  verification,
}: {
  investigation: ManualStepInvestigation | null;
  verification: ManualStepVerificationRecord | null;
}) {
  const [text, tone] = verification?.passed
    ? ["検証済み", "text-emerald-700 dark:text-emerald-300"]
    : verification
      ? ["検証失敗・未完了", "text-destructive"]
      : investigation
        ? investigation.user.length > 0
          ? ["あなたの操作を待っています", "text-violet-700 dark:text-violet-300"]
          : ["AIが実行中", "text-violet-700 dark:text-violet-300"]
        : ["未確認", "text-muted-foreground"];
  return (
    <span className={cn("rounded-full border border-current px-2 text-[11px] font-medium", tone)}>
      {text}
    </span>
  );
}

function StatusList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="min-w-0 rounded border px-2 py-1.5">
      <p className="text-[11px] font-medium">{title}</p>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">なし</p>
      ) : (
        <ul className="list-disc pl-4 text-xs text-muted-foreground">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** コピーして一度で実行できる1ライナー（#4315）。実行先・ユーザーはコマンドの前の行で示す */
function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-start gap-1.5">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre rounded bg-muted px-1.5 py-1 text-xs">
        {command}
      </code>
      <Button
        variant="outline"
        size="sm"
        onClick={async () => {
          setCopied(await copyText(command));
        }}
      >
        {copied ? <Check /> : <Copy />}
        コピー
      </Button>
    </div>
  );
}

function VerificationResult({ verification }: { verification: ManualStepVerificationRecord }) {
  return (
    <div className="mt-2 text-xs">
      <p className={verification.passed ? "text-emerald-700 dark:text-emerald-300" : "text-destructive"}>
        {verification.passed ? <BadgeCheck className="mr-1 inline size-3.5" /> : <TriangleAlert className="mr-1 inline size-3.5" />}
        {verification.passed
          ? "完了検証がすべて成功しました。"
          : "完了検証が成功していません。完了にはなりません。理由と残る対応はセッションの報告を確認してください。"}
      </p>
      <ul className="mt-1 space-y-0.5 text-muted-foreground">
        {verification.entries.map((entry) => (
          <li key={entry.command}>
            終了コード{entry.exitCode}：<code>{entry.command}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 定期巡回で完了の確認コマンドが通ったことを伝える（#2008）。
 *
 * **「完了済みの可能性」までしか言わない。** 巡回が見ているのは終了コードだけで、本文の
 * 「期待する出力」との照合はしていない（`lib/manual-step-verification.ts`）。断定すると、
 * 通っただけのものを確かめずにクローズしてしまう。
 *
 * **出力そのものはここに出さない。** 手作業の出力にはシークレットが混ざりうるため、置き場は
 * 実行キューのジョブ1か所に留める（#1828「出力は画面にだけ出す」）。
 */
function ManualStepVerifiedNotice({ verifiedAt }: { verifiedAt: string }) {
  return (
    <p
      className="flex items-start gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/5 px-2 py-1.5 text-xs text-emerald-700 dark:text-emerald-300"
      title={formatDateTimeFull(verifiedAt)}
    >
      <BadgeCheck className="mt-0.5 size-3.5 shrink-0" />
      <span>
        <span className="font-medium">完了済みの可能性があります。</span>
        {/* 日本語の地の文なので、行を分けてできる空白が入らないよう1つの文字列にまとめる */}
        {`${formatDateTime(verifiedAt)}の巡回で「完了の確認方法」のコマンドがすべて成功しました。` +
          "出力の中身までは照合していないため、セッションの完了検証で確かめます。"}
      </span>
    </p>
  );
}

/**
 * 実機のファイル変更を、管理リポジトリのIssueへ切り出す入口（#2021）。
 *
 * VPS・サブPCの設定ファイルは`guchi-apps/vps`・`guchi-apps/subpc`で管理されており、
 * `develop`へのマージと`develop`→`main`のリリースを経て実機へ自動で反映される。
 * **手で書き換えるとGitに残らずドリフトになる**ため、当たっている手順があるときだけ、
 * 切り出す導線をここに出す。
 *
 * **押しても勝手に起票しない。** 押すと新規作成ダイアログが対象リポジトリ・タイトル・本文を
 * 埋めた状態で開くだけで、作るかどうかは中身を読んだ人が決める（他リポジトリへ書く操作を
 * 画面が黙って行わない）。
 *
 * **手作業を止めない。** 検出はパスの文字列一致だけの推定で、外していることもある。
 * セッションの入口はそのまま押せる状態で残す。
 */
function InfraConfigNotice({
  targets,
  onCreate,
  isSubmitting,
}: {
  targets: InfraConfigTarget[];
  onCreate: (target: InfraConfigTarget) => void;
  isSubmitting: boolean;
}) {
  return (
    <section className="rounded-md border bg-background p-2.5" aria-labelledby="manual-step-config-title">
      <p id="manual-step-config-title" className="text-xs font-medium">
        リポジトリ経由で反映できます
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {"実機のファイルを書き換える手順があります。これらはGitで管理されていて、" +
          "developへマージしたうえでdevelop→mainのリリースをマージすると、実機へ自動で反映されます。"}
      </p>
      <ul className="mt-2 space-y-2">
        {targets.map((target) => (
          <li
            key={`${target.repo.repositoryFullName}:${target.entry.repoPath}:${target.line ?? target.stepText}`}
            className="flex flex-wrap items-center justify-between gap-2"
          >
            <span className="text-xs text-muted-foreground">
              <code className="rounded bg-muted px-1 py-px">{target.entry.livePath}</code>
              {" → "}
              <code className="rounded bg-muted px-1 py-px">
                {target.repo.repositoryFullName}
              </code>
              {" の "}
              <code className="rounded bg-muted px-1 py-px">{target.entry.repoPath}</code>
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={isSubmitting}
              onClick={() => onCreate(target)}
            >
              <GitBranch />
              設定変更Issueを作る
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
