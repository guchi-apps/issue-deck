"use client";

import {
  BadgeCheck,
  Check,
  Copy,
  GitBranch,
  Loader2,
  RotateCcw,
  TriangleAlert,
  User,
} from "lucide-react";
import { useState } from "react";

import { IssueDependents } from "@/components/dashboard/issue-dependents";
import {
  WORK_STATUS_VIEW,
  WORK_TONE_CLASS,
  WorkPurposeAndCriteria,
  WorkStatusPill,
} from "@/components/dashboard/issue-work-summary";
import { ManualStepPrerequisites } from "@/components/dashboard/manual-step-prerequisites";
import { Button } from "@/components/ui/button";
import { formatDateTime, formatDateTimeFull } from "@/lib/format-date-time";
import {
  ManualStepSessionPanel,
  useManualStepSessionLauncher,
} from "@/components/dashboard/manual-step-session-panel";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import type { IssueDependent } from "@/lib/issue-dependents";
import type { Issue, IssueComment } from "@/types/issue";
import type { InfraConfigTarget } from "@/lib/infra-config-repos";
import { copyText } from "@/lib/copy-text";
import {
  findLatestManualStepReports,
  type ManualStepInvestigation,
  type ManualStepUserAction,
  type ManualStepVerificationRecord,
} from "@/lib/manual-step-investigation";
import { resolveWorkStatus, type WorkStatus } from "@/lib/issue-work-summary";
import {
  describeDispatchJobStatus,
  describeManualStepSessionRejection,
  findManualStepSessionJobForIssue,
  isActiveDispatchJobStatus,
} from "@/lib/dispatch/dispatch-job";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import { findSessionForIssue } from "@/lib/dispatch/issue-session";
import { extractVerificationCommands } from "@/lib/manual-step-command";
import {
  matchManualStepDeviceNames,
  parseManualStepGuide,
  type ManualStepGuideWhere,
} from "@/lib/manual-step-guide";
import {
  resolveManualStepPhase,
  resolveManualStepPrimaryAction,
  type ManualStepPhase,
  type ManualStepPrimaryAction,
} from "@/lib/manual-step-phase";
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
 * 並びは「いまの状態 → あなたの作業 → 主操作 → AIの実施内容・根拠 → 補足」（#4426）。
 * 代表状態は`resolveManualStepPhase`が既存の報告・セッション・質問待ちから1つに決め、
 * 主操作も既存の経路（セッションの起動・質問への回答）だけを使う。PCで詳細ペインが広ければ
 * 主作業と根拠を左右に分け（`@container`）、狭いペインとスマホでは1列にする。
 * **番号・順番の進捗は出さない**。実際に必要な技術的依存は、前提条件（不足前提・待機理由）
 * として残し、待っている間は理由を先頭カードにも出す。
 *
 * amberは「ユーザーの確認待ち」（`00.check-user`）の色（sidebar-nav・workflow-status-steps）
 * なので、**あなたの操作待ちの状態だけ**に使う。AIが進めている状態はviolet（`71.manual-step`
 * ラベル自体の色`d876e3`、cross-repo-setup-guide.md）にする。
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
  questionPending = false,
  questionAnswered = false,
  onShowQuestion,
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
  sessionIssue?: Pick<Issue, "repositoryFullName" | "number" | "labels" | "body"> &
    Partial<Pick<Issue, "state">>;
  dispatch?: DispatchStateHandle;
  /** このIssueへの質問が回答待ち（#4426）。主操作を質問パネルへの移動にする */
  questionPending?: boolean;
  /** 質問に答えた直後（結果表示の行が残っている間）。「AIが確認中」の判定に使う */
  questionAnswered?: boolean;
  /** 質問パネルへ移動する。渡さなければ移動ボタンは出さず、案内文だけにする */
  onShowQuestion?: () => void;
  /** 互換用（補足は常に畳んだ状態で出す。#4524） */
  compact?: boolean;
  className?: string;
}) {
  const reports = comments
    ? findLatestManualStepReports(comments)
    : { investigation: null, investigationIndex: -1, verification: null, verificationIndex: -1 };
  const blocking = prerequisiteSummary?.blocking.length ? prerequisiteSummary : null;

  // 待っている相手の状況（#1705）。待っている間だけ先頭側に開いて出し、そろっていれば補足へ畳む（#4524）
  const prerequisitesNode =
    prerequisiteSummary && prerequisites && prerequisites.length > 0 && repositoryFullName ? (
      <ManualStepPrerequisites
        prerequisites={prerequisites}
        summary={prerequisiteSummary}
        repositoryFullName={repositoryFullName}
      />
    ) : null;
  // 設定変更の案内は、どの状態でも補足として出す
  const supplements = (
    <>
      {blocking && prerequisitesNode}
      {/* 実機を直接書き換える手順は、リポジトリ経由へ寄せられる（#2021） */}
      {onCreateConfigIssue && configTargets && configTargets.length > 0 && (
        <InfraConfigNotice
          targets={configTargets}
          onCreate={onCreateConfigIssue}
          isSubmitting={isSubmitting}
        />
      )}
    </>
  );

  if (!sessionIssue) {
    return (
      <section className={cn("flex flex-col gap-2", className)} aria-label="作業の状況">
        {!blocking && prerequisitesNode}
        {supplements}
        {dependents && dependents.length > 0 && repositoryFullName && (
          <IssueDependents dependents={dependents} repositoryFullName={repositoryFullName} />
        )}
        {verifiedAt && <ManualStepVerifiedNotice verifiedAt={verifiedAt} />}
      </section>
    );
  }

  const job = dispatch
    ? findManualStepSessionJobForIssue(dispatch.jobs, sessionIssue.repositoryFullName, sessionIssue.number)
    : null;
  const jobActive = job !== null && isActiveDispatchJobStatus(job.status);
  const session = dispatch
    ? findSessionForIssue(dispatch.sessions, sessionIssue.repositoryFullName, sessionIssue.number)
    : null;
  const sessionAlive = session?.state === "ALIVE";
  const phase = resolveManualStepPhase({
    reports,
    isOpen: sessionIssue.state !== "closed",
    sessionAlive,
    jobActive,
    questionPending,
    questionAnswered,
  });
  const primary = resolveManualStepPrimaryAction(phase, questionPending);
  const guide = parseManualStepGuide(sessionIssue.body);
  const verificationCount = extractVerificationCommands(sessionIssue.body, guide).length;
  const status = resolveWorkStatus({
    phase,
    blockingCount: prerequisiteSummary?.blocking.length ?? 0,
    sessionRunning: sessionAlive || jobActive,
    questionPending,
    isOpen: sessionIssue.state !== "closed",
  });
  const userActions =
    reports.investigation && phase !== "done" && phase !== "closed" ? reports.investigation.user : [];

  return (
    <section className={cn("@container flex flex-col gap-2", className)} aria-label="作業の状況">
      <div className="grid gap-2 @3xl:grid-cols-[minmax(0,1fr)_17rem] @3xl:items-start">
        <div className="flex min-w-0 flex-col gap-2">
          <ManualStepPhaseCard
            phase={phase}
            status={status}
            userActionCount={userActions.length}
            hasInvestigation={reports.investigation !== null}
            jobActive={jobActive && !sessionAlive}
            questionPending={questionPending}
            blockingMessage={blocking?.message ?? null}
          >
            <WorkPurposeAndCriteria
              body={sessionIssue.body}
              verificationPassed={phase === "done"}
              purposeFallback={reports.investigation?.purpose ?? null}
              idPrefix={`work-${sessionIssue.number}`}
            />
          </ManualStepPhaseCard>
          {userActions.length > 0 && (
            <ManualStepUserActions
              actions={userActions}
              where={guide.where}
              verificationCount={verificationCount}
              answered={phase === "ai_verifying"}
            >
              <ManualStepPrimary
                primary={primary}
                phase={phase}
                sessionIssue={sessionIssue}
                dispatch={dispatch}
                onShowQuestion={onShowQuestion}
              />
            </ManualStepUserActions>
          )}
          {userActions.length === 0 && primary !== "none" && !(primary === "start" && status === "dependency_wait") && (
            <ManualStepPrimary
              primary={primary}
              phase={phase}
              sessionIssue={sessionIssue}
              dispatch={dispatch}
              onShowQuestion={onShowQuestion}
            />
          )}
        </div>
        <ManualStepEvidence
          investigation={reports.investigation}
          verification={reports.verification}
          verificationIsLatest={reports.verificationIndex > reports.investigationIndex}
          verifiedAt={verifiedAt ?? null}
          dependents={dependents}
          repositoryFullName={repositoryFullName}
          prerequisites={blocking ? null : prerequisitesNode}
        />
      </div>
      {supplements}
      {/* 調査前は起動の選択（エージェント・モデル）そのものが主操作なので上に出している。
          それ以外の状態では、セッションの様子と本文から読み取った手順を補足として畳む */}
      {dispatch && (primary !== "start" || status === "dependency_wait") && (
        <details className="group rounded-md border bg-background px-2.5">
          <summary className="flex min-h-11 cursor-pointer items-center text-xs font-medium">
            セッション・本文から読み取った手順
          </summary>
          <ManualStepSessionPanel issue={sessionIssue} dispatch={dispatch} className="mb-2.5" />
        </details>
      )}
    </section>
  );
}

