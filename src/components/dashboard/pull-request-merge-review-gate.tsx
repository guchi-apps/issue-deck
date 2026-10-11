"use client";

import { useEffect, useState } from "react";

import { MarkdownBody } from "@/components/dashboard/markdown-body";
import { MergeHoldNotice } from "@/components/dashboard/pull-request-merge-hold";
import { Button } from "@/components/ui/button";
import { usePullRequestRepairMutation } from "@/hooks/use-pull-request-repair-mutation";
import { deriveMergeHold } from "@/lib/pull-request-merge-hold";
import type { PullRequestReviewCommentContent } from "@/lib/github/pull-request-review-comment";
import type { PullRequestSummary } from "@/types/pull-request";

type FindingsState =
  | { status: "loading" }
  | { status: "ready"; review: PullRequestReviewCommentContent | null; headSha: string | null }
  | { status: "failed" };

/**
 * 要修正のPRをマージしようとしたときに、確認ダイアログの中へ出す（#4377）。
 *
 * 主操作は「PRを自動修正」（#3970の修復経路。`/api/pull-requests/repair`）。「修正せずマージする」は
 * 副次で、未修正のまま通すことの明示確認（チェック）を済ませるまで押せない。確認はこの画面を開いた
 * 時点に取り直したHEADのSHAに紐付けて送り、閉じる・戻るだけでは何も実行しない。
 * 開いている間にHEADが動いたら、古い確認を流用せず更新内容を出して確認し直させる。
 */
export function PullRequestMergeReviewGate({
  pullRequest,
  open,
  isMerging,
  serverRequestedHeadSha,
  onMergeWithoutFix,
  onClose,
}: {
  pullRequest: PullRequestSummary;
  open: boolean;
  isMerging: boolean;
  /** サーバーが確認を求め直した（HEADが変わっていた）ときの最新HEAD。無ければnull */
  serverRequestedHeadSha: string | null;
  onMergeWithoutFix: (headSha: string) => void;
  onClose: () => void;
}) {
  const [owner, repo] = pullRequest.repositoryFullName.split("/");
  const [findings, setFindings] = useState<FindingsState>({ status: "loading" });
  // 確認は付けたときのHEADにだけ有効。HEADが変わると自然に外れる（effectで戻さない）
  const [understoodSha, setUnderstoodSha] = useState<string | null>(null);
  const [repairStarted, setRepairStarted] = useState(false);
  const { repairPullRequest, isSubmitting: isRepairing, error: repairError } =
    usePullRequestRepairMutation();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/pull-requests/review?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}&number=${pullRequest.number}`,
        );
        if (!res.ok) throw new Error(String(res.status));
        const data: { review: PullRequestReviewCommentContent | null; headSha?: string } = await res.json();
        if (!cancelled) {
          setFindings({ status: "ready", review: data.review, headSha: data.headSha ?? null });
        }
      } catch {
        if (!cancelled) setFindings({ status: "failed" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, owner, repo, pullRequest.number]);

  const liveHeadSha = findings.status === "ready" ? findings.headSha : null;
  const headMoved =
    (liveHeadSha !== null && liveHeadSha.toLowerCase() !== pullRequest.headSha.toLowerCase()) ||
    serverRequestedHeadSha !== null;
  // 確認はHEADごとにやり直す。取得できていない間は例外マージに進ませない
  const ackSha = serverRequestedHeadSha ?? liveHeadSha;

  const understood = ackSha !== null && understoodSha === ackSha;

  async function runRepair() {
    if (await repairPullRequest({ owner, repo, number: pullRequest.number })) {
      setRepairStarted(true);
    }
  }

  const hold = deriveMergeHold(pullRequest);

  return (
    <div className="flex flex-col gap-3 text-left text-sm" data-testid="merge-review-gate">
      <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
        自動レビューが「{pullRequest.reviewVerdict?.reviewLabel ?? "要修正"}」と判定しています。
        指摘を直さないままマージすると、未修正のままdevelopへ入ります。
      </p>
      <MergeHoldNotice hold={hold} />

      <div className="rounded-lg border">
        <div className="border-b bg-muted/50 px-3 py-1.5 text-xs font-semibold">最新のレビュー指摘</div>
        <div className="max-h-56 overflow-y-auto px-3 py-2 text-xs">
          {findings.status === "loading" && <p className="text-muted-foreground">指摘を取得しています…</p>}
          {findings.status === "failed" && (
            <p className="text-destructive">
              レビュー指摘を取得できませんでした。PRのレビューコメントで内容を確認してください。
            </p>
          )}
          {findings.status === "ready" &&
            (findings.review ? (
              <MarkdownBody content={findings.review.body} className="text-xs" />
            ) : (
              <p className="text-muted-foreground">
                レビュー本文の記録がありません。指摘はPRのコメントで確認してください。
              </p>
            ))}
        </div>
      </div>

      {headMoved && (
        <p role="status" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
          確認中にPRのHEADが更新されました（最新: {(ackSha ?? "").slice(0, 7)}）。上の内容は更新後のものです。
          未修正のままマージする場合は、確認し直してください。
        </p>
      )}

      {repairStarted ? (
        <p className="text-xs text-muted-foreground">
          PRを自動修正しています。修正後のCI・再レビューの結果はPRのコメントに届きます。
        </p>
      ) : (
        <Button className="w-full" onClick={runRepair} disabled={isRepairing || isMerging}>
          {isRepairing ? "起動中..." : "PRを自動修正"}
        </Button>
      )}
      {repairError && <p className="text-xs text-destructive">{repairError}</p>}

      <div className="flex flex-col gap-2 border-t pt-3">
        <label className="flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={understood}
            onChange={(event) => setUnderstoodSha(event.target.checked ? ackSha : null)}
            disabled={ackSha === null || isMerging}
          />
          <span>指摘を直さないまま、このPRをマージすることを確認しました</span>
        </label>
        <Button
          variant="outline"
          className="w-full"
          disabled={!understood || ackSha === null || isMerging}
          onClick={() => ackSha && onMergeWithoutFix(ackSha)}
        >
          {isMerging ? "マージ中..." : "修正せずマージする"}
        </Button>
        <Button variant="ghost" className="w-full" onClick={onClose} disabled={isMerging}>
          キャンセル
        </Button>
      </div>
    </div>
  );
}
