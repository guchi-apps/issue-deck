"use client";

import { useState, type CSSProperties } from "react";
import { isReleaseCandidateHeadRef } from "@/lib/release-branch";
import { ExternalLink, MessageSquareText, RefreshCw, Wrench } from "lucide-react";
import { showsPullRequestFixIssueButton } from "@/lib/github/pull-request-release-fix-issue";

import { DeployFailureAlert } from "@/components/dashboard/deploy-failure-alert";
import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import { MergeCheckReasonNotice } from "@/components/dashboard/merge-check-reason-notice";
import { MarkdownBody } from "@/components/dashboard/markdown-body";
import {
  AiReviewStatusButton,
  BranchBadge,
  CiStatusButton,
  DeployStatusBadge,
  PullRequestMetaBadge,
  PullRequestStateIcon,
  RepairRunBadge,
  UserMergeRequiredBadge,
  pullRequestKindLabel,
} from "@/components/dashboard/pull-request-badges";
import { PullRequestActionsMenu } from "@/components/dashboard/pull-request-actions-menu";
import { PullRequestChecksStrip } from "@/components/dashboard/pull-request-checks-strip";
import { PullRequestAiReviewJobs } from "@/components/dashboard/pull-request-ai-review-jobs";
import { PullRequestFileList } from "@/components/dashboard/pull-request-file-list";
import { PullRequestReviewRound } from "@/components/dashboard/pull-request-review-round";
import { PullRequestReadyButton } from "@/components/dashboard/pull-request-ready-button";
import { PullRequestUpdateBranchButton } from "@/components/dashboard/pull-request-update-branch-button";
import { PullRequestCiRerunButtons } from "@/components/dashboard/pull-request-ci-rerun-buttons";
import { PullRequestMergeButton } from "@/components/dashboard/pull-request-merge-button";
import { PullRequestMergeHoldNotice } from "@/components/dashboard/pull-request-merge-hold";
import { PullRequestRepairButtons } from "@/components/dashboard/pull-request-repair-buttons";
import { PullRequestBackupCi } from "@/components/dashboard/pull-request-backup-ci";
import { PullRequestReviewFindings } from "@/components/dashboard/pull-request-review-findings";
import {
  PullRequestReviewResponse,
  REVIEW_RESPONSE_ANCHOR_ID,
} from "@/components/dashboard/pull-request-review-response";
import {
  isOpenReleaseCandidate,
  ReleasePullRequestOverview,
} from "@/components/dashboard/release-pull-request-overview";
import { ConnectedReleaseReviewSections } from "@/components/dashboard/release-review-sections";
import { UserAvatar } from "@/components/dashboard/user-avatar";
import { VerificationSummaryPanel } from "@/components/dashboard/verification-summary-panel";
import { WorkflowRunProgressPanel } from "@/components/dashboard/workflow-run-progress-panel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { usePullRequestDeployStatus } from "@/hooks/use-pull-request-deploy-status";
import type { IssueSuggestion } from "@/components/dashboard/mention-textarea";
import { formatRelativeDate } from "@/lib/format-relative-date";
import { selectPullRequestReviewComment } from "@/lib/github/pull-request-review-comment";
import { repairKindsFor } from "@/lib/github/pull-request-repair";
import { parseReleaseVerification, type ReleaseVerificationRow } from "@/lib/github/release-verification";
import { canMergeFromDeck, isMergeWaitingForChecks, requiresUserMerge } from "@/lib/pull-request-list";
import { derivePrimaryState, type PrimaryStateTone } from "@/lib/pull-request-primary-state";
import { applyReviewAction, deriveReviewAction } from "@/lib/pull-request-review-action";
import { cn } from "@/lib/utils";
import type {
  PullRequestSummary,
  PullRequestDetail as PullRequestDetailData,
  PullRequestEvent,
  PullRequestReviewState,
} from "@/types/pull-request";

