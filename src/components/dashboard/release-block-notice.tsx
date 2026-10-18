"use client";

import { useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ReleaseDevelopSyncNotice } from "@/components/dashboard/release-develop-sync";
import { Button } from "@/components/ui/button";
import type { RcBlockSummary } from "@/lib/release-rc";
import { requestRcProductionRecheck, requestReleaseCandidateCancel } from "@/lib/release-request";
import { productionKindNotice } from "@/lib/release-production-stop";
import type { ReleaseStartMode } from "@/lib/release-start-mode";
import { cn } from "@/lib/utils";

/**
 * リリース開始前に出す、既存候補・取得状態の案内（#4628）。PCの個別ボタン・スマホのシート・一括の確認が
 * 同じ判定（`ReleaseStartMode`）を同じ表示で出す。**候補がないものとは扱わない**: 取得中・取得失敗は
 * それぞれ「確認中」「取得不能」と出し、開始操作は呼び出し側が無効にする。
 */

const CHIP = "inline-flex items-center whitespace-nowrap rounded-full px-2 py-px text-[11px] font-semibold";

/** 折り畳み・一括の1行に出す短い理由。ブロックが無いときはnull */
export function releaseBlockShortLabel(mode: ReleaseStartMode | null): string | null {
  if (mode?.mode !== "blocked") return null;
  if (mode.block.kind === "production_stopped") return `${mode.block.label} 稼働確認が停止・開始できません`;
  return mode.block.kind === "inconsistent" ? `${mode.block.label} 状態不整合・開始できません` : `${mode.block.label} 進行中・開始できません`;
}

export function ReleaseBlockNotice({
  repositoryFullName,
  startMode,
  blockOverride = null,
  onChanged,
  className,
}: {
  repositoryFullName: string;
  /** 取得中は`null` */
  startMode: ReleaseStartMode | null;
  /** 起動の直前に見つかった既存候補（表示後に作られたもの）。`startMode`より優先する */
  blockOverride?: RcBlockSummary | null;
  /** 再確認・終了のあとに、開始方式を取り直させる */
  onChanged: () => void;
  className?: string;
}) {
  const block = blockOverride ?? (startMode?.mode === "blocked" ? startMode.block : null);
  if (!blockOverride && startMode?.mode === "develop_sync") {
    // 前回の公開がdevelopへ戻るまで開始できない（#4641）。同期PRと次の操作をその場で出す
    return <ReleaseDevelopSyncNotice repositoryFullName={repositoryFullName} sync={startMode.sync} onChanged={onChanged} showStartBlocked className={className} />;
  }

  const contractNotice = !block && startMode?.mode === "candidate" ? productionKindNotice(startMode.productionKind) : null;
  if (!block && startMode?.mode === "candidate" && !startMode.successorOf && contractNotice) {
    return (
      <p className={cn("break-words text-xs text-amber-700 dark:text-amber-300", className)} data-testid="release-contract-notice">
        稼働確認: {contractNotice}
      </p>
    );
  }
  if (!block && startMode?.mode === "candidate" && startMode.successorOf) {
    // 証拠未設定で止まった候補を、次の候補の稼働確認で確かめる（#4712）。開始はできるので、何が起きるかを先に出す
    const prior = startMode.successorOf;
    return (
      <div className={cn("flex flex-col gap-1 rounded-md border border-amber-500/50 p-2.5 text-xs", className)} data-testid="release-block-successor">
        <p>
          <span className="mr-1.5 font-mono font-bold">{prior.label}</span>
          <span className={cn(CHIP, "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300")}>{prior.statusLabel}</span>
        </p>
        <p className="break-words">{prior.reason}</p>
        <p className="break-words text-muted-foreground">
          developには稼働版の照合が入っているため、次の候補を開始できます。開始すると{prior.label}は「後続の稼働確認待ち」へ移り、次の候補の稼働確認で{prior.label}を含む版の稼働を確かめた時点で完了します（完了・取消とは記録しません）。
        </p>
      </div>
    );
  }
  if (!block) {
    if (startMode === null) {
      return (
        <p className={cn("text-xs text-muted-foreground", className)} data-testid="release-block-loading">
          既存の候補の有無と開始できるかを確認しています。確認できるまで開始できません。
        </p>
      );
    }
    if (startMode.mode === "unknown") {
      return (
        <div className={cn("flex flex-col gap-1.5 rounded-md border border-destructive/40 p-2.5", className)} data-testid="release-block-unavailable">
          <p className="text-xs">
            <span className={cn(CHIP, "mr-1.5 bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300")}>取得できません</span>
            <span>{startMode.label}</span>
            <span className="text-muted-foreground">　候補がないものとは扱いません。</span>
          </p>
          <div>
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={onChanged}>
              再取得
            </Button>
          </div>
        </div>
      );
    }
    if (startMode.mode === "legacy") return <p className={cn("text-xs text-muted-foreground", className)}>{startMode.label}</p>;
    return null;
  }
  return <BlockDetail repositoryFullName={repositoryFullName} block={block} stale={blockOverride !== null} onChanged={onChanged} className={className} />;
}

