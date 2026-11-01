import { extractReviewConcerns } from "@/lib/github/pull-request-review-comment";
import type { PullRequestReviewCommentContent } from "@/lib/github/pull-request-review-comment";
import {
  isRepairWorkflowMissing,
  repairKindsFor,
  repairUnavailableNotices,
} from "@/lib/github/pull-request-repair";
import { resolveReviewVerdictFreshness } from "@/lib/github/review-verdict-freshness";
import type { PrimaryState } from "@/lib/pull-request-primary-state";
import type { PullRequestReviewResponseContext, PullRequestSummary } from "@/types/pull-request";

/**
 * 自動レビューが要修正・要確認と判定したPRで、利用者が次に何を押せばよいか（#4482）。
 *
 * PR詳細の上部（代表状態の下）と指摘タブの対応パネルは、**どちらもこの結果だけから作る**。
 * 片方にだけボタンがある・片方は消えている、という食い違いを作らないため。
 *
 * - `none` … 対応する指摘が無い（LGTM・省略・判定なし・閉じたPR・ドラフト）
 * - `repairing` … 自動修正が走っている。操作は不要
 * - `stale` … 判定が前のHEADのもの。新しいHEADの再レビューを待つ（古い指摘を現在の指摘として扱わない）
 * - `requested` … 現在のHEADへ修正を依頼済み。pushされるとCI・再レビューが走る。操作は不要
 * - `respond` … 利用者が対応を選ぶ。要修正で自動修正が使えれば`autoRepair`、自由文の依頼は廃止済みのため
 *   `request.available=false`と理由・代わりの操作を返す（ボタンも案内も無い状態にしない）
 */
export type ReviewAction =
  | { kind: "none" }
  | { kind: "repairing" }
  | { kind: "stale"; verdict: ReviewAttentionKind; reviewedSha: string | null }
  | { kind: "requested"; verdict: ReviewAttentionKind; commentUrl: string | null; createdAt: string }
  | {
      kind: "respond";
      verdict: ReviewAttentionKind;
      /** 上部に出す指摘の要点（最大3件）。本文が読めなければ空 */
      concerns: string[];
      /** レビュー本文を読めているか。読めていなければ「再読み込み／GitHubで読む」を出す */
      bodyAvailable: boolean;
      /** 既存の「PRを自動修正」（#4318の系列）を主操作にできるか。要修正だけが対象 */
      autoRepair: boolean;
      /** 自動修正ワークフローが未配布で押せないときの説明（要修正のときだけ） */
      autoRepairUnavailable: string | null;
      request: ReviewFixRequestAvailability;
      /** 依頼済みかを確かめられなかった（送信側の重複判定に任せる） */
      requestLookupFailed: boolean;
      /** 直前の依頼が中止・失敗した（#4639）。同じ画面から再送できる */
      interrupted: PullRequestReviewResponseContext["interruptedFixRequest"];
    };

export type ReviewAttentionKind = "changes-requested" | "needs-check";

/**
 * 自由文の修正依頼（Actions経由）は#4680で廃止した。サーバーの`requestPullRequestFix`は常に拒否するため、
 * 画面にも実行できるかのような依頼ボタンは出さず、理由と実際に使える次の操作（Issue詳細のホストセッション・
 * 修正Issueの起案）だけを返す。
 */
export type ReviewFixRequestAvailability = {
  available: false;
  reason: string;
  alternative: "draft-fix-issue" | "open-issue";
};

const ISSUE_BRANCH_PATTERN = /^issue-(\d+)$/;

/** 上部に並べる指摘の要点の上限。多いと原因より先に文章を読ませることになる */
const MAX_CONCERNS = 3;
const MAX_CONCERN_LENGTH = 90;

/**
 * レビュー本文から、上部に出す短い要点を取り出す。「気になった点」以降の箇条書き・番号付きの
 * 行頭だけを拾い、Markdownの装飾を落として切り詰める。拾えなければ空（本文は指摘タブで読む）。
 */