/**
 * 先頭の状態カード（#4426・#4524）。「いまどうなっていて、自分は何をするのか」を1枚で言い、
 * 目的と完了条件（`children`）を同じカードに続ける。
 * 依存待ち（青・操作不要）は、本人の操作待ち（amber）と別の状態として出す。
 */
function ManualStepPhaseCard({
  phase,
  status,
  userActionCount,
  hasInvestigation,
  jobActive,
  questionPending,
  blockingMessage,
  children,
}: {
  phase: ManualStepPhase;
  status: WorkStatus;
  userActionCount: number;
  hasInvestigation: boolean;
  /** 起動ジョブが未処理で、セッションはまだ立っていない */
  jobActive: boolean;
  questionPending: boolean;
  blockingMessage: string | null;
  children?: React.ReactNode;
}) {
  const view = WORK_STATUS_VIEW[status];
  const [title, description] = describePhase({
    phase,
    status,
    userActionCount,
    hasInvestigation,
    jobActive,
    questionPending,
    blockingMessage,
  });
  return (
    <section
      className={cn("rounded-md border border-l-4 bg-background p-3", WORK_TONE_CLASS[view.tone])}
      aria-labelledby="manual-step-status-title"
      data-phase={phase}
      data-work-status={status}
    >
      <p className="flex flex-wrap items-center gap-2">
        <span className="sr-only">作業の状況：</span>
        <WorkStatusPill status={status} label={
            status === "idle" && phase === "not_investigated"
              ? "未調査"
              : phase === "done"
                ? "完了検証がすべて成功"
                : undefined
          } />
      </p>
      <h3 id="manual-step-status-title" className="mt-1.5 text-sm font-semibold">
        {title}
      </h3>
      <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
      {children && <div className="mt-3 border-t pt-3">{children}</div>}
    </section>
  );
}

