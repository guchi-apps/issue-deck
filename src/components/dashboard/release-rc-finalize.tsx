"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { FINALIZE_STATUS_LABEL, FINALIZE_START_ERROR_LABEL, REVERIFY_PHASE_LABEL, type ReverifyPhase } from "@/lib/release-finalize";
import type { RcFinalizationOverview, RcFinalizationView } from "@/lib/release-finalize-run";
import type { RcCandidateView } from "@/lib/release-rc-run";
import { cn } from "@/lib/utils";
import { BUMP_KIND_CRITERIA, nextVersion, type BumpKind } from "@/lib/semver-bump";

/**
 * 公開準備（正式バンプ。#4496）のパネル。本番PR詳細の候補の帯の下に出す。
 *
 * - **予定の版と確定した版を分ける。** 検証中の版表示は予定値（点線）で、公開準備でバンプして予約した後だけ「確定」と出す
 * - バンプ前の検証結果は書き換えない。引継ぎは元の結果のhead・差分のファイル・理由を並べ、
 *   バンプ後のheadで実行した結果とは区別する
 * - Web本番とTestFlight配布は別の行にし、build番号と正式版を混ぜない
 */

const CHIP = "inline-flex items-center whitespace-nowrap rounded-full px-2 py-px text-[11px] font-semibold";
const TONE = {
  ok: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  run: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  warn: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  bad: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  mute: "bg-muted text-muted-foreground",
} as const;
type Tone = keyof typeof TONE;

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : "—");
const newRequestKey = () => crypto.randomUUID().replace(/-/g, "");

const KIND_LABEL: Record<string, string> = { ai_review: "全体レビュー", integration: "統合検証", ios: "iOS検証" };

const FINALIZE_ERROR: Record<string, string> = {
  ...FINALIZE_START_ERROR_LABEL,
  not_found: "候補が見つかりません",
  caller_unsupported: "このリポジトリのリリースworkflowが公開準備に対応していません",
  invalid_bump_kind: "上げ幅の指定が正しくありません",
  version_conflict: "版を予約できませんでした",
  dispatch_failed: "リリースworkflowを起動できませんでした",
};

const CI_DETAIL: Record<string, string> = {
  none: "バンプ後のheadで実行します（未実施・失敗では公開できません）",
  pending: "バンプ後のheadで実行中です",
  failure: "バンプ後のheadで失敗しています",
  unknown: "バンプ後の最終CI・ビルドの結果を取得できません",
};

const PHASE_TONE: Record<ReverifyPhase, Tone> = { done: "ok", running: "run", waiting: "run", failed: "bad", needs_check: "warn", not_run: "warn", invalidated: "warn" };

/** 「バンプ後の再検証・引継ぎ」の工程。**「再検証中」は実行中のジョブがあるときだけ**で、終了済みの未完了は工程と理由を併記する */
function reverifyStep(input: { afterBump: boolean; bumped: boolean; current: RcFinalizationView | null; checks: RcFinalizationOverview["checks"] }): Step {
  const { afterBump, bumped, current, checks } = input;
  const label = "バンプ後の再検証・引継ぎ";
  if (afterBump) return { label, detail: current && current.evidence.length > 0 ? "引き継いだ検証と再実行した検証は下の表で確認できます" : "引継ぎの判定はバンプ後に記録されます", tone: "ok", badge: "完了" };
  if (!bumped) return { label, detail: "引継ぎの判定はバンプ後に記録されます", tone: "mute", badge: "待機" };
  if (!checks) return { label, detail: "再検証の状態を取得できません。状態を取り直してください", tone: "warn", badge: "取得不能" };
  const open = checks.reverify.filter((i) => i.reason !== null);
  if (open.length === 0) return { label, detail: "再実行が必要な検証は全て合格しています", tone: "ok", badge: "完了" };
  return {
    label,
    detail: open.map((i) => `${i.label}: ${i.reason}`).join(" ／ "),
    tone: PHASE_TONE[checks.reverifyPhase],
    badge: REVERIFY_PHASE_LABEL[checks.reverifyPhase],
  };
}

type Step = { label: string; detail: string; tone: Tone; badge: string };

