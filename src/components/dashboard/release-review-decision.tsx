"use client";

import { useCallback, useEffect, useState } from "react";

import { toJstParts } from "@/lib/format-date-time";
import {
  RELEASE_REVIEW_DECISION_HINT,
  RELEASE_REVIEW_DECISION_KINDS,
  RELEASE_REVIEW_DECISION_LABEL,
  type FindingDecisionView,
  type ReleaseReviewDecisionAction,
  type ReleaseReviewDecisionKind,
  type ReleaseReviewDecisionRecord,
  type ReleaseReviewDecisionSummary,
} from "@/lib/release-review-decision";
import { prepareFixReason } from "@/lib/release-review-guidance";
import {
  REASON_SOURCE_LABEL,
  describeAdoption,
  draftToDecisionInput,
  oneTapBlocker,
  type ReleaseReviewRecommendation,
  type ReleaseReviewRecommendationsView,
} from "@/lib/release-review-recommendation";
import type { ReleaseReviewFinding } from "@/lib/release-review-result";
import { cn } from "@/lib/utils";

/**
 * 全体レビューの指摘ごとのユーザー判断（#4657）。PC・スマホ・本番マージ確認で共通の`release-review-sections.tsx`から使う。
 * **AIの原判定（重大度・止める理由・根拠）とユーザー判断は別の枠に出し、判断で原判定を書き換えて見せない。**
 *
 * AIの推奨（#4676）は第3の枠（藍色）に「未確定」として出す。推奨を表示しただけでは何も保存せず、
 * 「推奨どおり確定」か、判断を選んで「判断を保存」を押したときだけ判断APIへ送る。
 */

type Target = { baseSha: string; headSha: string };

const DECISION_TONE: Record<ReleaseReviewDecisionAction, string> = {
  fix_now: "border-sky-300 bg-sky-50/60 dark:border-sky-800 dark:bg-sky-950/20",
  post_release: "border-violet-300 bg-violet-50/60 dark:border-violet-800 dark:bg-violet-950/20",
  defer: "border-zinc-300 bg-zinc-50/60 dark:border-zinc-700 dark:bg-zinc-900/30",
  reject: "border-zinc-300 bg-zinc-50/60 dark:border-zinc-700 dark:bg-zinc-900/30",
  withdrawn: "border-zinc-300",
};

const ADOPTION_TONE = {
  adopted: "border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-400",
  edited: "border-sky-300 text-sky-700 dark:border-sky-800 dark:text-sky-400",
  differs: "border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-400",
} as const;

const AI_TAG = "rounded border border-indigo-300 px-1 text-[10px] text-indigo-700 dark:border-indigo-700 dark:text-indigo-300";

function when(iso: string): string {
  const p = toJstParts(iso);
  return p ? `${p.month}/${p.day} ${p.hour}:${String(p.minute).padStart(2, "0")}` : iso;
}

function followUpText(record: Pick<ReleaseReviewDecisionRecord, "followUp">): string | null {
  return record.followUp ? `${record.followUp.repo}#${record.followUp.number}` : null;
}

