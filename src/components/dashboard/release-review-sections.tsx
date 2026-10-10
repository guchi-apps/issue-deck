"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight, ExternalLink, RotateCcw } from "lucide-react";

import { REVIEW_MARK, REVIEW_TONE } from "@/components/dashboard/review-verdict";
import { ReleaseRebuildButton } from "@/components/dashboard/release-rebuild-button";
import { useReleaseChanges, type UseReleaseChangesResult } from "@/hooks/use-release-changes";
import { useReferenceNavigation } from "@/hooks/use-reference-navigation";
import { useReleaseVerification } from "@/hooks/use-release-verification";
import type { ReviewVerdictKind } from "@/lib/github/release-verification";
import { toJstParts } from "@/lib/format-date-time";
import { RELEASE_BRANCH_PREFIX } from "@/lib/pull-request-list";
import { tallyReleaseReviews } from "@/lib/release-changes";
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

type Tone = "ok" | "warn" | "bad" | "run" | "muted";

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
  children,
}: {
  title: string;
  note?: string;
  line: ReactNode;
  steps?: ReactNode;
  reason?: string | null;
  reasonTone?: Tone;
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
      </section>
    );
  }
  return (
    <details className="group border-b text-xs last:border-b-0" data-testid={testId}>
      <summary className="flex cursor-pointer list-none flex-col gap-1 px-3 py-2 focus-visible:bg-muted/50 focus-visible:outline-none [&::-webkit-details-marker]:hidden">
        {head}
      </summary>
      <div className="flex flex-col gap-1.5 px-3 pb-2.5">{children}</div>
    </details>
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

type SectionHead = {
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
function describeSection(section: ReleaseVerificationSection, nowMs: number): SectionHead {
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
          meta: [
            view.elapsedMs !== null ? `開始から ${formatReleaseElapsed(view.elapsedMs)}` : null,
            progress.host,
            lastReport,
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

function AiReviewSection({
  section,
  assignee,
  repositoryFullName,
  nowMs,
}: {
  section: ReleaseVerificationSection;
  assignee: string;
  repositoryFullName: string;
  nowMs: number;
}) {
  const head = describeSection(section, nowMs);
  const recordedAgent = section.agent ?? section.progress?.agent ?? null;
  const agentLabel = recordedAgent ? `担当: ${formatReleaseReviewAgent(recordedAgent)}` : `担当予定: ${assignee}`;
  const finished = ["passed", "failed", "needs_check"].includes(section.state);
  const counts = { high: 0, medium: 0, low: 0 };
  for (const finding of section.findings) counts[finding.severity in counts ? finding.severity : "medium"] += 1;
  const findingsText = finished
    ? section.findings.length > 0
      ? `指摘 ${section.findings.length}件（重大 ${counts.high}・中 ${counts.medium}・軽微 ${counts.low}）`
      : section.state === "failed"
        ? null
        : "指摘なし"
    : null;
  // 閉じた状態でも、いちばん重い指摘の題だけは読めるようにする
  const top =
    section.findings.find((f) => f.severity === "high") ?? section.findings.find((f) => f.severity === "medium") ?? section.findings[0];
  const reason =
    head.reason ?? (top ? `${SEVERITY_LABEL[top.severity] ?? "中"}: ${top.title}` : null);
  const reasonTone: Tone = head.reason ? head.reasonTone : top?.severity === "high" ? "bad" : top ? "warn" : "muted";
  const needsFix =
    section.findings.length > 0 || section.state === "failed" || section.state === "invalidated";
  const hasDetail =
    Boolean(section.summary) || section.findings.length > 0 || section.totalFiles !== null || needsFix || section.progress !== null;

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
              <span className="text-[11px] text-muted-foreground">{agentLabel}</span>
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
    >
      {hasDetail ? (
        <>
          <dl className="grid grid-cols-[6.5rem_1fr] gap-x-2 gap-y-0.5 text-[11.5px]">
            {section.totalFiles !== null && section.reviewedFiles !== null && (
              <>
                <dt className="text-muted-foreground">確認した範囲</dt>
                <dd>
                  {section.reviewedFiles} / {section.totalFiles} ファイル（終了後の範囲）
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
          {section.summary && <p className="whitespace-pre-wrap">{section.summary}</p>}
          {section.findings.length > 0 && (
            <ul className="flex flex-col gap-1">
              {section.findings.map((finding, index) => (
                <li key={`${finding.title}-${index}`} className="rounded bg-muted/40 px-2 py-1">
                  <span className={finding.severity === "high" ? "font-medium text-destructive" : "font-medium"}>
                    [{SEVERITY_LABEL[finding.severity] ?? "中"}] {finding.title}
                  </span>
                  {finding.file && <span className="ml-2 break-all text-muted-foreground">{finding.file}</span>}
                  {finding.detail && <p className="whitespace-pre-wrap text-muted-foreground">{finding.detail}</p>}
                  {finding.pullRequests?.length > 0 && (
                    <p className="text-muted-foreground">影響PR: {finding.pullRequests.map((n) => `#${n}`).join(" ")}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
          {section.affectedFiles.length > 0 && (
            <p className="break-all text-muted-foreground">
              影響ファイル: {section.affectedFiles.slice(0, 20).join(", ")}
            </p>
          )}
          <p className="text-[10.5px] text-muted-foreground">
            AIが問題なしと判断しても、自動で本番へマージはしません。マージは人が行います。
          </p>
          {needsFix && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-1.5 text-muted-foreground">
              <span>
                修正はリリースブランチを直接直さず、developへ入れてから作り直します。作り直すとSHAが変わり、統合検証と全体レビューがやり直されます。
              </span>
              <ReleaseRebuildButton repositoryFullName={repositoryFullName} />
            </div>
          )}
        </>
      ) : undefined}
    </SectionRow>
  );
}

function IntegrationSection({ section, nowMs }: { section: ReleaseVerificationSection; nowMs: number }) {
  const head = describeSection(section, nowMs);
  const progress = section.progress;
  const hasDetail = Boolean(section.summary) || Boolean(section.evidenceUrl) || progress !== null;
  return (
    <SectionRow
      title="統合検証"
      note="mainへ統合した状態でビルド・自動テスト（AIではない）"
      line={<HeadLine head={head} />}
      steps={
        head.steps && progress ? (
          <ProgressSteps progress={progress} currentTone={head.steps.tone} animate={head.steps.animate} />
        ) : undefined
      }
      reason={head.reason}
      reasonTone={head.reasonTone}
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
  onOpenPullRequest,
}: {
  changes: UseReleaseChangesResult;
  repositoryFullName: string;
  renderList?: (data: ReleaseChangeListResponse) => ReactNode;
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
        renderList(data)
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

export function ReleaseReviewSections({
  repositoryFullName,
  headRef,
  verification,
  verificationError,
  changes,
  onReload,
  renderIndividualList,
  onOpenPullRequest,
  extraRows,
  className,
}: {
  repositoryFullName: string;
  /** 凍結ブランチ（`release-main/…`）のリリースPRにだけ出す。旧世代（head=develop）は検証の対象外 */
  headRef: string;
  verification: ReleaseVerificationSummary | null;
  verificationError?: string | null;
  changes: UseReleaseChangesResult;
  onReload?: () => void;
  /** 個別PRレビューを開いたときの一覧を差し替える（確認ダイアログは既存の変更一覧を入れる） */
  renderIndividualList?: (data: ReleaseChangeListResponse) => ReactNode;
  onOpenPullRequest?: (pullRequestNumber: number) => void;
  /** 3区分の後に同じ枠で並べる行（確認ダイアログのCI・コンフリクト） */
  extraRows?: ReactNode;
  className?: string;
}) {
  const active =
    verification !== null &&
    [verification.aiReview, verification.integration].some(
      (section) => section.state === "waiting" || section.state === "running",
    );
  const nowMs = useNow(active);
  if (!headRef.startsWith(RELEASE_BRANCH_PREFIX)) return null;

  const gate = verification && verification.enforced && verification.gateStatus !== "not_enforced"
    ? GATE_LABEL[verification.gateStatus]
    : null;

  return (
    <div className={cn("overflow-hidden rounded-lg border text-left", className)} data-testid="release-review-sections">
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
      {gate && (
        <p className={cn("flex items-center gap-1.5 border-b px-3 py-1.5 text-xs font-bold", TONE_CLASS[gate.tone])}>
          <span aria-hidden="true" className="text-[10px]">
            {gate.mark}
          </span>
          {gate.text}
        </p>
      )}
      {verification ? (
        <>
          <AiReviewSection
            section={verification.aiReview}
            assignee={verification.aiReviewAssignee}
            repositoryFullName={repositoryFullName}
            nowMs={nowMs}
          />
          <IntegrationSection section={verification.integration} nowMs={nowMs} />
        </>
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
  className,
}: {
  repositoryFullName: string;
  pullRequestNumber: number;
  headRef: string;
  enabled?: boolean;
  renderIndividualList?: (data: ReleaseChangeListResponse) => ReactNode;
  onOpenPullRequest?: (pullRequestNumber: number) => void;
  extraRows?: ReactNode;
  className?: string;
}) {
  const [reloadToken, setReloadToken] = useState(0);
  const target = enabled && headRef.startsWith(RELEASE_BRANCH_PREFIX);
  const { verification, error } = useReleaseVerification(repositoryFullName, pullRequestNumber, target, reloadToken);
  const changes = useReleaseChanges(repositoryFullName, target, pullRequestNumber, reloadToken);
  const { openPullRequest } = useReferenceNavigation();
  return (
    <ReleaseReviewSections
      repositoryFullName={repositoryFullName}
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
