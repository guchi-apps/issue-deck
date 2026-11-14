"use client";

import { useEffect, useRef, useState } from "react";
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
import type { CrossRepoIssueDraft } from "@/lib/release-review-cross-repo";
import { describeUnresolvableCause } from "@/lib/release-review-guidance";
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

/**
 * 「次の操作」パネルの出し方（#5369）。新方式の候補では、修正の自動継続の入口をこのパネル1つにまとめ、
 * 旧「修正を自動で続ける」の開始ボタンは出さない。
 *
 * - `table`: 未判断の止める指摘がある。判定表を見せ、一括確定してから系列を始める（#5138）
 * - `start`: 判断済みで「今回直す」指摘が残る、または統合検証が失敗した。表なしで系列を始める
 * - `unresolvable`: 指摘0件で、再評価を終えても全体レビューの要確認だけが残った。直すコードが無く、系列を
 *   始めても同じ理由で止まるため、ボタンを出さずに再実行・判断の欄へ案内する。文言は原因別に出し分け、
 *   他リポジトリが原因なら利用側への確認Issueの下書きを出す（#5378。`describeUnresolvableCause`）
 * - `null`: 出さない（系列が動いている・直すものが無い・全体レビューの実行中や再評価中）
 */
export type AutoProceedMode = "table" | "start" | "unresolvable";

export function decideAutoProceedMode(verification: ReleaseVerificationSummary | null, runActive: boolean): AutoProceedMode | null {
  if (!verification || runActive) return null;
  const review = verification.aiReview;
  const counts = review.decisions?.counts;
  if (review.state === "needs_check" && (counts?.undecidedBlocking ?? 0) > 0) return "table";
  if (verification.integration.state === "failed") return "start";
  if (review.state === "needs_check" && (counts?.fixNow ?? 0) > 0) return "start";
  if (review.state === "needs_check" && review.findings.length === 0 && review.stage?.kind === "needs_check") return "unresolvable";
  return null;
}

/** パネルを出すか。修正の自動継続が動いておらず、出し方が決まるときだけ */
export function shouldShowAutoProceed(verification: ReleaseVerificationSummary | null, runActive: boolean): boolean {
  return decideAutoProceedMode(verification, runActive) !== null;
}

/** 予約を押した時点の対象。推奨が届いた後に、同じ対象・同じ指摘の表かを確かめるために控える（#5229） */
export type ArmedTarget = { baseSha: string; headSha: string; findingIds: string };

export type ArmedDecision =
  | { action: "wait" }
  | { action: "fire" }
  | { action: "cancel"; reason: "target_changed" | "error" | "fallback" };

/**
 * 予約中のパネルが、いま何をするか（#5229）。**「推奨が届いた」ではなく、取得が完了し、今の表が予約時の対象と一致し、
 * フォールバック（推奨なし・必須項目不足）が0件のときだけ`fire`する。** 再取得中は前回の結果が残るため`loading`も見る。
 * 1件でもフォールバックがあれば、人が表を見ないまま「あなたの判断」として記録しないよう予約を解除する。
 */
export function decideArmedAction(input: {
  armed: ArmedTarget;
  target: { baseSha: string; headSha: string } | null;
  findingIds: string;
  loading: boolean;
  error: string | null;
  hasView: boolean;
  fallbackCount: number;
}): ArmedDecision {
  const { armed, target } = input;
  if (!target || target.baseSha !== armed.baseSha || target.headSha !== armed.headSha || input.findingIds !== armed.findingIds) {
    return { action: "cancel", reason: "target_changed" };
  }
  if (input.loading) return { action: "wait" };
  if (input.error) return { action: "cancel", reason: "error" };
  if (!input.hasView) return { action: "wait" };
  if (input.fallbackCount > 0) return { action: "cancel", reason: "fallback" };
  return { action: "fire" };
}