function describePhase({
  phase,
  status,
  userActionCount,
  hasInvestigation,
  jobActive,
  questionPending,
  blockingMessage,
}: {
  phase: ManualStepPhase;
  status: WorkStatus;
  userActionCount: number;
  hasInvestigation: boolean;
  jobActive: boolean;
  questionPending: boolean;
  blockingMessage: string | null;
}): [string, string] {
  if (status === "dependency_wait") {
    return [
      "依存先の完了を待っています",
      `${blockingMessage ?? "先に完了している必要があるIssue・PRがあります。"}成立すると進められます。あなたの操作は要りません。`,
    ];
  }
  switch (phase) {
    case "not_investigated":
      // 実行者（AI／本人）は調査の前に決めない。本文からの見込みは出さない（#4524）
      return [
        "AIの事前調査がまだです",
        "下からAIセッションを起動すると、調査と実行を始めます。本人の操作が必要になった場合だけ、ここに案内が出ます。",
      ];
    case "ai_working":
      if (jobActive) {
        return ["セッションの起動を待っています", "反映まで30秒ほどかかります。あなたの操作は不要です。"];
      }
      return [
        hasInvestigation ? "AIが作業しています" : "AIが調査しています",
        "サブPCのセッションが進めています。あなたの操作が必要になると、質問としてこの下に出ます。",
      ];
    case "user_action":
      if (questionPending) {
        return [
          userActionCount > 0 ? `${userActionCount}件の操作が必要です` : "AIから質問が届いています",
          "操作を終えたら「操作したのでAIに確認を依頼」から質問に答えてください。答えるとAIが結果を確かめます。",
        ];
      }
      return [
        `${userActionCount}件の操作が必要です`,
        "AIのセッションは終了しています。操作を終えたら「操作したのでAIに確認を依頼」を押してください。",
      ];
    case "ai_verifying":
      return [
        "あなたの回答を受けて、AIが確かめています",
        "セッションが結果と「完了の確認方法」を実行しています。あなたの操作は不要です。",
      ];
    case "ai_stopped":
      return [
        "AIの作業が途中で止まっています",
        "調査の報告はありますが、セッションが終了し、完了検証もまだです。完了にはなっていません。",
      ];
    case "verify_failed":
      return [
        "完了にはなっていません",
        "最新の完了検証で成功しなかったコマンドがあります。根拠を確認し、AIに再確認を依頼してください。",
      ];
    case "done":
      return ["作業は完了しています", "セッションの完了検証で、確認コマンドがすべて成功しました。"];
    case "closed":
      return [
        "完了検証が成功しないままクローズされています",
        "このIssueは完了を確かめないまま閉じられました。",
      ];
  }
}

