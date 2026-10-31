"use client";

import { useState } from "react";
import { Loader2, Rocket } from "lucide-react";

import { useReleaseCompletionRun } from "@/components/dashboard/release-completion-panel";
import { useReleaseReviewRecommendations } from "@/components/dashboard/release-review-decision";
import { Button } from "@/components/ui/button";
import { useReleaseVerification } from "@/hooks/use-release-verification";
import { RELEASE_COMPLETION_SCOPE_READY } from "@/lib/release-completion";
import type { ReleaseCompletionRunView } from "@/lib/release-completion-run";
import {
  buildBulkDecisionRows,
  countBulkDecisions,
  toBulkDecisionItem,
  type BulkDecisionRow,
} from "@/lib/release-review-bulk";
import { RELEASE_REVIEW_DECISION_LABEL, type ReleaseReviewDecisionKind } from "@/lib/release-review-decision";
import type { ReleaseVerificationSummary } from "@/lib/release-verification-summary";
import { cn } from "@/lib/utils";

/**
 * リリース候補の「次の操作」に出す、指摘の一括判定と「おまかせで公開承認まで進める」（#5138）。
 *
 * 全体レビューに未判断の止める指摘があるとき、未判断の指摘とAIの推奨（推奨が無い止める指摘は安全側の「今回直す」）を
 * 1つの表に並べ、押す前に全件の判定を見せる。押すと表の判定を一括で確定し（`review-decisions/bulk`）、続けて
 * 「修正を自動で続ける」と同じ系列（`until_ready`）を始める。系列は全チェックが通ると公開承認待ちで止まり、
 * 公開承認は従来どおり人が押す。PC（本番PR詳細）とスマホ（リリースのシート）で同じ部品を使う。
 */

const SEVERITY_LABEL = { high: "高", medium: "中", low: "低" } as const;
const SEVERITY_TONE = {
  high: "bg-destructive/10 text-destructive",
  medium: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  low: "bg-muted text-muted-foreground",
} as const;

const TALLY_LABEL: Record<ReleaseReviewDecisionKind, string> = {
  fix_now: "今回直す（自動で修正）",
  post_release: "公開後に対応する（Issueを起票）",
  defer: "今回は見送る",
  reject: "指摘を採用しない",
};

/** パネルを出すか。未判断の止める指摘があり、修正の自動継続が動いていないときだけ */
export function shouldShowAutoProceed(verification: ReleaseVerificationSummary | null, runActive: boolean): boolean {
  if (!verification || runActive) return false;
  const review = verification.aiReview;
  return review.state === "needs_check" && (review.decisions?.counts.undecidedBlocking ?? 0) > 0;
}

type Props = {
  repositoryFullName: string;
  pullRequestNumber: number;
  verification: ReleaseVerificationSummary;
  /** 開始した系列を親（要約帯）へ渡す。省略時は渡さない */
  onRunStarted?: (run: ReleaseCompletionRunView) => void;
  /** 判断を保存した後に検証の結果を取り直す */
  onReload: () => void;
  /** 「自分で1件ずつ判断する」の飛び先（指摘の一覧）。無ければ出さない */
  manualHref?: string;
  className?: string;
};

type Outcome = { tone: "ok" | "error"; message: string };

