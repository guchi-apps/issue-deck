"use client";

import { ExternalLink } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { RELEASE_FIX_STEPS, RELEASE_FIX_MAX_GENERATION, type ReleaseFixSourceKind } from "@/lib/release-fix-series";
import type { ReleaseFixSeriesView } from "@/lib/release-fix-series-run";
import type { ReleaseReviewFinding } from "@/lib/release-review-result";
import { cn } from "@/lib/utils";

/**
 * リリース候補の修正起案と進捗（#4317）。PC・スマホで同じ部品を使う。
 * 起案は修正Issueを作るだけで、実装の開始・承認は既存のIssueの導線（計画・承認・実装・レビュー）に任せる。
 */

const SEVERITY_LABEL = { high: "重大", medium: "中", low: "軽微" } as const;

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
          setMessage(
            body.outcome === "existing"
              ? `すでに起案済みです（Issue #${body.series?.issueNumber}）。重複して作りません。`
              : `修正Issue #${body.series?.issueNumber} を作成しました。実装は通常のIssueと同じく開始してください。`,
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
    <div className="flex flex-col gap-1.5 rounded border border-dashed px-2 py-1.5" data-testid="release-fix-create">
      <p className="font-medium">修正Issueを作成（リリース候補への修正として追跡します）</p>
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
    </div>
  );
}

function issueUrl(repositoryFullName: string, number: number, kind: "issues" | "pull") {
  return `https://github.com/${repositoryFullName}/${kind}/${number}`;
}

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "-";
}

function SeriesRow({
  series,
  repositoryFullName,
  onAcceptExtra,
}: {
  series: ReleaseFixSeriesView;
  repositoryFullName: string;
  onAcceptExtra: (seriesId: string) => void;
}) {
  const stopped = series.status === "stopped" || series.status === "superseded" || series.status === "awaiting_decision";
  const link = (label: string, number: number | null, kind: "issues" | "pull") =>
    number === null ? null : (
      <a
        href={issueUrl(repositoryFullName, number, kind)}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-0.5 underline"
      >
        {label} #{number}
        <ExternalLink aria-hidden className="size-3" />
      </a>
    );
  return (
    <li className="flex flex-col gap-1 rounded bg-muted/40 px-2 py-1.5" data-testid="release-fix-series">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className={cn("font-medium", series.status === "ready" && "text-emerald-700 dark:text-emerald-400")}>
          {series.statusLabel}
        </span>
        <span className="text-muted-foreground">
          世代 {series.generation}/{RELEASE_FIX_MAX_GENERATION} · 元リリースPR #{series.releasePrNumber}
        </span>
        {link("修正Issue", series.issueNumber, "issues")}
        {link("修正PR", series.fixPrNumber, "pull")}
        {link("後継候補", series.successorPrNumber, "pull")}
      </div>
      <p className="break-words">{series.itemTitles.slice(0, 3).join(" / ")}{series.itemTitles.length > 3 ? ` ほか${series.itemTitles.length - 3}件` : ""}</p>
      <ol className="flex flex-wrap gap-x-1 gap-y-0.5 text-[10.5px]" aria-label="現在地">
        {RELEASE_FIX_STEPS.map((step, index) => (
          <li
            key={step}
            className={cn(
              "rounded px-1.5 py-0.5",
              index < series.stepIndex && "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
              index === series.stepIndex &&
                (stopped ? "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300" : "bg-sky-100 font-semibold text-sky-900 dark:bg-sky-950 dark:text-sky-300"),
              index > series.stepIndex && "text-muted-foreground",
            )}
            aria-current={index === series.stepIndex ? "step" : undefined}
          >
            {step}
          </li>
        ))}
      </ol>
      <p className="font-mono text-[10.5px] text-muted-foreground">
        起案時 main {shortSha(series.originBaseSha)} ← release {shortSha(series.originHeadSha)}
        {series.successorHeadSha && ` ／ 後継 main ${shortSha(series.successorBaseSha)} ← release ${shortSha(series.successorHeadSha)}`}
      </p>
      {series.stopReason && <p className="break-words text-amber-800 dark:text-amber-300">停止の理由: {series.stopReason}</p>}
      {series.status === "awaiting_decision" && (
        <button
          type="button"
          onClick={() => onAcceptExtra(series.id)}
          className="w-fit rounded border px-2 py-0.5 text-[11.5px] hover:bg-muted"
        >
          無関係な変更も含めて作り直す
        </button>
      )}
      {series.status === "ready" && (
        <p className="text-muted-foreground">検証済みの候補の準備が整いました。本番へのマージ・デプロイは人が承認します。</p>
      )}
    </li>
  );
}

/** 起案済みの修正系列の現在地。進行中は10秒おきに取り直す（解決完了は「本番承認待ち」まで進んだものだけ） */
export function ReleaseFixSeriesPanel({
  repositoryFullName,
  pullRequestNumber,
  reloadToken,
}: {
  repositoryFullName: string;
  pullRequestNumber: number;
  reloadToken?: number;
}) {
  const [series, setSeries] = useState<ReleaseFixSeriesView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

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
        setSeries(Array.isArray(body.series) ? body.series : []);
        setError(null);
      })
      .catch(() => {
        if (!cancelled) setError("修正の進捗を取得できませんでした");
      });
    return () => {
      cancelled = true;
    };
  }, [repositoryFullName, pullRequestNumber, reloadToken, tick]);

  const anyActive = series?.some((s) => s.active) ?? false;
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

  if (series === null && !error) return null;
  if (series !== null && series.length === 0 && !error) return null;
  return (
    <div className="flex flex-col gap-1.5 border-t px-3 py-2 text-[11.5px]" data-testid="release-fix-series-panel">
      <p className="text-xs font-semibold">この候補への修正の進捗</p>
      {error && <p className="text-destructive">{error}</p>}
      {series && (
        <ul className="flex flex-col gap-1.5">
          {series.map((item) => (
            <SeriesRow key={item.id} series={item} repositoryFullName={repositoryFullName} onAcceptExtra={acceptExtra} />
          ))}
        </ul>
      )}
    </div>
  );
}
