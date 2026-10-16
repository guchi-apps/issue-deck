"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { formatDateTime, formatMonthDayTime } from "@/lib/format-date-time";
import { FINALIZE_STATUS_LABEL, FINALIZE_START_ERROR_LABEL, REVERIFY_PHASE_LABEL, type ReverifyPhase } from "@/lib/release-finalize";
import type { RcFinalizationOverview, RcFinalizationView } from "@/lib/release-finalize-run";
import type { PublishApprovalView } from "@/lib/release-publish-approval-run";
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
 * - **公開準備の開始が唯一の公開承認（#4666）。** 確認画面で「合格後は自動で本番公開する」ことと承認の範囲を示し、
 *   最終検証の後に二度目の「本番承認」を出さない。承認の記録が無い既存の候補だけ、1回だけ承認を求める
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
  approval_required: "画面が古いため受け付けませんでした。再読み込みしてからやり直してください",
  run_active: "このリポジトリでは別の完了系列が進行中です",
  already_publishing: "本番マージの処理に入っているため、取り消せません",
  approval_invalid: "公開承認が失効しています。内容を確かめて、改めて承認してください",
  pull_request_unobserved: "候補のPR・mainの状態を取得できませんでした",
};

const APPROVAL_TONE: Record<string, Tone> = {
  needs_approval: "warn",
  final_checks: "run",
  auto_publish: "run",
  stopped: "bad",
  deploying: "run",
  verifying_production: "run",
  completed: "ok",
  invalidated: "bad",
  revoked: "mute",
};

const BUMP_POLICY_LABEL: Record<string, string> = { auto: "最終公開差分から自動判定", patch: "patch", minor: "minor", major: "major" };

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
export function buildFinalizeSteps(input: {
  phase: string;
  current: RcFinalizationView | null;
  checks: RcFinalizationOverview["checks"];
  approval?: PublishApprovalView | null;
}): Step[] {
  const { phase, current, checks } = input;
  const approval = input.approval ?? null;
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
    approvalStep({ phase, approval, released }),
    {
      label: "mainマージ・タグ・本番反映",
      detail: approval && (approval.status === "active" || approval.status === "merging" || approval.status === "consumed")
        ? "最終検証の合格後、mainの保護・必須チェックを通して自動でマージします。デプロイ成功と稼働中の版・SHAの一致を確かめるまで完了にしません"
        : "デプロイ成功と稼働中の版・SHAの一致を確かめるまで完了にしません",
      tone: phase === "completed" ? "ok" : released ? "run" : "mute",
      badge: phase === "completed" ? "完了" : phase === "verifying_production" ? "稼働確認中" : phase === "deploying" ? "反映中" : "待機",
    },
  ];
}

