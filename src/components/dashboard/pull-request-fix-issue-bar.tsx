"use client";

import { useState } from "react";
import { ExternalLink, Loader2, Pencil, Plus } from "lucide-react";

import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import type { IssueSuggestion } from "@/components/dashboard/mention-textarea";
import { PullRequestFixSessionDialog } from "@/components/dashboard/pull-request-fix-session-dialog";
import { Button } from "@/components/ui/button";
import { prFixRequestActionLabel, type PrFixRequestRoute } from "@/lib/dispatch/pr-fix-request";
import {
  buildPullRequestFixIssueDraft,
  buildPullRequestFixReason,
  selectOpenChangeRequests,
  type PullRequestFixIssueDraft,
  type PullRequestFixRoute,
} from "@/lib/github/pull-request-fix-issue";
import type { PullRequestReviewCommentContent } from "@/lib/github/pull-request-review-comment";
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
 * PR詳細の本文の前に置く、範囲外の課題を別Issueとして起票する例外操作（#2961、#3970）。
 *
 * レビュー要修正の通常導線は「PRを自動修正」が受け持つ。ここは常に中立に表示し、
 * 現在のPRで直すべき問題と別課題の起票を混同させない。
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
  // このPRを参照する既存の修正Issueが既にあるとき、押すたびに新規作成ダイアログを開くと
  // 同じ指摘を2重に起票してしまう（#3331）。既存Issueへのリンク表示に切り替えて気づかせる
  const alreadyFiledIssue = route.kind === "create-issue" ? existingFixIssue : null;
  const isAlreadyFiled = alreadyFiledIssue !== null;
  const buttonLabel = alreadyFiledIssue
    ? `別課題として起票済み（#${alreadyFiledIssue.number}）`
    : route.kind === "create-issue"
      ? "別課題としてIssue化"
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
    <Button asChild size="sm" variant="outline" className="shrink-0">
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
      variant="outline"
      className="shrink-0"
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

  return (
    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 border-b px-4 py-2">
      <p className="text-xs text-muted-foreground">
        {isAlreadyFiled
          ? "このPRと別に扱う課題は既に起票されています。"
          : "現在のPRの範囲外なら、別課題として起票できます。"}
      </p>
      {button}
      {dialog}
    </div>
  );
}