/** 公開までの流れ。段階（候補の`phase`）と公開準備・最終検証の観測から、各工程の状態を導く */
export function buildFinalizeSteps(input: { phase: string; current: RcFinalizationView | null; checks: RcFinalizationOverview["checks"] }): Step[] {
  const { phase, current, checks } = input;
  const bumped = current?.status === "applied";
  const afterBump = ["awaiting_approval", "deploying", "verifying_production", "completed"].includes(phase);
  const released = ["deploying", "verifying_production", "completed"].includes(phase);
  const ci = checks?.ciState ?? null;
  return [
    { label: "バンプ前の検証に合格", detail: current ? `revision ${current.revision} · 全体レビュー・統合検証` : "合格すると公開準備を始められます", tone: current ? "ok" : "mute", badge: current ? "合格" : "待機" },
    {
      label: "正式バンプ",
      detail: bumped || afterBump ? "版ファイル・更新履歴だけを変更（候補に固定した内容。最新developは取り込まない）" : (current?.failureReason ?? "候補ブランチへ早送りで積みます"),
      tone: bumped || afterBump ? "ok" : current?.status === "requested" ? "run" : current && !bumped ? "bad" : "mute",
      badge: bumped || afterBump ? short(current?.finalHeadSha ?? null) : current?.status === "requested" ? "実行中" : current ? FINALIZE_STATUS_LABEL[current.status] : "待機",
    },
    {
      label: "バンプ後の最終CI・ビルド",
      detail: afterBump || ci === "success" ? "バンプ後のheadで成功しています" : CI_DETAIL[ci ?? "none"] ?? CI_DETAIL.none,
      tone: afterBump || ci === "success" ? "ok" : ci === "failure" ? "bad" : bumped ? "run" : "mute",
      badge: afterBump || ci === "success" ? "成功" : ci === "failure" ? "失敗" : bumped ? "実行中" : "待機",
    },
    reverifyStep({ afterBump, bumped, current, checks }),
    { label: "本番承認", detail: "mainへのマージは既存の承認・保護を通ります", tone: phase === "awaiting_approval" ? "warn" : released ? "ok" : "mute", badge: phase === "awaiting_approval" ? "承認待ち" : released ? "済" : "待機" },
    {
      label: "mainマージ・タグ・本番反映",
      detail: "デプロイ成功と稼働中の版・SHAの一致を確かめるまで完了にしません",
      tone: phase === "completed" ? "ok" : released ? "run" : "mute",
      badge: phase === "completed" ? "完了" : phase === "verifying_production" ? "稼働確認中" : phase === "deploying" ? "反映中" : "待機",
    },
  ];
}