const ARMED_CANCEL_MESSAGE = {
  target_changed: "リリース候補か指摘が更新されたため、予約を解除しました。表を確かめて押し直してください。",
  error: "AIの推奨を取得できなかったため、予約を解除しました。推奨を取り直すか、表を確かめて押し直してください。",
  fallback: "推奨が無い指摘があるため、自動では進めず予約を解除しました。表の判定を確かめてから押してください。",
} as const;

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
  // 指摘ごとの取得失敗の理由（#5268）。表に「推奨を作れませんでした」だけを出すと、原因も取り直し方も分からなかった
  const failures = recommendations.view?.failures ?? {};
  const missingRecommendations = !loadingRecommendations && !recommendations.error && rows.some((row) => row.fallback === "no_recommendation");
  // 予約（#5229）。画面の中だけの状態で、閉じる・再読込すると消える
  const [armed, setArmed] = useState<ArmedTarget | null>(null);
  // 自動実行は1回だけ。再描画・再取得で`proceed()`が2回走らないようにする
  const firedRef = useRef(false);
  const findingIdsKey = rows.map((row) => row.findingId).join(",");

  async function proceed() {
    if (!target) return;
    const withTable = rows.length > 0;
    setBusy(true);
    setOutcome(null);
    const [owner, repo] = repositoryFullName.split("/");
    try {
      if (withTable) {
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
      }
      const started = await fetch("/api/repositories/release/completion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, repo, pullRequestNumber, scope: RELEASE_COMPLETION_SCOPE_READY, baseSha: target.baseSha, headSha: target.headSha }),
      });
      const startedBody = (await started.json().catch(() => null)) as { run?: ReleaseCompletionRunView; error?: string } | null;
      if (startedBody?.run) onRunStarted?.(startedBody.run);
      const decided = withTable ? "判定を確定し、" : "";
      if (started.ok) {
        setOutcome({ tone: "ok", message: `${decided}自動で修正を始めました。チェックがすべて通ると公開承認の画面で止まります。` });
      } else if (startedBody?.error === "nothing_to_recover") {
        // 全件を修正しない判断にした・ほかに失敗が無い。直すものが無いので、そのまま公開準備へ進める
        setOutcome({
          tone: "ok",
          message: withTable ? "判定を確定しました。直す指摘は無いため、そのまま公開準備（公開承認）へ進めます。" : "直すものは見つかりませんでした。画面を取り直して状態を確かめてください。",
        });
      } else {
        setOutcome({
          tone: "error",
          message: withTable
            ? `判定は確定しましたが、自動修正を始められませんでした（${startErrorText(startedBody?.error)}）。`
            : `自動修正を始められませんでした（${startErrorText(startedBody?.error)}）。`,
        });
      }
      onReload();
    } catch {
      setOutcome({ tone: "error", message: "通信に失敗しました。画面を取り直してから押し直してください。" });
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!armed || firedRef.current || busy) return;
    const decision = decideArmedAction({
      armed,
      target: target ?? null,
      findingIds: findingIdsKey,
      loading: recommendations.loading,
      error: recommendations.error,
      hasView: recommendations.view !== null,
      fallbackCount: rows.filter((row) => row.fallback !== null).length,
    });
    if (decision.action === "wait") return;
    // 予約の解除と結果表示は、推奨の取得結果（外部の非同期状態）に反応して行う
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setArmed(null);
    if (decision.action === "cancel") {
      setOutcome({ tone: "error", message: ARMED_CANCEL_MESSAGE[decision.reason] });
      return;
    }
    firedRef.current = true;
    void proceed();
    // proceedは今の描画の表と判定を読む。予約中は判定をロックしているので、発火条件の判定時点と同じ内容
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed, busy, recommendations.loading, recommendations.error, recommendations.view, findingIdsKey, target]);

  function onStartClick() {
    if (!target || busy || armed) return;
    if (!loadingRecommendations) {
      void proceed();
      return;
    }
    // 推奨の取得中は予約する。届いたら自動で始める
    firedRef.current = false;
    setOutcome(null);
    setArmed({ baseSha: target.baseSha, headSha: target.headSha, findingIds: findingIdsKey });
  }

  const mode = decideAutoProceedMode(verification, false);
  if (mode === "unresolvable") {
    // 原因別に出し分ける（#5378）。他リポジトリが原因なら、利用側への確認Issueの下書きを出す
    const cause = describeUnresolvableCause(verification, { repositoryFullName, pullRequestNumber });
    return (
      <section
        aria-label="次の操作"
        className={cn("flex flex-col gap-1.5 rounded-[10px] border-[1.5px] border-amber-600/70 bg-amber-500/5 p-3.5 text-sm", className)}
        data-testid="release-auto-proceed-unresolvable"
        data-cause={cause.kind}
      >
        <span className="text-xs text-muted-foreground">次の操作</span>
        <h3 className="text-[15px] font-semibold text-balance">{cause.title}</h3>
        <p className="break-words text-xs text-muted-foreground">{cause.description}</p>
        {cause.drafts.length > 0 && (
          <ul className="flex flex-col gap-2" aria-label="利用側リポジトリへの確認Issueの下書き">
            {cause.drafts.map((draft) => (
              <CrossRepoDraftItem key={draft.repository} draft={draft} />
            ))}
          </ul>
        )}
        {manualHref && (
          <Button asChild variant={cause.drafts.length > 0 ? "outline" : "default"} className="min-h-11 w-full gap-1.5 px-4 text-sm font-bold sm:w-fit">
            <a href={manualHref} data-testid="release-auto-proceed-unresolvable-link">
              {cause.kind === "cross_repo" ? "下の「現在候補の検証」で判断メモを残す ↓" : "下の「現在候補の検証」で再実行・判断する ↓"}
            </a>
          </Button>
        )}
      </section>
    );
  }
  if (mode === null || (mode === "table" && rows.length === 0)) {
    return outcome ? <OutcomeNote outcome={outcome} className={className} /> : null;
  }
  if (mode === "start") {
    return (
      <section
        aria-label="次の操作"
        className={cn("@container flex flex-col gap-1.5 rounded-[10px] border-[1.5px] border-foreground/70 bg-card p-3.5 text-sm", className)}
        data-testid="release-auto-proceed"
      >
        <span className="text-xs text-muted-foreground">次の操作</span>
        <h3 className="text-[15px] font-semibold text-balance">
          {verification.integration.state === "failed" ? "統合検証の失敗を自動で修正し、公開承認まで進めます" : "「今回直す」指摘を自動で修正し、公開承認まで進めます"}
        </h3>
        <Button
          className="min-h-11 w-full gap-1.5 px-4 text-sm font-bold sm:w-fit"
          onClick={() => void proceed()}
          disabled={busy || !target}
          data-testid="release-auto-proceed-start"
        >
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Rocket className="size-4" aria-hidden="true" />}
          おまかせで公開承認まで進める
        </Button>
        <p className="text-xs text-muted-foreground">
          修正Issueの作成から修正・取り込み・再検証までを、チェックがすべて通るまで自動で繰り返します。公開承認はあなたが押します。
        </p>
        {outcome && <OutcomeNote outcome={outcome} />}
      </section>
    );
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
            variant={armed ? "outline" : "default"}
            onClick={onStartClick}
            disabled={busy || armed !== null || !target}
            data-testid="release-auto-proceed-start"
          >
            {busy || armed ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Rocket className="size-4" aria-hidden="true" />}
            {armed ? "予約中：推奨が届いたら自動で進めます" : "おまかせで公開承認まで進める"}
          </Button>
          {armed && (
            <Button variant="ghost" size="sm" onClick={() => setArmed(null)} data-testid="release-auto-proceed-cancel">
              予約を取り消す
            </Button>
          )}
          <p className="text-xs text-muted-foreground @2xl:text-right">
            {armed
              ? "推奨が届き次第、表の判定を確定して修正を始めます。この画面を閉じると予約は消えます"
              : loadingRecommendations
              ? "AIの推奨を取得しています…押しておくと、推奨が届いたら自動で始めます"
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

      <ul className="flex flex-col divide-y" aria-label="指摘ごとの判定">
        {rows.map((row) => (
          <DecisionRow
            key={row.findingId}
            row={row}
            choice={choiceOf(row)}
            loading={loadingRecommendations}
            failure={failures[row.findingId] ?? null}
            onChange={(kind) => setOverrides((current) => ({ ...current, [row.findingId]: kind }))}
            disabled={busy || armed !== null}
          />
        ))}
      </ul>

      {recommendations.error && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          {recommendations.error}。表を確かめて押すと、推奨の無い指摘は「今回直す」で確定します。
          <button type="button" className="ml-1 underline underline-offset-2" onClick={recommendations.retry}>
            推奨を取り直す
          </button>
        </p>
      )}
      {missingRecommendations && (
        <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="release-auto-proceed-missing">
          AIの推奨を作れなかった指摘があります。
          <button
            type="button"
            className="ml-1 underline underline-offset-2"
            onClick={recommendations.retry}
            disabled={recommendations.loading || busy || armed !== null}
          >
            推奨を取り直す
          </button>
        </p>
      )}
      <p className="text-[11px] text-muted-foreground">押すと、表の判定をあなたの判断として記録します（公開承認はしません）。</p>
      {outcome && <OutcomeNote outcome={outcome} />}
    </section>
  );
}

