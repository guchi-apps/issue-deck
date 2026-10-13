"use client";

import { ExternalLink } from "lucide-react";
import { useCallback, useContext, useEffect, useState, type ReactNode } from "react";

import { ReleaseCompletionPanel, useReleaseCompletionRun } from "@/components/dashboard/release-completion-panel";
import type { ReleaseCompletionRunView } from "@/lib/release-completion-run";
import { ReleaseFixStartContext } from "@/components/dashboard/release-fix-start-context";
import { useReferenceNavigation } from "@/hooks/use-reference-navigation";
import type { UseReleaseChangesResult } from "@/hooks/use-release-changes";
import { classifyReleaseContents } from "@/lib/release-contents";
import {
  describeFixOverview,
  RELEASE_FIX_PHASES,
  releaseFixPhaseIndex,
  type FixOverview,
  type OverviewChecks,
  type OverviewTone,
} from "@/lib/release-fix-overview";
import { RELEASE_FIX_STEPS, type ReleaseFixSourceKind, type ReleaseFixStartState } from "@/lib/release-fix-series";
import type { RebuildEpisode } from "@/lib/release-rebuild-history";
import type { ReleaseVerificationSummary } from "@/lib/release-verification-summary";
import type { ReleaseFixSeriesView } from "@/lib/release-fix-series-run";
import type { ReleaseReviewFinding } from "@/lib/release-review-result";
import { cn } from "@/lib/utils";
import type { Issue } from "@/types/issue";

/**
 * リリース候補の修正起案と進捗（#4317）。PC・スマホで同じ部品を使う。
 * 起案は修正Issueを作るだけで、実装の開始・承認は既存のIssueの導線（計画・承認・実装・レビュー）に任せる。
 */

const SEVERITY_LABEL = { high: "重大", medium: "中", low: "軽微" } as const;

const START_STATE_LABEL: Record<Exclude<ReleaseFixStartState, "none">, string> = {
  queued: "受付済み・起動待ち",
  running: "修正を実行中",
};

/**
 * 修正Issueの「修正を開始」（#4396）。押すとサーバーが対象を確かめ、既存の「実装を開始」ダイアログを開く。
 * 作成の成功と実行の開始は別で、失敗しても修正Issueは残り、同じボタンで再試行できる（Issueは作り直さない）。
 * 受付済み・実行中なら重複して開始せず、状態とIssue詳細への導線を出す。
 */
export function ReleaseFixStartButton({
  repositoryFullName,
  seriesId,
  startState,
}: {
  repositoryFullName: string;
  seriesId: string;
  startState: ReleaseFixStartState;
}) {
  const openStart = useContext(ReleaseFixStartContext);
  const { openIssue } = useReferenceNavigation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!openStart) return null;

  const check = async (): Promise<{ issue?: Issue; ok: boolean; message?: string }> => {
    const [owner, repo] = repositoryFullName.split("/");
    const res = await fetch(
      `/api/repositories/release/fix-series?owner=${owner}&repo=${repo}&startCheck=${encodeURIComponent(seriesId)}`,
    );
    const body: { ok?: boolean; issue?: Issue; message?: string } = await res.json().catch(() => ({}));
    return { ok: res.ok && body.ok === true, issue: body.issue, message: body.message ?? `開始できませんでした (${res.status})` };
  };

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await check();
      if (result.ok && result.issue) openStart(result.issue);
      else if (startState !== "none" && result.issue) openIssue(result.issue.id);
      else setError(result.message ?? "開始できませんでした");
    } catch {
      setError("開始できませんでした（通信に失敗しました）。もう一度押してください。");
    } finally {
      setBusy(false);
    }
  };

  const started = startState !== "none";
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="release-fix-start">
      {started && (
        <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[11px] text-sky-900 dark:bg-sky-950 dark:text-sky-300">
          {START_STATE_LABEL[startState]}
        </span>
      )}
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className={cn(
          "min-h-8 rounded border px-3 py-1 text-[11.5px] disabled:opacity-50",
          started ? "hover:bg-muted" : "bg-primary font-medium text-primary-foreground hover:opacity-90",
        )}
      >
        {busy ? "確認中…" : started ? "進捗を見る" : error ? "もう一度開始" : "修正を開始"}
      </button>
      {error && (
        <span role="alert" className="break-words text-destructive">
          {error}（修正Issueは作成済みです）
        </span>
      )}
    </span>
  );
}

type CreateResponse = { outcome?: string; error?: string; message?: string; series?: ReleaseFixSeriesView };