/**
 * あなたの作業（#4426）。実行場所・必要な操作・コマンド（コピー）・完了後の確認を1件ずつ出す。
 *
 * 実行場所は調査報告の項目に構造化されていないため、項目本文の端末名（`MANUAL_STEP_DEVICE_NAMES`）
 * を読み、無ければ本文`## 前提条件`の既定の端末を使う。**決まらなければ推測せず「未記載」と出す。**
 * コマンドはセッションが書いたまま出す（作業ディレクトリへの`cd`やユーザーの切り替えを含む1行）。
 */
function ManualStepUserActions({
  actions,
  where,
  verificationCount,
  answered,
  children,
}: {
  actions: ManualStepUserAction[];
  where: ManualStepGuideWhere;
  verificationCount: number;
  /** 回答済みでAIが確かめている */
  answered: boolean;
  children?: React.ReactNode;
}) {
  return (
    <section className="rounded-md border bg-background p-3" aria-labelledby="manual-step-user-title">
      <h3 id="manual-step-user-title" className="flex items-center gap-1.5 text-sm font-semibold">
        <User className="size-4 shrink-0" aria-hidden />
        次の操作（{actions.length}件{answered ? "・実施済みと回答" : ""}）
      </h3>
      <ol className="mt-2 flex flex-col gap-2">
        {actions.map((action, i) => {
          const device = resolveUserActionDevice(action, where);
          return (
            <li key={`${i}:${action.text}`} className="rounded-md border p-2.5">
              <p className="flex flex-wrap gap-1.5">
                <Chip label="実行場所" value={device ?? "未記載"} />
                {where.directory && action.command === null && (
                  <Chip label="作業ディレクトリ" value={where.directory} />
                )}
              </p>
              <p className="mt-1.5 text-sm">{action.text}</p>
              {action.command && <CommandLine command={action.command} />}
            </li>
          );
        })}
      </ol>
      <p className="mt-2 text-xs text-muted-foreground">
        {verificationCount > 0
          ? `完了後：AIが本文「完了の確認方法」の${verificationCount}件のコマンドを実行して確かめます。すべて成功するまで完了にはなりません。`
          : "完了後：AIが目的に照らした読み取りの確認で確かめます。確認が成功するまで完了にはなりません。"}
      </p>
      {children && <div className="mt-3">{children}</div>}
    </section>
  );
}

