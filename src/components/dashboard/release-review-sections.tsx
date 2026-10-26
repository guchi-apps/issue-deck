"use client";

import {
  checkTone,
  countOpenItems,
  describeCheck,
  describeReviewKind,
  describeStall,
  findingTags,
} from "@/lib/release-review-contract-view";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { isReleaseCandidateHeadRef } from "@/lib/release-branch";
import { ChevronRight, ExternalLink, RotateCcw } from "lucide-react";

import { ReleaseFixCreate, ReleaseFixOverviewPanel } from "@/components/dashboard/release-fix-panel";
import { REVIEW_MARK, REVIEW_TONE } from "@/components/dashboard/review-verdict";
import { ReleaseRebuildButton } from "@/components/dashboard/release-rebuild-button";
import {
  FindingDecisionControl,
  ReviewDecisionSummaryPanel,
  useReleaseReviewRecommendations,
} from "@/components/dashboard/release-review-decision";
import { ReleaseGuidancePanel } from "@/components/dashboard/release-guidance-panel";
import { fixNowFindingIds, nonFixFindingIds } from "@/lib/release-review-decision";
import { useReleaseChanges, type UseReleaseChangesResult } from "@/hooks/use-release-changes";
import { useReferenceNavigation } from "@/hooks/use-reference-navigation";
import { useReleaseVerification } from "@/hooks/use-release-verification";
import type { ReviewVerdictKind } from "@/lib/github/release-verification";
import { toJstParts } from "@/lib/format-date-time";
import { tallyReleaseReviews } from "@/lib/release-changes";
import { describeReleaseReviewDiagnostic } from "@/lib/release-review-diagnostic";
import { POLLER_EXPLANATION, type ReleaseOpsAssessment } from "@/lib/release-review-ops-evidence";
import { describeIntegrationResume } from "@/lib/release-integration-rerun-view";
import { describeReviewRerun, type ReviewRerunView } from "@/lib/release-review-rerun-view";
import { describeReviewStageLabel, REVIEW_OPEN_ITEM_LABEL } from "@/lib/release-review-reevaluation";
import {
  formatReleaseElapsed,
  formatReleaseReviewAgent,
  viewReleaseProgress,
  type ReleaseVerificationProgress,
} from "@/lib/release-verification-progress";
import type { ReleaseVerificationSection, ReleaseVerificationSummary } from "@/lib/release-verification-summary";
import { cn } from "@/lib/utils";
import type { ReleaseChangeListResponse } from "@/types/pull-request";

/**
 * リリースの3区分（全体レビュー／統合検証／個別PRレビュー。#4238・#4212・#4277）。PC（リリースPR詳細）・
 * スマホ（リリースシート）・本番マージの確認ダイアログで共通。**区分ごとに「何を見たか」を分けて出し、
 * どれかの結果を別の区分の代わりにしない**——AIの全体レビューはテスト実行の代わりにならず、
 * 統合検証はAIのレビューの代わりにならず、個別PRレビューの転記でもない。
 *
 * **並びは全体レビュー → 統合検証 → 個別PRレビュー**（#4277）。表示の優先順位であって、実行の順序や
 * 依存関係ではない。どの区分も「見出し＋短い説明＋状態の1行」の同じ形で、閉じたままでも状態・
 * 現在の工程・指摘の有無が分かり、総評・実施内容・PR別の結果は開いて読む。
 *
 * **未完了・取得失敗を緑や「問題なし」で出さない。** 状態は記録（`ReleaseVerification`）が正で、
 * 進捗（`progress`）は「待機中・実行中のどこにいるか」を足すだけ。報告が途絶えたものは
 * 「応答なし」にしてアニメーションを止める（止まった処理を動いているように見せない）。
 *
 * 修正は`release-main/*`を直接書き換えず、developへ直してから「修正を入れて作り直す」（#3014）へ進む。
 * 作り直すとSHAが変わるので、新しいSHAで統合検証・全体レビューをやり直す。
 */

/**
 * 個別PRレビューの一覧を差し替える描画関数が受け取る、リリース共通の検証の状態（#4305）。
 * 各PR行の「全体〔共通〕」に、全体レビュー区分と同じ判定を渡すために使う
 */
export type IndividualListContext = {
  verification: ReleaseVerificationSummary | null;
  verificationError: string | null;
  nowMs: number;
};

export type Tone = "ok" | "warn" | "bad" | "run" | "muted";

const TONE_CLASS: Record<Tone, string> = {
  ok: "bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-400",
  warn: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400",
  bad: "bg-red-50 text-destructive dark:bg-red-950/40",
  run: "bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400",
  muted: "bg-muted text-muted-foreground",
};

const TEXT_TONE: Record<Tone, string> = {
  ok: "text-green-700 dark:text-green-400",
  warn: "text-amber-700 dark:text-amber-400",
  bad: "text-destructive",
  run: "text-blue-700 dark:text-blue-400",
  muted: "text-muted-foreground",
};

/** 記号でも区別する（色だけに頼らない）。並びは`review-verdict.tsx`の● ▲ ■ –に揃える */
function Pill({ tone, mark, children }: { tone: Tone; mark: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded px-1.5 text-[11px] leading-5 font-bold whitespace-nowrap",
        TONE_CLASS[tone],
      )}
    >
      <span aria-hidden="true" className="text-[10px] leading-none">
        {mark}
      </span>
      {children}
    </span>
  );
}

/** 経過時間を数えるための時計。動いている区分があるあいだだけ1秒ごとに進める */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function clock(iso: string | null): string | null {
  const parts = iso ? toJstParts(iso) : null;
  return parts ? `${parts.hour}:${String(parts.minute).padStart(2, "0")}` : null;
}

const shortSha = (sha: string) => sha.slice(0, 7);

/**
 * 区分1つの枠。`children`（開いて読む中身）があれば`<details>`にする。閉じた状態の`line`・
 * `steps`・`reason`には、状態・現在の工程・指摘の有無といった「開かなくても分かるべきこと」を置く
 */
