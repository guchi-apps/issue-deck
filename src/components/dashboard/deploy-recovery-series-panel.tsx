"use client";

import { useEffect, useState } from "react";
import { Bot, ExternalLink, Loader2, Square } from "lucide-react";

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
import { Button } from "@/components/ui/button";
import { DEPLOY_RECOVERY_MAX_REPAIR_ROUNDS } from "@/lib/deploy-recovery-series";
import type { DeployRecoverySeriesView } from "@/lib/deploy-recovery-series-run";
import { cn } from "@/lib/utils";

const POLL_INTERVAL_MS = 15_000;

type Props = {
  repositoryFullName: string;
  /** 帯が出している失敗のrun id。無ければ開始できない */
  runId: number | null;
  block?: boolean;
};

/**
 * デプロイ失敗の帯の主要操作「AIに修正を依頼」と、その復旧系列の状態（#3998）。
 *
 * 開始は1回だけで、以後の工程（修正Issue・実装・修正PRの修復）ごとの再承認は求めない。
 * 押す前に**どこまで自動で進めるか**をダイアログで示す。第1段は修正PRがdevelopへ入るまでで、
 * 本番（main）へは出さない。
 */
export function DeployRecoverySeriesPanel({ repositoryFullName, runId, block = false }: Props) {
  const [owner, repo] = repositoryFullName.split("/");
  const [series, setSeries] = useState<DeployRecoverySeriesView | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void fetchSeries(owner, repo).then((value) => {
      if (!cancelled && value !== undefined) setSeries(value);
    });
    return () => {
      cancelled = true;
    };
  }, [owner, repo, reloadKey]);

  // この失敗の系列か、進行中の系列だけを出す。過去の別の失敗の結果は混ぜない。
  const shown = series && (series.active || series.failedRunId === runId) ? series : null;

  useEffect(() => {
    if (!shown?.active) return;
    const timer = setInterval(() => setReloadKey((key) => key + 1), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [shown?.active]);

  async function start() {
    if (runId === null) return;
    setBusy("start");
    setError(null);
    try {
      const res = await fetch("/api/repositories/deploy-recovery-series", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, repo, runId }),
      });
      const data = await res.json().catch(() => null);
      if (data?.series) setSeries(data.series);
      if (!res.ok) {
        setError(
          data?.error === "series_active"
            ? "このリポジトリでは別の失敗の復旧が進行中です。"
            : data?.error === "not_latest_failure"
              ? "この失敗の後に新しいデプロイが走っています。画面を更新してください。"
              : data?.error === "deploy_not_failed"
                ? "この実行は失敗していないため、復旧を始められません。"
                : "開始できませんでした。時間をおいて押し直してください。",
        );
      }
    } catch {
      setError("通信に失敗しました。押し直してください。");
    } finally {
      setBusy(null);
      setConfirmOpen(false);
    }
  }

  async function stop() {
    if (!shown) return;
    setBusy("stop");
    setError(null);
    try {
      const res = await fetch("/api/repositories/deploy-recovery-series", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, repo, seriesId: shown.id }),
      });
      const data = await res.json().catch(() => null);
      if (data?.series) setSeries(data.series);
      if (!res.ok) setError("停止できませんでした。押し直してください。");
    } catch {
      setError("通信に失敗しました。押し直してください。");
    } finally {
      setBusy(null);
    }
  }

  const github = `https://github.com/${repositoryFullName}`;
  const canStart = runId !== null && !shown?.active && shown?.failedRunId !== runId;

  return (
    <div className={cn("flex flex-col gap-1.5", block && "w-full")}>
      {canStart && (
        <Button
          size="sm"
          className={block ? "h-8 w-full justify-center gap-1" : "h-6 gap-1 px-2 text-xs"}
          onClick={() => setConfirmOpen(true)}
          disabled={busy !== null}
        >
          {busy === "start" ? <Loader2 className="size-3 animate-spin" aria-hidden="true" /> : <Bot className="size-3" aria-hidden="true" />}
          AIに修正を依頼
        </Button>
      )}

      {shown && (
        <div className="flex flex-col gap-1 rounded-md border bg-background/70 p-2 text-xs">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-semibold">AIによる修正:</span>
            <span
              className={cn(
                "rounded-full border px-2 py-0.5",
                shown.status === "needs_attention" || shown.status === "awaiting_release"
                  ? "border-destructive text-destructive"
                  : "text-foreground",
              )}
            >
              {shown.statusLabel}
            </span>
            <span className="text-muted-foreground">
              修復 {shown.repairRoundsUsed}/{DEPLOY_RECOVERY_MAX_REPAIR_ROUNDS}回
            </span>
            {shown.active && (
              <button
                type="button"
                onClick={() => void stop()}
                disabled={busy !== null}
                className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 hover:bg-muted disabled:opacity-60"
              >
                {busy === "stop" ? <Loader2 className="size-3 animate-spin" aria-hidden="true" /> : <Square className="size-3" aria-hidden="true" />}
                停止
              </button>
            )}
          </p>
          {shown.stopMessage && <p className="leading-relaxed">{shown.stopMessage}</p>}
          {shown.status === "awaiting_release" && (
            <p className="leading-relaxed">
              修正はdevelopへ入りました。<span className="font-medium">本番へはまだ出ていません。</span>
              「既存の修正PRを選んで復旧」かリリースで反映してください。
            </p>
          )}
          <p className="flex flex-wrap gap-x-3 gap-y-1">
            {shown.issueNumber !== null && (
              <ExternalAnchor href={`${github}/issues/${shown.issueNumber}`}>修正Issue #{shown.issueNumber}</ExternalAnchor>
            )}
            {shown.pullRequestNumber !== null && (
              <ExternalAnchor href={`${github}/pull/${shown.pullRequestNumber}`}>修正PR #{shown.pullRequestNumber}</ExternalAnchor>
            )}
            <ExternalAnchor href={shown.failedRunUrl}>失敗した実行</ExternalAnchor>
          </p>
        </div>
      )}

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>AIに修正を依頼しますか</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-2 text-sm">
                <p>この失敗に限って、次の工程を確認なしで自動で進めます。</p>
                <ol className="list-decimal pl-5">
                  <li>原因を調べ、区分（コード・設定・DB・外部障害）を判定する</li>
                  <li>コードの問題なら修正Issueと修正PRを作る</li>
                  <li>CI・レビューで指摘があれば最大{DEPLOY_RECOVERY_MAX_REPAIR_ROUNDS}回まで直す</li>
                  <li>developへマージされたら、本番反映待ちとして知らせる</li>
                </ol>
                <p>
                  本番（main）への反映と再デプロイは、いまは自動で行いません。コード以外の原因・上限・24時間の期限に
                  達したときは止めて知らせます。途中でいつでも停止できます。
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy !== null}>やめる</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void start();
              }}
              disabled={busy !== null}
            >
              {busy === "start" && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
              開始する
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** 直近の系列を読む。取得に失敗したときはundefined（表示を変えない） */
async function fetchSeries(owner: string, repo: string): Promise<DeployRecoverySeriesView | null | undefined> {
  try {
    const params = new URLSearchParams({ owner, repo });
    const res = await fetch(`/api/repositories/deploy-recovery-series?${params.toString()}`, { cache: "no-store" });
    if (!res.ok) return undefined;
    const data = (await res.json().catch(() => null)) as { series?: DeployRecoverySeriesView | null } | null;
    return data?.series ?? null;
  } catch {
    // 表示用の取得。失敗しても帯の他の操作は使える
    return undefined;
  }
}

function ExternalAnchor({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
      <ExternalLink className="size-3" aria-hidden="true" />
      {children}
    </a>
  );
}