/** 「修正Issueを作成」。全体レビューの指摘は複数選択でき、統合検証の失敗は1件にまとめて起案する */
export function ReleaseFixCreate({
  repositoryFullName,
  pullRequestNumber,
  target,
  sourceKind,
  findings,
  onDone,
}: {
  repositoryFullName: string;
  pullRequestNumber: number;
  target: { baseSha: string; headSha: string };
  sourceKind: ReleaseFixSourceKind;
  findings?: ReleaseReviewFinding[];
  onDone?: () => void;
}) {
  const [selected, setSelected] = useState<number[]>(() => (findings ?? []).map((_, i) => i));
  const [needsDecision, setNeedsDecision] = useState(false);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [executionWarning, setExecutionWarning] = useState<string | null>(null);
  const [created, setCreated] = useState<ReleaseFixSeriesView | null>(null);

  const submit = useCallback(
    async (acknowledgeExecutionFailure: boolean) => {
      setBusy(true);
      setMessage(null);
      try {
        const [owner, repo] = repositoryFullName.split("/");
        const res = await fetch("/api/repositories/release/fix-series", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "create",
            owner,
            repo,
            pullRequestNumber,
            baseSha: target.baseSha,
            headSha: target.headSha,
            sourceKind,
            findingIndexes: selected,
            causeClass: needsDecision ? "decision" : "code",
            decisionQuestion: needsDecision ? question : null,
            acknowledgeExecutionFailure,
          }),
        });
        const body: CreateResponse = await res.json().catch(() => ({}));
        if (res.status === 409 && body.error === "execution_failure") {
          setExecutionWarning(body.message ?? "実行障害の可能性があります");
        } else if (res.status === 409 && body.error === "release_pr_changed") {
          setMessage("リリースPRが更新されています。「更新」で最新の状態を読み込んでください。");
        } else if (!res.ok) {
          setMessage(body.message ?? `起案できませんでした (${res.status})`);
        } else {
          setExecutionWarning(null);
          setCreated(body.series ?? null);
          setMessage(
            body.outcome === "existing"
              ? `すでに起案済みです（Issue #${body.series?.issueNumber}）。重複して作りません。`
              : `修正Issue #${body.series?.issueNumber} を作成しました（実装はまだ始まっていません）。`,
          );
          onDone?.();
        }
      } catch {
        setMessage("起案できませんでした（通信に失敗しました）。");
      } finally {
        setBusy(false);
      }
    },
    [needsDecision, onDone, pullRequestNumber, question, repositoryFullName, selected, sourceKind, target],
  );

  const canSubmit = !busy && (sourceKind === "integration_failure" || selected.length > 0) && (!needsDecision || question.trim() !== "");
  return (
    <div id="release-fix-create" className="flex flex-col gap-1.5 rounded border border-dashed px-2 py-1.5" data-testid="release-fix-create">
      <p className="font-medium">修正Issueを作成（このリリースへの修正として追跡します）</p>
      {sourceKind === "review_finding" && findings && findings.length > 1 && (
        <ul className="flex flex-col gap-0.5">
          {findings.map((finding, index) => (
            <li key={`${finding.title}-${index}`}>
              <label className="flex items-start gap-1.5">
                <input
                  type="checkbox"
                  checked={selected.includes(index)}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked ? [...current, index] : current.filter((n) => n !== index),
                    )
                  }
                  className="mt-0.5"
                />
                <span className="min-w-0 break-words">
                  [{SEVERITY_LABEL[finding.severity] ?? "中"}] {finding.title}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {sourceKind === "review_finding" && findings && findings.length > 1 && (
        <p className="text-muted-foreground">選んだ指摘は1件の修正Issueにまとめます（共通の原因は分けません）。</p>
      )}
      <label className="flex items-center gap-1.5">
        <input type="checkbox" checked={needsDecision} onChange={(event) => setNeedsDecision(event.target.checked)} />
        仕様の判断が必要（計画の承認を先に求めます）
      </label>
      {needsDecision && (
        <textarea
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="判断してほしい内容（例: AとBのどちらの挙動にするか）"
          className="min-h-16 rounded border bg-background px-2 py-1 text-[12px]"
        />
      )}
      {executionWarning && (
        <div className="flex flex-col gap-1 rounded border border-amber-300 bg-amber-50/60 px-2 py-1 dark:border-amber-800 dark:bg-amber-950/20">
          <p>{executionWarning}</p>
          <button
            type="button"
            onClick={() => submit(true)}
            disabled={busy}
            className="w-fit rounded border px-2 py-0.5 text-[11.5px] hover:bg-muted disabled:opacity-50"
          >
            コードの修正として起案する
          </button>
        </div>
      )}
      <span className="inline-flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => submit(false)}
          disabled={!canSubmit}
          className="inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11.5px] font-medium text-foreground hover:bg-muted disabled:opacity-50"
        >
          {busy ? "起案中…" : "修正Issueを作成"}
        </button>
        {message && <span role="status">{message}</span>}
      </span>
      {created && (
        <div className="flex flex-col gap-1">
          {created.itemTitles[0] && <p className="break-words text-muted-foreground">{created.itemTitles[0]}</p>}
          <ReleaseFixStartButton
            repositoryFullName={repositoryFullName}
            seriesId={created.id}
            startState={created.startState}
          />
        </div>
      )}
    </div>
  );
}

function issueUrl(repositoryFullName: string, number: number, kind: "issues" | "pull") {
  return `https://github.com/${repositoryFullName}/${kind}/${number}`;
}

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "-";
}

const TONE_PILL: Record<OverviewTone, string> = {
  ok: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  warn: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300",
  bad: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  progress: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-300",
  muted: "bg-muted text-muted-foreground",
};

/** 色だけで状態を伝えないための記号（#4428） */
const TONE_MARK: Record<OverviewTone, string> = { ok: "✓", warn: "▲", bad: "■", progress: "●", muted: "–" };

function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 underline">
      {children}
      <ExternalLink aria-hidden className="size-3" />
    </a>
  );
}

