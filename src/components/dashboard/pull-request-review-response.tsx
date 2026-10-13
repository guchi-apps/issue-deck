"use client";

import { ExternalLink, Loader2, MessageSquareText, RefreshCw, Wrench } from "lucide-react";
import { useState } from "react";

import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import { PullRequestMergeButton } from "@/components/dashboard/pull-request-merge-button";
import { PullRequestRepairButtons } from "@/components/dashboard/pull-request-repair-buttons";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatRelativeDate } from "@/lib/format-relative-date";
import { canMergeFromDeck } from "@/lib/pull-request-list";
import type { ReviewAction } from "@/lib/pull-request-review-action";
import { cn } from "@/lib/utils";
import type { PullRequestSummary } from "@/types/pull-request";

/** 対応パネルの位置。上部の「指摘に対応する」から指摘タブのここへ移動する */
export const REVIEW_RESPONSE_ANCHOR_ID = "pull-request-review-response";

type SendState =
  | { status: "idle" }
  | { status: "sending" }
  | { status: "sent"; duplicate: boolean; commentUrl: string | null; issueNumber: number }
  | { status: "error"; message: string };

/** サーバーが文言を返さなかった失敗の言い換え。権限不足・取得失敗を「失敗しました」に潰さない */
const INTERRUPT_REASON_LABEL: Record<string, string> = {
  check_user_added: "受付後に確認待ちが追加されました",
  issue_closed: "Issueがクローズされました",
  local_added: "ローカルセッションの対応に切り替わりました",
  run_failed: "実行が完了しませんでした",
};

const FALLBACK_ERROR_MESSAGE: Record<number, string> = {
  401: "ログインが切れています。ページを開き直してから送ってください。",
  403: "この操作を行う権限がありません。",
  404: "このリポジトリにアクセスできません。GitHub Appの導入先と権限を確かめてください。",
};

/**
 * 自動レビューの要修正・要確認への対応パネル（#4482）。PR詳細の指摘タブの先頭に置き、
 * 上部の「指摘に対応する」はここへ移動する。表示は`deriveReviewAction`の結果だけから決める。
 *
 * - 要修正で自動修正が使えれば、既存の「PRを自動修正」（#4318の系列）を先頭に置く
 * - 方針付きの依頼は既存の`requestPullRequestFix`（#4045）で、紐づくIssueへ`@claude`を書いて
 *   同じPRのブランチを直させる。方針は任意で、判断が要る点は推測で直さず質問させる
 * - 「修正せずにマージ」は既存のマージ確認（#4377）を必ず通る
 * - 依頼できないときは理由と代わりの操作を出す（ボタンも案内も消える状態にしない）
 */
