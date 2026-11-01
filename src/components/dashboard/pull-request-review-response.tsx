"use client";

import { ExternalLink, RefreshCw, Wrench } from "lucide-react";

import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import { PullRequestMergeButton } from "@/components/dashboard/pull-request-merge-button";
import { PullRequestRepairButtons } from "@/components/dashboard/pull-request-repair-buttons";
import { PullRequestReviewRerunButton } from "@/components/dashboard/pull-request-review-rerun-button";
import { Button } from "@/components/ui/button";
import { formatRelativeDate } from "@/lib/format-relative-date";
import { canMergeFromDeck } from "@/lib/pull-request-list";
import type { ReviewAction } from "@/lib/pull-request-review-action";
import { cn } from "@/lib/utils";
import type { PullRequestSummary } from "@/types/pull-request";

/** 対応パネルの位置。上部の「指摘に対応する」から指摘タブのここへ移動する */
export const REVIEW_RESPONSE_ANCHOR_ID = "pull-request-review-response";

/**
 * 自動レビューの要修正・要確認への対応パネル（#4482）。PR詳細の指摘タブの先頭に置き、
 * 上部の「指摘に対応する」はここへ移動する。表示は`deriveReviewAction`の結果だけから決める。
 *
 * - 要修正で自動修正が使えれば、既存の「PRを自動修正」（#4318の系列）を先頭に置く
 * - 自由文の修正依頼（Actions経由）は#4680で廃止済み。実行できないボタンは出さず、Issue詳細の
 *   ホストセッション・修正Issueの起案といった実際に使える操作だけを案内する
 * - 「修正せずにマージ」は既存のマージ確認（#4377）を必ず通る
 * - 要確認（人の確認待ち）は要修正（不具合）と色・文言・並びを分ける（#5158）。要確認ではマージ確認を先頭に置く
 * - 指摘の前提をコード以外で解消したときのため、現在のコミットのままAIレビューを再実行できる（#5158）
 * - 依頼できないときは理由と代わりの操作を出す（ボタンも案内も消える状態にしない）
 */
export function PullRequestReviewResponse({
  action,
  pullRequest,
  reviewUrl,
  onRefresh,
  onMerged,
  onDraftFixIssue,
  className,
}: {
  action: ReviewAction;
  pullRequest: PullRequestSummary;
  /** レビュー本文を読めないときの「GitHubで読む」の行き先 */
  reviewUrl: string | null;
  onRefresh: () => void;
  onMerged: () => void;
  onDraftFixIssue?: (pullRequest: PullRequestSummary) => void;
  className?: string;
}) {
  if (action.kind === "none") return null;

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
  if (action.kind === "requested") {
    const commentUrl = action.commentUrl;
    return (
      <StatusPanel className={className} tone="run" title="◷ 修正を依頼済みです">
        {action.createdAt ? `${formatRelativeDate(action.createdAt)}に` : ""}
        AIへ同じPRの修正を依頼しました
。
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

  const needsCheck = action.verdict === "needs-check";

  // 要確認は「人の確認が要る」の意味で、不具合の指摘ではない（#5158）。要修正と同じ琥珀色の枠・
  // 「対応を選んでください」で出すと失敗に見えるため、色と文言を分け、マージ確認を先に並べる
  const mergeOption = canMergeFromDeck(pullRequest) && (
    <Option title={needsCheck ? "確認して問題なければマージへ進む" : "修正せずにマージへ進む"}>
      <p className="text-xs text-muted-foreground">
        {needsCheck
          ? "指摘の点を確かめ、このままでよいと判断した場合。マージ確認の画面で指摘を確かめてから進みます。"
          : "指摘を読み、このままでよいと判断した場合。マージ確認の画面で指摘を確かめてから進みます。"}
      </p>
      <PullRequestMergeButton pullRequest={pullRequest} onMerged={onMerged} label="マージ確認へ進む" />
    </Option>
  );

  return (
    <section
      id={REVIEW_RESPONSE_ANCHOR_ID}
      aria-label="指摘への対応"
      data-testid="pull-request-review-response"
      data-verdict={action.verdict}
      className={cn(
        "flex scroll-mt-14 flex-col gap-2 rounded-lg border p-3",
        needsCheck ? "border-sky-500/50 bg-sky-50 dark:bg-sky-950/30" : "border-amber-500/60 bg-amber-50 dark:bg-amber-950/30",
        className,
      )}
    >
      <h3 className={cn("text-sm font-bold", needsCheck ? "text-sky-800 dark:text-sky-300" : "text-amber-800 dark:text-amber-300")}>
        {needsCheck ? (
          <>
            <span aria-hidden="true">◇</span> 人の確認を待っています
          </>
        ) : (
          <>
            <span aria-hidden="true">▲</span> この指摘への対応を選んでください
          </>
        )}
      </h3>
      {needsCheck && (
        <p className="text-xs text-muted-foreground">
          要確認は不具合の指摘ではなく、AIが自分では確かめられない点（仕様の判断・外部設定・手作業の実施など）を人に確かめてほしいという意味です。CIの結果とは別です。
        </p>
      )}

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

      {needsCheck && mergeOption}

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
              {action.autoRepairUnavailable ?? "このPRでは自動修正を起動できません。下の案内から、Issue詳細のホストセッションで修正を依頼してください。"}
            </p>
          )}
        </Option>
      )}

      <Option title="指摘の前提を解消したら、AIレビューをやり直す">
        <p className="text-xs text-muted-foreground">
          secretの同期・外部サービスの設定・別PRのマージなど、コードを変えずに指摘の原因を片付けた場合。コミットが変わらないとAIレビューは自動では走り直さないため、ここから現在のコミットのまま再実行します。
        </p>
        <PullRequestReviewRerunButton pullRequest={pullRequest} onChanged={onRefresh} />
      </Option>

      <Option title={needsCheck ? "確認の結果、修正が必要なら" : "指摘をAIに直してもらう"}>
        <p className="text-xs text-muted-foreground">
          このPRへ直接修正を依頼する操作は廃止しました。関連Issueの詳細からホストセッションを開いて指摘を伝えると、同じPRのブランチで修正できます。仕様の選択や実機での確認が要る点は、推測で直さずIssueで確かめてください。
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 basis-56 text-xs text-muted-foreground">{action.request.reason}</p>
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
      </Option>

      {!needsCheck && mergeOption}
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
