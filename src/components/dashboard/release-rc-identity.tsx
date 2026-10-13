"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { RcCandidateView, RcLegacyCandidate, RcOverview, RcRevisionView } from "@/lib/release-rc-run";
import type { RcStatus } from "@/lib/release-rc";
import { formatMonthDayTime } from "@/lib/format-date-time";
import { cn } from "@/lib/utils";

/**
 * 本番PR詳細に足す、リリース候補（#4495）の識別表示。候補一覧・ブランチ・スマホのシートへの配置は#4498で行い、
 * ここでは「どの候補の、どのrevisionか」「旧方式か」を読めるようにするだけにする。
 */

const STATUS_TONE: Record<RcStatus, string> = {
  creating: "bg-muted text-muted-foreground",
  awaiting_verification: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  verifying: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  needs_fix: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  fixing: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  ready_to_prepare: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  preparing: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  awaiting_approval: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  deploying: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  verifying_production: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  completed: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  cancelled: "bg-muted text-muted-foreground",
};

const CHIP = "inline-flex items-center whitespace-nowrap rounded-full px-2 py-px text-[11px] font-semibold";

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : "—");

/** 見出し下の1行。候補ID・revision・状態・正式版が未確定であること */
export function ReleaseRcIdentity({ candidate }: { candidate: RcCandidateView }) {
  const current = candidate.revisions.find((r) => r.revision === candidate.currentRevision) ?? null;
  return (
    <div className="flex flex-col gap-1" data-testid="release-rc-identity">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="font-mono text-[13px] font-bold">{candidate.label}</span>
        {candidate.currentRevision > 0 && (
          <span className={cn(CHIP, "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300")}>revision {candidate.currentRevision}</span>
        )}
        <span className={cn(CHIP, STATUS_TONE[candidate.status.status])}>{candidate.status.label}</span>
        <span className="text-[11.5px] text-muted-foreground">正式版は公開準備で確定します</span>
      </div>
      <p className="break-words font-mono text-[11.5px] text-muted-foreground">
        {candidate.branch} → main · base {short(current?.baseSha ?? null)} · head {short(current?.headSha ?? null)}
      </p>
      <p className="text-[11.5px] text-muted-foreground">{candidate.status.reason}</p>
      {candidate.status.attention && (
        <p className="text-[11.5px] text-destructive" role="alert">
          {candidate.status.attention}
        </p>
      )}
    </div>
  );
}

const REVISION_STATUS: Record<RcRevisionView["status"], { label: string; tone: string }> = {
  requested: { label: "作成中", tone: STATUS_TONE.fixing },
  applied: { label: "適用済み", tone: "bg-muted text-muted-foreground" },
  failed: { label: "失敗（未適用）", tone: STATUS_TONE.needs_fix },
  expired: { label: "期限切れ（未適用）", tone: "bg-muted text-muted-foreground" },
};

function revisionSummary(revision: RcRevisionView, candidate: RcCandidateView): string {
  if (revision.reason === "initial") return `developの ${short(candidate.frozenDevelopSha)} で固定（PR ${candidate.frozenPrs.length}件）`;
  if (revision.reason === "migration") {
    return `旧方式の候補${candidate.migratedFromPrNumber ? ` #${candidate.migratedFromPrNumber}` : ""}から移行（PR ${candidate.frozenPrs.length}件）`;
  }
  const prs = revision.importedPrs.map((p) => `#${p.number}${p.related ? "" : "（承認済み）"}`).join("、");
  return `${revision.reasonLabel}: ${prs || "—"}`;
}