/** 検証の取得結果から、要約帯が使う形（現在のSHAの結果だけ）へ */
export function toOverviewChecks(verification: ReleaseVerificationSummary | null): OverviewChecks | null {
  if (!verification) return null;
  const macState = verification.mac?.state;
  return {
    aiReview: {
      state: verification.aiReview.state,
      findingCount: verification.aiReview.findings.length,
      reason: verification.aiReview.reason,
      reviewedFiles: verification.aiReview.reviewedFiles,
      totalFiles: verification.aiReview.totalFiles,
    },
    integration: { state: verification.integration.state, reason: verification.integration.reason },
    mac:
      macState === "passed" || macState === "failed" || macState === "running"
        ? { state: macState }
        : null,
  };
}

/** `useReleaseFixOverview`が返す、要約帯・今回の変更・修正履歴の材料（#4398・#4428） */
export type ReleaseFixOverviewState = {
  repositoryFullName: string;
  pullRequestNumber: number;
  /** 検証の対象（現在のbase・head）。取得前はnull。「リリース完了まで進める」の開始で使う（#4480） */
  target: { baseSha: string; headSha: string } | null;
  overview: FixOverview;
  /** 表示する修正系列（進行中を優先）。修正の記録が無ければnull */
  current: ReleaseFixSeriesView | null;
  /** 修正系列の一覧。取得前はnull */
  list: ReleaseFixSeriesView[] | null;
  error: string | null;
  /** リリース完了系列（#4480）。要約帯とパネルで同じ取得結果を使う（#4498）。取得前はundefined */
  completionRun: ReleaseCompletionRunView | null | undefined;
  setCompletionRun: (run: ReleaseCompletionRunView | null) => void;
  contents: ReturnType<typeof classifyReleaseContents>;
  /** 表示中の検証結果が修正前のリリースのものか */
  previousResults: boolean;
  acceptExtra: (seriesId: string) => Promise<void>;
  /** 修正系列の記録を取り直す（再開・引き継ぎの後） */
  reload: () => void;
};

/**
 * 修正系列・作り直し履歴を取得し、現在状態（`describeFixOverview`）と「今回リリースする変更」を決める（#4398）。
 * 進行中は10秒おきに取り直し、`reloadToken`の更新でも取り直す。画面の並べ方は呼び出し側が決める（#4428）
 */