function resolveUserActionDevice(
  action: ManualStepUserAction,
  where: ManualStepGuideWhere,
): string | null {
  const names = matchManualStepDeviceNames(action.text);
  if (names.length === 1) return names[0];
  // 項目に2つ以上の端末名があるときは決まらない（既定値で埋めない）
  if (names.length > 1) return null;
  return where.defaultDevice;
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-px text-xs text-muted-foreground">
      {label}
      <span className="min-w-0 truncate font-semibold text-foreground">{value}</span>
    </span>
  );
}

/**
 * 主操作（#4426）。新しい経路は作らず、既存の質問回答と手作業セッションの起動だけを使う。
 * **押しても完了・クローズにはしない**——完了は完了検証の報告だけで決まる。
 */
function ManualStepPrimary({
  primary,
  phase,
  sessionIssue,
  dispatch,
  onShowQuestion,
}: {
  primary: ManualStepPrimaryAction;
  phase: ManualStepPhase;
  sessionIssue: Pick<Issue, "repositoryFullName" | "number" | "labels" | "body">;
  dispatch?: DispatchStateHandle;
  onShowQuestion?: () => void;
}) {
  if (primary === "none") return null;
  if (primary === "start") {
    return dispatch ? <ManualStepSessionPanel issue={sessionIssue} dispatch={dispatch} /> : null;
  }
  if (primary === "answer_question") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {onShowQuestion && (
          <Button className="min-h-11" onClick={onShowQuestion}>
            <Check />
            操作したのでAIに確認を依頼
          </Button>
        )}
        <span className="text-xs text-muted-foreground">
          下の質問パネルで「実行した・次へ」を選んで送ります。送っただけでは完了になりません。
        </span>
      </div>
    );
  }
  if (!dispatch) return null;
  return (
    <ManualStepLaunchButton
      label={
        primary === "request_check"
          ? "操作したのでAIに確認を依頼"
          : phase === "ai_stopped"
            ? "AIに作業の再開を依頼"
            : "AIに再確認を依頼"
      }
      sessionIssue={sessionIssue}
      dispatch={dispatch}
    />
  );
}

/** 手作業セッションを既定のエージェント・モデルで起動し直す（選びたいときは補足の起動欄から） */
function ManualStepLaunchButton({
  label,
  sessionIssue,
  dispatch,
}: {
  label: string;
  sessionIssue: Pick<Issue, "repositoryFullName" | "number" | "labels">;
  dispatch: DispatchStateHandle;
}) {
  const launcher = useManualStepSessionLauncher(sessionIssue, dispatch);
  const jobStatus = launcher.job ? describeDispatchJobStatus(launcher.job.status, launcher.job.kind) : null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          className="min-h-11"
          disabled={launcher.rejection !== null || dispatch.isSubmitting}
          onClick={() => void launcher.start()}
        >
          {dispatch.isSubmitting ? <Loader2 className="animate-spin" /> : <RotateCcw />}
          {label}
        </Button>
        <span className="text-xs text-muted-foreground">
          {formatDispatchHostName(launcher.hostName)}
          で作業セッションを起動し、AIが結果を確かめます。完了検証が成功するまで完了になりません。
        </span>
      </div>
      {launcher.rejection !== null && launcher.rejection !== "already_queued" && (
        <p className="text-xs text-muted-foreground">
          {describeManualStepSessionRejection(launcher.rejection, { hostName: launcher.hostName })}
        </p>
      )}
      {launcher.job && launcher.hasActiveJob && jobStatus && (
        <p className="text-xs text-muted-foreground">{jobStatus.label}（反映まで30秒ほどかかります）</p>
      )}
      {launcher.error && <p className="text-xs text-destructive">{launcher.error}</p>}
    </div>
  );
}

/**
 * 補足（#4524）。AIの実施内容・これから行うこと・完了の根拠・前提条件を、**閉じた1つの開閉欄**に
 * まとめる。通常Issueの簡素な詳細に合わせ、先頭には目的・完了条件・現在地・次の操作だけを置く。
 * **未確認を実施済みと表示しない**——調査報告が無ければ「AI実施済み」は空ではなく未確認と言う。
 */