/** 「公開承認」の工程。承認は公開準備の開始の1回だけで、最終検証の後に二度目の承認を求めない */
function approvalStep(input: { phase: string; approval: PublishApprovalView | null; released: boolean }): Step {
  const { phase, approval, released } = input;
  const label = "公開承認";
  if (approval === null) {
    if (released) return { label, detail: "承認の記録が無い候補として公開されました", tone: "mute", badge: "記録なし" };
    if (phase === "preparing" || phase === "awaiting_approval") {
      return { label, detail: "この候補には公開承認の記録がありません。内容を確かめて1回だけ承認してください", tone: "warn", badge: "承認が必要" };
    }
    return { label, detail: "「本番公開へ進む（公開承認）」を押した1回が承認です。最終検証の後に承認し直す必要はありません", tone: "mute", badge: "待機" };
  }
  const when = formatMonthDayTime(approval.approvedAt);
  if (approval.status === "invalidated") return { label, detail: approval.invalidMessage ?? "公開承認が失効しました", tone: "bad", badge: "失効" };
  if (approval.status === "revoked") return { label, detail: "自動公開を取り消しました", tone: "mute", badge: "取り消し" };
  return { label, detail: `${when}に承認（revision ${approval.revision} · ${short(approval.headSha)}）。想定した正式バンプの変更までが範囲です`, tone: "ok", badge: "承認済み" };
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

/** 公開承認の確認内容。**承認する前に、自動で本番公開することと承認の範囲を全部見せる** */
function ApprovalConfirm({
  repositoryFullName,
  candidate,
  target,
  bumpPolicy,
  reusing,
}: {
  repositoryFullName: string;
  candidate: RcCandidateView;
  target: { revision: number; baseSha: string; headSha: string };
  bumpPolicy: string;
  reusing: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-primary/50 bg-primary/5 p-2.5 text-[12px]" data-testid="release-rc-approval-confirm">
      <p className="font-semibold">
        {reusing
          ? "公開承認済みの内容で、公開準備をやり直します（承認し直しは不要です）"
          : "これは本番公開の承認です。正式バンプと必要な最終検証を行い、合格したら自動で本番公開します"}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <dt className="text-muted-foreground">対象</dt>
        <dd className="min-w-0 break-words">{repositoryFullName}</dd>
        <dt className="text-muted-foreground">候補</dt>
        <dd className="min-w-0 break-words">
          {candidate.label} · revision {target.revision} · main {short(target.baseSha)} ← {short(target.headSha)}
        </dd>
        <dt className="text-muted-foreground">公開内容</dt>
        <dd className="min-w-0 break-words">
          {candidate.frozenPrs.length > 0 ? candidate.frozenPrs.map((p) => `#${p.number} ${p.title}`).join("、") : "（候補に固定した内容）"}
        </dd>
        <dt className="text-muted-foreground">版の指定</dt>
        <dd>{BUMP_POLICY_LABEL[bumpPolicy] ?? bumpPolicy}</dd>
        <dt className="text-muted-foreground">承認の範囲</dt>
        <dd className="min-w-0 break-words">
          この候補と、正式バンプで版ファイル・更新履歴だけが変わることまで。それ以外のコード変更・候補の置換・mainの前進・取消があれば承認は失効し、もう一度確認します
        </dd>
        <dt className="text-muted-foreground">合格後</dt>
        <dd className="min-w-0 break-words">mainへのマージ・タグ・デプロイ・稼働中の版の確認まで自動で進めます。画面を開いておく必要はありません。公開の直前までは取り消せます</dd>
      </dl>
    </div>
  );
}

/** 公開承認と自動公開の状況。承認者・日時・対象・失効の理由と差分・止まった理由を出す */
function ApprovalBox({
  approval,
  busy,
  canResume,
  onRevoke,
  onResume,
}: {
  approval: PublishApprovalView;
  busy: boolean;
  canResume: boolean;
  onRevoke: () => void;
  onResume: () => void;
}) {
  const reason = approval.run && !approval.run.active ? approval.run.stopMessage : null;
  const note = approval.run?.active ? approval.run.note : null;
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border p-3 text-[12px]" data-testid="release-rc-approval">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">公開承認</span>
        <StateChip tone={APPROVAL_TONE[approval.progress] ?? "mute"}>{approval.progressLabel}</StateChip>
      </div>
      <p className="break-words text-muted-foreground">
        {formatDateTime(approval.approvedAt)}に承認 · revision {approval.revision} · main {short(approval.baseSha)} ← {short(approval.headSha)} · 版の指定:{" "}
        {BUMP_POLICY_LABEL[approval.bumpPolicy] ?? approval.bumpPolicy} · 有効期限 {formatDateTime(approval.expiresAt)}
      </p>
      {note && <p className="break-words">{note}</p>}
      {approval.status === "invalidated" && (
        <p className="break-words text-destructive" role="alert">
          {approval.invalidMessage}
          {approval.invalidDiff.length > 0 && <> 変わったファイル: {approval.invalidDiff.join("、")}</>}。古い承認では公開しません。内容を確かめて、改めて承認してください。
        </p>
      )}
      {reason && approval.status === "active" && (
        <p className="break-words text-destructive" role="alert" data-testid="release-rc-approval-stop">
          {reason}
        </p>
      )}
      {approval.status === "active" && (
        <div className="flex flex-wrap gap-2">
          {canResume && (
            <Button size="sm" onClick={onResume} disabled={busy}>
              自動公開を再開
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={onRevoke} disabled={busy}>
            自動公開を取り消す
          </Button>
        </div>
      )}
      {approval.status === "merging" && <p className="text-muted-foreground">本番マージの処理に入ったため、取り消せません。</p>}
    </div>
  );
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
  const approval = finalization.approval ?? null;
  const approvalLive = approval !== null && (approval.status === "active" || approval.status === "merging");
  const contract = candidate.finalizeContract;
  const canStart = contract !== null && candidate.phase === "review" && finalization.caller.supported;
  // 承認の記録が無い既存の公開準備済み候補（推定で承認扱いしない）
  const needsLegacyApproval =
    !approvalLive && ["preparing", "awaiting_approval"].includes(candidate.phase) && current?.status === "applied" && current.finalHeadSha !== null;
  const canResume = approval?.status === "active" && ["preparing", "awaiting_approval"].includes(candidate.phase) && approval.run?.active !== true;
  // 公開準備に関係する段階・記録が無い候補は、パネルを出さない
  if (!canStart && !current && !["preparing", "awaiting_approval", "deploying", "verifying_production", "completed"].includes(candidate.phase)) {
    return null;
  }

  const post = async (body: Record<string, unknown>, failure: string): Promise<boolean> => {
    setBusy(true);
    setMessage(null);
    const [owner, repo] = repositoryFullName.split("/");
    try {
      const res = await fetch("/api/repositories/release/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, repo, candidateId: candidate.id, ...body }),
      });
      const result: { ok?: boolean; error?: string; message?: string } = await res.json().catch(() => ({}));
      if (!res.ok || !result.ok) {
        setMessage(result.message ?? FINALIZE_ERROR[result.error ?? ""] ?? `${failure} (${res.status})`);
        // 状態が変わった・拒否された要求は同じキーで送り直さない
        setRequestKey(newRequestKey());
        return false;
      }
      setConfirming(false);
      onChanged();
      return true;
    } catch {
      setMessage("通信に失敗しました。もう一度押すと同じ要求として送り直します");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (!contract) return;
    await post({ action: "start", expectedHeadSha: contract.headSha, bumpKind, requestKey, approvePublish: true }, "公開準備を始められませんでした");
  };
  const approveLegacy = async () => {
    if (!current?.finalHeadSha) return;
    await post({ action: "approve", expectedHeadSha: current.finalHeadSha, requestKey }, "公開を承認できませんでした");
  };
  const resume = async () => {
    if (!current?.finalHeadSha && !approval) return;
    await post({ action: "approve", expectedHeadSha: current?.finalHeadSha ?? approval!.headSha, requestKey }, "自動公開を再開できませんでした");
  };
  const revoke = async () => {
    if (!window.confirm("自動公開を取り消しますか？本番へはマージしません。続けるには、改めて公開を承認します。")) return;
    await post({ action: "revoke" }, "自動公開を取り消せませんでした");
  };

  const steps = buildFinalizeSteps({ phase: candidate.phase, current, checks: finalization.checks, approval });
  const plannedKind = bumpKind === "auto" ? null : bumpKind;
  const reusing = approval?.status === "active";
  return (
    <section aria-label="公開準備" className="flex flex-col gap-3 rounded-[10px] border bg-card p-3.5 pb-20 sm:pb-3.5" data-testid="release-rc-finalize">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <h3 className="text-sm font-semibold">公開準備</h3>
        {current && <StateChip tone={current.status === "failed" || current.status === "expired" ? "bad" : current.status === "applied" ? "ok" : "run"}>{current.statusLabel}</StateChip>}
        <span className="text-[11.5px] text-muted-foreground">合格した候補だけを、公開の直前に正式バンプします</span>
      </div>

      <VersionBox finalization={current && current.status !== "superseded" ? current : null} plannedKind={plannedKind} mainVersion={finalization.mainVersion} />

      {approval && <ApprovalBox approval={approval} busy={busy} canResume={canResume} onRevoke={revoke} onResume={resume} />}

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
            revision {contract!.revision} が全体レビュー・統合検証に合格しています。「本番公開へ進む（公開承認）」を押すと、版ファイルと更新履歴だけを変更するコミットを候補へ積み、
            最終検証に合格したら自動で本番公開します。最終検証の後に承認し直す必要はありません。
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
            <>
              <ApprovalConfirm repositoryFullName={repositoryFullName} candidate={candidate} target={contract!} bumpPolicy={bumpKind} reusing={reusing} />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={start} disabled={busy}>
                  {busy ? "公開準備を始めています…" : reusing ? "公開準備をやり直す" : "公開を承認して進める"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setConfirming(false)} disabled={busy}>
                  やめる
                </Button>
              </div>
            </>
          ) : (
            <div>
              <Button size="sm" onClick={() => setConfirming(true)}>
                {reusing ? "公開準備をやり直す（承認済み）" : "本番公開へ進む（公開承認）"}
              </Button>
            </div>
          )}
        </div>
      )}
      {needsLegacyApproval && current && (
        <div className="flex flex-col gap-2 rounded-lg border border-amber-500/60 p-3" data-testid="release-rc-legacy-approval">
          <p className="text-[12px]">
            {approval
              ? "前の公開承認は使えません（失効・取り消し）。現在の内容を確かめて承認し直すと、最終検証の合格後に自動で本番公開します。"
              : "この候補は公開準備が済んでいますが、公開承認の記録がありません（以前の画面で公開準備を始めた候補です）。内容を確かめて1回だけ承認すると、最終検証の合格後に自動で本番公開します。"}
          </p>
          {confirming ? (
            <>
              <ApprovalConfirm
                repositoryFullName={repositoryFullName}
                candidate={candidate}
                target={{ revision: candidate.currentRevision, baseSha: current.finalBaseSha ?? "", headSha: current.finalHeadSha ?? "" }}
                bumpPolicy={current.bumpKind ?? "auto"}
                reusing={false}
              />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={approveLegacy} disabled={busy}>
                  {busy ? "承認しています…" : "公開を承認する"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setConfirming(false)} disabled={busy}>
                  やめる
                </Button>
              </div>
            </>
          ) : (
            <div>
              <Button size="sm" onClick={() => setConfirming(true)}>
                公開の承認内容を確認する
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