export function summarizeReviewConcerns(body: string): string[] {
  const concerns: string[] = [];
  for (const raw of extractReviewConcerns(body).split("\n")) {
    const match = /^(?:[-*+]|\d+[.)])\s+(.+)$/.exec(raw);
    if (!match) continue;
    const text = match[1]
      .replace(/\*\*|__|`/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .trim();
    if (!text) continue;
    concerns.push(text.length > MAX_CONCERN_LENGTH ? `${text.slice(0, MAX_CONCERN_LENGTH - 1)}…` : text);
    if (concerns.length >= MAX_CONCERNS) break;
  }
  return concerns;
}

export function deriveReviewAction(params: {
  pullRequest: PullRequestSummary;
  /** PR詳細のコメントから選んだレビュー本文。詳細を読み込む前・記録が無ければnull */
  review: PullRequestReviewCommentContent | null;
  /** PR詳細APIの`reviewResponse`。読み込む前・古い応答ではundefined */
  context: PullRequestReviewResponseContext | null | undefined;
}): ReviewAction {
  const { pullRequest, review, context } = params;
  const verdict = pullRequest.reviewVerdict?.reviewKind;
  if (pullRequest.merged || pullRequest.state !== "open" || pullRequest.draft) return { kind: "none" };
  if (verdict !== "changes-requested" && verdict !== "needs-check") return { kind: "none" };
  if (pullRequest.repairRun) return { kind: "repairing" };

  const reviewedSha = pullRequest.reviewVerdict?.reviewedSha ?? null;
  if (resolveReviewVerdictFreshness({ reviewedSha, headSha: pullRequest.headSha }) === "stale") {
    return { kind: "stale", verdict, reviewedSha };
  }

  if (context?.currentFixRequest) {
    return {
      kind: "requested",
      verdict,
      commentUrl: context.currentFixRequest.commentUrl,
      createdAt: context.currentFixRequest.createdAt,
    };
  }

  const repairKinds = repairKindsFor(pullRequest, pullRequest.mergeable);
  const reviewRepair = repairKinds.includes("review");
  const reviewWorkflowMissing = reviewRepair && isRepairWorkflowMissing(pullRequest.repairWorkflowAvailability, "review");

  const bodyAvailable = review !== null && !review.isStale;
  return {
    kind: "respond",
    verdict,
    concerns: bodyAvailable ? summarizeReviewConcerns(review.body) : [],
    bodyAvailable,
    autoRepair: reviewRepair && !reviewWorkflowMissing,
    autoRepairUnavailable: reviewWorkflowMissing
      ? (repairUnavailableNotices(["review"], pullRequest.repairWorkflowAvailability)[0] ?? null)
      : null,
    request: resolveRequestAvailability(pullRequest, context),
    requestLookupFailed: context?.fetchFailed ?? false,
    interrupted: context?.interruptedFixRequest ?? null,
  };
}

function resolveRequestAvailability(
  pullRequest: PullRequestSummary,
  context: PullRequestReviewResponseContext | null | undefined,
): ReviewFixRequestAvailability {
  const match = ISSUE_BRANCH_PATTERN.exec(pullRequest.headRef);
  if (!match) {
    return {
      available: false,
      reason: `${pullRequest.headRef} は issue-<番号> ブランチではないため、AIへの修正依頼を渡すIssueがありません。`,
      alternative: "draft-fix-issue",
    };
  }
  const issueNumber = Number(match[1]);
  if (context?.linkedIssueClosed) {
    return {
      available: false,
      reason: `Issue #${issueNumber} はクローズ済みのため、ここからの依頼は実行されません。Issueを再オープンするか、修正Issueを起案してください。`,
      alternative: "draft-fix-issue",
    };
  }
  // 11.localは作業を終えたあとも残ることがある（セッションの再開で付け直された等。#5160）。
  // 生きているセッションが無いと確かめられたときは「対応中」と言わず、外し忘れとして外す案内を出す
  if (context?.linkedIssueLocal && context.linkedIssueSessionAlive === false) {
    return {
      available: false,
      reason: `Issue #${issueNumber} に11.local（ローカルで対応中）が残っていますが、動いているローカルセッションはありません。作業を終えたセッションの外し忘れの可能性があります。Issue詳細のラベルから11.localを外し、ホストセッションを開いて指摘を伝えてください。`,
      alternative: "open-issue",
    };
  }
  if (context?.linkedIssueLocal) {
    return {
      available: false,
      reason: `Issue #${issueNumber} はローカルセッションで対応中（11.local）です。Issue詳細から実行中のセッションへ指摘を伝えて修正を依頼してください。`,
      alternative: "open-issue",
    };
  }
  return {
    available: false,
    reason: `PRへの自由文の修正依頼（Actions経由）は廃止しました。Issue #${issueNumber} の詳細からホストセッションを開き、指摘を伝えて修正を依頼してください。`,
    alternative: "open-issue",
  };
}

/**
 * 代表状態へ「依頼済み」を重ねる。代表状態（`derivePrimaryState`）は一覧と共通でPRの要約しか
 * 見ないため、Issueのコメントにある依頼はPR詳細でだけ分かる。**依頼済みでも解消済みにはしない**
 * ——新しいHEADのCI・再レビューの結果が出るまでは「修正を依頼済み」で待つ。
 */
export function applyReviewAction(primary: PrimaryState, action: ReviewAction): PrimaryState {
  if (primary.kind !== "review-findings" || action.kind !== "requested") return primary;
  return {
    ...primary,
    label: "修正を依頼済み",
    tone: "run",
    mark: "◷",
    reason: "AIへ同じPRの修正を依頼しました。pushされるとCI・再レビューが自動で走り、結果がそろうまで解消済みにはしません（操作は不要です）",
    needsAction: false,
    repairKinds: [],
  };
}