export function PullRequestReviewResponse({
  action,
  pullRequest,
  reviewUrl,
  onRefresh,
  onRequested,
  onMerged,
  onDraftFixIssue,
  className,
}: {
  action: ReviewAction;
  pullRequest: PullRequestSummary;
  /** レビュー本文を読めないときの「GitHubで読む」の行き先 */
  reviewUrl: string | null;
  onRefresh: () => void;
  onRequested: () => void;
  onMerged: () => void;
  onDraftFixIssue?: (pullRequest: PullRequestSummary) => void;
  className?: string;
}) {
  const [policy, setPolicy] = useState("");
  const [send, setSend] = useState<SendState>({ status: "idle" });

  if (action.kind === "none") return null;

  const [owner, repo] = pullRequest.repositoryFullName.split("/");

  if (action.kind === "repairing") {
    return (
      <StatusPanel className={className} tone="run" title="◷ 自動修正が実行中です">
        完了するとCI・再レビューが自動で走ります。結果がそろうまで操作は不要です。
      </StatusPanel>
    );
  }
  if (action.kind === "stale") {
    return (
      <StatusPanel className={className} tone="run" title="◷ 再レビュー待ち">
        {action.verdict === "needs-check" ? "要確認" : "要修正"}の判定は前のHEAD
        {action.reviewedSha ? `（${action.reviewedSha.slice(0, 7)}）` : ""}に対するものです。最新HEADの
        再レビューを待っています（操作は不要です）。下の本文は前のHEADの指摘として読めます。
      </StatusPanel>
    );
  }
  if (action.kind === "requested" || send.status === "sent") {
    const commentUrl = action.kind === "requested" ? action.commentUrl : send.status === "sent" ? send.commentUrl : null;
    return (
      <StatusPanel className={className} tone="run" title="◷ 修正を依頼済みです">
        {action.kind === "requested" && action.createdAt ? `${formatRelativeDate(action.createdAt)}に` : ""}
        AIへ同じPRの修正を依頼しました
        {send.status === "sent" && send.duplicate ? "（同じ依頼が既にあったため、再送はしていません）" : ""}。
        pushされるとCI・再レビューが自動で走り、新しいHEADの結果がそろうまで解消済みにはしません（操作は不要です）。
        {commentUrl && (
          <a
            href={commentUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-1 inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline"
          >
            依頼コメントを開く
            <ExternalLink aria-hidden className="size-3" />
          </a>
        )}
      </StatusPanel>
    );
  }

  async function submit() {
    if (send.status === "sending") return;
    setSend({ status: "sending" });
    try {
      const response = await fetch("/api/pull-requests/fix-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner,
          repo,
          number: pullRequest.number,
          headSha: pullRequest.headSha,
          instruction: policy,
        }),
      });
      const payload: {
        message?: string;
        duplicate?: boolean;
        commentUrl?: string | null;
        issueNumber?: number;
      } = await response.json().catch(() => ({}));
      if (!response.ok) {
        setSend({
          status: "error",
          message:
            payload.message ?? FALLBACK_ERROR_MESSAGE[response.status] ?? "依頼を送れませんでした。時間をおいてもう一度試してください。",
        });
        return;
      }
      setSend({
        status: "sent",
        duplicate: payload.duplicate === true,
        commentUrl: payload.commentUrl ?? null,
        issueNumber: payload.issueNumber ?? 0,
      });
      onRequested();
    } catch {
      setSend({ status: "error", message: "IssueDeckへ接続できませんでした。通信状況を確かめてもう一度試してください。" });
    }
  }

  const needsCheck = action.verdict === "needs-check";
  const sending = send.status === "sending";

  return (
    <section
      id={REVIEW_RESPONSE_ANCHOR_ID}
      aria-label="指摘への対応"
      data-testid="pull-request-review-response"
      className={cn(
        "flex scroll-mt-14 flex-col gap-2 rounded-lg border border-amber-500/60 bg-amber-50 p-3 dark:bg-amber-950/30",
        className,
      )}
    >
      <h3 className="text-sm font-bold text-amber-800 dark:text-amber-300">
        <span aria-hidden="true">▲</span> この指摘への対応を選んでください
      </h3>

      {!action.bodyAvailable && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 basis-56">
            {needsCheck ? "要確認" : "要修正"}の判定はありますが、指摘の本文をこの画面で読み込めませんでした。
          </span>
          <Button size="sm" variant="outline" className="h-9 text-xs" onClick={onRefresh}>
            <RefreshCw className="size-3.5" />
            再読み込み
          </Button>
          {reviewUrl && (
            <a
              href={reviewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-9 items-center gap-1 text-xs text-foreground hover:underline"
            >
              GitHubで読む
              <ExternalLink aria-hidden className="size-3" />
            </a>
          )}
        </div>
      )}

      {action.verdict === "changes-requested" && (
        <Option title="指摘を自動で直す（PRを自動修正）">
          <p className="text-xs text-muted-foreground">
            Claude Codeが指摘を読んで同じPRを直し、CI・再レビューまで進めます（最大3回）。判断が要る指摘は直さず、Issueで確認を求めます。
          </p>
          {action.autoRepair ? (
            <PullRequestRepairButtons
              repositoryFullName={pullRequest.repositoryFullName}
              pullRequestNumber={pullRequest.number}
              kinds={["review"]}
              availability={pullRequest.repairWorkflowAvailability}
              runningKind={null}
            />
          ) : (
            <p className="text-xs text-amber-800 dark:text-amber-300">
              {action.autoRepairUnavailable ?? "このPRでは自動修正を起動できません。下の「AIに修正を依頼」を使ってください。"}
            </p>
          )}
        </Option>
      )}

      <Option title={needsCheck ? "AIに調査・修正を依頼する" : "方針を書いてAIに修正を依頼する"}>
        <p className="text-xs text-muted-foreground">
          指摘を読み、コードで直せるものは同じPRで直してpushします（CI・再レビューは自動で走ります）。仕様の選択や実機での確認が要る点は推測で直さず、Issueで質問します。
        </p>
        {action.request.available ? (
          <>
            <Textarea
              value={policy}
              onChange={(event) => setPolicy(event.target.value)}
              maxLength={4000}
              disabled={sending}
              aria-label="修正の方針（任意）"
              placeholder="方針があれば書いてください（任意）。例：未達の要件は別Issueに分けるので、このPRでは準備中の判定だけ直す"
              className="min-h-20 bg-background text-sm"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                className="h-9 text-xs"
                variant={action.autoRepair ? "outline" : "default"}
                disabled={sending}
                onClick={() => void submit()}
              >
                {sending ? <Loader2 className="size-3.5 animate-spin" /> : <MessageSquareText className="size-3.5" />}
                {sending ? "依頼を送っています…" : "AIに修正を依頼"}
              </Button>
              {action.request.issueNumber !== null && (
                <span className="text-[11px] text-muted-foreground">
                  Issue #{action.request.issueNumber} へあなたの名前で依頼コメントを投稿します
                </span>
              )}
            </div>
            {action.interrupted && (
              <p role="status" className="text-xs text-amber-800 dark:text-amber-300">
                直前の依頼は{action.interrupted.kind === "aborted" ? "実行前に中止されました" : "実行に失敗しました"}
                （{INTERRUPT_REASON_LABEL[action.interrupted.reason] ?? "理由は結果コメントを確認してください"}）。
                「AIに修正を依頼」を押すと同じ依頼を再送します。
                {action.interrupted.resultUrl && (
                  <a
                    href={action.interrupted.resultUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-1 underline-offset-2 hover:underline"
                  >
                    結果コメントを開く
                  </a>
                )}
              </p>
            )}
            {action.requestLookupFailed && (
              <p className="text-[11px] text-muted-foreground">
                依頼済みかを確かめられませんでした。同じ内容を送り直しても、二重には依頼されません。
              </p>
            )}
            {send.status === "error" && (
              <p role="alert" className="text-xs text-destructive">
                {send.message}
              </p>
            )}
          </>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 basis-56 text-xs text-amber-800 dark:text-amber-300">{action.request.reason}</p>
            {action.request.alternative === "draft-fix-issue" && onDraftFixIssue && (
              <Button size="sm" variant="outline" className="h-9 text-xs" onClick={() => onDraftFixIssue(pullRequest)}>
                <Wrench className="size-3.5" />
                修正Issueを起案
              </Button>
            )}
            {action.request.alternative === "open-issue" && pullRequest.linkedIssueNumber !== null && (
              <GithubReferenceLink
                href={`https://github.com/${pullRequest.repositoryFullName}/issues/${pullRequest.linkedIssueNumber}`}
                reference={{
                  repositoryFullName: pullRequest.repositoryFullName,
                  number: pullRequest.linkedIssueNumber,
                  kind: "issue",
                }}
                className="inline-flex h-9 items-center rounded-md border px-3 text-xs font-medium hover:bg-muted"
              >
                Issue #{pullRequest.linkedIssueNumber} を開く
              </GithubReferenceLink>
            )}
            {/* 起案の導線を渡さない画面でも、代わりの操作を必ず1つ残す */}
            <a
              href={pullRequest.htmlUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-9 items-center gap-1 text-xs text-foreground hover:underline"
            >
              PRをGitHubで開く
              <ExternalLink aria-hidden className="size-3" />
            </a>
          </div>
        )}
      </Option>

      {canMergeFromDeck(pullRequest) && (
        <Option title="修正せずにマージへ進む">
          <p className="text-xs text-muted-foreground">
            指摘を読み、このままでよいと判断した場合。マージ確認の画面で指摘を確かめてから進みます。
          </p>
          <PullRequestMergeButton pullRequest={pullRequest} onMerged={onMerged} label="マージ確認へ進む" />
        </Option>
      )}
    </section>
  );
}

function Option({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border bg-card p-2.5">
      <p className="text-xs font-semibold">{title}</p>
      {children}
    </div>
  );
}

function StatusPanel({
  title,
  tone,
  children,
  className,
}: {
  title: string;
  tone: "run";
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      id={REVIEW_RESPONSE_ANCHOR_ID}
      aria-label="指摘への対応"
      data-testid="pull-request-review-response"
      data-tone={tone}
      className={cn(
        "flex scroll-mt-14 flex-col gap-1 rounded-lg border border-blue-500/40 bg-blue-50 p-3 text-xs text-muted-foreground dark:bg-blue-950/30",
        className,
      )}
    >
      <h3 className="text-sm font-bold text-blue-700 dark:text-blue-400">{title}</h3>
      <p>{children}</p>
    </section>
  );
}