type PullRequestDetailProps = {
  /** 一覧で選択中のPR。未選択ならnull */
  pullRequest: PullRequestSummary | null;
  /** 本文・コメント。取得前・取得失敗時はnull */
  detail: PullRequestDetailData | null;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
  onMerged: () => void;
  /**
   * ヘッダーの「…」メニュー（#3161）。PRをクローズできたとき・編集を保存できたとき。
   * どちらも渡さない画面ではメニューを出さない。編集後の詳細の取り直しは部品の中で
   * `onRefresh`を呼んで済ませる（通常の詳細と確認待ちの重ね表示は取得が別のため、
   * 表示中の側だけを取り直す）ので、`onUpdated`は一覧の取り直しだけでよい。
   */
  onClosed?: () => void;
  onUpdated?: () => void;
  /**
   * 検証結果の「要修正」「要確認」の行から、指摘を新規Issueの下書きにして開く（#2838）。
   * 渡さない画面ではボタンを出さない。起点のリリースPRは表示中の`pullRequest`から渡す。
   */
  onCreateFixIssue?: (row: ReleaseVerificationRow, pullRequest: PullRequestSummary) => void;
  /**
   * マージ済みPRの「修正Issueを起案」。リリース履歴で実機確認して反映されていなかったときに、
   * 対象PRを引用した新規Issueの下書きを開く（#4154）。渡さない画面ではボタンを出さない。
   */
  onDraftFixIssue?: (pullRequest: PullRequestSummary) => void;
  /** PR本文を編集するときの`@Issue番号`補完に使う候補一覧 */
  issueSuggestions?: IssueSuggestion[];
  /** ヘッダーの左に置く戻るボタン等（スマホ画面向け） */
  headerLeading?: React.ReactNode;
  className?: string;
  style?: CSSProperties;
  /** スマホのボトムナビと最後の項目が重ならないよう末尾に余白を入れる */
  footerSpacing?: boolean;
};

/** 詳細のタブ（#4427）。概要＝本文と補足、指摘＝CI・レビューの根拠、変更ファイル、活動＝コメント */
type DetailTab = "overview" | "findings" | "files" | "activity";

const DETAIL_TAB_LABEL: Record<DetailTab, string> = {
  overview: "概要",
  findings: "指摘",
  files: "変更ファイル",
  activity: "活動",
};

const PRIMARY_TONE_CLASS: Record<PrimaryStateTone, string> = {
  ok: "text-green-700 dark:text-green-400",
  bad: "text-destructive",
  warn: "text-amber-700 dark:text-amber-400",
  run: "text-blue-700 dark:text-blue-400",
  muted: "text-muted-foreground",
};

const REVIEW_STATE_LABEL: Record<PullRequestReviewState, string> = {
  approved: "承認",
  changes_requested: "変更を要求",
  commented: "コメント",
  dismissed: "取り消し済み",
};

function ReviewStateBadge({ reviewState }: { reviewState: PullRequestReviewState }) {
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        reviewState === "approved"
          ? "bg-green-600/15 text-green-700 ring-green-600 dark:text-green-400"
          : reviewState === "changes_requested"
            ? "bg-destructive/15 text-destructive ring-destructive"
            : "bg-muted text-muted-foreground ring-border",
      )}
    >
      {REVIEW_STATE_LABEL[reviewState]}
    </span>
  );
}

function EventItem({
  event,
  repositoryFullName,
}: {
  event: PullRequestEvent;
  repositoryFullName: string;
}) {
  return (
    <li className="border-b px-4 py-3 last:border-b-0">
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <UserAvatar login={event.authorLogin} className="size-4" />
        <span className="font-medium text-foreground">{event.authorLogin}</span>
        {event.kind === "review" && event.reviewState && (
          <ReviewStateBadge reviewState={event.reviewState} />
        )}
        {event.kind === "review-comment" && event.path && (
          <code className="min-w-0 truncate rounded bg-muted px-1 py-0.5">
            {event.path}
            {event.line !== null ? `:${event.line}` : ""}
          </code>
        )}
        <span className="shrink-0">{formatRelativeDate(event.createdAt)}</span>
      </div>
      {event.body.trim() ? (
        <MarkdownBody
          content={event.body}
          className="mt-2"
          repositoryFullName={repositoryFullName}
        />
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">（本文なし）</p>
      )}
    </li>
  );
}

