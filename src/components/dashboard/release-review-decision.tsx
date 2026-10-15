"use client";

import { useState } from "react";

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
import { cn } from "@/lib/utils";

/**
 * 全体レビューの指摘ごとのユーザー判断（#4657）。PC・スマホ・本番マージ確認で共通の`release-review-sections.tsx`から使う。
 * **AIの原判定（重大度・止める理由・根拠）とユーザー判断は別の枠に出し、判断で原判定を書き換えて見せない。**
 */

type Target = { baseSha: string; headSha: string };

const DECISION_TONE: Record<ReleaseReviewDecisionAction, string> = {
  fix_now: "border-sky-300 bg-sky-50/60 dark:border-sky-800 dark:bg-sky-950/20",
  post_release: "border-violet-300 bg-violet-50/60 dark:border-violet-800 dark:bg-violet-950/20",
  defer: "border-zinc-300 bg-zinc-50/60 dark:border-zinc-700 dark:bg-zinc-900/30",
  reject: "border-zinc-300 bg-zinc-50/60 dark:border-zinc-700 dark:bg-zinc-900/30",
  withdrawn: "border-zinc-300",
};

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
        判断はAIの判定を書き換えません。判断の保存だけでは本番へマージせず、必須の検証（統合検証・CI・Mac検証）の未完了や失敗も解除しません。
      </p>
    </div>
  );
}

