"use client";

import { useRef, useState } from "react";
import { GitMerge, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { updateBranchErrorMessage } from "@/lib/pull-request-update-branch";
import type { PullRequestSummary } from "@/types/pull-request";

/**
 * 通常PRの「最新のbase（マージ先）を取り込む」（#4626）。PC・スマホ共通のPR詳細に置く。
 *
 * headブランチへbaseをマージする操作で、画面の更新でも、headをbaseへマージする操作でもない。
 * 押すと`POST /api/pull-requests/update-branch`へ、画面が見ているheadSHAを添えて依頼する。
 * **依頼の受け付けと取り込み完了は別**で、受け付け後は「取り込みを依頼しました」を出し、
 * `onChanged`で最新状態（新しいhead・CI）を取り直す。
 */
export function PullRequestUpdateBranchButton({
  pullRequest,
  onChanged,
}: {
  pullRequest: PullRequestSummary;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestedFrom, setRequestedFrom] = useState<string | null>(null);
  const inFlight = useRef(false);
  const behind = pullRequest.mergeableState === "behind";
  // 依頼したheadから変わっていれば、取り込みが反映された（新しいSHAで検証が始まっている）
  const reflected = requestedFrom !== null && requestedFrom !== pullRequest.headSha;
  const waiting = requestedFrom !== null && !reflected;

  const run = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const [owner, repo] = pullRequest.repositoryFullName.split("/");
      const response = await fetch("/api/pull-requests/update-branch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, repo, number: pullRequest.number, headSha: pullRequest.headSha }),
      });
      if (!response.ok) {
        const payload: { error?: string } = await response.json().catch(() => ({}));
        setError(updateBranchErrorMessage(payload.error, pullRequest.baseRef));
        return;
      }
      setRequestedFrom(pullRequest.headSha);
      onChanged();
    } catch {
      setError(updateBranchErrorMessage(undefined, pullRequest.baseRef));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col items-start gap-1" data-testid="pull-request-update-branch">
      {behind && !waiting && (
        <p className="text-xs text-muted-foreground">
          最新の{pullRequest.baseRef}を取り込んでいないため、マージ待ちで止まっています。下のボタンで取り込むと、
          新しいコミットに対してCI・レビューが再開されます。
        </p>
      )}
      <Button
        size="sm"
        variant={behind ? "default" : "outline"}
        className="h-9 text-xs"
        disabled={busy || waiting}
        aria-busy={busy}
        onClick={run}
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <GitMerge className="size-3.5" />}
        {busy ? "依頼中…" : `最新の${pullRequest.baseRef}を取り込む`}
      </Button>
      {waiting && (
        <p role="status" className="text-xs text-muted-foreground">
          取り込みを依頼しました。新しいコミットが反映されるまで待っています（「更新」で再取得できます）。
        </p>
      )}
      {reflected && (
        <p role="status" className="text-xs text-muted-foreground">
          取り込みが反映されました。新しいコミットでCI・レビューが実行されます。
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