function SectionRow({
  title,
  note,
  line,
  steps,
  reason,
  reasonTone = "muted",
  actions,
  children,
}: {
  title: string;
  note?: string;
  line: ReactNode;
  steps?: ReactNode;
  reason?: string | null;
  reasonTone?: Tone;
  /** 詳細を開かなくても見える次の操作（再実行など）。`<summary>`の外に置く（押しても開閉しない） */
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const head = (
    <>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <h3 className="text-xs font-semibold">{title}</h3>
        {note && <span className="text-[10.5px] text-muted-foreground">{note}</span>}
        {children && (
          <ChevronRight
            aria-hidden
            className="ml-auto size-3.5 shrink-0 self-center text-muted-foreground transition-transform group-open:rotate-90"
          />
        )}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">{line}</div>
      {steps}
      {reason && <p className={cn("text-[11.5px]", reasonTone === "muted" ? "" : TEXT_TONE[reasonTone])}>{reason}</p>}
    </>
  );
  const testId = `release-section-${title}`;
  if (!children) {
    return (
      <section className="flex flex-col gap-1 border-b px-3 py-2 text-xs last:border-b-0" data-testid={testId}>
        {head}
        {actions}
      </section>
    );
  }
  const details = (
    <details className="group text-xs" data-testid={testId}>
      <summary className="flex cursor-pointer list-none flex-col gap-1 px-3 py-2 focus-visible:bg-muted/50 focus-visible:outline-none [&::-webkit-details-marker]:hidden">
        {head}
      </summary>
      <div className="flex flex-col gap-1.5 px-3 pb-2.5">{children}</div>
    </details>
  );
  if (!actions) return <div className="border-b last:border-b-0">{details}</div>;
  return (
    <div className="border-b text-xs last:border-b-0">
      {details}
      <div className="px-3 pb-2.5">{actions}</div>
    </div>
  );
}

/**
 * 工程の列。済は緑、現在は青（動いている間だけ点滅）、未着手は灰。**百分率は出さない**——
 * 工程の総量が分からないものに割合を当てると、進んでいない処理が進んでいるように見える
 */
function ProgressSteps({
  progress,
  currentTone,
  animate,
}: {
  progress: ReleaseVerificationProgress;
  currentTone: Tone;
  animate: boolean;
}) {
  if (progress.currentIndex === null) return null;
  return (
    <ol className="flex flex-wrap items-center gap-1 text-[10.5px]" aria-label="工程">
      {progress.steps.map((step, index) => {
        const done = index < (progress.currentIndex ?? 0);
        const current = index === progress.currentIndex;
        return (
          <li
            key={`${step.key}-${index}`}
            aria-current={current ? "step" : undefined}
            className={cn(
              "rounded px-1.5 leading-5",
              done && "bg-muted text-green-700 dark:text-green-400",
              current && cn("font-bold", TONE_CLASS[currentTone], animate && "animate-pulse motion-reduce:animate-none"),
              !done && !current && "bg-muted text-muted-foreground",
            )}
          >
            {done ? "✓ " : ""}
            {step.label}
          </li>
        );
      })}
    </ol>
  );
}

export type SectionHead = {
  tone: Tone;
  mark: string;
  label: string;
  /** 状態の横に置く要点（工程名・待機理由・指摘の件数など） */
  detail: string | null;
  meta: string[];
  reason: string | null;
  reasonTone: Tone;
  /** 工程の列。待機・実行中・止まった工程があるときだけ */
  steps: { tone: Tone; animate: boolean } | null;
  /** 1秒ごとの再描画が要るか */
  ticking: boolean;
};

/**
 * 統合検証・全体レビューの区分の「閉じた1行」を、記録の状態と進捗から決める。
 * **記録が待機・実行中でないときは進捗で状態を上書きしない**（結果が正）。
 */
export function describeSection(
  section: ReleaseVerificationSection,
  nowMs: number,
  options: { compact?: boolean } = {},
): SectionHead {
  const progress = section.progress;
  const view = progress ? viewReleaseProgress(progress, nowMs) : null;
  const base = { meta: [] as string[], reason: section.reason, reasonTone: "muted" as Tone, steps: null, ticking: false };

  if (section.state === "waiting" || section.state === "running") {
    if (!view || !progress) {
      return { ...base, tone: "muted", mark: "◷", label: "待機中", detail: "待機理由: 未取得" };
    }
    const lastReport =
      view.sinceLastReportMs !== null ? `最終報告 ${formatReleaseElapsed(view.sinceLastReportMs)}前` : null;
    switch (view.phase) {
      case "queued":
        return {
          ...base,
          tone: "muted",
          mark: "◷",
          label: "待機中",
          detail: view.waitingReason ?? "待機理由: 未取得",
          meta: view.elapsedMs !== null ? [`依頼から ${formatReleaseElapsed(view.elapsedMs)}`] : [],
          reason: progress.hostOnline === false ? "実行先が復帰すると自動で始まります" : base.reason,
          reasonTone: progress.hostOnline === false ? "warn" : "muted",
          ticking: true,
        };
      case "starting":
        return {
          ...base,
          tone: "muted",
          mark: "◷",
          label: "待機中",
          detail: view.waitingReason,
          meta: view.elapsedMs !== null ? [`依頼から ${formatReleaseElapsed(view.elapsedMs)}`] : [],
          steps: { tone: "run", animate: true },
          ticking: true,
        };
      case "running":
        return {
          ...base,
          tone: "run",
          mark: "●",
          label: "実行中",
          detail: view.stepLabel ?? "工程: 未取得",
          // ブランチ画面（compact）は開始からの時間だけを札の行に残す。実行先は詳細に出る（#4938）
          meta: [
            view.elapsedMs !== null ? `開始から ${formatReleaseElapsed(view.elapsedMs)}` : null,
            options.compact ? null : progress.host,
            options.compact ? null : lastReport,
          ].filter((v): v is string => Boolean(v)),
          steps: { tone: "run", animate: true },
          ticking: true,
        };
      case "stalled":
        return {
          ...base,
          tone: "warn",
          mark: "▲",
          label: "応答なし",
          detail: view.stepLabel ? `${view.stepLabel}で止まっています` : "報告が止まっています",
          meta: [lastReport].filter((v): v is string => Boolean(v)),
          reason: "実行先から10分以上報告がありません。成功とは扱いません",
          reasonTone: "warn",
          steps: { tone: "warn", animate: false },
          ticking: true,
        };
      case "canceled":
        return {
          ...base,
          tone: "warn",
          mark: "▲",
          label: "中断",
          detail: "実行が取り消されました",
          meta: [clock(progress.finishedAt)].filter((v): v is string => Boolean(v)),
          reason: progress.message,
          reasonTone: "warn",
        };
      default:
        return {
          ...base,
          tone: "warn",
          mark: "▲",
          label: "中断",
          detail: "結果が記録されないまま終了しました",
          meta: [clock(progress.finishedAt)].filter((v): v is string => Boolean(v)),
          reason: progress.message,
          reasonTone: "warn",
          steps: view.stepLabel ? { tone: "warn", animate: false } : null,
        };
    }
  }

  const finished = clock(section.updatedAt);
  const took = view && view.phase === "ended" && view.elapsedMs !== null ? `所要 ${formatReleaseElapsed(view.elapsedMs)}` : null;
  const doneMeta = [finished ? `${finished} 完了` : null, took].filter((v): v is string => Boolean(v));
  switch (section.state) {
    case "passed":
      return { ...base, tone: "ok", mark: "●", label: "問題なし", detail: null, meta: doneMeta };
    case "failed":
      return {
        ...base,
        tone: "bad",
        mark: "■",
        label: "失敗",
        detail: view?.stepLabel ? `${view.stepLabel}で失敗` : null,
        meta: doneMeta,
        reasonTone: "bad",
        steps: view?.stepLabel ? { tone: "bad", animate: false } : null,
      };
    case "needs_check":
      return { ...base, tone: "warn", mark: "▲", label: "要確認", detail: null, meta: doneMeta, reasonTone: "warn" };
    case "not_applicable":
      return { ...base, tone: "muted", mark: "–", label: "対象外", detail: null, meta: [] };
    case "invalidated":
      return { ...base, tone: "warn", mark: "▲", label: "古い結果", detail: null, meta: [], reasonTone: "warn" };
    default:
      return { ...base, tone: "muted", mark: "–", label: "未実施", detail: null, meta: [] };
  }
}

function HeadLine({ head, extra }: { head: SectionHead; extra?: ReactNode }) {
  return (
    <>
      <Pill tone={head.tone} mark={head.mark}>
        {head.label}
      </Pill>
      {head.detail && <span className="min-w-0">{head.detail}</span>}
      {extra}
      {head.meta.length > 0 && (
        <span className="text-[11px] text-muted-foreground tabular-nums">{head.meta.join(" ・ ")}</span>
      )}
    </>
  );
}

const SEVERITY_LABEL = { high: "重大", medium: "中", low: "軽微" } as const;

/**
 * 実行障害のときの「再実行」。コードを直さずに、同じ対象（今のリリースPR）でやり直す（#4300）。
 * 対象はサーバーが解決し、ここで送るSHAは「見ていた対象との一致確認」にだけ使われる
 */
function ReviewRerunButton({
  repositoryFullName,
  pullRequestNumber,
  baseSha,
  headSha,
  label = "全体レビューを再実行",
  disabled = false,
  onDone,
  endpoint = "/api/repositories/release/review-rerun",
  acceptedMessage = "再実行を受け付けました。これはレビューの合格ではありません。待機中→実行中→完了の順に表示が変わります。",
}: {
  repositoryFullName: string;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
  label?: string;
  /** 統合検証の再開（#5020）でも同じ押下処理を使う */
  endpoint?: string;
  acceptedMessage?: string;
  /** 統合検証の結果待ちなど、今は押せないとき */
  disabled?: boolean;
  onDone?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const run = async () => {
    // 連打で二重に依頼しない（サーバーも同じ対象の実行中・待機中は積まない）
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const [owner, repo] = repositoryFullName.split("/");
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, repo, pullRequestNumber, baseSha, headSha }),
      });
      const body: { outcome?: string; error?: string; message?: string } = await res.json().catch(() => ({}));
      if (res.status === 409 && body.error === "release_pr_changed") {
        setMessage("リリースPRが更新されています。「更新」で最新の状態を読み込んでください。");
      } else if (res.status === 401 || res.status === 403) {
        setMessage("再実行する権限がありません。ログインし直してください。");
      } else if (res.status === 404) {
        setMessage("対象のリリースPRが見つかりません。「更新」で最新の状態を読み込んでください。");
      } else if (!res.ok) {
        setMessage(body.message ?? `再実行を依頼できませんでした (${res.status})。時間をおいて、もう一度お試しください。`);
      } else {
        setMessage(
          body.outcome === "already_queued"
            ? "すでに実行中または待機中です。新しい依頼は積んでいません。結果が出るまでお待ちください。"
            : acceptedMessage,
        );
        onDone?.();
      }
    } catch {
      setMessage("再実行を依頼できませんでした（通信に失敗しました）。通信を確かめて、もう一度お試しください。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={run}
        disabled={busy || disabled}
        className="inline-flex min-h-11 items-center gap-1 rounded border px-4 text-[13px] font-medium text-foreground hover:bg-muted disabled:opacity-50"
      >
        <RotateCcw aria-hidden className="size-3" />
        {busy ? "依頼中…" : label}
      </button>
      {message && <span role="status">{message}</span>}
    </span>
  );
}