export function ReleaseAutoProceedPanel({ repositoryFullName, pullRequestNumber, verification, onRunStarted, onReload, manualHref, className }: Props) {
  const review = verification.aiReview;
  const decisions = review.decisions ?? null;
  const target = verification.target;
  const recommendations = useReleaseReviewRecommendations({
    repositoryFullName,
    pullRequestNumber,
    target,
    decisions,
    findingIds: [...review.findings, ...review.suggestions].flatMap((f) => (f.id ? [f.id] : [])),
  });
  const rows = buildBulkDecisionRows({
    findings: review.findings,
    suggestions: review.suggestions,
    decisions,
    recommendations: recommendations.view?.byFinding ?? {},
  });
  // 選び直した判断（指摘ID→判断）。推奨が後から届いても、選び直していない行は推奨に追随する
  const [overrides, setOverrides] = useState<Record<string, ReleaseReviewDecisionKind>>({});
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const choiceOf = (row: BulkDecisionRow) => {
    const chosen = overrides[row.findingId];
    return chosen && row.options.includes(chosen) ? chosen : row.decision;
  };
  const counts = countBulkDecisions(rows.map(choiceOf));
  const loadingRecommendations = recommendations.loading && !recommendations.view;

  async function proceed() {
    if (!target || rows.length === 0) return;
    setBusy(true);
    setOutcome(null);
    const [owner, repo] = repositoryFullName.split("/");
    try {
      const items = rows.map((row) => toBulkDecisionItem(row, choiceOf(row))).filter((item) => item !== null);
      const saved = await fetch("/api/repositories/release/review-decisions/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, repo, pullRequestNumber, baseSha: target.baseSha, headSha: target.headSha, items }),
      });
      const savedBody = (await saved.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        results?: { findingId: string; ok: boolean; message?: string | null }[];
      };
      if (!saved.ok) {
        setOutcome({
          tone: "error",
          message:
            saved.status === 409
              ? `${savedBody.message ?? "リリース候補が更新されました。"}画面を取り直してから押し直してください。`
              : saved.status === 401 || saved.status === 403
                ? "判定を確定する権限がありません。ログインし直してください。"
                : (savedBody.message ?? `判定を確定できませんでした (${saved.status})。`),
        });
        onReload();
        return;
      }
      const failed = (savedBody.results ?? []).filter((r) => !r.ok);
      if (failed.length > 0) {
        // 確定できた分は残る。失敗した指摘だけが未判断のまま表に残るので、自動修正は始めない
        setOutcome({
          tone: "error",
          message: `${failed.length}件の判定を確定できませんでした（${failed.map((f) => `${f.findingId}: ${f.message ?? "失敗"}`).join(" / ")}）。残った指摘を確かめて押し直してください。`,
        });
        onReload();
        return;
      }
      const started = await fetch("/api/repositories/release/completion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, repo, pullRequestNumber, scope: RELEASE_COMPLETION_SCOPE_READY, baseSha: target.baseSha, headSha: target.headSha }),
      });
      const startedBody = (await started.json().catch(() => null)) as { run?: ReleaseCompletionRunView; error?: string } | null;
      if (startedBody?.run) onRunStarted?.(startedBody.run);
      if (started.ok) {
        setOutcome({ tone: "ok", message: "判定を確定し、自動で修正を始めました。チェックがすべて通ると公開承認の画面で止まります。" });
      } else if (startedBody?.error === "nothing_to_recover") {
        // 全件を修正しない判断にした・ほかに失敗が無い。直すものが無いので、そのまま公開準備へ進める
        setOutcome({ tone: "ok", message: "判定を確定しました。直す指摘は無いため、そのまま公開準備（公開承認）へ進めます。" });
      } else {
        setOutcome({ tone: "error", message: `判定は確定しましたが、自動修正を始められませんでした（${startErrorText(startedBody?.error)}）。` });
      }
      onReload();
    } catch {
      setOutcome({ tone: "error", message: "通信に失敗しました。画面を取り直してから押し直してください。" });
    } finally {
      setBusy(false);
    }
  }

  if (rows.length === 0) {
    return outcome ? <OutcomeNote outcome={outcome} className={className} /> : null;
  }

  return (
    <section
      aria-label="次の操作"
      className={cn("@container flex flex-col gap-3 rounded-[10px] border-[1.5px] border-foreground/70 bg-card p-3.5 text-sm", className)}
      data-testid="release-auto-proceed"
    >
      <div className="flex flex-col gap-3 @2xl:flex-row @2xl:items-start @2xl:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs text-muted-foreground">次の操作</span>
          <h3 className="text-[15px] font-semibold text-balance">
            指摘{rows.length}件の判定をAIの推奨で確定し、自動で修正して公開承認まで進めます
          </h3>
        </div>
        <div className="flex flex-col gap-1 @2xl:items-end">
          <Button
            className="min-h-11 w-full gap-1.5 px-4 text-sm font-bold @2xl:w-fit"
            onClick={() => void proceed()}
            disabled={busy || loadingRecommendations || !target}
            data-testid="release-auto-proceed-start"
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Rocket className="size-4" aria-hidden="true" />}
            おまかせで公開承認まで進める
          </Button>
          <p className="text-xs text-muted-foreground @2xl:text-right">
            {loadingRecommendations
              ? "AIの推奨を取得しています…"
              : counts.fix_now > 0
                ? `今回直す${counts.fix_now}件を修正 → 再検証 → 公開承認の画面で止まります`
                : "判定を確定し、公開承認の画面へ進めます"}
          </p>
          {manualHref && (
            <a href={manualHref} className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
              自分で1件ずつ判断する
            </a>
          )}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-2 @2xl:grid-cols-4" data-testid="release-auto-proceed-tally">
        {(Object.keys(TALLY_LABEL) as ReleaseReviewDecisionKind[]).map((kind) => (
          <div key={kind} className="flex flex-col rounded-md border px-2.5 py-1.5">
            <dt className="order-2 text-xs text-muted-foreground">{TALLY_LABEL[kind]}</dt>
            <dd className="order-1 text-lg font-bold tabular-nums">{counts[kind]}</dd>
          </div>
        ))}
      </dl>

      <ul className="flex flex-col divide-y" aria-label="指摘ごとの判定">
        {rows.map((row) => (
          <DecisionRow
            key={row.findingId}
            row={row}
            choice={choiceOf(row)}
            loading={loadingRecommendations}
            onChange={(kind) => setOverrides((current) => ({ ...current, [row.findingId]: kind }))}
            disabled={busy}
          />
        ))}
      </ul>

      {recommendations.error && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          {recommendations.error}。推奨の無い止める指摘は「今回直す」で確定します。
          <button type="button" className="ml-1 underline underline-offset-2" onClick={recommendations.retry}>
            推奨を取り直す
          </button>
        </p>
      )}
      <p className="text-[11px] text-muted-foreground">
        押すと、この表の判定をあなたの判断として記録します（AIの推奨どおりか、推奨が無かったかも残します）。公開承認はこの操作では行いません。
      </p>
      {outcome && <OutcomeNote outcome={outcome} />}
    </section>
  );
}

