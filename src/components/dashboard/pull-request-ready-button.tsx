"use client";

import { useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { readyForReviewErrorMessage } from "@/lib/pull-request-ready-for-review";
import type { PullRequestSummary } from "@/types/pull-request";

/**
 * ドラフトPRの「レビュー可能にする」（#4453）。PR詳細の主操作カードにだけ置く。
 *
 * サーバーが現在のPRを取り直して判定する（`POST /api/pull-requests/ready-for-review`）。
 * **成功したらドラフト表示を自分では消さず、`onChanged`で最新状態を取り直す。**
 * 失敗時はドラフト表示を保ち、理由と再試行方法を出す。
 */
export function PullRequestReadyButton({
  pullRequest,
  onChanged,
}: {
  pullRequest: PullRequestSummary;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // stateの更新は次の描画まで反映されないため、連打の2回目を同期的に止める
  const inFlight = useRef(false);

  const run = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const [owner, repo] = pullRequest.repositoryFullName.split("/");
      const response = await fetch("/api/pull-requests/ready-for-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, repo, number: pullRequest.number, headSha: pullRequest.headSha }),
      });
      if (!response.ok) {
        const payload: { error?: string } = await response.json().catch(() => ({}));
        setError(readyForReviewErrorMessage(payload.error));
        return;
      }
      onChanged();
    } catch {
      setError(readyForReviewErrorMessage(undefined));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <Button size="sm" className="h-9 text-xs" disabled={busy} aria-busy={busy} onClick={run}>
        {busy && <Loader2 className="size-3.5 animate-spin" />}
        {busy ? "切り替え中…" : "レビュー可能にする"}
      </Button>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