export function useReleaseFixOverview({
  repositoryFullName,
  pullRequestNumber,
  verification,
  verificationError,
  changes,
  reloadToken,
}: {
  repositoryFullName: string;
  pullRequestNumber: number;
  verification: ReleaseVerificationSummary | null;
  verificationError: string | null;
  changes: UseReleaseChangesResult;
  reloadToken?: number;
}): ReleaseFixOverviewState {
  const [series, setSeries] = useState<{ key: string; list: ReleaseFixSeriesView[] } | null>(null);
  const [episodes, setEpisodes] = useState<{ key: string; list: RebuildEpisode[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // 取得結果が別のPR・リポジトリのものなら使わない（切替直後に対象を取り違えない）
  const key = `${repositoryFullName}#${pullRequestNumber}`;

  useEffect(() => {
    let cancelled = false;
    const [owner, repo] = repositoryFullName.split("/");
    fetch(`/api/repositories/release/fix-series?owner=${owner}&repo=${repo}&pullRequest=${pullRequestNumber}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        return (await res.json()) as { series: ReleaseFixSeriesView[] };
      })
      .then((body) => {
        if (cancelled) return;
        setSeries({ key, list: Array.isArray(body.series) ? body.series : [] });
        setError(null);
      })
      .catch(() => {
        if (!cancelled) setError("修正の進捗を取得できませんでした");
      });
    fetch(`/api/repositories/release/rebuild-history?owner=${owner}&repo=${repo}`)
      .then(async (res) => (res.ok ? ((await res.json()) as { episodes?: RebuildEpisode[] }) : null))
      .then((body) => {
        if (!cancelled && body) setEpisodes({ key, list: Array.isArray(body.episodes) ? body.episodes : [] });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [repositoryFullName, pullRequestNumber, reloadToken, tick, key]);

  const list = series && series.key === key ? series.list : null;
  const anyActive = list?.some((s) => s.active) ?? false;
  useEffect(() => {
    if (!anyActive) return;
    const timer = setInterval(() => setTick((n) => n + 1), 10_000);
    return () => clearInterval(timer);
  }, [anyActive]);

  const acceptExtra = async (seriesId: string) => {
    const [owner, repo] = repositoryFullName.split("/");
    await fetch("/api/repositories/release/fix-series", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "accept_extra", owner, repo, seriesId }),
    }).catch(() => undefined);
    setTick((n) => n + 1);
  };

  const { run: completionRun, setRun: setCompletionRun } = useReleaseCompletionRun(repositoryFullName, pullRequestNumber);
  const current = list?.find((s) => s.active) ?? list?.[0] ?? null;
  // 修正の記録を読み終えるまでは、修正前の指摘を現在状態として見せない
  const seriesPending = list === null && error === null;
  // 作り直し・修正後のチェック中に、作り直し前のリリースPRを見ている間、その検証結果は修正前のもの
  const previousResults =
    current !== null && (current.status === "rebuilding" || current.status === "reverifying") && current.releasePrNumber === pullRequestNumber;
  const overview = seriesPending
    ? describeFixOverview({ series: null, checks: null })
    : describeFixOverview({
        series: current ? { ...current, internalPause: current.internal?.pause ?? null } : null,
        checks: toOverviewChecks(verification),
        checksError: verification === null && verificationError !== null,
        completion: completionRun?.active
          ? { status: completionRun.status, active: true, candidatePrNumber: completionRun.candidatePrNumber }
          : null,
      });
  const episode = (episodes && episodes.key === key ? episodes.list : []).find(
    (e) => e.successor?.number === pullRequestNumber,
  );
  const contents = classifyReleaseContents({
    changes: changes.data,
    isLoading: changes.isLoading,
    error: changes.error,
    addedPrNumbers: episode?.selectedPrs.map((p) => p.number) ?? [],
    excludedPrNumbers: episode?.excludedPrs ?? [],
  });
  return {
    repositoryFullName,
    pullRequestNumber,
    target: verification?.target ?? null,
    overview,
    current,
    list,
    error,
    completionRun,
    setCompletionRun,
    contents,
    previousResults,
    acceptExtra,
    reload: () => setTick((n) => n + 1),
  };
}

/**
 * 修正の工程（修正→取り込み→再検証→公開。#4428）。**修正の記録がある候補にだけ**出し、
 * 修正の無い通常リリースには架空の工程を出さない（呼び出し側は`current`が無ければ描かない）
 */
export function ReleaseFixPhases({ current, className }: { current: ReleaseFixSeriesView; className?: string }) {
  const phase = releaseFixPhaseIndex(current.stepIndex);
  return (
    <ol className={cn("flex flex-wrap gap-1.5 text-xs", className)} aria-label="修正の工程" data-testid="release-fix-phases">
      {RELEASE_FIX_PHASES.map((label, index) => (
        <li
          key={label}
          className={cn(
            "rounded-full px-2.5 py-0.5",
            index < phase && "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
            index === phase && "bg-sky-100 font-semibold text-sky-900 dark:bg-sky-950 dark:text-sky-300",
            index > phase && "bg-muted text-muted-foreground",
          )}
          aria-current={index === phase ? "step" : undefined}
        >
          <span aria-hidden="true">{index < phase ? "✓ " : ""}</span>
          {label}
        </li>
      ))}
    </ol>
  );
}

/** 現在状態の主操作（修正Issueの作成・修正の開始・判断・再試行・進捗）。操作が無ければ何も出さない */
export function ReleaseFixPrimaryAction({ state }: { state: ReleaseFixOverviewState }) {
  const { overview, current, repositoryFullName, acceptExtra } = state;
  const action = overview.action;
  if (action.kind === "none") return null;
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="release-fix-primary-action">
      {action.kind === "create_issue" && (
        <button
          type="button"
          onClick={() => document.getElementById("release-fix-create")?.scrollIntoView({ block: "center" })}
          className="rounded border border-primary bg-primary px-3 py-1 text-[12px] font-semibold text-primary-foreground"
        >
          {action.label}
        </button>
      )}
      {action.kind === "accept_extra" && current && (
        <button
          type="button"
          onClick={() => acceptExtra(current.id)}
          className="rounded border border-primary bg-primary px-3 py-1 text-[12px] font-semibold text-primary-foreground"
        >
          {action.label}
        </button>
      )}
      {action.kind === "start_fix" && current && (
        <ReleaseFixStartButton
          repositoryFullName={repositoryFullName}
          seriesId={current.id}
          startState={current.startState}
        />
      )}
      {action.kind === "retry_rebuild" && (
        <>
          <span className="break-words font-medium">{action.label}</span>
          {current && <ExtLink href={issueUrl(repositoryFullName, current.issueNumber, "issues")}>修正Issue #{current.issueNumber}（作成済み）</ExtLink>}
        </>
      )}
      {(action.kind === "start_fix" || action.kind === "view_progress") && current && (
        <ExtLink href={issueUrl(repositoryFullName, current.fixPrNumber && action.kind === "view_progress" ? current.fixPrNumber : current.issueNumber, current.fixPrNumber && action.kind === "view_progress" ? "pull" : "issues")}>
          {action.kind === "start_fix" ? `${action.label}（修正Issue #${current.issueNumber}）` : action.label}
        </ExtLink>
      )}
    </div>
  );
}

/** 一時停止の再開と担当の引き継ぎ（#4587）。主操作は原因ごとに必要な入力だけを求める。PC・スマホで同じ部品を使う */
function InternalControls({
  repositoryFullName,
  issueNumber,
  internal,
  onChanged,
}: {
  repositoryFullName: string;
  issueNumber: number;
  internal: NonNullable<ReleaseFixSeriesView["internal"]>;
  onChanged?: () => void;
}) {
  const { pause } = internal;
  const [addMinutes, setAddMinutes] = useState("60");
  const [direction, setDirection] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const send = async (action: "resume_internal" | "handover_internal") => {
    const [owner, repo] = repositoryFullName.split("/");
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/repositories/release/fix-series", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          owner,
          repo,
          issueNumber,
          ...(action === "resume_internal" ? { addMinutes: pause?.resumeNeed === "budget" ? Number(addMinutes) : undefined, direction: direction || undefined } : {}),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) setMessage(body?.message ?? "操作できませんでした");
      else {
        setMessage(action === "resume_internal" ? "再開しました" : "担当を解放しました。別のエージェントが引き継げます");
        onChanged?.();
      }
    } catch {
      setMessage("通信に失敗しました");
    } finally {
      setBusy(false);
    }
  };
  const inputClass = "min-h-9 w-full rounded border bg-background px-2 text-[13px]";
  return (
    <div className="flex flex-col gap-1.5" data-testid="release-fix-internal-controls">
      {pause && pause.resumeNeed === "budget" && (
        <label className="flex flex-col gap-0.5 text-[11px]">
          追加する稼働時間（分）
          <input className={inputClass} inputMode="numeric" value={addMinutes} onChange={(e) => setAddMinutes(e.target.value)} />
        </label>
      )}
      {pause && pause.resumeNeed === "direction" && (
        <label className="flex flex-col gap-0.5 text-[11px]">
          進め方の方針
          <textarea className={cn(inputClass, "min-h-16 py-1")} value={direction} onChange={(e) => setDirection(e.target.value)} />
        </label>
      )}
      <div className="flex flex-wrap gap-1.5">
        {pause && (
          <button type="button" disabled={busy} onClick={() => void send("resume_internal")} className="min-h-9 rounded bg-primary px-3 text-[13px] font-semibold text-primary-foreground disabled:opacity-60" data-testid="release-fix-internal-resume">
            {pause.autoResumable ? "再開する" : pause.resumeNeed === "budget" ? "予算を追加して再開" : "方針を入力して再開"}
          </button>
        )}
        {internal.assignee.name && (
          <button type="button" disabled={busy} onClick={() => void send("handover_internal")} className="min-h-9 rounded border px-3 text-[13px] disabled:opacity-60" data-testid="release-fix-internal-handover">
            担当を解放（引き継ぎ）
          </button>
        )}
      </div>
      {message && <p className="break-words text-muted-foreground">{message}</p>}
    </div>
  );
}