/** 指摘1件ぶんの判断の表示と、判断の入力 */
export function FindingDecisionControl({
  repositoryFullName,
  pullRequestNumber,
  target,
  findingId,
  view,
  onSaved,
}: {
  repositoryFullName: string;
  pullRequestNumber: number;
  target: Target;
  findingId: string;
  view: FindingDecisionView | undefined;
  onSaved?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const current = view?.current ?? null;
  const latestId = view?.history.at(-1)?.id ?? null;
  return (
    <div className="mt-1 flex flex-col gap-1" data-testid="finding-decision">
      {current ? (
        <div className={cn("rounded border px-2 py-1", DECISION_TONE[current.decision])}>
          <p>
            <span className="font-medium">ユーザー判断: {RELEASE_REVIEW_DECISION_LABEL[current.decision]}</span>
            <span className="ml-2 text-[11px] text-muted-foreground">
              {current.decidedBy} · {when(current.decidedAt)} · PR #{current.prNumber}
            </span>
          </p>
          <p className="whitespace-pre-wrap">理由: {current.reason}</p>
          {current.impact && <p className="whitespace-pre-wrap">残る影響: {current.impact}</p>}
          {current.scope && <p className="whitespace-pre-wrap">対象範囲: {current.scope}</p>}
          {current.decision === "post_release" && (
            <p>
              公開後作業: {followUpText(current) ?? "Issue未指定"}
              {current.timing && ` · 時期: ${current.timing}`}
              <span className="text-muted-foreground">（未実施。配布・適用済みとは扱いません）</span>
            </p>
          )}
          {view?.stale && <p className="font-medium text-amber-700 dark:text-amber-400">再確認が必要: {view.stale}</p>}
        </div>
      ) : (
        <p className="text-amber-700 dark:text-amber-400">ユーザー判断: 未判断</p>
      )}
      {view && view.history.length > 1 && (
        <details>
          <summary className="cursor-pointer text-[11px] text-muted-foreground">判断の履歴（{view.history.length}件）</summary>
          <ol className="mt-0.5 flex flex-col gap-0.5 text-[11px]">
            {view.history.map((h) => (
              <li key={h.id}>
                {when(h.decidedAt)} {h.decidedBy}: {RELEASE_REVIEW_DECISION_LABEL[h.decision]} — {h.reason}
              </li>
            ))}
          </ol>
        </details>
      )}
      {editing ? (
        <DecisionForm
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
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="self-start rounded border px-2 py-0.5 text-[11.5px] hover:bg-muted"
        >
          {current ? "判断を変更・撤回" : "判断する"}
        </button>
      )}
      {note && <p className="text-[11.5px] text-sky-700 dark:text-sky-400">{note}</p>}
    </div>
  );
}

function DecisionForm({
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
  initial: ReleaseReviewDecisionKind | "withdrawn" | null;
  onCancel: () => void;
  onSaved: (note: string | null) => void;
}) {
  const [decision, setDecision] = useState<ReleaseReviewDecisionAction | null>(initial === "withdrawn" ? null : initial);
  const [reason, setReason] = useState("");
  const [impact, setImpact] = useState("");
  const [scope, setScope] = useState("");
  const [timing, setTiming] = useState("");
  const [followUpKind, setFollowUpKind] = useState<"existing" | "create">("existing");
  const [followUpNumber, setFollowUpNumber] = useState("");
  const [followUpTitle, setFollowUpTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const submit = async () => {
    if (busy || !decision) return;
    setBusy(true);
    setMessage(null);
    try {
      const [owner, repo] = repositoryFullName.split("/");
      const followUp =
        decision !== "post_release"
          ? null
          : followUpKind === "existing"
            ? { kind: "existing", number: Number(followUpNumber.replace(/^#/, "")) }
            : { kind: "create", title: followUpTitle };
      const res = await fetch("/api/repositories/release/review-decisions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner,
          repo,
          pullRequestNumber,
          baseSha: target.baseSha,
          headSha: target.headSha,
          findingId,
          expectedDecisionId,
          decision,
          reason,
          impact,
          scope,
          timing,
          followUp,
        }),
      });
      const body: { error?: string; message?: string; activeFixSeries?: number } = await res.json().catch(() => ({}));
      if (res.status === 401 || res.status === 403) setMessage("判断を保存する権限がありません。ログインし直してください。");
      else if (res.status === 409) setMessage(`${body.message ?? "対象が更新されました。"}「更新」で最新の状態を読み込んでください。`);
      else if (!res.ok) setMessage(body.message ?? `判断を保存できませんでした (${res.status})。`);
      else {
        onSaved(
          body.activeFixSeries && body.activeFixSeries > 0 && decision !== "fix_now"
            ? "判断を保存しました。稼働中の修正系列があります。以降の追加修正・候補の更新はこの判断に従いますが、実行中のセッションと、developへ取り込み済みの修正PRはそのまま残ります（不要なら修正Issueを閉じてください）。"
            : null,
        );
      }
    } catch {
      setMessage("判断を保存できませんでした（通信に失敗しました）。");
    } finally {
      setBusy(false);
    }
  };

  const field = "w-full rounded border bg-background px-1.5 py-1 text-[12px]";
  return (
    <div className="flex flex-col gap-1.5 rounded border px-2 py-1.5" data-testid="finding-decision-form">
      <fieldset className="flex flex-col gap-0.5">
        <legend className="text-[11px] text-muted-foreground">判断</legend>
        {RELEASE_REVIEW_DECISION_KINDS.map((kind) => (
          <label key={kind} className="flex items-start gap-1.5">
            <input type="radio" name={`decision-${findingId}`} checked={decision === kind} onChange={() => setDecision(kind)} className="mt-0.5" />
            <span>
              {RELEASE_REVIEW_DECISION_LABEL[kind]}
              <span className="block text-[11px] text-muted-foreground">{RELEASE_REVIEW_DECISION_HINT[kind]}</span>
            </span>
          </label>
        ))}
        {canWithdraw && (
          <label className="flex items-start gap-1.5">
            <input type="radio" name={`decision-${findingId}`} checked={decision === "withdrawn"} onChange={() => setDecision("withdrawn")} className="mt-0.5" />
            <span>
              判断を撤回（未判断へ戻す）
            </span>
          </label>
        )}
      </fieldset>
      <label className="flex flex-col gap-0.5">
        <span className="text-[11px] text-muted-foreground">理由（必須）{decision === "reject" && "：誤認・対象外・過剰な要求など"}</span>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className={field} maxLength={2000} />
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
            <span className="text-[11px] text-muted-foreground">実施時期（必須。例: 本番公開の直後・次のリリースまで）</span>
            <input value={timing} onChange={(e) => setTiming(e.target.value)} className={field} maxLength={500} />
          </label>
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] text-muted-foreground">追跡するIssue（必須）</span>
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
          disabled={busy || !decision}
          className="rounded bg-foreground px-2.5 py-1 text-[12px] text-background disabled:opacity-50"
        >
          {busy ? "保存中…" : "判断を保存"}
        </button>
        <button type="button" onClick={onCancel} className="rounded border px-2.5 py-1 text-[12px]">
          やめる
        </button>
        <span className="text-[10.5px] text-muted-foreground">保存しても本番へはマージしません</span>
      </div>
      {message && <p className="text-[11.5px] text-red-600" role="alert">{message}</p>}
    </div>
  );
}
