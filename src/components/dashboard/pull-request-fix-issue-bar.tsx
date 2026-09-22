"use client";

import { useState } from "react";
import { AlertCircle, ExternalLink, Loader2, Pencil, Plus, Wrench } from "lucide-react";

import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import type { IssueSuggestion } from "@/components/dashboard/mention-textarea";
import { PullRequestFixSessionDialog } from "@/components/dashboard/pull-request-fix-session-dialog";
import { ReviewVerdictFreshnessNote } from "@/components/dashboard/review-verdict";
import { Button } from "@/components/ui/button";
import { prFixRequestActionLabel, type PrFixRequestRoute } from "@/lib/dispatch/pr-fix-request";
import {
  buildPullRequestFixIssueDraft,
  buildPullRequestFixReason,
  resolvePullRequestFixIssueTone,
  selectOpenChangeRequests,
  type PullRequestFixIssueDraft,
  type PullRequestFixRoute,
} from "@/lib/github/pull-request-fix-issue";
import {
  selectPullRequestReviewComment,
  type PullRequestReviewCommentContent,
} from "@/lib/github/pull-request-review-comment";
import { resolveReviewVerdictFreshness } from "@/lib/github/review-verdict-freshness";
import { isMergeJudgementPending } from "@/lib/pull-request-list";
import { cn } from "@/lib/utils";
import type { Issue } from "@/types/issue";
import type { PullRequestEvent, PullRequestSummary } from "@/types/pull-request";

type PullRequestFixIssueBarProps = {
  pullRequest: PullRequestSummary;
  events: readonly PullRequestEvent[];
  onCreate: (draft: PullRequestFixIssueDraft) => void;
  /**
   * 送り先（#3009）。既定は従来どおり新規Issue作成。**判定材料はPRのマージ状態と元Issueの
   * ラベル・セッション状態**で、ここでは決めない（`resolvePullRequestFixRoute`）。
   */
  route?: PullRequestFixRoute;
  /**
   * `route`が`create-issue`のとき、このPRを参照する既存の修正Issueが既にあればそれ（#3331）。
   * あればボタンを新規作成ではなくそのIssueへのリンクに切り替え、二重起票に気づけるようにする。
   */
  existingFixIssue?: Pick<Issue, "number" | "htmlUrl"> | null;
  repositoryFullName: string;
  issueSuggestions: IssueSuggestion[];
  /** `route`が`create-issue`以外のときの送信（#3009）。成功したら確認ダイアログを閉じる */
  onRequestSessionFix?: (route: PrFixRequestRoute, reason: string) => Promise<boolean>;
  isSubmittingSessionFix?: boolean;
  /** 送れない理由（`session`・`resume`のときだけ意味がある） */
  sessionFixRejection?: string | null;
  /** 送信そのものが失敗した理由（押した後に出る） */
  sessionFixError?: string | null;
};

/**
 * 自動レビューの本文を取る。**失敗しても下書きは開く**——レビューが読めないことを理由に
 * 起案そのものを止めると、指摘を手で書き写す手段まで失う。
 */
async function fetchReview(pullRequest: PullRequestSummary): Promise<PullRequestReviewCommentContent | null> {
  const [owner, repo] = pullRequest.repositoryFullName.split("/");
  try {
    const res = await fetch(
      `/api/pull-requests/review?owner=${owner}&repo=${repo}&number=${pullRequest.number}`,
    );
    if (!res.ok) return null;
    const data: { review: PullRequestReviewCommentContent | null } = await res.json();
    return data.review;
  } catch {
    return null;
  }
}

/**
 * PR詳細のヘッダーと本文の間に置く「修正Issueを起案」（#2961）。
 *
 * 判定が要修正・要確認のときは色付きの帯で理由を添え、それ以外は右寄せのボタンだけにする。
 * 押すと自動レビューの本文を取り、**送り先が新規Issue作成（既定）なら**下書きを埋めた
 * 新規作成ダイアログを開く。
 *
 * **未マージPRで元Issueが1件に絞れるときは、新しいIssueを作らず元Issueのセッションへ
 * 送る**（#3009）。送り先（`route`）が`create-issue`以外なら、押したときに確認ダイアログ
 * （`PullRequestFixSessionDialog`）を開く。
 */