/**
 * 内部確認（#4410）。実装・独立レビュー・テストの状態と未解決の指摘、上限の消費を1つの修正作業として出す。
 * 求めない系列（旧い系列）には何も出さない。レビュー・テストの結果は確認した内容に紐付いており、
 * ここに出る状態は最後に報告された内容のもの。
 */
export function ReleaseFixInternalReview({
  current,
  repositoryFullName,
  onChanged,
}: {
  current: ReleaseFixSeriesView;
  /** 再開・引き継ぎの操作を出すときに渡す。省くと表示だけ */
  repositoryFullName?: string;
  onChanged?: () => void;
}) {
  const internal = current.internal;
  if (!internal || !internal.required) return null;
  const latest = internal.rounds[internal.rounds.length - 1] ?? null;
  const open = internal.findings.filter((f) => f.status === "open");
  const resolved = internal.findings.filter((f) => f.status === "resolved");
  const reviewWord = !latest || latest.reviewVerdict === null ? "未実施" : latest.reviewVerdict === "pass" ? "指摘なし" : `指摘${open.length}件`;
  const testWord = !latest || latest.testState === null ? "未実施" : latest.testState === "passed" ? "合格" : "失敗";
  const { limits, pause } = internal;
  return (
    <div className="flex flex-col gap-1 rounded border bg-muted/30 px-2 py-1.5" data-testid="release-fix-internal">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="font-semibold">内部確認</span>
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[10.5px] font-bold",
            pause
              ? "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300"
              : internal.stopReason
              ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"
              : internal.gate.complete
                ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                : "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-300",
          )}
        >
          {pause ? (pause.autoResumable ? "一時停止（再開可）" : "一時停止") : internal.stopReason ? "要判断" : internal.gate.complete ? "完了（PR作成可）" : "確認中"}
        </span>
        <span className="text-muted-foreground">
          修正Issue #{current.issueNumber}
          {current.continuedFromParent ? "（追加の修正）" : ""}
        </span>
      </p>
      <p className="break-words text-muted-foreground" data-testid="release-fix-internal-lanes">
        独立レビュー: {reviewWord} ／ テスト: {testWord}
        {latest && latest.reviewTargetSha && (
          <>
            {" "}
            ／ 確認した内容 <span className="font-mono">{shortSha(latest.reviewTargetSha)}</span>
          </>
        )}
      </p>
      {!internal.gate.complete && !internal.stopReason && <p className="break-words text-muted-foreground">{internal.gate.message}</p>}
      {pause && (
        <div className="flex flex-col gap-0.5" data-testid="release-fix-internal-pause">
          <p className="break-words text-amber-900 dark:text-amber-300">{pause.message}</p>
          <p className="break-words">
            <span className="font-semibold">次の操作: </span>
            {pause.nextAction}
          </p>
        </div>
      )}
      {!pause && internal.pendingPause && <p className="break-words text-amber-900 dark:text-amber-300">次の報告で一時停止する見込み: {internal.pendingPause.message}</p>}
      {!pause && internal.stopReason && <p className="break-words text-destructive">{internal.stopReason}</p>}
      {internal.findings.length > 0 && (
        <ul className="flex flex-col gap-0.5" data-testid="release-fix-internal-findings">
          {[...open, ...resolved].map((f) => (
            <li key={f.key} className="flex min-w-0 gap-1.5">
              <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{f.key}</span>
              <span className={cn("shrink-0 text-[10.5px] font-semibold", f.status === "open" ? "text-amber-800 dark:text-amber-300" : "text-emerald-800 dark:text-emerald-300")}>
                {f.status === "open" ? "未解決" : "対応済み"}
              </span>
              <span className="min-w-0 break-words">
                {f.title}
                {f.status === "open" && f.reopenCount > 0 ? `（未解消のまま再指摘${f.reopenCount}回）` : ""}
                {f.regressionCount > 0 ? `（解消後の再発${f.regressionCount}回）` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[10.5px] tabular-nums text-muted-foreground">
        独立レビュー {limits.round}回 ・ 稼働 {limits.activeMinutes}分 / 予算 {limits.budgetMinutes}分（待機・中断は含みません）
      </p>
      <p className="break-words text-[10.5px] text-muted-foreground" data-testid="release-fix-internal-assignee">
        担当: {internal.assignee.name ? `${internal.assignee.name}${internal.assignee.leaseActive ? "" : "（応答なし）"}` : "なし"}
      </p>
      {repositoryFullName && (pause || internal.assignee.name) && (
        <InternalControls repositoryFullName={repositoryFullName} issueNumber={current.issueNumber} internal={internal} onChanged={onChanged} />
      )}
    </div>
  );
}

/** 現在状態の要約（状態ラベル・見出し・理由・検証の要約）。理由は現在の操作に必要なので折りたたまない */
export function ReleaseFixSummary({
  state,
  showPhases = false,
  extraAction,
  className,
}: {
  state: ReleaseFixOverviewState;
  /** 修正の工程を出すか（本番PR詳細。修正の記録があるときだけ実際に出る） */
  showPhases?: boolean;
  /** 修正の操作が無いときに置く主操作（本番PR詳細の「本番公開へ進む」） */
  extraAction?: ReactNode;
  className?: string;
}) {
  const { overview, current, error } = state;
  return (
    <div className={cn("flex flex-col gap-1.5", className)} data-testid="release-fix-summary">
      <span className={cn("w-fit rounded px-1.5 py-0.5 text-[11px] font-bold", TONE_PILL[overview.tone])}>
        <span aria-hidden="true">{TONE_MARK[overview.tone]} </span>
        {overview.pill}
      </span>
      <p className="break-words text-[13.5px] font-semibold" data-testid="release-fix-headline">
        {overview.headline}
      </p>
      {/* 停止・判断の理由は現在の操作に必要なので、行数で切らない（#4428） */}
      {overview.detail && <p className="break-words text-muted-foreground">{overview.detail}</p>}
      {overview.autoProgress && <p className="text-muted-foreground" data-testid="release-fix-auto">操作は不要です。自動で進みます。</p>}
      {overview.checksLine && <p className="break-words text-muted-foreground">{overview.checksLine}</p>}
      {showPhases && current && current.status !== "superseded" && <ReleaseFixPhases current={current} className="mt-0.5" />}
      {current && current.status !== "superseded" && <ReleaseFixInternalReview current={current} repositoryFullName={state.repositoryFullName} onChanged={state.reload} />}
      <ReleaseCompletionPanel
        runState={{ run: state.completionRun, setRun: state.setCompletionRun }}
        repositoryFullName={state.repositoryFullName}
        pullRequestNumber={state.pullRequestNumber}
        target={state.target}
        canStart={overview.tone === "bad" || current !== null}
      />
      {error && <p className="text-destructive">{error}</p>}
      {overview.action.kind !== "none" ? <ReleaseFixPrimaryAction state={state} /> : extraAction}
    </div>
  );
}

/** 「今回リリースする変更」。元から含む・今回の修正で追加・今回は含めないを分け、不明なものは不明と出す */
export function ReleaseContentsList({ state, className }: { state: ReleaseFixOverviewState; className?: string }) {
  const { contents, repositoryFullName } = state;
  const prUrl = (n: number) => issueUrl(repositoryFullName, n, "pull");
  return (
    <div className={cn("flex flex-col gap-1", className)} data-testid="release-contents">
      <p className="font-semibold">今回リリースする変更</p>
      {contents.kind === "loading" && <p className="text-muted-foreground">取得中です…</p>}
      {contents.kind === "error" && (
        <p className="text-destructive">変更の一覧を取得できません（{contents.message}）。変更なしとは扱いません</p>
      )}
      {contents.kind === "ready" && (
        <>
          <ul className="flex flex-col gap-0.5">
            {contents.original.map((pr) => (
              <li key={pr.number} className="flex min-w-0 gap-1.5">
                <span className="shrink-0 rounded bg-muted px-1 text-[10.5px] text-muted-foreground">元から含む</span>
                <span className="min-w-0 break-words">
                  <ExtLink href={prUrl(pr.number)}>#{pr.number}</ExtLink> {pr.title}
                </span>
              </li>
            ))}
            {contents.added.map((pr) => (
              <li key={pr.number} className="flex min-w-0 gap-1.5">
                <span className="shrink-0 rounded bg-sky-100 px-1 text-[10.5px] text-sky-900 dark:bg-sky-950 dark:text-sky-300">今回の修正で追加</span>
                <span className="min-w-0 break-words">
                  <ExtLink href={prUrl(pr.number)}>#{pr.number}</ExtLink> {pr.title}
                </span>
              </li>
            ))}
          </ul>
          {contents.original.length + contents.added.length === 0 && contents.unknownCommits.length === 0 && (
            <p className="text-muted-foreground">PRに紐づく変更は見つかりませんでした</p>
          )}
          {contents.unknownCommits.length > 0 && (
            <p className="text-muted-foreground">PRを特定できない変更が{contents.unknownCommits.length}件あります（PRに紐づかないコミット）</p>
          )}
          {contents.truncated && (
            <p className="text-amber-800 dark:text-amber-300">一覧は先頭だけです。残りはGitHubのリリースPRで確認してください（全件ではありません）</p>
          )}
          {contents.excluded.length > 0 && (
            <p className="break-words text-muted-foreground">
              今回は含めない変更（developにありますが、このリリースには入りません）:{" "}
              {contents.excluded.map((n) => (
                <span key={n} className="mr-1">
                  <ExtLink href={prUrl(n)}>#{n}</ExtLink>
                </span>
              ))}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** 修正履歴と技術的な詳細（世代・SHA・番号・工程）。記録は消さず折りたたみに置く。修正の記録が無ければ何も出さない */
export function ReleaseFixHistory({ state }: { state: ReleaseFixOverviewState }) {
  const { list, repositoryFullName } = state;
  if (!list || list.length === 0) return null;
  const prUrl = (n: number) => issueUrl(repositoryFullName, n, "pull");
  return (
    <>
      <details className="border-b px-3 py-1.5" data-testid="release-fix-history">
        <summary className="cursor-pointer text-muted-foreground">修正履歴（{list.length}件）</summary>
        <ul className="mt-1 flex flex-col gap-1">
          {list.map((item) => (
            <li key={item.id} className="flex flex-col rounded bg-muted/40 px-2 py-1" data-testid="release-fix-series">
              <span className="font-medium">{item.statusLabel}</span>
              <span className="break-words text-muted-foreground">
                {item.itemTitles.slice(0, 3).join(" / ")}
                {item.itemTitles.length > 3 ? ` ほか${item.itemTitles.length - 3}件` : ""}
              </span>
            </li>
          ))}
        </ul>
      </details>
      <details className="px-3 py-1.5" data-testid="release-fix-technical">
        <summary className="cursor-pointer text-muted-foreground">技術的な詳細</summary>
        <ul className="mt-1 flex flex-col gap-1.5">
          {list.map((item) => (
            <li key={item.id} className="flex flex-col gap-1 rounded bg-muted/40 px-2 py-1.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="text-muted-foreground">
                  世代 {item.generation} · 元のリリースPR #{item.releasePrNumber}
                </span>
                <ExtLink href={issueUrl(repositoryFullName, item.issueNumber, "issues")}>修正Issue #{item.issueNumber}</ExtLink>
                {item.fixPrNumber !== null && (
                  <ExtLink href={prUrl(item.fixPrNumber)}>指摘への修正内容 #{item.fixPrNumber}</ExtLink>
                )}
                {item.successorPrNumber !== null && (
                  <ExtLink href={prUrl(item.successorPrNumber)}>修正を反映したリリース #{item.successorPrNumber}</ExtLink>
                )}
              </div>
              <ol className="flex flex-wrap gap-x-1 gap-y-0.5 text-[10.5px]" aria-label="工程">
                {RELEASE_FIX_STEPS.map((step, index) => (
                  <li
                    key={step}
                    className={cn(
                      "rounded px-1.5 py-0.5",
                      index < item.stepIndex && "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
                      index === item.stepIndex && "bg-sky-100 font-semibold text-sky-900 dark:bg-sky-950 dark:text-sky-300",
                      index > item.stepIndex && "text-muted-foreground",
                    )}
                    aria-current={index === item.stepIndex ? "step" : undefined}
                  >
                    {step}
                  </li>
                ))}
              </ol>
              <p className="font-mono text-[10.5px] text-muted-foreground">
                起案時 main {shortSha(item.originBaseSha)} ← release {shortSha(item.originHeadSha)}
                {item.successorHeadSha && ` ／ 反映後 main ${shortSha(item.successorBaseSha)} ← release ${shortSha(item.successorHeadSha)}`}
              </p>
              {item.stopReason && <p className="break-words text-muted-foreground">停止の理由: {item.stopReason}</p>}
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}

/**
 * リリースの検証・修正画面の上部（#4398）。現在の状態を一文で出し、検証の要約・残件・主操作を隣に置く。
 * 世代・SHA・番号・工程は折りたたんだ「修正履歴」「技術的な詳細」へ移す（記録は消さない）。
 * スマホのリリースシート・本番マージの確認ダイアログが使う。本番PR詳細は部品を並べ替えて使う（#4428）
 */
export function ReleaseFixOverviewPanel({
  repositoryFullName,
  pullRequestNumber,
  verification,
  verificationError,
  changes,
  reloadToken,
  onPreviousResultsChange,
}: {
  repositoryFullName: string;
  pullRequestNumber: number;
  verification: ReleaseVerificationSummary | null;
  verificationError: string | null;
  changes: UseReleaseChangesResult;
  reloadToken?: number;
  /** 表示中の検証結果が修正前のリリースのものか。trueの間、呼び出し側は結果を履歴の折りたたみへ移す */
  onPreviousResultsChange?: (previous: boolean) => void;
}) {
  const state = useReleaseFixOverview({ repositoryFullName, pullRequestNumber, verification, verificationError, changes, reloadToken });
  const { previousResults } = state;
  useEffect(() => {
    onPreviousResultsChange?.(previousResults);
  }, [previousResults, onPreviousResultsChange]);

  return (
    <div className="flex flex-col text-xs" data-testid="release-fix-overview">
      <ReleaseFixSummary state={state} className="border-b px-3 py-2.5" />
      <ReleaseContentsList state={state} className="border-b px-3 py-2" />
      <ReleaseFixHistory state={state} />
    </div>
  );
}