function DecisionRow({
  row,
  choice,
  loading,
  onChange,
  disabled,
}: {
  row: BulkDecisionRow;
  choice: ReleaseReviewDecisionKind;
  loading: boolean;
  onChange: (kind: ReleaseReviewDecisionKind) => void;
  disabled: boolean;
}) {
  const id = `release-auto-proceed-${row.findingId}`;
  const reason = row.recommendation?.drafts[choice]?.reason || null;
  return (
    <li className="grid gap-1.5 py-2.5 @2xl:grid-cols-[3rem_minmax(0,1fr)_12rem_minmax(0,38%)] @2xl:items-start @2xl:gap-3" data-testid="release-auto-proceed-row">
      <span className={cn("w-fit rounded px-1.5 text-[11px] font-bold", SEVERITY_TONE[row.severity])}>
        {SEVERITY_LABEL[row.severity]}
        {row.blocking && <span className="@2xl:hidden">・止める</span>}
      </span>
      <span className="min-w-0 break-words text-[13px] font-medium">
        {row.title}
        {row.blocking && (
          <span className="ml-1 hidden rounded border border-destructive px-1 text-[10.5px] font-normal whitespace-nowrap text-destructive @2xl:inline">止める</span>
        )}
      </span>
      <div className="flex flex-col gap-0.5">
        <label htmlFor={id} className="sr-only">
          {row.title}の判定
        </label>
        <select
          id={id}
          value={choice}
          onChange={(event) => onChange(event.target.value as ReleaseReviewDecisionKind)}
          disabled={disabled || row.options.length < 2}
          className="min-h-9 w-full rounded-md border bg-background px-2 text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-80"
        >
          {row.options.map((kind) => (
            <option key={kind} value={kind}>
              {RELEASE_REVIEW_DECISION_LABEL[kind]}
              {row.recommendation?.recommended === kind && row.fallback === null ? "（推奨）" : ""}
            </option>
          ))}
        </select>
        {row.fallback && !loading && <span className="text-[11px] text-amber-700 dark:text-amber-400">AIが判断できなかったため安全側</span>}
      </div>
      <p className="min-w-0 break-words text-xs text-muted-foreground">
        {loading
          ? "AIの推奨を取得しています…"
          : reason
            ? reason
            : row.fallback === "no_recommendation"
              ? "推奨を作れませんでした。「今回直す」で入れています"
              : "推奨の必須項目が揃っていないため、「今回直す」で入れています"}
      </p>
    </li>
  );
}

function OutcomeNote({ outcome, className }: { outcome: Outcome; className?: string }) {
  return (
    <p
      role={outcome.tone === "error" ? "alert" : "status"}
      className={cn("break-words text-xs", outcome.tone === "error" ? "text-destructive" : "text-emerald-700 dark:text-emerald-400", className)}
      data-testid="release-auto-proceed-outcome"
    >
      {outcome.message}
    </p>
  );
}

function startErrorText(error: string | undefined): string {
  switch (error) {
    case "run_active":
      return "このリポジトリでは別のリリース完了系列が進行中です";
    case "release_pr_changed":
      return "リリース候補が更新されています。画面を取り直してください";
    case "not_release_pull_request":
      return "このPRはリリース候補ではありません";
    default:
      return "時間をおいて「修正を自動で続ける」を押してください";
  }
}

/**
 * 検証の結果を自分で取るパネル（スマホのリリースシート）。本番PR詳細は取得済みの結果を渡すので`ReleaseAutoProceedPanel`を使う
 */
export function ConnectedReleaseAutoProceedPanel({ repositoryFullName, pullRequestNumber }: { repositoryFullName: string; pullRequestNumber: number }) {
  const [reloadToken, setReloadToken] = useState(0);
  // 一度押した後は、表が空になっても結果の一文を残す（判断を保存すると出す条件から外れるため）
  const [engaged, setEngaged] = useState(false);
  const { verification } = useReleaseVerification(repositoryFullName, pullRequestNumber, true, reloadToken);
  const { run, setRun } = useReleaseCompletionRun(repositoryFullName, pullRequestNumber);
  if (!verification || run === undefined) return null;
  if (!engaged && !shouldShowAutoProceed(verification, run?.active ?? false)) return null;
  return (
    <ReleaseAutoProceedPanel
      repositoryFullName={repositoryFullName}
      pullRequestNumber={pullRequestNumber}
      verification={verification}
      onRunStarted={setRun}
      onReload={() => {
        setEngaged(true);
        setReloadToken((n) => n + 1);
      }}
    />
  );
}