function DecisionRow({
  row,
  choice,
  loading,
  failure,
  onChange,
  disabled,
}: {
  row: BulkDecisionRow;
  choice: ReleaseReviewDecisionKind;
  loading: boolean;
  /** 推奨を作れなかった理由（サーバーが指摘ごとに返したもの） */
  failure: string | null;
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
              ? `推奨を作れませんでした${failure ? `（${failure}）` : ""}。「今回直す」で入れています`
              : "推奨の必須項目が揃っていないため、「今回直す」で入れています"}
      </p>
    </li>
  );
}

function CrossRepoDraftItem({ draft }: { draft: CrossRepoIssueDraft }) {
  return (
    <li className="flex flex-col gap-1.5 rounded-md border bg-card p-2.5" data-testid="release-auto-proceed-cross-repo-draft">
      <span className="break-all text-xs font-semibold">{draft.repository}</span>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">下書きを見る: {draft.title}</summary>
        <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 text-[11px]">{draft.body}</pre>
      </details>
      <div className="flex flex-col gap-1.5 sm:flex-row">
        <Button asChild variant="outline" size="sm" className="min-h-9">
          <a href={draft.searchUrl} target="_blank" rel="noreferrer">
            既存のIssueを探す
          </a>
        </Button>
        <Button asChild size="sm" className="min-h-9">
          <a href={draft.newIssueUrl} target="_blank" rel="noreferrer" data-testid="release-auto-proceed-cross-repo-create">
            下書きでIssueを起こす（GitHub）
          </a>
        </Button>
      </div>
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
      return "時間をおいて「おまかせで公開承認まで進める」を押してください";
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