function ManualStepEvidence({
  investigation,
  verification,
  verificationIsLatest,
  verifiedAt,
  dependents,
  repositoryFullName,
  prerequisites,
}: {
  investigation: ManualStepInvestigation | null;
  verification: ManualStepVerificationRecord | null;
  verificationIsLatest: boolean;
  verifiedAt: string | null;
  dependents?: IssueDependent[];
  repositoryFullName?: string;
  /** 前提がそろっているときの前提条件の表示（待っている間は先頭側に出すのでnull） */
  prerequisites?: React.ReactNode;
}) {
  return (
    <details className="min-w-0 rounded-md border bg-background px-2.5">
      <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-xs font-semibold">
        補足
        <span className="font-normal text-muted-foreground">実施記録・根拠</span>
      </summary>
      <div className="flex min-w-0 flex-col gap-3 pb-2.5">
        <EvidenceSection title="AIが実施済み" count={investigation?.done.length}>
          {investigation ? (
            <EvidenceList items={investigation.done} />
          ) : (
            <p className="text-xs text-muted-foreground">未確認（事前調査の報告がありません）</p>
          )}
        </EvidenceSection>
        <EvidenceSection title="これからAIが行うこと" count={investigation?.auto.length}>
          {investigation ? (
            <EvidenceList items={investigation.auto} />
          ) : (
            <p className="text-xs text-muted-foreground">未確認（調査で決まります）</p>
          )}
        </EvidenceSection>
        <EvidenceSection title="完了の根拠">
          {verification ? (
            <VerificationResult verification={verification} stale={!verificationIsLatest} />
          ) : (
            <p className="text-xs text-muted-foreground">完了検証：まだ実行していません（未確認）</p>
          )}
          {verifiedAt && !(verification?.passed && verificationIsLatest) && (
            <ManualStepVerifiedNotice verifiedAt={verifiedAt} className="mt-2" />
          )}
        </EvidenceSection>
        {prerequisites}
        {dependents && dependents.length > 0 && repositoryFullName && (
          <IssueDependents dependents={dependents} repositoryFullName={repositoryFullName} />
        )}
      </div>
    </details>
  );
}

function EvidenceSection({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h4 className="flex items-center gap-1.5 text-xs font-semibold">
        {title}
        {count !== undefined && <span className="font-normal text-muted-foreground">{count}件</span>}
      </h4>
      <div className="mt-1">{children}</div>
    </section>
  );
}

function EvidenceList({ items }: { items: string[] }) {
  if (items.length === 0) return <p className="text-xs text-muted-foreground">なし</p>;
  return (
    <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

/** コピーして一度で実行できる1ライナー（#4315）。実行先・ユーザーはコマンドの前の行で示す */
function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 flex flex-col gap-1.5 @md:flex-row @md:items-start">
      {/* 長いコマンドでも主操作を押し出さないよう、横スクロールではなく折り返す */}
      <code className="min-w-0 flex-1 whitespace-pre-wrap break-all rounded border bg-muted px-2 py-1.5 font-mono text-xs leading-relaxed">
        {command}
      </code>
      <Button
        variant="outline"
        size="sm"
        className="min-h-11 shrink-0 @md:min-h-8"
        onClick={async () => {
          setCopied(await copyText(command));
        }}
      >
        {copied ? <Check /> : <Copy />}
        {copied ? "コピーしました" : "コピー"}
      </Button>
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? "コマンドをコピーしました" : ""}
      </span>
    </div>
  );
}

function VerificationResult({
  verification,
  stale,
}: {
  verification: ManualStepVerificationRecord;
  /** この検証のあとで調査がやり直されている（前回の試みの結果） */
  stale: boolean;
}) {
  return (
    <div className="text-xs">
      {stale && <p className="mb-1 text-muted-foreground">前回の試みの結果です（その後に調査がやり直されています）。</p>}
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
function ManualStepVerifiedNotice({
  verifiedAt,
  className,
}: {
  verifiedAt: string;
  className?: string;
}) {
  return (
    <p
      className={cn("flex items-start gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/5 px-2 py-1.5 text-xs text-emerald-700 dark:text-emerald-300", className)}
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