/**
 * 選択中PRの本文・コメントを表示する（#1087）。
 *
 * ヘッダーに出す情報（タイトル・ブランチ・CI状態・作者）は`PullRequestSummary`から描く。
 * 一覧から選んだ場合は一覧が既に持っているものをそのまま使うので、PRを選んでから表示までが速い。
 * 画面内のリンクから直接開いた場合は一覧に項目が無いため、詳細APIが返す`summary`が親経由で
 * 渡ってくる（#1260）。
 */
export function PullRequestDetail({
  pullRequest,
  detail,
  isLoading,
  error,
  onRefresh,
  onMerged,
  onClosed,
  onUpdated,
  onCreateFixIssue,
  onDraftFixIssue,
  issueSuggestions = [],
  headerLeading,
  className,
  style,
  footerSpacing = false,
}: PullRequestDetailProps) {
  // 本番へ届いたか（#1814）。マージ済みのPRでだけ取りに行く。ヘッダーの「更新」でも
  // 取り直したいので、詳細の取得時刻をキーに渡す。スマホのPR詳細画面もこの部品を使うため、
  // ここで持つことでPC・スマホの両方に同じ表示が出る。
  const { status: deployStatus } = usePullRequestDeployStatus(
    pullRequest?.id ?? null,
    pullRequest?.merged ?? false,
    detail?.fetchedAt ?? null,
  );

  // CIの内訳（#2777）。**開いたPRのidで持つ**——真偽値だけで持つと、PRを切り替えたときに
  // 前のPRで開いた状態が引き継がれ、別のPRの内訳が開いたまま出る。
  const [ciDetailPullRequestId, setCiDetailPullRequestId] = useState<string | null>(null);
  // レビュー本文もCIと同じく、開いたPRのidで状態を持つ。PRを切り替えたときに前の本文を
  // 誤って残さないため（#3319）。
  const [reviewDetailPullRequestId, setReviewDetailPullRequestId] = useState<string | null>(null);
  // 開いているタブ。**PRのidで持つ**（切り替えたら概要へ戻す。前のPRのタブを引き継がない）
  const [tabState, setTabState] = useState<{ pullRequestId: string; tab: DetailTab } | null>(null);

  // 画面内のリンクから一覧に無いPRを開いた場合、ヘッダーの材料（summary）が届くまで
  // 選択中PRはnullのまま。「PRを選ぶと〜」ではなく読み込み中・失敗として見せる（#1260）。
  if (!pullRequest) {
    return (
      <div className={cn("flex flex-col overflow-hidden", className)} style={style}>
        <header className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
          {headerLeading}
          <p className="min-w-0 flex-1 truncate text-sm font-semibold text-muted-foreground">
            {error ? "Pull Requestを開けませんでした" : isLoading ? "読み込み中..." : "Pull Request"}
          </p>
        </header>
        {error ? (
          <p className="px-4 py-3 text-sm text-destructive">{error}</p>
        ) : isLoading ? (
          <div className="flex flex-col gap-2 px-4 py-3">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            PRを選ぶと本文とコメントを表示します。
          </p>
        )}
      </div>
    );
  }

  const kindLabel = pullRequestKindLabel(pullRequest.kind);
  // 開いている本番PR（#4428）。ヘッダーを短くし、本文の先頭に現在状態・検証・今回の変更を出す。
  // 既存のバッジ・内訳・本文・コメントは、その下の「詳細・履歴」としてそのまま残す
  const releaseCandidate = isOpenReleaseCandidate(pullRequest);
  // 取得結果が選択中PRのものか（切り替え直後に前のPRの本文を出さないための保険）
  const currentDetail = detail && detail.id === pullRequest.id ? detail : null;
  // `mergeable`は一覧・詳細のどちらの`summary`にも入っている（#1742）ので、CI失敗と
  // コンフリクトの両方の修復ボタンを出せる（#1293）。
  const repairKinds = repairKindsFor(pullRequest, pullRequest.mergeable);
  // リリースPRの本文に載っている検証結果（#2448）。見出しを持たないPRではnullになる
  const verification = parseReleaseVerification(currentDetail?.body);
  // 検証結果の行の「確認済み・対応しない」の記録・取り消し（#3739）。develop向けPRへ記録を残し、
  // このリリースPR本文の該当行も書き換える（本文は作成時に1回しか書かれないため）。
  const sendReviewAck = async (
    row: ReleaseVerificationRow,
    action: "acknowledge" | "revoke",
    reason?: string,
  ) => {
    if (row.pullRequestNumber === null) {
      throw new Error("対応するdevelop向けPRが見つからないため記録できません");
    }
    const [owner, repo] = pullRequest.repositoryFullName.split("/");
    const response = await fetch("/api/pull-requests/review-ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        owner,
        repo,
        number: row.pullRequestNumber,
        issueNumber: row.issueNumber,
        releasePullRequestNumber: pullRequest.number,
        action,
        reason,
      }),
    });
    if (!response.ok) {
      const payload: { message?: string; error?: string } = await response.json().catch(() => ({}));
      throw new Error(payload.message ?? payload.error ?? "記録できませんでした");
    }
    onRefresh();
  };
  // CIの内訳は、チェック一覧を行の元にし、`ciRunId`は現在ステップと見込み時間を足すためだけに使う。
  // 一覧の再取得でチェックが一時的に空になっても、CIの操作表示そのものは読み取り専用へ戻さない。
  const showsCiBadge = !pullRequest.merged && pullRequest.state === "open" && !pullRequest.draft;
  const ciChecks = showsCiBadge ? pullRequest.ciChecks : [];
  const ciRunId = showsCiBadge ? pullRequest.ciRunId : null;
  const ciDetailOpen = ciDetailPullRequestId === pullRequest.id;
  const reviewDetailOpen = reviewDetailPullRequestId === pullRequest.id;
  // 自動レビューの本文は`events`に入っており、一覧の応答を増やさずPR詳細を開いたときだけ読む。
  // レビュー本体は会話コメントとして投稿されるため、通常のレビューや行コメントとは混ぜない。
  const review = currentDetail
    ? selectPullRequestReviewComment(
        currentDetail.events
          .filter((event) => event.kind === "comment")
          .map((event) => ({ body: event.body, createdAt: event.createdAt, htmlUrl: null })),
        pullRequest.headSha,
      )
    : null;

  // レビュー指摘への対応（#4482）。上部と指摘タブの対応パネルは、同じこの結果から作る
  const reviewAction = deriveReviewAction({ pullRequest, review, context: currentDetail?.reviewResponse });
  const primary = applyReviewAction(derivePrimaryState(pullRequest), reviewAction);
  // 指摘への対応・修正が残っている間は「マージする」を主操作にせず、マージの説明は詳細へ畳む
  const reviewUnresolved = reviewAction.kind === "respond" || reviewAction.kind === "requested" || reviewAction.kind === "repairing";
  const reviewRespond = reviewAction.kind === "respond" ? reviewAction : null;
  const activeTab: DetailTab = tabState?.pullRequestId === pullRequest.id ? tabState.tab : "overview";
  const selectTab = (tab: DetailTab) => setTabState({ pullRequestId: pullRequest.id, tab });
  const isDevelopOpen = pullRequest.baseRef === "develop" && pullRequest.state === "open" && !pullRequest.merged;
  // 通常PR（リリースPR・バージョンバンプPRを除く）の開いたPRにだけ、最新baseの取り込みとCI再実行を出す（#4626）
  const canUpdateBranch =
    pullRequest.state === "open" &&
    !pullRequest.merged &&
    pullRequest.kind !== "release" &&
    pullRequest.kind !== "version-bump";
  const findingsNeedAttention = primary.kind === "ci-failed" || primary.kind === "review-findings";
  // 上部の「指摘に対応する」。指摘タブを開いてレビュー本文も開き、対応パネルの位置まで移動する
  const openReviewResponse = () => {
    selectTab("findings");
    setReviewDetailPullRequestId(pullRequest.id);
    requestAnimationFrame(() =>
      document.getElementById(REVIEW_RESPONSE_ANCHOR_ID)?.scrollIntoView({ block: "start", behavior: "smooth" }),
    );
  };

  return (
    <div className={cn("flex flex-col overflow-hidden", className)} style={style}>
      {/* 短い固定ヘッダー（#4427）。戻る・画面種別・番号・更新・その他だけを置き、長い正式タイトルは本文側で全文を出す */}
      <header className="flex min-h-12 shrink-0 items-center gap-2 border-b px-4 py-1.5">
        {headerLeading}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <PullRequestStateIcon pullRequest={pullRequest} className="size-4 shrink-0" />
          <p className="min-w-0 truncate text-sm font-semibold">
            {releaseCandidate ? "本番PR" : "Pull Request"} <span className="tabular-nums text-muted-foreground">#{pullRequest.number}</span>
          </p>
        </div>
        <a
          href={pullRequest.htmlUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex size-11 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          aria-label={`#${pullRequest.number} をGitHubで開く`}
        >
          <ExternalLink className="size-4" />
        </a>
        <Button
          size="sm"
          variant="ghost"
          className="h-9 shrink-0"
          disabled={isLoading}
          onClick={onRefresh}
        >
          <RefreshCw className={cn("size-3.5", isLoading && "animate-spin")} />
          更新
        </Button>
        {onClosed && onUpdated && (
          <PullRequestActionsMenu
            pullRequest={pullRequest}
            body={currentDetail?.body ?? null}
            issueSuggestions={issueSuggestions}
            onUpdated={() => {
              onRefresh();
              onUpdated();
            }}
            onClosed={onClosed}
          />
        )}
      </header>

      <div className="flex-1 overflow-y-auto overscroll-contain">
        <div className="flex flex-col gap-3 border-b px-4 py-4">
          <div className="min-w-0">
            <p className="truncate text-xs text-muted-foreground">{pullRequest.repositoryFullName}</p>
            <h1 className="mt-0.5 text-lg leading-snug font-bold break-words">
              #{pullRequest.number} {pullRequest.title}
            </h1>
          </div>

          {/* 本番PRの状態・主操作・検証・今回の変更は専用の要約が持つ（#4428）。同じ操作を2か所に置かない */}
          {releaseCandidate && <ReleasePullRequestOverview pullRequest={pullRequest} onMerged={onMerged} />}
          {releaseCandidate && <h2 className="-mx-4 border-y bg-muted/50 px-4 py-2 text-xs font-semibold">詳細・履歴</h2>}

          {!releaseCandidate && (
          <section
            aria-label="現在の状態と主操作"
            data-testid="pull-request-primary-action"
            className="flex flex-col gap-2 rounded-lg border bg-card px-4 py-3"
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <div className="min-w-0 flex-1 basis-56">
                <p className={cn("text-sm font-bold", PRIMARY_TONE_CLASS[primary.tone])}>
                  <span aria-hidden="true">{primary.mark}</span> {primary.label}
                </p>
                <p className="text-xs text-muted-foreground">{primary.reason}</p>
                {reviewRespond && reviewRespond.concerns.length > 0 && (
                  <ul aria-label="レビューの指摘の要点" className="mt-1 list-disc pl-4 text-xs">
                    {reviewRespond.concerns.map((concern) => (
                      <li key={concern} className="break-words">
                        {concern}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                {/* 失敗の隣に「いま自動で直しにいっている」を出す（#2072）。進捗は経過時間つきで、再起動は促さない */}
                <RepairRunBadge run={pullRequest.repairRun} />
                <PullRequestRepairButtons
                  repositoryFullName={pullRequest.repositoryFullName}
                  pullRequestNumber={pullRequest.number}
                  kinds={repairKinds}
                  availability={pullRequest.repairWorkflowAvailability}
                  runningKind={pullRequest.repairRun?.kind ?? null}
                />
                {reviewRespond && (
                  <Button
                    size="sm"
                    variant={reviewRespond.autoRepair || repairKinds.length > 0 ? "outline" : "default"}
                    className="h-9 text-xs"
                    onClick={openReviewResponse}
                  >
                    <MessageSquareText className="size-3.5" />
                    指摘に対応する
                  </Button>
                )}
                {pullRequest.draft && pullRequest.state === "open" && !pullRequest.merged && (
                  <PullRequestReadyButton
                    pullRequest={pullRequest}
                    onChanged={() => {
                      onRefresh();
                      onUpdated?.();
                    }}
                  />
                )}
                {canUpdateBranch && (
                  <PullRequestUpdateBranchButton
                    pullRequest={pullRequest}
                    onChanged={() => {
                      onRefresh();
                      onUpdated?.();
                    }}
                  />
                )}
                {canMergeFromDeck(pullRequest) && (
                  <PullRequestMergeButton
                    pullRequest={pullRequest}
                    onMerged={onMerged}
                    // CI・レビュー・判定の完了待ちのあいだは押してよい状態に見せないため強調しない（#4783）
                    variant={repairKinds.length === 0 && !reviewUnresolved && !isMergeWaitingForChecks(pullRequest) ? "default" : "outline"}
                  />
                )}
                {onDraftFixIssue && showsPullRequestFixIssueButton(pullRequest) && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-9 text-xs"
                    onClick={() => onDraftFixIssue(pullRequest)}
                  >
                    <Wrench className="size-3.5" />
                    修正Issueを起案
                  </Button>
                )}
              </div>
            </div>

            {reviewUnresolved ? (
              /* 指摘への対応が残っている間は、マージの保留理由・ユーザー確認を先に並べない（#4482）。
                 「ユーザーのマージが必要です」は指摘を片付けた後の最終マージの話なので、根拠として畳む */
              <details className="border-t border-dashed pt-2 text-xs text-muted-foreground">
                <summary className="cursor-pointer text-foreground">マージについて（詳細）</summary>
                <div className="mt-2 flex flex-col gap-2">
                  <p>
                    指摘への対応・判断が済むまでは、マージを主操作にしていません。修正せずにマージする場合も、マージ確認の画面で指摘を確かめてから進みます。
                  </p>
                  <PullRequestMergeHoldNotice pullRequest={pullRequest} />
                  {requiresUserMerge(pullRequest) && <UserMergeRequiredBadge />}
                  {requiresUserMerge(pullRequest) && currentDetail?.userMergeReasons && (
                    <MergeCheckReasonNotice reasons={currentDetail.userMergeReasons} />
                  )}
                </div>
              </details>
            ) : (
              <>
                <PullRequestMergeHoldNotice pullRequest={pullRequest} />

                {requiresUserMerge(pullRequest) && <UserMergeRequiredBadge />}
                {/* ユーザーのマージが必要な理由（#4088）。押す前に読めるようにする */}
                {requiresUserMerge(pullRequest) && currentDetail?.userMergeReasons && (
                  <MergeCheckReasonNotice reasons={currentDetail.userMergeReasons} />
                )}
              </>
            )}
            <DeployStatusBadge status={deployStatus} />
            {/* このPRの変更が本番へ出ていないとき、押せる場所をその場に出す（#2236）。失敗しているときだけ */}
            {deployStatus?.kind === "failed" && (
              <DeployFailureAlert
                repositoryFullName={pullRequest.repositoryFullName}
                title="このPRの変更は本番へ出ていません"
                version={deployStatus.version}
                runUrl={deployStatus.deployRunUrl}
              />
            )}
          </section>
          )}

          {/* チェックの根拠（#4366・#4427）。このPR（CI・コード・競合）とリリース候補（全体・統合・Mac）を分けて読む。
              リリース候補が未作成でも通常PRのマージ条件は増えない */}
          {!releaseCandidate && (
            <PullRequestChecksStrip
              pullRequest={pullRequest}
              onOpenPullRequest={() => selectTab("findings")}
              showCandidateNote
              pullRequestEvidenceLabel="指摘・CIの内訳を開く"
              className="-mx-1 px-0"
            />
          )}

          {/* 補足（属性）。現在の阻害要因は上の主操作に出るので、ここは読み物 */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <BranchBadge baseRef={pullRequest.baseRef} headRef={pullRequest.headRef} />
            {kindLabel && <PullRequestMetaBadge>{kindLabel}</PullRequestMetaBadge>}
            {pullRequest.draft && <PullRequestMetaBadge>ドラフト</PullRequestMetaBadge>}
            {pullRequest.autoMergeEnabled && <PullRequestMetaBadge>Auto-merge有効</PullRequestMetaBadge>}
            {pullRequest.linkedIssueNumber !== null && (
              <GithubReferenceLink
                href={`https://github.com/${pullRequest.repositoryFullName}/issues/${pullRequest.linkedIssueNumber}`}
                reference={{
                  repositoryFullName: pullRequest.repositoryFullName,
                  number: pullRequest.linkedIssueNumber,
                  kind: "issue",
                }}
                className="text-xs text-primary hover:underline"
              >
                Issue #{pullRequest.linkedIssueNumber}
              </GithubReferenceLink>
            )}
            <span className="flex items-center gap-1">
              <UserAvatar login={pullRequest.authorLogin} className="size-4" />
              {pullRequest.authorLogin}
            </span>
            <span>{formatRelativeDate(pullRequest.createdAt)}</span>
            {currentDetail && (
              <span>
                <span className="text-green-600">+{currentDetail.additions}</span>{" "}
                <span className="text-destructive">-{currentDetail.deletions}</span>
                {` ・ ${currentDetail.changedFiles}ファイル ・ ${currentDetail.commits}コミット`}
              </span>
            )}
          </div>
        </div>

        <div role="tablist" aria-label="PR詳細の表示切り替え" className="sticky top-0 z-10 flex gap-1 overflow-x-auto border-b bg-background px-2">
          {(Object.keys(DETAIL_TAB_LABEL) as DetailTab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              onClick={() => selectTab(tab)}
              className={cn(
                "flex min-h-11 shrink-0 items-center gap-1 px-3 text-sm font-medium text-muted-foreground hover:text-foreground",
                activeTab === tab && "border-b-2 border-primary text-primary",
              )}
            >
              {DETAIL_TAB_LABEL[tab]}
              {tab === "findings" && findingsNeedAttention && (
                <span aria-label="対応が必要" className="size-2 rounded-full bg-destructive" />
              )}
            </button>
          ))}
        </div>

        {activeTab === "findings" && (
          <section aria-label="指摘" className="border-b px-4 py-3">
            {/* 対応パネル（#4482）。上部の「指摘に対応する」の行き先。CI・レビューの内訳より先に置く */}
            <PullRequestReviewResponse
              key={pullRequest.id}
              action={reviewAction}
              pullRequest={pullRequest}
              reviewUrl={review?.htmlUrl ?? pullRequest.mergeJudgement.aiReview.runUrl ?? pullRequest.htmlUrl}
              onRefresh={onRefresh}
              onRequested={onRefresh}
              onMerged={onMerged}
              onDraftFixIssue={onDraftFixIssue}
              className="mb-3"
            />
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {pullRequest.merged ? null : pullRequest.state === "closed" ? null : pullRequest.draft ? null : (
                <CiStatusButton
                  ciState={pullRequest.ciState}
                  expanded={ciDetailOpen}
                  onClick={() => setCiDetailPullRequestId(ciDetailOpen ? null : pullRequest.id)}
                />
              )}
              {/* CIとは別の軸のレビュー状態（#3319）。実行中・省略・失敗・完了を同じ操作表示で出す */}
              <AiReviewStatusButton
                aiReview={pullRequest.mergeJudgement.aiReview}
                reviewVerdict={pullRequest.reviewVerdict}
                expanded={reviewDetailOpen}
                onClick={() => setReviewDetailPullRequestId(reviewDetailOpen ? null : pullRequest.id)}
              />
            </div>

            {canUpdateBranch && !pullRequest.draft && (
              <PullRequestCiRerunButtons
                pullRequest={pullRequest}
                onChanged={() => {
                  onRefresh();
                  onUpdated?.();
                }}
              />
            )}

            {/* CIのジョブ単位の内訳（#2777）。押したときだけ取得する */}
            {ciDetailOpen && (
              <WorkflowRunProgressPanel
                repositoryFullName={pullRequest.repositoryFullName}
                runId={ciRunId}
                open={ciDetailOpen}
                title="CIの内訳"
                checks={ciChecks}
              />
            )}

            {reviewDetailOpen && (
              <PullRequestReviewFindings
                review={review}
                pullRequestNumber={pullRequest.number}
                pullRequestUrl={pullRequest.htmlUrl}
                reviewRunUrl={pullRequest.mergeJudgement.aiReview.runUrl}
                repair={{
                  repositoryFullName: pullRequest.repositoryFullName,
                  kinds: repairKinds,
                  availability: pullRequest.repairWorkflowAvailability,
                  runningKind: pullRequest.repairRun?.kind ?? null,
                }}
                responseAnchorId={reviewAction.kind === "none" ? undefined : REVIEW_RESPONSE_ANCHOR_ID}
              />
            )}
          </section>
        )}

        {error && <p className="px-4 py-3 text-sm text-destructive">{error}</p>}

        {!error && !currentDetail && isLoading && (
          <div className="flex flex-col gap-2 px-4 py-3">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        )}

        {/* サブPCで走るAIレビュー（PR_REVIEW・#3990）の状態。develop向けの未マージPRだけ。指摘の根拠なので指摘タブへ置く */}
        {activeTab === "findings" && isDevelopOpen && (
          <PullRequestAiReviewJobs
            repositoryFullName={pullRequest.repositoryFullName}
            prNumber={pullRequest.number}
            headSha={pullRequest.headSha}
          />
        )}

        {currentDetail && activeTab === "overview" && (
          <>
            {pullRequest.kind !== "release" && <PullRequestReviewRound pullRequest={pullRequest} />}

            {/* リリースPRの3区分（全体レビュー／統合検証／個別PRレビュー。#4238・#4277）。並びと形式は本番マージの
                確認ダイアログ・スマホのリリースシートと同じ部品で揃える */}
            {pullRequest.kind === "release" &&
              !releaseCandidate &&
              !pullRequest.merged &&
              pullRequest.state === "open" &&
              isReleaseCandidateHeadRef(pullRequest.headRef) && (
                <div className="border-b px-4 py-3">
                  <ConnectedReleaseReviewSections
                    repositoryFullName={pullRequest.repositoryFullName}
                    pullRequestNumber={pullRequest.number}
                    headRef={pullRequest.headRef}
                  />
                </div>
              )}

            {/* リリースPRの検証結果は、本文より先に出す（#2448）。見出しを持たないPRではparseがnullを返すので何も出ない */}
            {verification && (
              <VerificationSummaryPanel
                verification={verification}
                repositoryFullName={pullRequest.repositoryFullName}
                showRebuildGuide={!pullRequest.merged && pullRequest.state === "open"}
                onCreateFixIssue={
                  onCreateFixIssue && ((row) => onCreateFixIssue(row, pullRequest))
                }
                onAcknowledge={
                  pullRequest.merged || pullRequest.state !== "open"
                    ? undefined
                    : (row, reason) => sendReviewAck(row, "acknowledge", reason)
                }
                onRevokeAcknowledgement={
                  pullRequest.merged || pullRequest.state !== "open"
                    ? undefined
                    : (row) => sendReviewAck(row, "revoke")
                }
              />
            )}

            <section className="border-b px-4 py-3">
              {currentDetail.body.trim() ? (
                <MarkdownBody
                  content={currentDetail.body}
                  repositoryFullName={pullRequest.repositoryFullName}
                />
              ) : (
                <p className="text-sm text-muted-foreground">本文はありません。</p>
              )}
            </section>

            {/* GitHub Actions障害時のバックアップCI（#4065）。補足なのでここへ置く。
                develop向けの未マージPRだけ。CIが現在の阻害要因のときは上の主操作に理由を出している */}
            {isDevelopOpen && (
              <PullRequestBackupCi
                repositoryFullName={pullRequest.repositoryFullName}
                prNumber={pullRequest.number}
                headSha={pullRequest.headSha}
                headRef={pullRequest.headRef}
                actionsChecks={ciChecks}
              />
            )}
          </>
        )}

        {currentDetail && activeTab === "files" && (
          <PullRequestFileList
            pullRequestId={pullRequest.id}
            htmlUrl={pullRequest.htmlUrl}
            changedFiles={currentDetail.changedFiles}
            additions={currentDetail.additions}
            deletions={currentDetail.deletions}
            refreshKey={currentDetail.fetchedAt}
          />
        )}

        {currentDetail && activeTab === "activity" && (
          <section>
            <h2 className="border-b bg-muted/50 px-4 py-2 text-xs font-semibold">
              コメント {currentDetail.events.length}件
            </h2>
            {currentDetail.events.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                コメントはまだありません。
              </p>
            ) : (
              <ul>
                {currentDetail.events.map((event) => (
                  <EventItem
                    key={event.id}
                    event={event}
                    repositoryFullName={pullRequest.repositoryFullName}
                  />
                ))}
              </ul>
            )}
          </section>
        )}

        {footerSpacing && <div className="h-14" aria-hidden="true" />}
      </div>
    </div>
  );
}
