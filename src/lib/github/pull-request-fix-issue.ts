import {
  extractReviewConcerns,
  quoteReviewText,
  type PullRequestReviewCommentContent,
} from "@/lib/github/pull-request-review-comment";
import { needsReviewAttention } from "@/lib/github/pull-request-review-verdict";
import type { PullRequestEvent, PullRequestSummary } from "@/types/pull-request";

/**
 * PR詳細の「修正Issueを起案」（#2961）。
 *
 * **ここでは起票しない。** 埋めた新規作成ダイアログを開くための下書きを作るだけで、立てるか・
 * どの指摘を残すかは読んだ人が決める（リリースPRの検証結果から作る
 * `buildReleaseVerificationFixIssueDraft`・#2838と同じ立場）。
 *
 * リリースPR（develop→main）には帯を出さない。そちらは検証結果パネルに元Issueごとの
 * 「修正をIssueにする」があり、1本のリリースPRへまとめて起案すると元Issueとの対応が消える。
 */

export type PullRequestFixIssueDraft = {
  repositoryFullName: string;
  title: string;
  body: string;
};

/**
 * 帯の強さ。`changes-requested`は赤、`needs-check`は黄、`none`は控えめなボタンだけ。
 *
 * 材料はPR本文の自動レビュー判定（`reviewVerdict`）と、人の「変更を要求」レビュー。
 * **自動レビューの本文はここでは取りに行かない**——判定だけならPR本文から読めており、
 * 本文の取得（GitHub APIを2リクエスト使う）はボタンを押したときだけにする。
 */
export type PullRequestFixIssueTone = "changes-requested" | "needs-check" | "none";

export function showsPullRequestFixIssueBar(pullRequest: Pick<PullRequestSummary, "kind">): boolean {
  return pullRequest.kind !== "release";
}

/**
 * いま「変更を要求」のまま残っている人のレビュー。レビュアーごとに最後の判定だけを見る。
 *
 * **コメントだけのレビューは判定を上書きしない**（GitHubでも変更要求はApproveか取り消しで
 * 解けるまで残る）。後から承認・取り消しされたものは、直す対象ではないので落とす。
 */
export function selectOpenChangeRequests(events: readonly PullRequestEvent[]): PullRequestEvent[] {
  const latestByAuthor = new Map<string, PullRequestEvent>();
  for (const event of events) {
    if (event.kind !== "review" || event.reviewState === null || event.reviewState === "commented") {
      continue;
    }
    latestByAuthor.set(event.authorLogin, event);
  }
  return events.filter(
    (event) =>
      event.reviewState === "changes_requested" && latestByAuthor.get(event.authorLogin) === event,
  );
}

export function resolvePullRequestFixIssueTone(
  pullRequest: Pick<PullRequestSummary, "reviewVerdict">,
  openChangeRequests: readonly PullRequestEvent[],
): PullRequestFixIssueTone {
  const kind = pullRequest.reviewVerdict?.reviewKind;
  if (kind === "changes-requested" || openChangeRequests.length > 0) return "changes-requested";
  if (kind && needsReviewAttention(kind)) return "needs-check";
  return "none";
}

function stateLabel(pullRequest: Pick<PullRequestSummary, "merged" | "state">): string {
  if (pullRequest.merged) return "マージ済み";
  return pullRequest.state === "closed" ? "クローズ済み" : "未マージ";
}

export function buildPullRequestFixIssueDraft(params: {
  pullRequest: Pick<
    PullRequestSummary,
    | "repositoryFullName"
    | "number"
    | "title"
    | "baseRef"
    | "headRef"
    | "merged"
    | "state"
    | "linkedIssueNumbers"
    | "reviewVerdict"
  >;
  /** 自動レビューの本文。取れなかった・無い場合はnull */
  review: Pick<PullRequestReviewCommentContent, "body" | "verdictLabel" | "isStale"> | null;
  openChangeRequests: readonly PullRequestEvent[];
}): PullRequestFixIssueDraft {
  const { pullRequest, review, openChangeRequests } = params;
  const tone = resolvePullRequestFixIssueTone(pullRequest, openChangeRequests);
  const verdictLabel = pullRequest.reviewVerdict?.reviewLabel ?? review?.verdictLabel ?? null;
  const issueRefs = pullRequest.linkedIssueNumbers.map((number) => `#${number}`).join("、");

  const lead =
    tone === "none"
      ? `${pullRequest.repositoryFullName} の PR #${pullRequest.number} に対する修正です。`
      : `${pullRequest.repositoryFullName} の PR #${pullRequest.number} のレビューで` +
        `${tone === "changes-requested" ? "修正を求められた" : "確認を求められた"}指摘です。`;

  const lines = [
    lead,
    "",
    `- 元Issue: ${issueRefs || "（記録なし）"}`,
    `- 対象PR: #${pullRequest.number}（${pullRequest.baseRef} ← ${pullRequest.headRef}・${stateLabel(pullRequest)}）`,
    `- 自動レビュー: ${verdictLabel ?? "（記録なし）"}`,
    "",
    "## 指摘",
    "",
  ];

  const quotes: string[] = [];
  if (review) {
    quotes.push(
      [
        `**自動レビュー（${review.verdictLabel}）**` +
          (review.isStale ? "（PRの最新コミットより前のコミットへのレビューです）" : ""),
        "",
        quoteReviewText(extractReviewConcerns(review.body)),
      ].join("\n"),
    );
  }
  for (const event of openChangeRequests) {
    quotes.push(
      [
        `**変更を要求（${event.authorLogin}）**`,
        "",
        event.body.trim() ? quoteReviewText(event.body.trim()) : "> （本文なし。差分の行へのコメントを確認してください）",
      ].join("\n"),
    );
  }
  lines.push(
    quotes.length > 0
      ? quotes.join("\n\n")
      : `レビューの指摘は取り込めませんでした。PR #${pullRequest.number} のレビューを読んで、直す点を書いてください。`,
  );

  lines.push("", "## 関連", "");
  for (const number of pullRequest.linkedIssueNumbers) {
    lines.push(`- 元Issue: #${number}`);
  }
  lines.push(`- 対象PR: #${pullRequest.number}`);

  return {
    repositoryFullName: pullRequest.repositoryFullName,
    title: `${pullRequest.title} の修正（レビュー指摘）`,
    body: lines.join("\n"),
  };
}
