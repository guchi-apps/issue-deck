"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ciRerunErrorMessage, type CiRerunRun, type CiRerunScope } from "@/lib/pull-request-ci-rerun";
import type { PullRequestSummary } from "@/types/pull-request";

/**
 * CIの再実行（#4626）。**現在のheadのCI run**だけを再実行し、失敗分と全体を別のボタンにする。
 * AIレビューの再実行・デプロイ・リリース系のworkflowは対象外。
 *
 * 対象のworkflow名・状態・SHAはボタンの下に出す。再実行の依頼後は、実行中になるまで
 * 以前の結果を「合格」として見せない（`pending`表示にして、再取得で実際の状態へ戻す）。
 */
export function PullRequestCiRerunButtons({
  pullRequest,
  onChanged,
  onPendingRequestChange,
}: {
  pullRequest: PullRequestSummary;
  onChanged: () => void;
  /** 再実行の依頼後、まだ実行中の間だけtrue。閉じたアコーディオン行のサマリに出すため親へ知らせる（#5171） */
  onPendingRequestChange?: (pending: boolean) => void;
}) {
  const [runs, setRuns] = useState<CiRerunRun[] | null>(null);
  const [busy, setBusy] = useState<CiRerunScope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requested, setRequested] = useState(false);
  const inFlight = useRef(false);
  const [owner, repo] = pullRequest.repositoryFullName.split("/");

  const load = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/pull-requests/ci-rerun?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}&number=${pullRequest.number}`,
      );
      if (!response.ok) return;
      const payload: { runs?: CiRerunRun[] } = await response.json();
      setRuns(payload.runs ?? []);
    } catch {
      /* 一覧が取れなくても再実行ボタンは出す */
    }
  }, [owner, repo, pullRequest.number]);

  // headが変わったら（再実行・取り込み後を含む）対象runを取り直す。CI状態の変化でも取り直す
  useEffect(() => {
    // 外部（GitHub）の状態を取り込む同期のため、effect内での更新は意図どおり
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, pullRequest.headSha, pullRequest.ciState]);

  const run = async (scope: CiRerunScope) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(scope);
    setError(null);
    try {
      const response = await fetch("/api/pull-requests/ci-rerun", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, repo, number: pullRequest.number, headSha: pullRequest.headSha, scope }),
      });
      if (!response.ok) {
        const payload: { error?: string } = await response.json().catch(() => ({}));
        setError(ciRerunErrorMessage(payload.error));
        return;
      }
      const result: { failedRuns?: { name: string | null; id: number }[] } = await response.json().catch(() => ({}));
      if (result.failedRuns && result.failedRuns.length > 0) {
        setError(
          `一部のCIは再実行できませんでした（${result.failedRuns.map((r) => r.name ?? `run ${r.id}`).join("、")}）。残りは再実行を依頼済みです。`,
        );
      }
      setRequested(true);
      void load();
      onChanged();
    } catch {
      setError(ciRerunErrorMessage(undefined));
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  const running = runs?.some((r) => r.status !== "completed") ?? false;
  const disabled = busy !== null || running;
  const pendingRequest = requested && running;

  useEffect(() => {
    onPendingRequestChange?.(pendingRequest);
    return () => onPendingRequestChange?.(false);
  }, [pendingRequest, onPendingRequestChange]);

  return (
    <div className="flex min-w-0 flex-col items-start gap-1" data-testid="pull-request-ci-rerun">
      <p className="text-[11px] font-semibold text-muted-foreground">
        CIを再実行（現在のコミット {pullRequest.headSha.slice(0, 7)}）
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" className="h-8 text-xs" disabled={disabled} onClick={() => run("failed")}>
          {busy === "failed" ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCw className="size-3.5" />}
          失敗したCIを再実行
        </Button>
        <Button size="sm" variant="outline" className="h-8 text-xs" disabled={disabled} onClick={() => run("all")}>
          {busy === "all" ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCw className="size-3.5" />}
          CIをすべて再実行
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {running ? "実行中は押せません。" : ""}AIレビューは再実行されません。
      </p>
      {runs && runs.length === 0 && (
        <p className="text-[11px] text-muted-foreground">
          このコミットのCI実行記録はありません。最新の{pullRequest.baseRef}を取り込むとCIが起動します。
        </p>
      )}
      {runs && runs.length > 0 && (
        <ul className="text-[11px] text-muted-foreground">
          {runs.map((r) => (
            <li key={r.id} className="break-words">
              {r.name ?? r.path ?? `run ${r.id}`}: {r.status === "completed" ? (r.conclusion ?? "完了") : "実行中"}
            </li>
          ))}
        </ul>
      )}
      {pendingRequest && (
        <p role="status" className="text-[11px] text-muted-foreground">
          再実行を依頼しました。完了するまで以前の結果は現在の結果として扱われません。
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