function BlockDetail({
  repositoryFullName,
  block,
  stale,
  onChanged,
  className,
}: {
  repositoryFullName: string;
  block: RcBlockSummary;
  stale: boolean;
  onChanged: () => void;
  className?: string;
}) {
  const inconsistent = block.kind === "inconsistent";
  const productionStopped = block.kind === "production_stopped";
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prUrl = block.prNumber === null ? null : `https://github.com/${repositoryFullName}/pull/${block.prNumber}`;

  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      await requestReleaseCandidateCancel(
        repositoryFullName,
        block,
        inconsistent ? "状態不整合（PRはマージ済みだが管理記録が残っていた）のため、画面から終了" : "リリース開始画面から終了",
      );
      setConfirming(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // 状態が変わっていた場合に備えて、表示を取り直す
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const recheck = async () => {
    setBusy(true);
    setError(null);
    try {
      await requestRcProductionRecheck(repositoryFullName, block.candidateId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  return (
    <div
      className={cn("flex min-w-0 flex-col gap-1.5 rounded-md border p-2.5", inconsistent || productionStopped ? "border-destructive/50" : "border-amber-500/50", className)}
      data-testid="release-block-notice"
      data-kind={block.kind}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-[13px] font-bold">{block.label}</span>
        <span className={cn(CHIP, inconsistent || productionStopped ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300" : "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300")}>
          {inconsistent ? "状態不整合" : block.statusLabel}
        </span>
        <span className={cn(CHIP, "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300")}>新規開始できません</span>
      </div>
      {stale && <p className="text-xs text-amber-700 dark:text-amber-300">表示後に別の候補が作られていました。二重には作成していません。</p>}
      <p className="break-words text-xs">{block.reason}</p>
      <ul className="list-disc pl-4 text-[11.5px] text-muted-foreground">
        {block.facts.map((fact) => (
          <li key={fact}>{fact}</li>
        ))}
        {block.unconfirmed.length > 0 && <li>未確認: {block.unconfirmed.join(" / ")}</li>}
        {inconsistent && <li>履歴・公開済みコード・版の追跡は残ります</li>}
      </ul>
      {productionStopped && block.action && <p className="break-words text-xs font-medium">次の操作: {block.action}</p>}
      {productionStopped && block.successorStart && !block.successorStart.allowed && (
        <p className="break-words text-[11.5px] text-muted-foreground">次の候補を始められない理由: {block.successorStart.reason}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {productionStopped ? (
          <>
            <Button size="sm" className="h-7 px-2 text-xs" disabled={busy} onClick={() => void recheck()}>
              {busy ? "確かめています…" : "稼働確認をやり直す"}
            </Button>
            {prUrl && (
              <Button size="sm" variant="outline" className="h-7 px-2 text-xs" asChild>
                <a href={prUrl} target="_blank" rel="noreferrer">
                  PR #{block.prNumber} を開く
                </a>
              </Button>
            )}
          </>
        ) : inconsistent ? (
          <>
            <Button size="sm" className="h-7 px-2 text-xs" onClick={onChanged}>
              候補の状態を再確認
            </Button>
            {prUrl && (
              <Button size="sm" variant="outline" className="h-7 px-2 text-xs" asChild>
                <a href={prUrl} target="_blank" rel="noreferrer">
                  PR #{block.prNumber} を開く
                </a>
              </Button>
            )}
            {block.cancellable && (
              <Button size="sm" variant="outline" className="h-7 px-2 text-xs text-destructive" onClick={() => setConfirming(true)}>
                管理記録を終了する…
              </Button>
            )}
          </>
        ) : (
          <>
            {prUrl ? (
              <Button size="sm" className="h-7 px-2 text-xs" asChild>
                <a href={prUrl} target="_blank" rel="noreferrer">
                  既存の候補を開く
                </a>
              </Button>
            ) : (
              <span className="text-[11.5px] text-muted-foreground">候補のPRを作成中です。作成が終わると既存の候補を開けます。</span>
            )}
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={onChanged}>
              状態を再確認
            </Button>
          </>
        )}
      </div>
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}

      <AlertDialog open={confirming} onOpenChange={(open) => !busy && setConfirming(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{block.label} の管理記録を終了しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              {repositoryFullName}の{block.label}（{block.prNumber === null ? "PRなし" : `PR #${block.prNumber}`}）を「中止」にして、新しい候補を開始できるようにします。
              履歴・検証結果・公開済みコードは消えません。PRがマージ済みの場合、マージ時点の版は消費済みとして残し、developへの同期の追跡も保ちます。
              検証合格や公開完了とは記録しません。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>やめる</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void cancel();
              }}
            >
              {busy ? "終了しています…" : "管理記録を終了する"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
