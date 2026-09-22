/**
 * PR本文に残っている「Issueを閉じるPRか、途中PRか」のマーカーを読み取る（#3334）。
 *
 * **developへのマージではissueを自動クローズしない運用**（`CLAUDE.md`「PR本文テンプレート」）
 * のため、GitHubの`closes`/`fixes`キーワードでは「このPRでIssueが完結するか」を表せない。
 * 代わりに実装エージェントがPR本文の該当項目へ`<!-- issue-deck-pr-role:closing -->`
 * （このIssueを完了させる最終PR）または`<!-- issue-deck-pr-role:interim -->`
 * （後続PRが必要な途中PR）を書く。
 *
 * **問い合わせはしない。** 材料はPR本文だけで、Issue画面向けの取得（`/api/issues/pull-requests`）
 * は本文を既に受け取っている（`pull-request-review-verdict.ts`と同じ立場）。
 */

export type PullRequestRole = "closing" | "interim";

const ROLE_MARKER_PATTERN = /<!--\s*issue-deck-pr-role:(closing|interim)\s*-->/;

/**
 * PR本文からロールのマーカーを読み取る。無ければ`null`（マーカー導入前のPR・
 * このリポジトリの運用に従っていないPRなど、書かれていない場合すべてを含む）。
 */
export function parsePullRequestRole(body: string | null | undefined): PullRequestRole | null {
  if (!body) return null;
  const matched = ROLE_MARKER_PATTERN.exec(body);
  return matched ? (matched[1] as PullRequestRole) : null;
}