/** 判断の集計と次の操作。止める指摘・改善提案の一覧より前に置く */
export function ReviewDecisionSummaryPanel({ decisions }: { decisions: ReleaseReviewDecisionSummary }) {
  const c = decisions.counts;
  const tone =
    c.undecidedBlocking > 0 || c.stale > 0
      ? "border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/20"
      : decisions.cleared
        ? "border-emerald-300 bg-emerald-50/60 dark:border-emerald-800 dark:bg-emerald-950/20"
        : "border-border";
  return (
    <div className={cn("flex flex-col gap-1 rounded border px-2 py-1.5 text-[11.5px]", tone)} data-testid="review-decision-summary">
      <p className="font-medium">ユーザー判断</p>
      <dl className="grid grid-cols-[8rem_1fr] gap-x-2 gap-y-0.5">
        <dt className="text-muted-foreground">未判断の止める指摘</dt>
        <dd>{c.undecidedBlocking}件{c.stale > 0 && `（うち前提が変わった判断 ${c.stale}件）`}</dd>
        <dt className="text-muted-foreground">公開前に残る確認</dt>
        <dd>今回直す {c.fixNow}件</dd>
        <dt className="text-muted-foreground">公開後作業</dt>
        <dd>
          {decisions.postReleaseWork.length === 0
            ? "なし"
            : decisions.postReleaseWork.map((w) => (
                <span key={w.findingId} className="block">
                  <code>{w.findingId}</code> {w.title}
                  {w.followUp && `（${w.followUp.repo}#${w.followUp.number}）`}
                  {w.timing && ` · 時期: ${w.timing}`}
                  <span className="text-muted-foreground"> · 未実施（公開後に確認します）</span>
                </span>
              ))}
        </dd>
        <dt className="text-muted-foreground">見送り・不採用</dt>
        <dd>
          見送り {c.deferred}件・不採用 {c.rejected}件
        </dd>
        <dt className="text-muted-foreground">次の操作</dt>
        <dd>{decisions.next}</dd>
      </dl>
      {decisions.detached.length > 0 && (
        <div className="text-amber-700 dark:text-amber-400" data-testid="review-decision-detached">
          <p>
            判断が外れた可能性があります（今回の結果に同じIDの指摘がありません。解消された、またはAIが言い換えて別IDになった可能性があります）:
          </p>
          <ul className="list-disc pl-4">
            {decisions.detached.map((d) => (
              <li key={d.findingId}>
                <code>{d.findingId}</code> {d.current?.findingTitle}（{d.current ? RELEASE_REVIEW_DECISION_LABEL[d.current.decision] : ""}）
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-[10.5px] text-muted-foreground">
        判断はAIの判定を書き換えません。AIの推奨は確定するまで保存しません。判断の保存だけでは本番へマージせず、必須の検証（統合検証・CI・iOS検証）の未完了や失敗も解除しません。
      </p>
    </div>
  );
}

export type RecommendationsState = {
  loading: boolean;
  view: ReleaseReviewRecommendationsView | null;
  /** 一覧の取得そのものの失敗（指摘ごとの失敗は`view.failures`） */
  error: string | null;
  retry: () => void;
};

/**
 * 未判断（と前提が変わった判断）の指摘についてAIの推奨をまとめて取得する（#4676）。サーバーは対象ごとに
 * 保存済みの推奨を返し、無い指摘だけAIに作らせる。判断を保存して対象の指摘が減っても、残りは保存済みを返すだけ
 */
export function useReleaseReviewRecommendations(input: {
  repositoryFullName: string;
  pullRequestNumber: number | undefined;
  target: Target | null | undefined;
  decisions: ReleaseReviewDecisionSummary | null;
  findingIds: readonly string[];
}): RecommendationsState {
  const { repositoryFullName, pullRequestNumber, target, decisions } = input;
  const pending = input.findingIds.filter((id) => {
    const view = decisions?.byFinding[id];
    return !view?.current || Boolean(view.stale);
  });
  const key = decisions && target && pullRequestNumber !== undefined && pending.length > 0
    ? `${repositoryFullName}#${pullRequestNumber}:${target.baseSha}:${target.headSha}:${pending.join(",")}`
    : null;
  const [retryTick, setRetryTick] = useState(0);
  // 応答が届いた要求（対象＋再取得の回数）。今の要求と違う間は取得中として扱う
  const [state, setState] = useState<{ key: string | null; request: string | null; view: ReleaseReviewRecommendationsView | null; error: string | null }>({
    key: null,
    request: null,
    view: null,
    error: null,
  });
  const request = key ? `${key}:${retryTick}` : null;

  useEffect(() => {
    if (!key || !request || !target || pullRequestNumber === undefined) return;
    let cancelled = false;
    const [owner, repo] = repositoryFullName.split("/");
    fetch("/api/repositories/release/review-recommendations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner, repo, pullRequestNumber, baseSha: target.baseSha, headSha: target.headSha, retry: retryTick > 0 }),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          const message =
            res.status === 403
              ? "この環境ではAIの推奨を取得できません"
              : res.status === 409
                ? (body.message ?? "リリース候補が更新されました。画面を更新してください")
                : (body.message ?? `AIの推奨を取得できませんでした (${res.status})`);
          setState({ key, request, view: null, error: message });
          return;
        }
        setState({ key, request, view: body as ReleaseReviewRecommendationsView, error: null });
      })
      .catch(() => {
        if (!cancelled) setState({ key, request, view: null, error: "AIの推奨を取得できませんでした（通信に失敗しました）" });
      });
    return () => {
      cancelled = true;
    };
    // requestに対象・SHA・再取得の回数を含めている
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const retry = useCallback(() => setRetryTick((n) => n + 1), []);
  const sameTarget = key !== null && state.key === key;
  return {
    loading: key !== null && state.request !== request,
    // 再取得中も、同じ対象の前回の結果は出したままにする
    view: sameTarget ? state.view : null,
    error: sameTarget && state.request === request ? state.error : null,
    retry,
  };
}

type PostResult = { ok: true; note: string | null } | { ok: false; message: string };

/** 判断APIへ1件送る。画面のメッセージまでをここで作る（ワンタップとフォームで共有） */
async function postDecision(input: {
  repositoryFullName: string;
  pullRequestNumber: number;
  target: Target;
  findingId: string;
  expectedDecisionId: string | null;
  recommendationId: string | null;
  decision: ReleaseReviewDecisionAction;
  reason: string;
  impact: string | null;
  scope: string | null;
  timing: string | null;
  followUp: { kind: "existing"; number: number } | { kind: "create"; title: string } | null;
}): Promise<PostResult> {
  try {
    const [owner, repo] = input.repositoryFullName.split("/");
    const res = await fetch("/api/repositories/release/review-decisions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        owner,
        repo,
        pullRequestNumber: input.pullRequestNumber,
        baseSha: input.target.baseSha,
        headSha: input.target.headSha,
        findingId: input.findingId,
        expectedDecisionId: input.expectedDecisionId,
        recommendationId: input.recommendationId,
        decision: input.decision,
        reason: input.reason,
        impact: input.impact,
        scope: input.scope,
        timing: input.timing,
        followUp: input.followUp,
      }),
    });
    const body: { error?: string; message?: string; activeFixSeries?: number } = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) return { ok: false, message: "判断を保存する権限がありません。ログインし直してください。" };
    if (res.status === 409) return { ok: false, message: `${body.message ?? "対象が更新されました。"}「更新」で最新の状態を読み込んでください。` };
    if (!res.ok) return { ok: false, message: body.message ?? `判断を保存できませんでした (${res.status})。` };
    return {
      ok: true,
      note:
        body.activeFixSeries && body.activeFixSeries > 0 && input.decision !== "fix_now"
          ? "判断を保存しました。稼働中の修正系列があります。以降の追加修正・候補の更新はこの判断に従いますが、実行中のセッションと、developへ取り込み済みの修正PRはそのまま残ります（不要なら修正Issueを閉じてください）。"
          : null,
    };
  } catch {
    return { ok: false, message: "判断を保存できませんでした（通信に失敗しました）。" };
  }
}

/** 指摘1件ぶんの判断の表示と、判断の入力 */
export function FindingDecisionControl({
  repositoryFullName,
  pullRequestNumber,
  target,
  findingId,
  finding,
  blocking = true,
  view,
  onSaved,
  recommendation = null,
  recommendationFailure = null,
  recommendationLoading = false,
  onRetryRecommendation,
}: {
  repositoryFullName: string;
  pullRequestNumber: number;
  target: Target;
  findingId: string;
  finding?: ReleaseReviewFinding;
  blocking?: boolean;
  view: FindingDecisionView | undefined;
  onSaved?: () => void;
  /** 今の対象に対するAIの推奨（#4676）。未判断・前提が変わった判断のときだけ表示する */
  recommendation?: ReleaseReviewRecommendation | null;
  recommendationFailure?: string | null;
  recommendationLoading?: boolean;
  onRetryRecommendation?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [quickBusy, setQuickBusy] = useState(false);
  const [quickMessage, setQuickMessage] = useState<string | null>(null);
  const current = view?.current ?? null;
  const latestId = view?.history.at(-1)?.id ?? null;
  const needsDecision = !current || Boolean(view?.stale);
  // 古い対象の推奨は使わない（サーバーも確定時に拒否する）
  const rec =
    needsDecision && recommendation && recommendation.baseSha === target.baseSha && recommendation.headSha === target.headSha
      ? recommendation
      : null;
  const adoption = current
    ? describeAdoption({
        decision: current.decision,
        recommendedDecision: current.recommendation?.decision ?? null,
        reasonSource: current.reasonSource ?? null,
      })
    : null;

  const confirmRecommendation = async () => {
    if (!rec || quickBusy) return;
    setQuickBusy(true);
    setQuickMessage(null);
    const result = await postDecision({
      repositoryFullName,
      pullRequestNumber,
      target,
      findingId,
      expectedDecisionId: latestId,
      recommendationId: rec.id,
      ...draftToDecisionInput(rec.recommended, rec.drafts[rec.recommended]),
    });
    setQuickBusy(false);
    if (!result.ok) {
      setQuickMessage(result.message);
      return;
    }
    setNote(result.note);
    onSaved?.();
  };

  return (
    <div className="mt-1 flex flex-col gap-1" data-testid="finding-decision">
      {current ? (
        <div className={cn("rounded border px-2 py-1", DECISION_TONE[current.decision])}>
          <p className="flex flex-wrap items-center gap-x-2">
            <span className="font-medium">ユーザー判断: {RELEASE_REVIEW_DECISION_LABEL[current.decision]}</span>
            {adoption && (
              <span className={cn("rounded border px-1 text-[10.5px]", ADOPTION_TONE[adoption.tone])} data-testid="decision-adoption">
                {adoption.label}
              </span>
            )}
            <span className="text-[11px] text-muted-foreground">
              {current.decidedBy} · {when(current.decidedAt)} · PR #{current.prNumber}
            </span>
          </p>
          <p className="whitespace-pre-wrap">
            理由: {current.reason}
            {current.reasonSource && <span className="ml-1 text-[10.5px] text-muted-foreground">（{REASON_SOURCE_LABEL[current.reasonSource]}）</span>}
          </p>
          {current.impact && <p className="whitespace-pre-wrap">残る影響: {current.impact}</p>}
          {current.scope && <p className="whitespace-pre-wrap">対象範囲: {current.scope}</p>}
          {current.decision === "post_release" && (
            <p>
              公開後作業: {followUpText(current) ?? "Issue未指定"}
              {current.timing && ` · 時期: ${current.timing}`}
              <span className="text-muted-foreground">（未実施。配布・適用済みとは扱いません）</span>
            </p>
          )}
          {current.recommendation && adoption?.tone !== "adopted" && (
            <p className="whitespace-pre-wrap text-[11px] text-muted-foreground">
              判断時のAI推奨: {RELEASE_REVIEW_DECISION_LABEL[current.recommendation.decision]} — {current.recommendation.reason}
            </p>
          )}
          {view?.stale && <p className="font-medium text-amber-700 dark:text-amber-400">再確認が必要: {view.stale}</p>}
        </div>
      ) : (
        <p className={blocking ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}>{blocking ? "ユーザー判断: 未判断" : "対応は任意です（公開を止めない改善提案）"}</p>
      )}
      {view && view.history.length > 1 && (
        <details>
          <summary className="cursor-pointer text-[11px] text-muted-foreground">判断の履歴（{view.history.length}件）</summary>
          <ol className="mt-0.5 flex flex-col gap-0.5 text-[11px]">
            {view.history.map((h) => (
              <li key={h.id}>
                {when(h.decidedAt)} {h.decidedBy}: {RELEASE_REVIEW_DECISION_LABEL[h.decision]} — {h.reason}
                {h.recommendation && (
                  <span className="text-muted-foreground">
                    （AI推奨: {RELEASE_REVIEW_DECISION_LABEL[h.recommendation.decision]}
                    {h.reasonSource && `・${REASON_SOURCE_LABEL[h.reasonSource]}`}）
                  </span>
                )}
              </li>
            ))}
          </ol>
        </details>
      )}
      {needsDecision && !editing && (
        <RecommendationCard
          rec={rec}
          stale={Boolean(current && view?.stale)}
          loading={recommendationLoading}
          failure={rec ? null : recommendationFailure}
          busy={quickBusy}
          onConfirm={confirmRecommendation}
          onChooseOther={() => setEditing(true)}
          onRetry={onRetryRecommendation}
        />
      )}
      {quickMessage && (
        <p className="text-[11.5px] text-red-600" role="alert">
          {quickMessage}
        </p>
      )}
      {editing ? (
        <DecisionForm
          key={`${target.baseSha}:${target.headSha}:${findingId}:${latestId}`}
          preparedReason={prepareFixReason(finding, blocking)}
          recommendation={rec}
          repositoryFullName={repositoryFullName}
          pullRequestNumber={pullRequestNumber}
          target={target}
          findingId={findingId}
          expectedDecisionId={latestId}
          canWithdraw={current !== null}
          initial={current?.decision ?? null}
          onCancel={() => setEditing(false)}
          onSaved={(saved) => {
            setEditing(false);
            setNote(saved);
            onSaved?.();
          }}
        />
      ) : (
        !rec && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="inline-flex min-h-11 items-center self-start rounded border px-4 text-[13px] font-medium hover:bg-muted max-sm:w-full max-sm:justify-center"
          >
            {current ? "判断を変更・撤回" : blocking ? "対応案を確認して判断" : "対応を記録する（任意）"}
          </button>
        )
      )}
      {note && <p className="text-[11.5px] text-sky-700 dark:text-sky-400">{note}</p>}
    </div>
  );
}

/** AIの推奨（未確定）の枠。推奨・理由案・根拠・判断材料の不足と、確定／別の判断の操作 */
function RecommendationCard({
  rec,
  stale,
  loading,
  failure,
  busy,
  onConfirm,
  onChooseOther,
  onRetry,
}: {
  rec: ReleaseReviewRecommendation | null;
  stale: boolean;
  loading: boolean;
  failure: string | null;
  busy: boolean;
  onConfirm: () => void;
  onChooseOther: () => void;
  onRetry?: () => void;
}) {
  if (!rec) {
    if (loading) {
      return <p className="text-[11.5px] text-muted-foreground" data-testid="recommendation-loading">AIの推奨を作成しています…（待たずに手動で判断することもできます）</p>;
    }
    if (!failure) return null;
    return (
      <div className="flex flex-wrap items-center gap-2 rounded border px-2 py-1 text-[11.5px] text-muted-foreground" data-testid="recommendation-failure">
        <span>AIの推奨を取得できませんでした（{failure}）。判断と理由は手動で保存できます。</span>
        {onRetry && (
          <button type="button" onClick={onRetry} className="inline-flex min-h-11 items-center rounded border px-4 text-[13px] font-medium hover:bg-muted max-sm:w-full max-sm:justify-center">
            推奨を再取得
          </button>
        )}
      </div>
    );
  }
  const draft = rec.drafts[rec.recommended];
  const blocker = oneTapBlocker(rec);
  return (
    <div
      className="flex flex-col gap-1 rounded border border-indigo-300 bg-indigo-50/60 px-2 py-1.5 dark:border-indigo-800 dark:bg-indigo-950/20"
      data-testid="finding-recommendation"
    >
      <p className="flex flex-wrap items-center gap-x-2">
        <span className="text-[10.5px] font-semibold text-muted-foreground">AIの推奨（未確定）</span>
        <span className="font-semibold text-indigo-700 dark:text-indigo-300">{RELEASE_REVIEW_DECISION_LABEL[rec.recommended]}</span>
      </p>
      {stale && <p className="text-[11px] text-amber-700 dark:text-amber-400">前提が変わったため新しい推奨を出しました。今の判断は、確定するまで変わりません。</p>}
      <p className="whitespace-pre-wrap">理由案: {draft.reason}</p>
      <p className="whitespace-pre-wrap text-[11px] text-muted-foreground">推奨の根拠: {rec.rationale}</p>
      {rec.recommended === "defer" && (
        <p className="whitespace-pre-wrap text-[11.5px]">
          残る影響: {draft.impact ?? "（未提示）"} · 対象範囲: {draft.scope ?? "（未提示）"}
        </p>
      )}
      {rec.recommended === "post_release" && (
        <p className="whitespace-pre-wrap text-[11.5px]">
          公開後作業: {draft.followUpTitle ? `新しいIssue「${draft.followUpTitle}」を作成` : "（追跡するIssueの案なし）"} · 時期（AIの提案・期日は未定）: {draft.timing ?? "（未提示）"}
        </p>
      )}
      {rec.missing.length > 0 && (
        <div className="rounded border border-dashed border-amber-300 px-1.5 py-0.5 text-[11px] text-amber-700 dark:border-amber-800 dark:text-amber-400" data-testid="recommendation-missing">
          判断材料の不足（確認できていない事項）:
          <ul className="list-disc pl-4">
            {rec.missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {!blocker && (
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="min-h-11 rounded bg-foreground px-4 py-1 text-[13px] font-medium text-background disabled:opacity-50 max-sm:w-full"
          >
            {busy ? "保存中…" : `推奨どおり「${RELEASE_REVIEW_DECISION_LABEL[rec.recommended]}」で確定${rec.recommended === "post_release" ? "（Issueを作成）" : ""}`}
          </button>
        )}
        <button type="button" onClick={onChooseOther} disabled={busy} className="min-h-11 rounded border px-4 py-1 text-[13px] font-medium hover:bg-muted max-sm:w-full">
          別の判断を選ぶ
        </button>
      </div>
      <p className="text-[10.5px] text-muted-foreground">
        {blocker ?? "確定すると、この理由で判断を保存します。"}保存しても本番へはマージしません。
      </p>
    </div>
  );
}

function DecisionForm({
  preparedReason,
  recommendation,
  repositoryFullName,
  pullRequestNumber,
  target,
  findingId,
  expectedDecisionId,
  canWithdraw,
  initial,
  onCancel,
  onSaved,
}: {
  repositoryFullName: string;
  pullRequestNumber: number;
  target: Target;
  findingId: string;
  expectedDecisionId: string | null;
  canWithdraw: boolean;
  preparedReason: string | null;
  recommendation: ReleaseReviewRecommendation | null;
  initial: ReleaseReviewDecisionKind | "withdrawn" | null;
  onCancel: () => void;
  onSaved: (note: string | null) => void;
}) {
  // 開いた時点の推奨に固定する（入力中に推奨が届いて、入力が置き換わらないように）
  const [rec] = useState(recommendation);
  const draftReason = (kind: ReleaseReviewDecisionAction | null): string | null =>
    kind && kind !== "withdrawn" && rec?.drafts[kind].reason ? rec.drafts[kind].reason : null;
  const defaultReason = (kind: ReleaseReviewDecisionAction | null): string =>
    draftReason(kind) ?? (kind === "fix_now" ? preparedReason ?? "" : "");
  const initialKind: ReleaseReviewDecisionAction | null =
    initial === "withdrawn" ? null : initial ?? rec?.recommended ?? (preparedReason ? "fix_now" : null);
  const [decision, setDecision] = useState<ReleaseReviewDecisionAction | null>(initialKind);
  const [reason, setReason] = useState(() =>
    rec ? defaultReason(initialKind) : (!initial || initial === "fix_now") ? preparedReason ?? "" : "",
  );
  const [reasonDrafts, setReasonDrafts] = useState<Partial<Record<ReleaseReviewDecisionAction, string>>>({});
  const choose = (next: ReleaseReviewDecisionAction) => {
    if (decision) setReasonDrafts((drafts) => ({ ...drafts, [decision]: reason }));
    setDecision(next);
    setReason(reasonDrafts[next] ?? defaultReason(next));
  };
  const [impact, setImpact] = useState(rec?.drafts.defer.impact ?? "");
  const [scope, setScope] = useState(rec?.drafts.defer.scope ?? "");
  const [timing, setTiming] = useState(rec?.drafts.post_release.timing ?? "");
  const [followUpKind, setFollowUpKind] = useState<"existing" | "create">(rec?.drafts.post_release.followUpTitle ? "create" : "existing");
  const [followUpNumber, setFollowUpNumber] = useState("");
  const [followUpTitle, setFollowUpTitle] = useState(rec?.drafts.post_release.followUpTitle ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const aiReason = draftReason(decision);

  const restoreDraft = () => {
    if (!rec || !decision || decision === "withdrawn") return;
    const d = rec.drafts[decision];
    setReason(d.reason);
    if (decision === "defer") {
      setImpact(d.impact ?? "");
      setScope(d.scope ?? "");
    }
    if (decision === "post_release") {
      setTiming(d.timing ?? "");
      if (d.followUpTitle) {
        setFollowUpKind("create");
        setFollowUpTitle(d.followUpTitle);
      }
    }
  };

  const submit = async () => {
    if (busy || !decision) return;
    setBusy(true);
    setMessage(null);
    const result = await postDecision({
      repositoryFullName,
      pullRequestNumber,
      target,
      findingId,
      expectedDecisionId,
      recommendationId: rec?.id ?? null,
      decision,
      reason,
      impact,
      scope,
      timing,
      followUp:
        decision !== "post_release"
          ? null
          : followUpKind === "existing"
            ? { kind: "existing", number: Number(followUpNumber.replace(/^#/, "")) }
            : { kind: "create", title: followUpTitle },
    });
    setBusy(false);
    if (result.ok) onSaved(result.note);
    else setMessage(result.message);
  };

  const field = "w-full rounded border bg-background px-1.5 py-1 text-[12px]";
  return (
    <div className="flex flex-col gap-1.5 rounded border px-2 py-1.5" data-testid="finding-decision-form">
      {rec ? (
        <p className="text-xs text-muted-foreground">判断を選ぶと、その判断用のAIの理由案が入ります。編集・補足してから保存してください。選び直しただけでは保存しません。</p>
      ) : (
        preparedReason && <p className="text-xs text-muted-foreground">AIレビューに記録された影響・根拠から「今回直す」の理由を用意しました。内容を確認し、そのまま保存するか編集してください。採否の確定はあなたが行います。</p>
      )}
      <fieldset disabled={busy} className="flex flex-col gap-0.5">
        <legend className="text-[11px] text-muted-foreground">判断</legend>
        {RELEASE_REVIEW_DECISION_KINDS.map((kind) => (
          <label key={kind} className="flex items-start gap-1.5">
            <input type="radio" name={`decision-${findingId}`} checked={decision === kind} onChange={() => choose(kind)} className="mt-0.5" />
            <span>
              {RELEASE_REVIEW_DECISION_LABEL[kind]}
              {rec?.recommended === kind && <span className={cn("ml-1", AI_TAG)}>AI推奨</span>}
              <span className="block text-[11px] text-muted-foreground">{RELEASE_REVIEW_DECISION_HINT[kind]}</span>
            </span>
          </label>
        ))}
        {canWithdraw && (
          <label className="flex items-start gap-1.5">
            <input type="radio" name={`decision-${findingId}`} checked={decision === "withdrawn"} onChange={() => choose("withdrawn")} className="mt-0.5" />
            <span>
              判断を撤回（未判断へ戻す）
            </span>
          </label>
        )}
      </fieldset>
      <label className="flex flex-col gap-0.5">
        <span className="text-[11px] text-muted-foreground">
          判断の理由（入力済みなら手入力不要）{decision === "reject" && "：誤認・対象外・過剰な要求など"}
          {aiReason && (
            <span className={cn("ml-1", AI_TAG)} data-testid="reason-origin">
              {aiReason.trim() === reason.trim() ? "AIの理由案" : "AIの理由案を編集中"}
            </span>
          )}
        </span>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} className={field} maxLength={2000} />
      </label>
      {decision === "defer" && (
        <>
          <label className="flex flex-col gap-0.5">
            <span className="text-[11px] text-muted-foreground">残る影響（必須）</span>
            <textarea value={impact} onChange={(e) => setImpact(e.target.value)} rows={2} className={field} maxLength={2000} />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[11px] text-muted-foreground">対象範囲（必須）</span>
            <input value={scope} onChange={(e) => setScope(e.target.value)} className={field} maxLength={2000} />
          </label>
        </>
      )}
      {decision === "post_release" && (
        <>
          <label className="flex flex-col gap-0.5">
            <span className="text-[11px] text-muted-foreground">
              実施時期（必須。例: 本番公開の直後・次のリリースまで）{rec?.drafts.post_release.timing && "。AIの提案は期日ではありません"}
            </span>
            <input value={timing} onChange={(e) => setTiming(e.target.value)} className={field} maxLength={500} />
          </label>
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] text-muted-foreground">追跡するIssue（必須）{rec && "。AIは既存のIssueを確認していません"}</span>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={followUpKind === "existing"} onChange={() => setFollowUpKind("existing")} />
              既存のIssue
              <input
                value={followUpNumber}
                onChange={(e) => setFollowUpNumber(e.target.value)}
                placeholder="#4651"
                inputMode="numeric"
                className="w-24 rounded border bg-background px-1.5 py-0.5 text-[12px]"
              />
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={followUpKind === "create"} onChange={() => setFollowUpKind("create")} />
              新しいIssueを作る
            </label>
            {followUpKind === "create" && (
              <input value={followUpTitle} onChange={(e) => setFollowUpTitle(e.target.value)} placeholder="Issueの題" className={field} maxLength={200} />
            )}
          </div>
        </>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={busy || !decision || !reason.trim()}
          className="min-h-8 rounded bg-foreground px-2.5 py-1 text-[12px] text-background disabled:opacity-50"
        >
          {busy ? "保存中…" : "判断を保存"}
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className="min-h-8 rounded border px-2.5 py-1 text-[12px]">
          やめる
        </button>
        {aiReason && aiReason.trim() !== reason.trim() && (
          <button type="button" disabled={busy} onClick={restoreDraft} className="min-h-8 rounded border px-2.5 py-1 text-[12px]">
            AIの理由案に戻す
          </button>
        )}
        <span className="text-[10.5px] text-muted-foreground">保存しても本番へはマージしません</span>
      </div>
      {message && <p className="text-[11.5px] text-red-600" role="alert">{message}</p>}
    </div>
  );
}