function StateChip({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={cn(CHIP, TONE[tone])}>{children}</span>;
}

const EVIDENCE_TONE = (action: string): Tone => (action === "inherit" ? "ok" : "warn");

function VersionBox({ finalization, plannedKind, mainVersion }: { finalization: RcFinalizationView | null; plannedKind: BumpKind | null; mainVersion: string | null }) {
  const planned = plannedKind ? nextVersion(mainVersion, plannedKind) : null;
  return (
    <div className="flex flex-wrap gap-2.5">
      <div className="min-w-[200px] flex-1 rounded-lg border p-3">
        <p className="text-[11px] text-muted-foreground">検証中の予定（見込み）</p>
        <p className="mt-0.5 inline-block border-b-2 border-dashed font-mono text-xl font-bold text-muted-foreground">{planned ? `v${planned}` : "自動判定"}</p>
        <p className="mt-0.5 text-[11.5px] text-muted-foreground">
          {planned ? "指定した上げ幅から計算した見込みです。変わることがあります。" : "上げ幅は公開準備で最終公開差分から判定します。確定するまで版は決まりません。"}
        </p>
      </div>
      <div className={cn("min-w-[200px] flex-1 rounded-lg border p-3", finalization?.version && "border-green-600/60")}>
        <p className="text-[11px] text-muted-foreground">確定した正式版</p>
        <p className="mt-0.5 font-mono text-xl font-bold">{finalization?.version ? `v${finalization.version}` : "未確定"}</p>
        <p className="mt-0.5 text-[11.5px] text-muted-foreground">
          {finalization?.version ? (
            <>
              <StateChip tone={finalization.versionReservation === "consumed" ? "mute" : "ok"}>{finalization.versionReservation === "consumed" ? "消費済み" : "予約済み"}</StateChip>{" "}
              公開前の再試行では増やしません。公開した版は再利用しません。
            </>
          ) : (
            "公開準備でバンプすると確定し、版を予約します。"
          )}
        </p>
      </div>
    </div>
  );
}

function EvidenceTable({ finalization, checks }: { finalization: RcFinalizationView; checks: RcFinalizationOverview["checks"] }) {
  const rows = finalization.evidence
    .filter((e) => e.kind !== "ios")
    .map((e) => {
      const live = checks?.reverify.find((i) => i.kind === e.kind);
      const after =
        e.action === "inherit"
          ? { tone: EVIDENCE_TONE(e.action), text: "引継ぎ" }
          : live && live.reason !== null
            ? { tone: PHASE_TONE[stateToPhase(live.state)], text: REVERIFY_PHASE_LABEL[stateToPhase(live.state)] }
            : { tone: "ok" as Tone, text: live ? "成功" : "再検証" };
      return { e, after, reason: live && live.reason !== null ? `${e.reason}。現在: ${live.reason}` : e.reason };
    });
  if (rows.length === 0) return null;
  return (
    <div className="rounded-lg border" data-testid="release-rc-evidence-table">
      <h4 className="border-b px-3 py-2 text-[12.5px] font-semibold">検証の対象と引継ぎ</h4>
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full min-w-[420px] text-[12px]">
          <thead>
            <tr className="text-left text-[11px] text-muted-foreground">
              <th className="px-3 py-1.5 font-semibold">検証</th>
              <th className="px-3 py-1.5 font-semibold">バンプ前 {short(finalization.preHeadSha)}</th>
              <th className="px-3 py-1.5 font-semibold">バンプ後 {short(finalization.finalHeadSha)}</th>
              <th className="px-3 py-1.5 font-semibold">理由</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ e, after, reason }) => (
              <tr key={e.kind} className="border-t align-top">
                <td className="px-3 py-1.5">{KIND_LABEL[e.kind] ?? e.kind}</td>
                <td className="px-3 py-1.5">
                  <StateChip tone="ok">合格</StateChip>
                </td>
                <td className="px-3 py-1.5">
                  <StateChip tone={after.tone}>{after.text}</StateChip>
                </td>
                <td className="px-3 py-1.5">{reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="flex flex-col gap-2 p-3 sm:hidden" aria-label="検証の対象と引継ぎ（カード表示）">
        {rows.map(({ e, after, reason }) => (
          <li key={e.kind} className="rounded-md border p-2.5 text-[12px]">
            <p className="font-semibold">{KIND_LABEL[e.kind] ?? e.kind}</p>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">バンプ前 {short(finalization.preHeadSha)}</dt>
              <dd><StateChip tone="ok">合格</StateChip></dd>
              <dt className="text-muted-foreground">バンプ後 {short(finalization.finalHeadSha)}</dt>
              <dd><StateChip tone={after.tone}>{after.text}</StateChip></dd>
              <dt className="text-muted-foreground">理由</dt>
              <dd className="min-w-0 break-words">{reason}</dd>
            </dl>
          </li>
        ))}
      </ul>
      <p className="border-t px-3 py-2 text-[11.5px] text-muted-foreground">
        引継ぎは元の結果と差分の根拠を残します。バンプ後のheadで実行した結果としては扱いません。変わったファイル:{" "}
        {finalization.files.length > 0 ? finalization.files.map((f) => f.path).join("、") : "なし（既にバンプ済みのheadをそのまま使用）"}
      </p>
    </div>
  );
}

function stateToPhase(state: string): ReverifyPhase {
  return state === "running" || state === "waiting" || state === "failed" || state === "needs_check" || state === "not_run" || state === "invalidated" ? state : "done";
}

export function ReleaseRcFinalizePanel({
  candidate,
  finalization,
  repositoryFullName,
  onChanged,
}: {
  candidate: RcCandidateView;
  finalization: RcFinalizationOverview;
  repositoryFullName: string;
  onChanged: () => void;
}) {
  const [bumpKind, setBumpKind] = useState<BumpKind | "auto">("auto");
  const [confirming, setConfirming] = useState(false);
  const [requestKey, setRequestKey] = useState(newRequestKey);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const current = finalization.current;
  const contract = candidate.finalizeContract;
  const canStart = contract !== null && candidate.phase === "review" && finalization.caller.supported;
  // 公開準備に関係する段階・記録が無い候補は、パネルを出さない
  if (!canStart && !current && !["preparing", "awaiting_approval", "deploying", "verifying_production", "completed"].includes(candidate.phase)) {
    return null;
  }

  const start = async () => {
    if (!contract) return;
    setBusy(true);
    setMessage(null);
    const [owner, repo] = repositoryFullName.split("/");
    try {
      const res = await fetch("/api/repositories/release/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, repo, action: "start", candidateId: candidate.id, expectedHeadSha: contract.headSha, bumpKind, requestKey }),
      });
      const body: { ok?: boolean; error?: string; message?: string } = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        setMessage(body.message ?? FINALIZE_ERROR[body.error ?? ""] ?? `公開準備を始められませんでした (${res.status})`);
        // 状態が変わった・拒否された要求は同じキーで送り直さない
        setRequestKey(newRequestKey());
      } else {
        setConfirming(false);
        onChanged();
      }
    } catch {
      setMessage("通信に失敗しました。もう一度押すと同じ要求として送り直します");
    } finally {
      setBusy(false);
    }
  };

  const steps = buildFinalizeSteps({ phase: candidate.phase, current, checks: finalization.checks });
  const plannedKind = bumpKind === "auto" ? null : bumpKind;
  return (
    <section aria-label="公開準備" className="flex flex-col gap-3 rounded-[10px] border bg-card p-3.5 pb-20 sm:pb-3.5" data-testid="release-rc-finalize">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <h3 className="text-sm font-semibold">公開準備</h3>
        {current && <StateChip tone={current.status === "failed" || current.status === "expired" ? "bad" : current.status === "applied" ? "ok" : "run"}>{current.statusLabel}</StateChip>}
        <span className="text-[11.5px] text-muted-foreground">合格した候補だけを、公開の直前に正式バンプします</span>
      </div>

      <VersionBox finalization={current && current.status !== "superseded" ? current : null} plannedKind={plannedKind} mainVersion={finalization.mainVersion} />

      {current && current.status === "failed" && current.failureReason && (
        <p className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-[12px] text-destructive" role="alert">
          {current.failureReason}。同じ候補の修正工程へ戻しました。予約した版は保ち、版は増やしません。
        </p>
      )}
      {current && current.status === "applied" && current.failureReason && (
        <p className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-[12px] text-destructive" role="alert">
          {current.failureReason}。版の消費・developへの同期・本番反映の追跡は、最終検証の合格を確認してから進めます。合格を確かめようがない場合は、候補を取り消すと予約した版を消費済みにして終えられます。
        </p>
      )}
      {current && current.status === "superseded" && current.failureReason && (
        <p className="rounded-md border px-3 py-2 text-[12px] text-muted-foreground">{current.failureReason}。予約した版は保っています。</p>
      )}

      {canStart && (
        <div className="flex flex-col gap-2 rounded-lg border p-3">
          <p className="text-[12px]">
            revision {contract!.revision} が全体レビュー・統合検証に合格しています。公開準備を始めると、版ファイルと更新履歴だけを変更するコミットを候補へ積みます。
            これは本番公開の実行ではなく、mainへのマージは既存の承認を通ります。
          </p>
          <label className="flex flex-wrap items-center gap-2 text-[12px]" htmlFor="finalize-bump-kind">
            <span className="font-semibold">上げ幅</span>
            <select
              id="finalize-bump-kind"
              className="h-8 rounded-md border bg-background px-2 text-[12px]"
              value={bumpKind}
              onChange={(e) => setBumpKind(e.target.value as BumpKind | "auto")}
              disabled={busy}
            >
              <option value="auto">最終公開差分から自動判定</option>
              <option value="patch">patch</option>
              <option value="minor">minor</option>
              <option value="major">major</option>
            </select>
            {bumpKind !== "auto" && <span className="text-muted-foreground">{BUMP_KIND_CRITERIA[bumpKind]}</span>}
          </label>
          {confirming ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={start} disabled={busy}>
                {busy ? "公開準備を始めています…" : "公開準備を始める"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConfirming(false)} disabled={busy}>
                やめる
              </Button>
            </div>
          ) : (
            <div>
              <Button size="sm" onClick={() => setConfirming(true)}>
                公開準備へ進む
              </Button>
            </div>
          )}
        </div>
      )}
      {!finalization.caller.supported && contract !== null && candidate.phase === "review" && (
        <p className="text-[11.5px] text-muted-foreground">{finalization.caller.reasonLabel}</p>
      )}
      {message && (
        <p className="text-[11.5px] text-destructive" role="alert">
          {message}
        </p>
      )}

      <ol className="flex flex-col rounded-lg border" aria-label="公開までの流れ">
        {steps.map((step) => (
          <li key={step.label} className="grid grid-cols-[1fr_auto] items-start gap-x-2.5 border-t px-3 py-2 first:border-t-0">
            <div className="min-w-0">
              <p className="text-[12.5px] font-semibold">{step.label}</p>
              <p className="break-words text-[11.5px] text-muted-foreground">{step.detail}</p>
            </div>
            <StateChip tone={step.tone}>{step.badge}</StateChip>
          </li>
        ))}
      </ol>

      {current && current.status === "applied" && <EvidenceTable finalization={current} checks={finalization.checks} />}

      <div className="rounded-lg border">
        <h4 className="border-b px-3 py-2 text-[12.5px] font-semibold">公開結果（Webと配布は別）</h4>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-3 py-2 text-[12px]">
          <dt className="text-muted-foreground">Web本番</dt>
          <dd>
            <span className="font-mono">{current?.version ? `v${current.version}` : "—"}</span>{" "}
            <StateChip tone={candidate.phase === "completed" ? "ok" : ["deploying", "verifying_production"].includes(candidate.phase) ? "run" : "mute"}>
              {candidate.phase === "completed" ? "稼働を確認済み" : ["deploying", "verifying_production"].includes(candidate.phase) ? "反映中" : "未反映"}
            </StateChip>
          </dd>
          <dt className="text-muted-foreground">TestFlight</dt>
          <dd className="text-muted-foreground">Web本番とは別の結果として確認します。build番号は正式版と別の番号で、ここには混ぜません。</dd>
        </dl>
      </div>
    </section>
  );
}
