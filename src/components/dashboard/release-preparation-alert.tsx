"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Loader2, RotateCcw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatMonthDayTime } from "@/lib/format-date-time";
import type { ReleasePreparationFailureView } from "@/lib/release-preparation";
import { cn } from "@/lib/utils";

type FailureWithAction = ReleasePreparationFailureView & { nextAction: string };

/**
 * リリース準備（バンプPR・リリースPRの作成）が失敗したときの帯（#4335）。
 *
 * 失敗は共通のリリース処理1件なので、個別Issueへ確認待ちを付けず**リリース画面にまとめて出す**。
 * 失敗した工程・エラー行はサーバーがGitHubから取り直したもの（`ReleasePreparationFailure`）。
 * 取得はDBだけで、GitHub APIは叩かない（PCのブランチ画面の前提を崩さない）。失敗が無ければ何も出さない。
 *
 * 「再開」は同じ上げ幅でリリースworkflowを起動し直す。帯は、次のrunで準備が進んだ報告が届くまで
 * 消えない（押しただけで解決扱いにしない）。
 */
export function ReleasePreparationAlert({
  repositoryFullName,
  onResumed,
  className,
}: {
  repositoryFullName: string;
  onResumed?: () => void;
  className?: string;
}) {
  const [owner, repo] = repositoryFullName.split("/");
  const [failure, setFailure] = useState<FailureWithAction | null>(null);
  const [resuming, setResuming] = useState(false);
  const [resumed, setResumed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/repositories/release/preparation?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`);
      if (!res.ok) return;
      const data = await res.json().catch(() => null);
      setFailure(data?.failure ?? null);
    } catch {
      // 取れなければ出さない（帯は補助で、取得失敗を失敗の表示と取り違えない）
    }
  }, [owner, repo]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 取得結果の反映（同期的なsetStateではない）
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  if (!failure) return null;

  async function resume() {
    if (!failure || resuming) return;
    setResuming(true);
    setMessage(null);
    try {
      const res = await fetch("/api/repositories/release/preparation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, repo, failureId: failure.id }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        setResumed(true);
        setMessage("リリースworkflowを起動しました。準備が進むとこの表示は消えます。");
        onResumed?.();
      } else if (data?.error === "failure_changed") {
        setMessage("状態が変わっていました。表示を更新します。");
        void load();
      } else {
        setMessage("起動できませんでした。時間をおいて押し直すか、実行ログを確認してください。");
      }
    } catch {
      setMessage("通信に失敗しました。押し直してください。");
    } finally {
      setResuming(false);
    }
  }

  const failedAt = formatMonthDayTime(failure.createdAt);

  return (
    <div
      role="alert"
      className={cn("flex min-w-0 flex-col gap-2 rounded-lg border border-destructive bg-destructive/10 p-3", className)}
    >
      <p className="flex items-center gap-1.5 text-sm font-semibold text-destructive">
        <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
        リリース準備に失敗しました
      </p>
      <p className="text-xs leading-relaxed">
        {failedAt}のリリースworkflowが、バンプPR・リリースPRを作る前に止まりました。
        <span className="font-medium">個別のIssueは本番反映待ちのままです</span>（確認待ちにはしていません）。
      </p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">失敗した工程</dt>
        <dd className="break-words">{failure.stepName ?? "取得できませんでした"}</dd>
      </dl>
      {failure.errorExcerpt && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-background/60 p-2 text-[11px] leading-snug">
          {failure.errorExcerpt}
        </pre>
      )}
      <p className="text-xs leading-relaxed">{failure.nextAction}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" className="h-8" disabled={resuming || resumed} onClick={() => void resume()}>
          {resuming ? <Loader2 className="animate-spin" /> : <RotateCcw />}
          {resumed ? "起動済み" : "再開"}
        </Button>
        <a
          href={failure.runUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          実行ログ
          <ExternalLink className="size-3" aria-hidden="true" />
        </a>
      </div>
      {message && <p className="text-xs text-muted-foreground">{message}</p>}
    </div>
  );
}
