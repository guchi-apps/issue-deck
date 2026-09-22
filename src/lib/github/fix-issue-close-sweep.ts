import { COMMENT_SOURCE_MARKER } from "@/lib/github/progress-sweep";

/**
 * 「修正Issueを起案」（`pull-request-fix-issue.ts`）が作る修正Issueを、対象PRのマージ検知で
 * 巡回から自動closeする（#3353）。
 *
 * 修正Issueはレビュー指摘への対応として、セッションへの依頼や追加コミットの形で**対象PR側へ
 * 直接取り込まれる**ことが多く、修正Issue自身は`issue-<番号>`ブランチを持たない。そのため
 * 「本番反映を検知してcloseする」既存の巡回（`decideMergedOpenIssue`・#2715）はブランチの
 * 有無を前提にしており対象外になり、対象PRがマージされても手動closeを忘れると残り続けていた。
 *
 * 判定と文面はここに置く（純粋関数）。DB・GitHubに触る側は
 * [`fix-issue-close-sweep-run.ts`](./fix-issue-close-sweep-run.ts)。全指摘が対応済みの
 * コードレビューIssueを閉じる`code-review-close-sweep.ts`と同じ構造。
 */

/** 平常時に毎巡回起きる見送り理由。ログに出さず、件数にも数えない */
export type FixIssueCloseQuietSkipReason =
  /** 対象PRがまだopen（大多数はこれ） */
  | "pr_open"
  /** 対象PRがマージされずにクローズされた（別PRに置き換えられた可能性があり、安全側で見送る） */
  | "pr_not_merged";

/** closeすると決めた後に止まったもの。巡回の`skipped`へ数える */
export type FixIssueCloseSkipReason =
  /** 人が開け直したことがある。閉じ直さない */
  | "fix_issue_reopened"
  /** 開け直しの有無を確かめられなかった。次の巡回で引き直す */
  | "fix_issue_reopen_unknown";

export type FixIssueCloseDecision =
  | { action: "close" }
  | { action: "skip"; reason: FixIssueCloseQuietSkipReason };

/**
 * 修正Issue1件を閉じてよいかを、対象PRの状態から決める。
 *
 * **閉じるのは対象PRがマージされたときだけ。** クローズされても未マージなら、別PRへの
 * 置き換えなど中身が分からない状態のため見送る。
 */
export function decideFixIssueClose(params: {
  pullRequest: { merged: boolean; state: "open" | "closed" };
}): FixIssueCloseDecision {
  if (params.pullRequest.merged) return { action: "close" };
  return {
    action: "skip",
    reason: params.pullRequest.state === "open" ? "pr_open" : "pr_not_merged",
  };
}

/** 自動closeしたときに残すコメント。なぜ閉じたのかと、開け直せば閉じ直さないことを伝える */
export function buildFixIssueAutoClosedComment(pullRequestNumber: number): string {
  return [
    `✅ 対象PR #${pullRequestNumber} がマージされ、この修正が取り込まれたと判断してこのIssueをcloseしました。`,
    "",
    "まだ対応が残っている場合は、このIssueを開き直してください（開き直したものは自動では閉じません）。",
    "",
    COMMENT_SOURCE_MARKER,
  ].join("\n");
}