/** 候補の改訂履歴。過去のrevisionの結果は記録として残し、現在の合否には使わない */
export function ReleaseRcRevisionHistory({ candidate }: { candidate: RcCandidateView }) {
  if (candidate.revisions.length === 0) return null;
  return (
    <section aria-label="候補の改訂履歴" className="flex flex-col gap-1 rounded-[10px] border bg-card p-3.5">
      <h3 className="text-sm font-semibold">候補の改訂履歴</h3>
      <p className="text-[11.5px] text-muted-foreground">新しい順。過去のrevisionの結果は記録として残し、現在の合否には使いません。</p>
      <ol className="flex flex-col">
        {[...candidate.revisions].reverse().map((revision) => {
          const tone = REVISION_STATUS[revision.status];
          const isCurrent = revision.revision === candidate.currentRevision && revision.status === "applied";
          return (
            <li
              key={revision.revision}
              className="grid grid-cols-[44px_1fr] items-start gap-x-2.5 gap-y-1 border-t py-2 first:border-t-0 sm:grid-cols-[52px_1fr_auto]"
            >
              <span className="font-mono font-bold">r{revision.revision}</span>
              <div className="min-w-0">
                <p className="break-words">{revisionSummary(revision, candidate)}</p>
                <p className="break-words font-mono text-[11.5px] text-muted-foreground">
                  head {short(revision.headSha)} · {formatMonthDayTime(revision.createdAt)}
                  {revision.runUrl && (
                    <>
                      {" · "}
                      <a href={revision.runUrl} target="_blank" rel="noreferrer" className="underline">
                        実行ログ
                      </a>
                    </>
                  )}
                </p>
                {revision.failureReason && revision.status !== "applied" && (
                  <p className="break-words text-[11.5px] text-destructive">{revision.failureReason}</p>
                )}
              </div>
              <span className={cn(CHIP, "col-start-2 justify-self-start sm:col-start-auto", isCurrent ? STATUS_TONE[candidate.status.status] : tone.tone)}>
                {isCurrent ? `現在: ${candidate.status.label}` : tone.label}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function newRequestKey(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** 旧方式（`release-main/v*`）の候補・未対応のcallerの表示。閉じたり取り消したりせず、移行は明示的な操作だけ */
export function ReleaseRcLegacyNotice({
  overview,
  legacy,
  repositoryFullName,
  onChanged,
}: {
  overview: RcOverview;
  legacy: RcLegacyCandidate;
  repositoryFullName: string;
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  // 二重押し・再送で同じ要求キーを送る（サーバーは同じキーの要求を1回だけ処理する）
  const [requestKey, setRequestKey] = useState(newRequestKey);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (!overview.caller.supported) {
    return (
      <div className="flex flex-col gap-1" data-testid="release-rc-legacy">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="font-mono text-[13px] font-bold">{legacy.version ? `v${legacy.version}` : `#${legacy.prNumber}`}</span>
          <span className={cn(CHIP, "border bg-background text-muted-foreground")}>旧方式で動作中</span>
        </div>
        <p className="text-[11.5px] text-muted-foreground">{overview.caller.reasonLabel}</p>
      </div>
    );
  }

  const migrate = async () => {
    setBusy(true);
    setMessage(null);
    const [owner, repo] = repositoryFullName.split("/");
    try {
      const res = await fetch("/api/repositories/release/rc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, repo, action: "migrate", legacyPrNumber: legacy.prNumber, expectedHeadSha: legacy.headSha, requestKey }),
      });
      const body: { ok?: boolean; error?: string; message?: string } = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        setMessage(body.message ?? MIGRATE_ERROR[body.error ?? ""] ?? `移行を始められませんでした (${res.status})`);
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

  return (
    <div className="flex flex-col gap-1.5" data-testid="release-rc-legacy">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="font-mono text-[13px] font-bold">{legacy.version ? `v${legacy.version}` : `#${legacy.prNumber}`}</span>
        <span className={cn(CHIP, "border bg-background text-muted-foreground")}>旧方式の候補</span>
      </div>
      <p className="text-[12px]">
        正式版を上げてから作られた旧方式のリリースPRです。閉じたりバンプを取り消したりせず、このまま旧方式で完了できます。
      </p>
      {legacy.migratable.ok ? (
        confirming ? (
          <div className="flex flex-col gap-1.5 rounded-md border p-2.5">
            <p className="text-[12px]">
              版を上げる前の固定点から新しい候補を作り、作れた後にこのPRを閉じます。版上げのコミットは取り消しません。このPRの検証結果は記録として残り、新しい候補の合否には使いません。
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={migrate} disabled={busy}>
                {busy ? "移行を始めています…" : "移行する"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConfirming(false)} disabled={busy}>
                やめる
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
              新方式へ移行
            </Button>
          </div>
        )
      ) : (
        <p className="text-[11.5px] text-muted-foreground">{legacy.migratable.reason}</p>
      )}
      {message && (
        <p className="text-[11.5px] text-destructive" role="alert">
          {message}
        </p>
      )}
    </div>
  );
}

const MIGRATE_ERROR: Record<string, string> = {
  caller_unsupported: "このリポジトリのリリースworkflowが候補管理に対応していません",
  rc_active: "進行中の新方式の候補があります",
  legacy_changed: "旧方式の候補が更新されました。画面を読み込み直してください",
  not_migratable: "この候補は移行できません。旧方式のまま完了させてください",
  dispatch_failed: "リリースworkflowを起動できませんでした",
  not_found: "旧方式の候補が見つかりません",
};
