"use client";

import { useRef, useState } from "react";
import { Loader2, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { reviewRerunErrorMessage } from "@/lib/pull-request-review-rerun";
import type { PullRequestSummary } from "@/types/pull-request";

/**
 * 「AIレビューを再実行」（#5158）。現在のコミットのAIレビューをやり直す。
 * secretの同期・外部設定など、コードを変えずに指摘の前提を解消したときに使う。
 * 依頼後は判定が更新されるまで「依頼済み」を出し、押せる状態に戻さない（連打はサーバーも409で止める）。
 */
export function PullRequestReviewRerunButton({
  pullRequest,
  onChanged,
}: {
  pullRequest: PullRequestSummary;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [requestedSha, setRequestedSha] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const requested = requestedSha === pullRequest.headSha;

  const rerun = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const [owner, repo] = pullRequest.repositoryFullName.split("/");
    try {
      const response = await fetch("/api/pull-requests/review-rerun", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, repo, number: pullRequest.number, headSha: pullRequest.headSha }),
      });
      if (!response.ok) {
        const payload: { error?: string } = await response.json().catch(() => ({}));
        setError(reviewRerunErrorMessage(payload.error));
        return;
      }
      setRequestedSha(pullRequest.headSha);
      onChanged();
    } catch {
      setError(reviewRerunErrorMessage(undefined));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col items-start gap-1" data-testid="pull-request-review-rerun">
      <Button size="sm" variant="outline" className="h-9 text-xs" disabled={busy || requested} onClick={rerun}>
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCw className="size-3.5" />}
        AIレビューを再実行
      </Button>
      <p className="text-[11px] text-muted-foreground">
        対象: 現在のコミット（{pullRequest.headSha.slice(0, 7)}）のAIレビュー。コードは変わりません。
      </p>
      {requested && (
        <p role="status" className="text-[11px] text-muted-foreground">
          再実行を依頼しました。数分で判定が更新されます（「更新」で最新の状態を取り直せます）。
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