export function PullRequestFixIssueBar({
  pullRequest,
  events,
  onCreate,
  route = { kind: "create-issue" },
  existingFixIssue = null,
  repositoryFullName,
  issueSuggestions,
  onRequestSessionFix,
  isSubmittingSessionFix = false,
  sessionFixRejection = null,
  sessionFixError = null,
}: PullRequestFixIssueBarProps) {
  const [isPreparing, setIsPreparing] = useState(false);
  const [sessionDialogOpen, setSessionDialogOpen] = useState(false);
  const [sessionReview, setSessionReview] = useState<PullRequestReviewCommentContent | null>(null);

  const openChangeRequests = selectOpenChangeRequests(events);
  const tone = resolvePullRequestFixIssueTone(pullRequest, openChangeRequests);
  const verdictKind = pullRequest.reviewVerdict?.reviewKind;
  const isReviewAutoFixRunning = pullRequest.repairRun?.kind === "review";

  // 判定時点のコミット（#3172）。PR本文のマーカーを先に見て、無ければ**この画面が既に
  // 持っているレビューコメント**のマーカーで補う（`sha=`をPR本文へ書き始める前のPRと、
  // 本文にしか判定を書かないローカルのレビュー・統合セッションのPRが読めるようになる）。
  // どちらも取得済みの材料なので、GitHub APIの消費は増えない。
  const reviewedSha =
    pullRequest.reviewVerdict?.reviewedSha ??
    selectPullRequestReviewComment(
      events.map((event) => ({ body: event.body, createdAt: event.createdAt, htmlUrl: null })),
      pullRequest.headSha,
    )?.reviewedSha ??
    null;
  const freshness = resolveReviewVerdictFreshness({ reviewedSha, headSha: pullRequest.headSha });

  const headline =
    verdictKind === "changes-requested" || verdictKind === "needs-check"
      ? `自動レビューが「${pullRequest.reviewVerdict?.reviewLabel}」と判定して${
          // 判定の後にコミットが積まれているときは時制で先に言う。詳しい突き合わせは下の1行
          freshness === "stale" ? "いました" : "います"
        }`
      : "レビューで変更を求められています";
  // このPRを参照する既存の修正Issueが既にあるとき、押すたびに新規作成ダイアログを開くと
  // 同じ指摘を2重に起票してしまう（#3331）。既存Issueへのリンク表示に切り替えて気づかせる
  const alreadyFiledIssue = route.kind === "create-issue" ? existingFixIssue : null;
  const isAlreadyFiled = alreadyFiledIssue !== null;
  const buttonLabel = alreadyFiledIssue
    ? `起票済み（#${alreadyFiledIssue.number}）`
    : route.kind === "create-issue"
      ? "修正Issueを起案"
      : prFixRequestActionLabel(route);

  async function handleClick() {
    setIsPreparing(true);
    const review = await fetchReview(pullRequest);
    setIsPreparing(false);
    if (route.kind === "create-issue") {
      onCreate(buildPullRequestFixIssueDraft({ pullRequest, review, openChangeRequests }));
      return;
    }
    setSessionReview(review);
    setSessionDialogOpen(true);
  }

  async function handleSubmitSessionFix(reason: string) {
    if (route.kind === "create-issue" || !onRequestSessionFix) return;
    if (await onRequestSessionFix(route, reason)) setSessionDialogOpen(false);
  }

  const button = alreadyFiledIssue ? (
    <Button asChild size="sm" variant="outline" className={cn("shrink-0", tone !== "none" && "max-md:w-full")}>
      <GithubReferenceLink
        href={alreadyFiledIssue.htmlUrl}
        reference={{ repositoryFullName, number: alreadyFiledIssue.number, kind: "issue" }}
      >
        <ExternalLink />
        {buttonLabel}
      </GithubReferenceLink>
    </Button>
  ) : (
    <Button
      size="sm"
      variant={tone === "none" ? "ghost" : tone === "needs-check" ? "outline" : "default"}
      className={cn(
        "shrink-0",
        tone === "changes-requested" && "bg-destructive text-white hover:bg-destructive/90",
        tone !== "none" && "max-md:w-full",
      )}
      disabled={isPreparing}
      onClick={handleClick}
    >
      {isPreparing ? <Loader2 className="animate-spin" /> : route.kind === "create-issue" ? <Plus /> : <Pencil />}
      {buttonLabel}
    </Button>
  );

  // 開くたびに新しいコンポーネントとしてマウントする——`initialReason`はマウント時の
  // `useState`初期値としてしか使わないので、これで押すたびにその時点の引用へ作り直す
  // （閉じたあとに残る書きかけを次に開いたときへ持ち越さない）
  const dialog = route.kind !== "create-issue" && sessionDialogOpen && (
    <PullRequestFixSessionDialog
      open={sessionDialogOpen}
      route={route}
      initialReason={buildPullRequestFixReason({
        pullRequestNumber: pullRequest.number,
        review: sessionReview,
        openChangeRequests,
      })}
      repositoryFullName={repositoryFullName}
      issueSuggestions={issueSuggestions}
      isSubmitting={isSubmittingSessionFix}
      rejection={sessionFixRejection}
      error={sessionFixError}
      onSubmit={handleSubmitSessionFix}
      onClose={() => setSessionDialogOpen(false)}
    />
  );

  if (tone === "none") {
    return (
      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 border-b px-4 py-2">
        <p className="text-xs text-muted-foreground">
          {isAlreadyFiled
            ? "このPRの修正Issueは既に起票されています。"
            : route.kind === "create-issue"
              ? "レビュー後に気づいた修正も、ここからIssueにできます。"
              : "レビュー後に気づいた修正も、ここから元Issueのセッションへ送れます。"}
        </p>
        {button}
        {dialog}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-l-[3px] py-3 pr-4 pl-[13px]",
        tone === "changes-requested"
          ? "border-l-destructive bg-destructive/10"
          : "border-l-amber-500 bg-amber-500/10",
      )}
    >
      <div className="min-w-0 flex-1 basis-56">
        <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">
          <AlertCircle
            className={cn(
              "size-4 shrink-0",
              tone === "changes-requested" ? "text-destructive" : "text-amber-600 dark:text-amber-400",
            )}
            aria-hidden="true"
          />
          {headline}
          {openChangeRequests.length > 0 && (
            <span className="inline-flex items-center rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive ring-1 ring-inset ring-destructive">
              変更を要求 {openChangeRequests.length}件
            </span>
          )}
        </p>
        {/* 「いまの中身に対する判定か」を、指摘そのものより先に言う（#3172）。修正コミットを
            積んだ後も同じ帯が残るため、これが無いと修正前の話なのかが読み取れない */}
        {/* 自動修正へ回っているあいだ（#3363）。帯の赤は消さず、放っておけば片付くことを
            先に言う——この1行が無いと、走っている最中に同じ指摘を手で依頼し直してしまう */}
        {isReviewAutoFixRunning && (
          <p className="mt-1 flex items-start gap-1.5 text-xs font-medium text-primary">
            <Wrench className="mt-0.5 size-3 shrink-0 animate-spin" aria-hidden="true" />
            人の判断が要らない指摘のため、自動修正に回しています。終わると再レビューされ、問題が無ければそのままマージされます。
          </p>
        )}
        <ReviewVerdictFreshnessNote
          className="mt-1"
          freshness={freshness}
          reviewedSha={reviewedSha}
          headSha={pullRequest.headSha}
          isReviewing={isMergeJudgementPending(pullRequest.mergeJudgement)}
        />
        <p className="mt-0.5 text-xs text-muted-foreground">
          {isAlreadyFiled
            ? "二重に起票しないよう、リンクから既存Issueの内容を確認してください。"
            : route.kind === "create-issue"
              ? "指摘を引用した新しいIssueの下書きを開きます。この画面からは起票しません。"
              : "新しいIssueは作らず、このPRを実装していたIssueへ指摘を伝えます。"}
        </p>
      </div>
      {button}
      {dialog}
    </div>
  );
}