const OPS_STATUS_LABEL: Record<ReleaseOpsAssessment["status"], string> = {
  not_needed: "更新不要",
  updated: "更新済み",
  needed: "更新が必要",
  unknown: "状態を確認できない",
};

/**
 * レビューがpollerの更新・再起動に触れたときの案内（#4665）。結論・pollerの説明・理由・対象ホスト・
 * 確認できた事実・次の操作を出す。判定は`release-review-ops-evidence.ts`が持つ
 */
function ReviewOpsNotice({ ops, repositoryFullName }: { ops: ReleaseOpsAssessment; repositoryFullName: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded border border-dashed px-2 py-1" data-testid="review-rerun-ops">
      <p className="break-words font-medium">
        運用状態（{OPS_STATUS_LABEL[ops.status]}）: {ops.headline}
      </p>
      <p className="break-words text-muted-foreground">{POLLER_EXPLANATION}</p>
      <dl className="grid grid-cols-[5.5rem_1fr] gap-x-2 gap-y-0.5">
        <dt className="text-muted-foreground">レビューの記述</dt>
        <dd className="min-w-0 break-words">{ops.reason}</dd>
        {ops.hosts.length > 0 && (
          <>
            <dt className="text-muted-foreground">対象ホスト</dt>
            <dd className="min-w-0 break-words">{ops.hosts.join("、")}</dd>
          </>
        )}
        {ops.facts.length > 0 && (
          <>
            <dt className="text-muted-foreground">確認できた事実</dt>
            <dd className="min-w-0">
              <ul className="flex flex-col gap-0.5">
                {ops.facts.map((fact) => (
                  <li key={fact} className="break-words">
                    {fact}
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
        {ops.relatedIssues.length > 0 && (
          <>
            <dt className="text-muted-foreground">関連Issue</dt>
            <dd className="flex flex-wrap gap-x-2">
              {ops.relatedIssues.map((n) => (
                <a
                  key={n}
                  href={`https://github.com/${repositoryFullName}/issues/${n}`}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  #{n}
                </a>
              ))}
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">次の操作</dt>
        <dd className="min-w-0 break-words">{ops.nextAction}</dd>
      </dl>
    </div>
  );
}

/**
 * 全体レビュー欄の「次の操作」（#4632）。詳細を開かなくても、前提（コードの読み残し・統合検証・運用状態）と
 * 再実行の可否が見える。運用状態はレビューがpollerの更新に触れたときだけ、稼働情報と照らした結果を出す（#4665）
 */
function ReviewRerunPanel({
  view,
  repositoryFullName,
  pullRequestNumber,
  target,
  onDone,
}: {
  view: Exclude<ReviewRerunView, { kind: "none" }>;
  repositoryFullName: string;
  pullRequestNumber: number;
  target: { baseSha: string; headSha: string };
  onDone?: () => void;
}) {
  const waiting = view.kind === "wait";
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded border px-2 py-1.5 text-[11.5px]",
        waiting
          ? "border-sky-300 bg-sky-50/60 dark:border-sky-800 dark:bg-sky-950/20"
          : "border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/20",
      )}
      data-testid="review-rerun-panel"
    >
      <p className="font-medium">{view.lead}</p>
      <dl className="grid grid-cols-[6.5rem_1fr] gap-x-2 gap-y-0.5">
        <dt className="text-muted-foreground">対象</dt>
        <dd className="font-mono">
          main {shortSha(target.baseSha)} ← release {shortSha(target.headSha)}
        </dd>
        {view.prerequisites.map((p) => (
          <Fragment key={p.label}>
            <dt className="text-muted-foreground">{p.label}</dt>
            <dd className="min-w-0 break-words">
              <span aria-hidden>{p.status === "ok" ? "✓ " : p.status === "pending" ? "◔ " : "△ "}</span>
              {p.text}
            </dd>
          </Fragment>
        ))}
      </dl>
      {view.ops && <ReviewOpsNotice ops={view.ops} repositoryFullName={repositoryFullName} />}
      <ReviewRerunButton
        repositoryFullName={repositoryFullName}
        pullRequestNumber={pullRequestNumber}
        baseSha={target.baseSha}
        headSha={target.headSha}
        label={view.buttonLabel}
        disabled={waiting}
        onDone={onDone}
      />
    </div>
  );
}

/** 非修正の判断ごとの、閉じた行での呼び方（#4814） */
const DECIDED_FINDING_LABEL: Record<string, string> = {
  post_release: "判断済み（公開後対応）",
  defer: "判断済み（見送り）",
  reject: "判断済み（不採用）",
};

function AiReviewSection({
  section,
  integration,
  assignee,
  repositoryFullName,
  pullRequestNumber,
  target,
  onReload,
  onFixCreated,
  nowMs,
  hideRebuild = false,
  compact = false,
}: {
  /** ブランチ画面は作り直しを追加PR群の直下に1つだけ置く（#4357）ので、ここでは出さない */
  hideRebuild?: boolean;
  /**
   * ブランチ画面の要約（#4938）。札の行を「札・要点・時刻」に絞り、「指摘なし」は出さず、担当は詳細へ移す
   */
  compact?: boolean;
  section: ReleaseVerificationSection;
  /** 統合検証の区分。再実行の前提（結果待ちか・証跡が更新されたか）の判定に使う（#4632） */
  integration?: ReleaseVerificationSection;
  assignee: string;
  repositoryFullName: string;
  pullRequestNumber?: number;
  target?: { baseSha: string; headSha: string };
  onReload?: () => void;
  onFixCreated?: () => void;
  nowMs: number;
}) {
  const baseHead = describeSection(section, nowMs, { compact });
  // 実行障害（レビューを最後まで行えなかった）は、コードへの指摘とは別の見た目にする（#4300）。
  // 「失敗」「不合格」と読ませず、レビュー未完了であることと工程・原因・次の操作を出す
  const executionFailed = section.state === "failed";
  const rerunView = integration ? describeReviewRerun(section, integration) : ({ kind: "none" } as const);
  const diagnosticView = executionFailed ? describeReleaseReviewDiagnostic(section.diagnostic) : null;
  // 統合検証の証跡から見た共通の段階（#4664）。上部バッジ・本番確認と同じ名前を見出しに出す
  const stage = section.stage;
  const stageHead: SectionHead | null =
    stage && (stage.kind === "integration_waiting" || stage.kind === "reevaluating" || stage.kind === "awaiting_integration")
      ? {
          ...baseHead,
          tone: "run",
          mark: "◌",
          label: describeReviewStageLabel(stage),
          detail:
            stage.kind === "awaiting_integration"
              ? "統合検証が終わると、その証跡を持つサブPCで全体レビューを開始します"
              : stage.kind === "integration_waiting"
                ? "全体レビューの最終確認は未完了です"
                : "統合検証の結果に依存する項目だけを自動で再評価しています",
        }
      : stage?.kind === "needs_check" && stage.cleared
        ? {
            // 止める指摘がすべて非修正の判断済み（#4814）。人の判断は済んでいるので赤の「対応／判断が必要」にしない
            ...baseHead,
            tone: "ok",
            mark: "✓",
            label: describeReviewStageLabel(stage),
            detail: "止める指摘はすべて判断済み（修正しない）",
          }
        : stage?.kind === "needs_check" && stage.autoReevaluated
        ? {
            ...baseHead,
            label: describeReviewStageLabel(stage),
            detail: stage.items.map((item) => REVIEW_OPEN_ITEM_LABEL[item]).join("・") || baseHead.detail,
          }
        : null;
  const head: SectionHead = stageHead
    ? stageHead
    : executionFailed && diagnosticView
      ? {
          ...baseHead,
          tone: "warn",
          mark: "◌",
          label: "レビュー未完了",
          detail: diagnosticView.stageLabel ? `${diagnosticView.stageLabel}の工程で中断` : "実行障害（コードへの指摘ではありません）",
          reason: diagnosticView.unidentified
            ? "原因未特定です。コードの問題と判断されたわけではありません"
            : `原因: ${diagnosticView.causeLabel}`,
          reasonTone: "warn",
        }
      : baseHead;
  const recordedAgent = section.agent ?? section.progress?.agent ?? null;
  const agentLabel = recordedAgent ? `担当: ${formatReleaseReviewAgent(recordedAgent)}` : `担当予定: ${assignee}`;
  const finished = ["passed", "failed", "needs_check"].includes(section.state);
  const counts = { high: 0, medium: 0, low: 0 };
  for (const finding of section.findings) counts[finding.severity in counts ? finding.severity : "medium"] += 1;
  const decisions = section.decisions ?? null;
  // 未判断・前提が変わった判断の指摘に、AIの推奨判断と理由案を出す（#4676）。対象ごとに1回作って保存し、以後は保存済みを返す
  const recommendations = useReleaseReviewRecommendations({
    repositoryFullName,
    pullRequestNumber,
    target,
    decisions,
    findingIds: [...section.findings, ...section.suggestions].flatMap((f) => (f.id ? [f.id] : [])),
  });
  const recommendationProps = (id: string) => ({
    recommendation: recommendations.view?.byFinding[id] ?? null,
    recommendationFailure: recommendations.view?.failures[id] ?? recommendations.error,
    recommendationLoading: recommendations.loading,
    onRetryRecommendation: recommendations.retry,
  });
  // 判断済み（修正しない）の指摘は、修正Issueの起案から外す（#4657）
  const nonFixIds = [...nonFixFindingIds(decisions)];
  const fixable = section.findings.filter((f) => !(f.id && nonFixIds.includes(f.id)));
  // 「今回直す」と判断した改善提案も起案の対象にする（#5102）。止める指摘へは変換せず、添字は指摘の後ろに続ける
  const fixNowIds = [...fixNowFindingIds(decisions)];
  const fixNowSuggestions = section.suggestions.filter((s) => s.id && fixNowIds.includes(s.id));
  const fixCandidates = [...section.findings, ...section.suggestions];
  const fixExcludedIds = [
    ...nonFixIds,
    ...section.suggestions.flatMap((s) => (s.id && !fixNowIds.includes(s.id) ? [s.id] : [])),
  ];
  const decisionText = decisions
    ? decisions.cleared
      ? "・すべて判断済み（修正しない）"
      : decisions.counts.undecidedBlocking > 0
        ? `・未判断 ${decisions.counts.undecidedBlocking}件`
        : ""
    : "";
  const findingsText = finished
    ? section.findings.length > 0
      ? `指摘 ${section.findings.length}件（重大 ${counts.high}・中 ${counts.medium}・軽微 ${counts.low}）${decisionText}`
      : section.state === "failed" || compact
        ? null
        : "指摘なし"
    : null;
  // 閉じた状態でも、いちばん重い指摘の題だけは読めるようにする。未判断の指摘を先に選び、判断済み（修正しない）の
  // 指摘しか無ければ「判断済み（公開後対応）」として控えめに出す（#4814。赤字の「重大: …」にしない）
  const pickTop = (list: typeof section.findings) =>
    list.find((f) => f.severity === "high") ?? list.find((f) => f.severity === "medium") ?? list[0];
  const top = pickTop(fixable) ?? pickTop(section.findings);
  const topDecided = top !== undefined && !fixable.includes(top);
  const topDecision = topDecided && top.id ? decisions?.byFinding[top.id]?.current?.decision : undefined;
  const reason =
    head.reason ??
    (top
      ? topDecided
        ? `${DECIDED_FINDING_LABEL[topDecision ?? ""] ?? "判断済み（修正しない）"}: ${top.title}`
        : `${SEVERITY_LABEL[top.severity] ?? "中"}: ${top.title}`
      : null);
  const reasonTone: Tone = head.reason
    ? head.reasonTone
    : topDecided
      ? "muted"
      : top?.severity === "high"
        ? "bad"
        : top
          ? "warn"
          : "muted";
  // 実行障害にはコード修正→作り直しを勧めない（直すものが無い）。再実行が主導線
  const needsFix = fixable.length > 0 || section.state === "invalidated" || section.state === "needs_check";
  const hasDetail =
    compact ||
    Boolean(section.summary) ||
    section.findings.length > 0 ||
    section.suggestions.length > 0 ||
    section.review !== null ||
    section.totalFiles !== null ||
    needsFix ||
    section.progress !== null ||
    executionFailed;

  return (
    <SectionRow
      title="全体レビュー"
      note="リリース差分全体のコード・仕様をAIが確認"
      line={
        <HeadLine
          head={head}
          extra={
            <>
              {findingsText && <span>{findingsText}</span>}
              {!compact && <span className="text-[11px] text-muted-foreground">{agentLabel}</span>}
            </>
          }
        />
      }
      steps={
        head.steps && section.progress ? (
          <ProgressSteps progress={section.progress} currentTone={head.steps.tone} animate={head.steps.animate} />
        ) : undefined
      }
      reason={reason}
      reasonTone={reasonTone}
      actions={
        rerunView.kind !== "none" && pullRequestNumber !== undefined && target ? (
          <ReviewRerunPanel
            view={rerunView}
            repositoryFullName={repositoryFullName}
            pullRequestNumber={pullRequestNumber}
            target={target}
            onDone={onReload}
          />
        ) : undefined
      }
    >
      {hasDetail ? (
        <>
          <dl className="grid grid-cols-[6.5rem_1fr] gap-x-2 gap-y-0.5 text-[11.5px]">
            {compact && (
              <>
                <dt className="text-muted-foreground">{recordedAgent ? "担当" : "担当予定"}</dt>
                <dd>{recordedAgent ? formatReleaseReviewAgent(recordedAgent) : assignee}</dd>
              </>
            )}
            {section.totalFiles !== null && (
              <>
                <dt className="text-muted-foreground">確認した範囲</dt>
                <dd>{describeReviewCoverage(section)}</dd>
              </>
            )}
            {section.coverage && section.coverage.open.length > 0 && (
              <>
                <dt className="text-muted-foreground">未確認の対象</dt>
                <dd className="space-y-0.5">
                  {section.coverage.open.slice(0, 10).map((o) => (
                    <div key={o.file} className="break-all">
                      <span className={o.kind === "unreadable" ? "text-red-600" : "text-amber-600"}>
                        {o.kind === "unreadable" ? "取得不能" : "未確認"}
                      </span>{" "}
                      <code>{o.file}</code>
                    </div>
                  ))}
                  {section.coverage.open.length > 10 && <div>ほか{section.coverage.open.length - 10}件</div>}
                </dd>
              </>
            )}
            {section.progress?.files !== null && section.progress?.files !== undefined && !finished && (
              <>
                <dt className="text-muted-foreground">差分</dt>
                <dd>{section.progress.files} ファイル</dd>
              </>
            )}
            {section.progress?.host && (
              <>
                <dt className="text-muted-foreground">実行先</dt>
                <dd>{section.progress.host}</dd>
              </>
            )}
          </dl>
          {executionFailed && diagnosticView && (
            <div className="flex flex-col gap-1 rounded border border-amber-300 bg-amber-50/60 px-2 py-1.5 dark:border-amber-800 dark:bg-amber-950/20">
              <p className="font-medium">
                レビューは最後まで行えていません。コードの品質が不合格になったわけではなく、問題なしとも扱いません。
              </p>
              <dl className="grid grid-cols-[6.5rem_1fr] gap-x-2 gap-y-0.5 text-[11.5px]">
                <dt className="text-muted-foreground">失敗した工程</dt>
                <dd>{diagnosticView.stageLabel ?? "特定できていません"}</dd>
                <dt className="text-muted-foreground">確認できた原因</dt>
                <dd>
                  {diagnosticView.causeLabel}
                  {section.diagnostic?.exitCode != null && `（終了コード ${section.diagnostic.exitCode}）`}
                </dd>
                {section.updatedAt && (
                  <>
                    <dt className="text-muted-foreground">記録した時刻</dt>
                    <dd>{clock(section.updatedAt)}</dd>
                  </>
                )}
                {target && (
                  <>
                    <dt className="text-muted-foreground">対象</dt>
                    <dd className="font-mono">
                      main {shortSha(target.baseSha)} ← release {shortSha(target.headSha)}
                    </dd>
                  </>
                )}
              </dl>
              {section.reason && (
                <p className="break-words text-muted-foreground">実行側の報告: {section.reason}</p>
              )}
              <p>次の操作: {diagnosticView.action}</p>
              {section.diagnostic?.excerpt && (
                <details>
                  <summary className="cursor-pointer text-muted-foreground">エラーの抜粋（機密は除去済み・末尾のみ）</summary>
                  <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted/50 p-2 text-[11px] whitespace-pre-wrap">
                    {section.diagnostic.excerpt}
                  </pre>
                </details>
              )}
            </div>
          )}
          {section.previousRun && (
            <p className="text-muted-foreground" data-testid="review-previous-run">
              前回の結果（履歴・現在の結果ではありません）: {clock(section.previousRun.at)}・
              {section.previousRun.unverifiedScope ? `未確認範囲あり（${section.previousRun.unverifiedScope}）` : section.previousRun.state}
            </p>
          )}
          <ReviewContractPanel section={section} />
          {section.summary && <p className="whitespace-pre-wrap">{section.summary}</p>}
          {decisions && (section.findings.length > 0 || section.suggestions.length > 0 || decisions.detached.length > 0) && (
            <ReviewDecisionSummaryPanel decisions={decisions} />
          )}
          {section.findings.length > 0 && (
            <ul className="flex flex-col gap-1">
              {section.findings.map((finding, index) => (
                <li key={`${finding.title}-${index}`} className="rounded bg-muted/40 px-2 py-1">
                  <span className={finding.severity === "high" ? "font-medium text-destructive" : "font-medium"}>
                    [{SEVERITY_LABEL[finding.severity] ?? "中"}] {finding.title}
                  </span>
                  {finding.file && (
                    <span className="ml-2 break-all text-muted-foreground">
                      {finding.file}
                      {finding.line ? `:${finding.line}` : ""}
                    </span>
                  )}
                  {findingTags(finding).length > 0 && (
                    <span className="ml-2 text-[11px] text-muted-foreground">{findingTags(finding).join(" · ")}</span>
                  )}
                  {finding.detail && <p className="whitespace-pre-wrap text-muted-foreground">{finding.detail}</p>}
                  {finding.blockingReason && <p className="whitespace-pre-wrap">止める理由: {finding.blockingReason}</p>}
                  {describeStall(finding) && (
                    <p className="whitespace-pre-wrap">
                      解消されない原因: {describeStall(finding)?.cause}。{describeStall(finding)?.next}
                    </p>
                  )}
                  {finding.impact && <p className="whitespace-pre-wrap">影響: {finding.impact}</p>}
                  {finding.evidence && <p className="whitespace-pre-wrap text-muted-foreground">根拠: {finding.evidence}</p>}
                  {finding.recommendation && <p className="whitespace-pre-wrap">推奨対応: {finding.recommendation}</p>}
                  {finding.pullRequests?.length > 0 && (
                    <p className="text-muted-foreground">影響PR: {finding.pullRequests.map((n) => `#${n}`).join(" ")}</p>
                  )}
                  {finding.premiseChanged && (
                    <p className="whitespace-pre-wrap text-amber-700 dark:text-amber-400">AIが報告した前提の変化: {finding.premiseChanged}</p>
                  )}
                  {decisions && finding.id && pullRequestNumber !== undefined && target && (
                    <FindingDecisionControl
                      repositoryFullName={repositoryFullName}
                      pullRequestNumber={pullRequestNumber}
                      target={target}
                      findingId={finding.id}
                      finding={finding}
                      blocking={true}
                      view={decisions.byFinding[finding.id]}
                      onSaved={onReload}
                      {...recommendationProps(finding.id)}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
          {section.suggestions.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground">
                改善提案 {section.suggestions.length}件（リリースは止めません。必要なら別Issueで追跡してください）
              </span>
              <ul className="flex flex-col gap-1">
                {section.suggestions.map((s, index) => (
                  <li key={`${s.title}-${index}`} className="rounded bg-muted/30 px-2 py-1">
                    <span className="font-medium">{s.title}</span>
                    {s.file && (
                      <span className="ml-2 break-all text-muted-foreground">
                        {s.file}
                        {s.line ? `:${s.line}` : ""}
                      </span>
                    )}
                    {s.detail && <p className="whitespace-pre-wrap text-muted-foreground">{s.detail}</p>}
                    {s.demotedReason && (
                      <p className="whitespace-pre-wrap text-muted-foreground">提案へ降格: {s.demotedReason}</p>
                    )}
                    {decisions && s.id && pullRequestNumber !== undefined && target && (
                      <FindingDecisionControl
                        repositoryFullName={repositoryFullName}
                        pullRequestNumber={pullRequestNumber}
                        target={target}
                        findingId={s.id}
                        finding={s}
                        blocking={false}
                        view={decisions.byFinding[s.id]}
                        onSaved={onReload}
                        {...recommendationProps(s.id)}
                      />
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {section.affectedFiles.length > 0 && (
            <p className="break-all text-muted-foreground">
              影響ファイル: {section.affectedFiles.slice(0, 20).join(", ")}
            </p>
          )}
          <p className="text-[10.5px] text-muted-foreground">
            AIの判定だけでは本番公開しません。公開承認済みの候補は、必要な条件が揃ったら自動で公開へ進みます。
          </p>
          {needsFix && !hideRebuild && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-1.5 text-muted-foreground">
              <span>
                修正はリリースブランチを直接直さず、developへ入れてから作り直します。作り直すとSHAが変わり、統合検証と全体レビューがやり直されます。
              </span>
              <ReleaseRebuildButton repositoryFullName={repositoryFullName} />
            </div>
          )}
          {(fixable.length > 0 || fixNowSuggestions.length > 0) &&
            !executionFailed &&
            pullRequestNumber !== undefined &&
            target && (
            <ReleaseFixCreate
              repositoryFullName={repositoryFullName}
              pullRequestNumber={pullRequestNumber}
              target={target}
              sourceKind="review_finding"
              findings={fixCandidates}
              excludedFindingIds={fixExcludedIds}
              suggestionsFrom={section.findings.length}
              onDone={onFixCreated}
            />
          )}
        </>
      ) : undefined}
    </SectionRow>
  );
}

function ReviewContractPanel({ section }: { section: ReleaseVerificationSection }) {
  const review = section.review;
  if (!review) return null;
  const kind = describeReviewKind(review);
  const open = countOpenItems(review, section.findings);
  return (
    <div className="flex flex-col gap-1.5 rounded border px-2 py-1.5" data-testid="review-contract">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="font-medium">{kind.label}</span>
        <span className="text-muted-foreground">{kind.version}</span>
        {!review.legacy && (
          <span className="text-muted-foreground">
            未確認の項目 {open.unconfirmed}件・未解決の阻害指摘 {open.blocking}件
          </span>
        )}
      </div>
      {review.legacy && (
        <p className="text-amber-700 dark:text-amber-400">
          項目別の確認記録がありません（旧ランナーの結果）。サブPCのpollerを更新して再実行すると、確認項目ごとの結果が残ります。
        </p>
      )}
      {review.fullReviewReason && <p className="text-muted-foreground">対象全体を確認: {review.fullReviewReason}</p>}
      {review.mode === "rereview" && (
        <dl className="grid grid-cols-[6.5rem_1fr] gap-x-2 gap-y-0.5">
          {review.previous && (
            <>
              <dt className="text-muted-foreground">前回の対象</dt>
              <dd className="font-mono">PR #{review.previous.prNumber} · {shortSha(review.previous.headSha)}</dd>
            </>
          )}
          {review.fixDiffFileCount !== null && (
            <>
              <dt className="text-muted-foreground">修正差分</dt>
              <dd>{review.fixDiffFileCount} ファイル</dd>
            </>
          )}
          {review.recheckScope && (
            <>
              <dt className="text-muted-foreground">再確認した範囲</dt>
              <dd className="whitespace-pre-wrap">{review.recheckScope}</dd>
            </>
          )}
        </dl>
      )}
      {!review.legacy && (
        <ul className="flex flex-col gap-0.5">
          {review.checks.map((check) => {
            const view = describeCheck(check, shortSha);
            const tone = checkTone(check);
            return (
              <li key={check.id} className="flex flex-col">
                <span>
                  <span className={tone === "ok" ? "text-emerald-700 dark:text-emerald-400" : tone === "bad" ? "font-medium text-destructive" : "text-muted-foreground"}>
                    [{view.status}]
                  </span>{" "}
                  {view.label}
                  {view.source && <span className="ml-1 text-muted-foreground">（{view.source}）</span>}
                </span>
                {view.evidence && <span className="whitespace-pre-wrap break-words text-muted-foreground">{view.evidence}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {review.previousFindings.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <span className="text-muted-foreground">前回の指摘の解消</span>
          <ul className="flex flex-col gap-0.5">
            {review.previousFindings.map((p) => (
              <li key={p.id}>
                <span className={p.status === "resolved" ? "text-emerald-700 dark:text-emerald-400" : "font-medium text-destructive"}>
                  [{p.status === "resolved" ? "解消" : p.status === "unresolved" ? "未解消" : "未確認"}]
                </span>{" "}
                <span className="font-mono">{p.id}</span> {p.title}
                {p.evidence && <span className="block whitespace-pre-wrap break-words text-muted-foreground">{p.evidence}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-[10.5px] text-muted-foreground">
        再レビューは合格の保証ではありません。現在の対象で必須の確認項目に未確認が無く、リリースを止める指摘が解消したときだけ先へ進めます。
      </p>
    </div>
  );
}

function IntegrationSection({
  section,
  nowMs,
  repositoryFullName,
  pullRequestNumber,
  target,
  onFixCreated,
  onReload,
  compact = false,
}: {
  section: ReleaseVerificationSection;
  nowMs: number;
  repositoryFullName: string;
  pullRequestNumber?: number;
  target?: { baseSha: string; headSha: string };
  onFixCreated?: () => void;
  /** 再開を受け付けたあとに状態を取り直す（#5020） */
  onReload?: () => void;
  /** ブランチ画面の要約（#4938）。実行中の札の行から実行先・最終報告を外す（実行先は詳細に出る） */
  compact?: boolean;
}) {
  const head = describeSection(section, nowMs, { compact });
  const progress = section.progress;
  const canDraftFix =
    (section.state === "failed" || section.state === "needs_check") && pullRequestNumber !== undefined && target !== undefined;
  const hasDetail = Boolean(section.summary) || Boolean(section.evidenceUrl) || progress !== null || canDraftFix;
  // 中断・失敗した統合検証は、詳細を開かなくても再開できる（#5020）
  const resume = pullRequestNumber !== undefined && target ? describeIntegrationResume(section, nowMs) : ({ kind: "none" } as const);
  return (
    <SectionRow
      title="統合検証"
      note="mainへ統合した状態でビルド・自動テスト"
      line={<HeadLine head={head} />}
      steps={
        head.steps && progress ? (
          <ProgressSteps progress={progress} currentTone={head.steps.tone} animate={head.steps.animate} />
        ) : undefined
      }
      reason={head.reason}
      reasonTone={head.reasonTone}
      actions={
        resume.kind === "ready" && pullRequestNumber !== undefined && target ? (
          <div
            className="flex flex-col gap-1.5 rounded border border-amber-300 bg-amber-50/60 px-2 py-1.5 text-[11.5px] dark:border-amber-800 dark:bg-amber-950/20"
            data-testid="integration-resume-panel"
          >
            <p className="font-medium">{resume.lead}</p>
            <dl className="grid grid-cols-[6.5rem_1fr] gap-x-2 gap-y-0.5">
              <dt className="text-muted-foreground">対象</dt>
              <dd className="font-mono">
                main {shortSha(target.baseSha)} ← release {shortSha(target.headSha)}
              </dd>
              {progress?.host && (
                <>
                  <dt className="text-muted-foreground">実行先</dt>
                  <dd>
                    {progress.host}
                    {progress.hostOnline === false ? "（オフライン）" : progress.hostOnline ? "（オンライン）" : ""}
                  </dd>
                </>
              )}
            </dl>
            <ReviewRerunButton
              repositoryFullName={repositoryFullName}
              pullRequestNumber={pullRequestNumber}
              baseSha={target.baseSha}
              headSha={target.headSha}
              label={resume.buttonLabel}
              endpoint="/api/repositories/release/integration-rerun"
              acceptedMessage="再開を受け付けました。これは検証の合格ではありません。待機中→実行中→完了の順に表示が変わります。"
              onDone={onReload}
            />
          </div>
        ) : undefined
      }
    >
      {hasDetail ? (
        <>
          {progress && (
            <dl className="grid grid-cols-[6.5rem_1fr] gap-x-2 gap-y-0.5 text-[11.5px]">
              {progress.host && (
                <>
                  <dt className="text-muted-foreground">実行先</dt>
                  <dd>
                    {progress.host}
                    {progress.hostOnline === false ? "（オフライン）" : progress.hostOnline ? "（オンライン）" : ""}
                  </dd>
                </>
              )}
              {progress.command && (
                <>
                  <dt className="text-muted-foreground">{head.label === "実行中" ? "現在のコマンド" : "最後のコマンド"}</dt>
                  <dd className="min-w-0 font-mono break-all">{progress.command}</dd>
                </>
              )}
            </dl>
          )}
          {section.summary && (
            <pre className="max-h-48 overflow-auto rounded bg-muted/50 p-2 text-[11px] whitespace-pre-wrap">
              {section.summary}
            </pre>
          )}
          {section.evidenceUrl && (
            <a
              href={section.evidenceUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex w-fit items-center gap-1 underline"
            >
              既存CIの記録
              <ExternalLink aria-hidden className="size-3" />
            </a>
          )}
          {canDraftFix && pullRequestNumber !== undefined && target && (
            <ReleaseFixCreate
              repositoryFullName={repositoryFullName}
              pullRequestNumber={pullRequestNumber}
              target={target}
              sourceKind="integration_failure"
              onDone={onFixCreated}
            />
          )}
        </>
      ) : undefined}
    </SectionRow>
  );
}

const VERDICT_LABEL: Record<ReviewVerdictKind, string> = {
  ok: "問題なし",
  "needs-check": "要確認",
  "changes-requested": "要修正",
  skipped: "レビューなし",
  unknown: "記録なし",
};

/** 個別PRの一覧（既定）。行を押すとPR詳細へ、押せない画面ではGitHubのPRへ */
function IndividualList({
  data,
  repositoryFullName,
  onOpenPullRequest,
}: {
  data: ReleaseChangeListResponse;
  repositoryFullName: string;
  onOpenPullRequest?: (pullRequestNumber: number) => void;
}) {
  return (
    <ul className="flex max-h-[min(14rem,40vh)] flex-col overflow-y-auto">
      {data.pullRequests.map((pr) => {
        const kind: ReviewVerdictKind | null = pr.isVersionBump ? null : (pr.review?.reviewKind ?? "unknown");
        const body = (
          <>
            <span className="w-12 shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">#{pr.number}</span>
            <span className="min-w-0 flex-1 truncate">{pr.title}</span>
            {pr.reviewUnavailable ? (
              <span className="shrink-0 text-[11px] font-bold text-destructive">取得不可</span>
            ) : kind ? (
              <span className={cn("shrink-0 text-[11px] font-bold whitespace-nowrap", REVIEW_TONE[kind])}>
                <span aria-hidden="true">{REVIEW_MARK[kind]}</span> {VERDICT_LABEL[kind]}
              </span>
            ) : (
              <span className="shrink-0 text-[11px] text-muted-foreground">対象外</span>
            )}
          </>
        );
        return (
          <li key={pr.number} className="border-b border-dashed last:border-b-0">
            {onOpenPullRequest ? (
              <button
                type="button"
                onClick={() => onOpenPullRequest(pr.number)}
                className="flex w-full items-center gap-2 py-1 text-left hover:bg-muted/50"
              >
                {body}
              </button>
            ) : (
              <a
                href={`https://github.com/${repositoryFullName}/pull/${pr.number}`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 py-1 hover:bg-muted/50"
              >
                {body}
              </a>
            )}
          </li>
        );
      })}
      {data.unknownCommits.length > 0 && (
        <li className="py-1 text-[11px] text-muted-foreground">PRに紐づかないコミット {data.unknownCommits.length}件</li>
      )}
    </ul>
  );
}

function IndividualReviewSection({
  changes,
  repositoryFullName,
  renderList,
  context,
  onOpenPullRequest,
}: {
  changes: UseReleaseChangesResult;
  repositoryFullName: string;
  renderList?: (data: ReleaseChangeListResponse, context: IndividualListContext) => ReactNode;
  context: IndividualListContext;
  onOpenPullRequest?: (pullRequestNumber: number) => void;
}) {
  const { data, isLoading, error } = changes;
  const tally = data ? tallyReleaseReviews(data.pullRequests) : null;
  const note = "対象PRとPRごとのAIレビュー（develop向けPR単位）";

  if (error) {
    return (
      <SectionRow
        title="個別PRレビュー"
        note={note}
        line={
          <Pill tone="bad" mark="■">
            取得できません
          </Pill>
        }
        reason={`${error}。問題なしとは扱いません。「更新」で取り直せます`}
        reasonTone="bad"
      />
    );
  }
  if (!tally || !data) {
    return (
      <SectionRow
        title="個別PRレビュー"
        note={note}
        line={<span className="text-muted-foreground">{isLoading ? "取得中です…" : "未取得"}</span>}
      />
    );
  }

  const reviewable = data.pullRequests.filter((pr) => !pr.isVersionBump);
  const bumps = data.pullRequests.length - reviewable.length;
  const pick = (kind: ReviewVerdictKind) =>
    reviewable.filter((pr) => !pr.reviewUnavailable && (pr.review?.reviewKind ?? "unknown") === kind).map((pr) => `#${pr.number}`);
  const reasons = [
    [pick("changes-requested"), "が要修正"],
    [pick("needs-check"), "が要確認"],
  ] as const;
  const reason =
    reasons
      .filter(([numbers]) => numbers.length > 0)
      .map(([numbers, phrase]) => `${numbers.slice(0, 4).join("・")}${numbers.length > 4 ? `ほか${numbers.length - 4}件` : ""}${phrase}`)
      .join("、") || null;
  const pills: { kind: ReviewVerdictKind; tone: Tone; count: number }[] = [
    { kind: "changes-requested", tone: "bad", count: tally.changesRequested },
    { kind: "needs-check", tone: "warn", count: tally.needsCheck },
    { kind: "ok", tone: "ok", count: tally.ok },
    { kind: "skipped", tone: "muted", count: tally.skipped },
    { kind: "unknown", tone: "muted", count: tally.unknown },
  ];

  return (
    <SectionRow
      title="個別PRレビュー"
      note={note}
      line={
        <>
          <span>
            <span className="font-semibold tabular-nums">PR {reviewable.length}件</span>
            {bumps > 0 && <span className="text-[11px] text-muted-foreground">（＋バンプ{bumps}）</span>}
          </span>
          {pills
            .filter((p) => p.count > 0)
            .map((p) => (
              <Pill key={p.kind} tone={p.tone} mark={REVIEW_MARK[p.kind]}>
                {VERDICT_LABEL[p.kind]} {p.count}
              </Pill>
            ))}
          {tally.unavailable > 0 && (
            <Pill tone="bad" mark="■">
              取得不可 {tally.unavailable}
            </Pill>
          )}
        </>
      }
      reason={reason}
      reasonTone={tally.changesRequested > 0 ? "bad" : "warn"}
    >
      {renderList ? (
        renderList(data, context)
      ) : (
        <IndividualList data={data} repositoryFullName={repositoryFullName} onOpenPullRequest={onOpenPullRequest} />
      )}
    </SectionRow>
  );
}

const GATE_LABEL: Record<Exclude<ReleaseVerificationSummary["gateStatus"], "not_enforced">, { tone: Tone; mark: string; text: string }> = {
  ready: { tone: "ok", mark: "●", text: "統合検証・全体レビューは揃っています" },
  needs_confirmation: { tone: "warn", mark: "▲", text: "要確認があります。理由を読んで、問題なければ明示して進めます" },
  blocked: { tone: "bad", mark: "■", text: "未完了または失敗があるため、まだ進められません" },
};

/**
 * 「確認した範囲」の文言。**入力へ載せた件数ではなく、根拠つきで確認した実績**を出す（#4615）。
 * ファイル別の実績が無い旧結果は件数を出さず「実績不明」にする
 */
export function describeReviewCoverage(section: Pick<ReleaseVerificationSection, "coverage" | "reviewedFiles" | "totalFiles">): string {
  const { coverage, reviewedFiles, totalFiles } = section;
  if (!coverage || reviewedFiles === null || totalFiles === null) return "実績不明（旧形式の結果。再実行すると確認した件数が記録されます）";
  const rest = [
    coverage.unreviewed > 0 ? `未確認 ${coverage.unreviewed}` : null,
    coverage.unreadable > 0 ? `取得不能 ${coverage.unreadable}` : null,
  ].filter((v): v is string => v !== null);
  const batches = coverage.batches > 1 ? `・${coverage.batches}バッチ` : "";
  const pending = coverage.pendingBatches > 0 ? `・残り${coverage.pendingBatches}バッチ` : "";
  // 同じ対象の保存済みの結果を使い回した数（#4767）。「確認済みは再利用」の説明と実際を揃える
  const reused =
    (coverage.reusedBatches ?? 0) > 0
      ? `・再利用${coverage.reusedBatches}／再確認${coverage.rerunBatches ?? 0}バッチ${coverage.integrationReused ? "（相互作用の確認も再利用）" : ""}`
      : "";
  return `確認済み ${reviewedFiles} / ${totalFiles} ファイル${rest.length > 0 ? `（${rest.join("・")}）` : ""}${batches}${pending}${reused}`;
}

export function ReleaseReviewSections({
  repositoryFullName,
  pullRequestNumber,
  headRef,
  verification,
  verificationError,
  changes,
  onReload,
  renderIndividualList,
  onOpenPullRequest,
  extraRows,
  hideOverview = false,
  previousResults: previousResultsProp,
  className,
}: {
  repositoryFullName: string;
  /** 全体レビューの再実行に使う。無ければ再実行の導線を出さない */
  pullRequestNumber?: number;
  /** 凍結ブランチ（`release-main/…`）のリリースPRにだけ出す。旧世代（head=develop）は検証の対象外 */
  headRef: string;
  verification: ReleaseVerificationSummary | null;
  verificationError?: string | null;
  changes: UseReleaseChangesResult;
  onReload?: () => void;
  /** 個別PRレビューを開いたときの一覧を差し替える（確認ダイアログは既存の変更一覧を入れる） */
  renderIndividualList?: (data: ReleaseChangeListResponse, context: IndividualListContext) => ReactNode;
  onOpenPullRequest?: (pullRequestNumber: number) => void;
  /** 3区分の後に同じ枠で並べる行（確認ダイアログのCI・コンフリクト） */
  extraRows?: ReactNode;
  /**
   * 上部の要約（`ReleaseFixOverviewPanel`）を出さない（#4428）。本番PR詳細は要約・今回の変更・履歴を
   * 別の位置へ並べるため、ここでは検証の区分だけを出す。そのとき修正前の結果かどうかは`previousResults`で受け取る
   */
  hideOverview?: boolean;
  previousResults?: boolean;
  className?: string;
}) {
  const active =
    verification !== null &&
    [verification.aiReview, verification.integration].some(
      (section) => section.state === "waiting" || section.state === "running",
    );
  const nowMs = useNow(active);
  const [fixTick, setFixTick] = useState(0);
  const sectionsRef = useRef<HTMLDivElement>(null);
  const openSection = (title: string) => {
    const detail = sectionsRef.current?.querySelector<HTMLDetailsElement>(`details[data-testid="release-section-${title}"]`);
    if (!detail) return;
    detail.open = true;
    detail.querySelector("summary")?.focus();
    detail.scrollIntoView?.({ block: "nearest" });
  };
  // 作り直し・修正後のチェック中は、作り直し前のリリースの結果を現在の結果として見せず、履歴へ移す（#4398）
  const [previousResultsState, setPreviousResults] = useState(false);
  const previousResults = hideOverview ? (previousResultsProp ?? false) : previousResultsState;
  const onFixCreated = () => {
    setFixTick((n) => n + 1);
    onReload?.();
  };
  if (!isReleaseCandidateHeadRef(headRef)) return null;

  const gate = verification && verification.enforced && verification.gateStatus !== "not_enforced"
    ? GATE_LABEL[verification.gateStatus]
    : null;

  return (
    <div ref={sectionsRef} className={cn("overflow-hidden rounded-lg border text-left", className)} data-testid="release-review-sections">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b bg-muted/50 px-3 py-1.5">
        <span className="text-xs font-semibold">リリースの検証</span>
        {verification && (
          <span className="font-mono text-[10.5px] text-muted-foreground">
            main {shortSha(verification.target.baseSha)} ← release {shortSha(verification.target.headSha)}
          </span>
        )}
        {onReload && (
          <button
            type="button"
            onClick={onReload}
            className="ml-auto inline-flex items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <RotateCcw aria-hidden className="size-3" />
            更新
          </button>
        )}
      </div>
      {pullRequestNumber !== undefined && !hideOverview && (
        <ReleaseFixOverviewPanel
          repositoryFullName={repositoryFullName}
          pullRequestNumber={pullRequestNumber}
          verification={verification}
          verificationError={verificationError ?? null}
          changes={changes}
          reloadToken={fixTick}
          onPreviousResultsChange={setPreviousResults}
          headRef={headRef}
        />
      )}
      {verification && !verificationError && !previousResults && <ReleaseGuidancePanel verification={verification} onOpenReview={() => openSection("全体レビュー")} onOpenIntegration={() => openSection("統合検証")} />}
      {gate && !previousResults && (
        <p className={cn("flex items-center gap-1.5 border-b px-3 py-1.5 text-xs font-bold", TONE_CLASS[gate.tone])}>
          <span aria-hidden="true" className="text-[10px]">
            {gate.mark}
          </span>
          {gate.text}
        </p>
      )}
      {verification ? (
        previousResults ? (
          <details className="border-b px-3 py-1.5" data-testid="release-previous-results">
            <summary className="cursor-pointer text-muted-foreground">修正前のリリース・検証履歴（現在の結果ではありません）</summary>
            <div className="mt-1 opacity-80">
              <AiReviewSection
                section={verification.aiReview}
                integration={verification.integration}
                hideRebuild
                assignee={verification.aiReviewAssignee}
                repositoryFullName={repositoryFullName}
                target={verification.target}
                nowMs={nowMs}
              />
              <IntegrationSection
                section={verification.integration}
                nowMs={nowMs}
                repositoryFullName={repositoryFullName}
                target={verification.target}
              />
            </div>
          </details>
        ) : (
          <>
            <AiReviewSection
              section={verification.aiReview}
              integration={verification.integration}
              assignee={verification.aiReviewAssignee}
              repositoryFullName={repositoryFullName}
              pullRequestNumber={pullRequestNumber}
              target={verification.target}
              onReload={onReload}
              onFixCreated={onFixCreated}
              nowMs={nowMs}
            />
            <IntegrationSection
              section={verification.integration}
              nowMs={nowMs}
              repositoryFullName={repositoryFullName}
              pullRequestNumber={pullRequestNumber}
              target={verification.target}
              onFixCreated={onFixCreated}
              onReload={onReload}
            />
          </>
        )
      ) : (
        <>
          <SectionRow
            title="全体レビュー"
            line={
              verificationError ? (
                <Pill tone="bad" mark="■">
                  取得できません
                </Pill>
              ) : (
                <span className="text-muted-foreground">取得中です…</span>
              )
            }
            reason={verificationError ? `${verificationError}。問題なしとは扱いません` : null}
            reasonTone="bad"
          />
          <SectionRow
            title="統合検証"
            line={
              verificationError ? (
                <Pill tone="bad" mark="■">
                  取得できません
                </Pill>
              ) : (
                <span className="text-muted-foreground">取得中です…</span>
              )
            }
          />
        </>
      )}
      <IndividualReviewSection
        changes={changes}
        repositoryFullName={repositoryFullName}
        renderList={renderIndividualList}
        context={{ verification, verificationError: verificationError ?? null, nowMs }}
        onOpenPullRequest={onOpenPullRequest}
      />
      {extraRows}
      {verification && verificationError && (
        <p className="border-t px-3 py-1 text-[11px] text-destructive">
          最新の状態を取得できませんでした（{verificationError}）。表示は最後に取得できた時点のものです
        </p>
      )}
      {verification && (
        <div className="border-t px-3 py-1.5 text-[10.5px] text-muted-foreground">
          {verification.enforced ? (
            verification.blockers.length > 0 && (
              <ul className="list-disc pl-4">
                {verification.blockers.map((blocker) => (
                  <li key={`${blocker.kind}-${blocker.state}`}>{blocker.reason}</li>
                ))}
              </ul>
            )
          ) : (
            <span>この検証は表示のみです（このリポジトリでは検証結果をマージの条件にしていません）。</span>
          )}
          {verification.enforced && verification.blockers.length === 0 && (
            <span>マージの可否はこれまでどおりの設定とAPIの判定に従います。</span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 状態を自分で取得する版。PCのリリースPR詳細・スマホのリリースシート・本番マージの確認ダイアログが使う。
 * `enabled`がfalseの間（ダイアログが閉じている間）は取得しない。「更新」で両方を取り直す
 */
export function ConnectedReleaseReviewSections({
  repositoryFullName,
  pullRequestNumber,
  headRef,
  enabled = true,
  renderIndividualList,
  onOpenPullRequest,
  extraRows,
  includeMergeChecks = false,
  className,
}: {
  repositoryFullName: string;
  pullRequestNumber: number;
  headRef: string;
  enabled?: boolean;
  renderIndividualList?: (data: ReleaseChangeListResponse, context: IndividualListContext) => ReactNode;
  onOpenPullRequest?: (pullRequestNumber: number) => void;
  extraRows?: ReactNode;
  /** PRごとのCI・計画レビューも取る（本番マージ確認ダイアログの5チェック。#4305） */
  includeMergeChecks?: boolean;
  className?: string;
}) {
  const [reloadToken, setReloadToken] = useState(0);
  const target = enabled && isReleaseCandidateHeadRef(headRef);
  const { verification, error } = useReleaseVerification(repositoryFullName, pullRequestNumber, target, reloadToken);
  const changes = useReleaseChanges(
    repositoryFullName,
    target,
    pullRequestNumber,
    reloadToken,
    includeMergeChecks,
  );
  const { openPullRequest } = useReferenceNavigation();
  return (
    <ReleaseReviewSections
      repositoryFullName={repositoryFullName}
      pullRequestNumber={pullRequestNumber}
      headRef={headRef}
      verification={verification}
      verificationError={error}
      changes={changes}
      onReload={() => setReloadToken((n) => n + 1)}
      renderIndividualList={renderIndividualList}
      onOpenPullRequest={
        onOpenPullRequest ?? ((number) => openPullRequest(`${repositoryFullName}#${number}`))
      }
      extraRows={extraRows}
      className={className}
    />
  );
}

/**
 * ブランチ画面の候補に出す「全体レビュー」「統合検証」だけの枠（#4357）。個別PRレビュー・修正PR系列は
 * 出さず、PRのCI・レビューの表示とは別枠にする。**対象はサーバーが現在のbase・headで判定する**ので、
 * 作り直した候補（別のPR）に古いSHAの成功は出ない。進行中は既存フックが5秒ごとに取り直し、
 * 「更新」で即時に取り直す。詳細・指摘・ログ・再実行は各区分を開いて読む（PRの詳細と同じ部品）
 */
export function ReleaseVerificationBrief({
  repositoryFullName,
  pullRequestNumber,
  headRef,
  className,
  onStatusChanged,
}: {
  repositoryFullName: string;
  pullRequestNumber: number;
  headRef: string;
  className?: string;
  /**
   * 取り直した検証の状態（区分ごとの状態・対象SHA）が前回と変わったとき（#4390）。初回の取得では呼ばない。
   * ブランチ画面はここでPR一覧を取り直し、見出しの「リリース検証中」「mainへマージ待ち」を詳細枠に揃える
   */
  onStatusChanged?: () => void;
}) {
  const [reloadToken, setReloadToken] = useState(0);
  const enabled = isReleaseCandidateHeadRef(headRef);
  const { verification, error } = useReleaseVerification(repositoryFullName, pullRequestNumber, enabled, reloadToken);
  const signature = verification
    ? [
        verification.aiReview.state,
        verification.integration.state,
        verification.mac.state,
        // 自動再評価の段階（#4664）。区分の状態が同じでも、見出しの「統合検証待ち」「確認中」を揃える
        verification.aiReview.stage?.kind ?? "",
        verification.target.baseSha,
        verification.target.headSha,
      ].join("|")
    : null;
  const lastSignature = useRef<string | null>(null);
  const onStatusChangedRef = useRef(onStatusChanged);
  useEffect(() => {
    onStatusChangedRef.current = onStatusChanged;
  });
  useEffect(() => {
    if (signature === null) return;
    const previous = lastSignature.current;
    lastSignature.current = signature;
    if (previous !== null && previous !== signature) onStatusChangedRef.current?.();
  }, [signature]);
  const active =
    verification !== null &&
    [verification.aiReview, verification.integration].some(
      (section) => section.state === "waiting" || section.state === "running",
    );
  const nowMs = useNow(active);
  if (!enabled) return null;
  const reload = () => setReloadToken((n) => n + 1);
  const unavailable = (
    <span className="min-w-0">
      {error ? (
        <Pill tone="bad" mark="■">
          取得できません
        </Pill>
      ) : (
        <span className="text-muted-foreground">取得中です…</span>
      )}
    </span>
  );

  return (
    <div
      className={cn("overflow-hidden rounded-lg border text-left", className)}
      data-testid="release-verification-brief"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b bg-muted/50 px-3 py-1.5">
        <span className="text-xs font-semibold">リリースの検証</span>
        {verification && (
          <span className="font-mono text-[10.5px] text-muted-foreground">
            release {shortSha(verification.target.headSha)}
          </span>
        )}
        <button
          type="button"
          onClick={reload}
          className="ml-auto inline-flex items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <RotateCcw aria-hidden className="size-3" />
          更新
        </button>
      </div>
      {verification ? (
        <>
          <AiReviewSection
            section={verification.aiReview}
            integration={verification.integration}
            assignee={verification.aiReviewAssignee}
            repositoryFullName={repositoryFullName}
            pullRequestNumber={pullRequestNumber}
            target={verification.target}
            onReload={reload}
            onFixCreated={reload}
            nowMs={nowMs}
            hideRebuild
            compact
          />
          <IntegrationSection
            section={verification.integration}
            nowMs={nowMs}
            repositoryFullName={repositoryFullName}
            pullRequestNumber={pullRequestNumber}
            target={verification.target}
            onFixCreated={reload}
            onReload={reload}
            compact
          />
          {error && (
            <p className="border-t px-3 py-1 text-[11px] text-destructive">
              最新の状態を取得できませんでした（{error}）。表示は最後に取得できた時点のものです
            </p>
          )}
        </>
      ) : (
        <>
          <SectionRow title="全体レビュー" line={unavailable} />
          <SectionRow title="統合検証" line={unavailable} />
        </>
      )}
    </div>
  );
}

