import type { CheckUserReason } from "@/lib/github/approval-labels";
import { extractCommentSourceId } from "@/lib/github/comment-source";

/**
 * コンフリクト自動解消が付けた確認待ち（`00.check-user`＋`01.check-blocked`）を、コンフリクトが
 * 消えたPRについて外してよいか（#4924）。
 *
 * `claude-conflict-resolve.yml`は、解消を断念したとき・報告コメントを確認できなかったとき
 * （フォールバック）に対応Issueへ確認待ちを付けて止まる。ところが**その後の再実行で解消に
 * 成功しても、付けた確認待ちを外す経路が無い。** #4917では1回目がフォールバックで確認待ちに
 * なり、2回目の解消が走ってPRがマージ可能になってからも「ユーザーの確認待ち」に残り続けた。
 * 人が見に行っても、もう直すものが無い。
 *
 * そこで、巡回（`runConflictSweep`）がコンフリクト有無を見たついでに外す。外してよいのは
 * **確認待ちの起点がコンフリクト解消だと言えるときだけ**にする。
 *
 * | 条件 | 理由 |
 * |---|---|
 * | PRが`mergeable === true` | 未判定（null）は外さない。直ったと言える根拠が無い |
 * | 解消の実行中でない | 走っている間は結果（断念の報告）がまだ出ていない |
 * | 理由ラベルが`01.check-blocked` | ワークフローが付けるのはこの1枚だけ。`01.check-merge`等は別の実行体の合図 |
 * | 確認待ちが付いた時点の直前のコメントが`issue-deck-source:claude-conflict-resolve` | 確認待ちを付けたのがコンフリクト解消であること |
 * | それより後のコメントもすべて同じ出所 | 確認待ちの後に人や別の実行体が書いていれば、それが新しい起点かもしれない |
 *
 * **最新コメントの出所だけでは足りない。** 同じマーカーは着手・成功報告・フォールバック・断念の
 * すべてに付くので、CI修正が断念して付けた`01.check-blocked`の後にコンフリクト解消が着手・成功
 * すると、最新コメントだけ見れば条件を満たしてしまう（計画レビューの指摘）。そこで、ワークフローが
 * 「コメント→ラベル」の順で付ける（`.github/prompts/conflict-resolve.md`・フォールバック）ことを
 * 使い、ラベルが付いた時点の直前のコメントで起点を確かめる。
 *
 * 後半の条件は保守的に倒してある。フォールバックの後に人がコメントしていれば外さない——
 * 誤って外すと、人が見るべき状態が一覧から黙って消える。外し損ねても従来どおり人が外せる。
 */
export type ConflictCheckUserClearInput = {
  /** 対応Issueの確認待ちの理由（`checkUserReason`）。確認待ちでなければnull */
  checkUserReason: CheckUserReason | null;
  /** 対応PRのコンフリクト有無（GitHubの`mergeable`） */
  mergeable: boolean | null;
  /** 同じPRのコンフリクト解消が走っているか */
  repairRunning: boolean;
  /**
   * `00.check-user`が付いた時刻（`Issue.checkUserLabeledAt`）。同期した時刻なので実際の付与より
   * 数秒遅い。未記録（null）なら起点が分からないので外さない
   */
  checkUserLabeledAt: Date | null;
  /** 対応Issueのコメント（古い順）。本文がnullのものも含めてよい */
  comments: readonly { body: string | null; created_at: string }[];
};

/** コメントを取りに行く前に絞り込む条件（GitHub APIを消費しないもの） */
export function isConflictCheckUserClearCandidate(
  input: Omit<ConflictCheckUserClearInput, "comments">,
): boolean {
  if (input.mergeable !== true || input.repairRunning || input.checkUserLabeledAt === null) {
    return false;
  }
  return input.checkUserReason === "blocked";
}

function isConflictResolveComment(comment: { body: string | null }): boolean {
  return extractCommentSourceId({ body: comment.body ?? "" }) === "claude-conflict-resolve";
}

export function shouldClearConflictCheckUser(input: ConflictCheckUserClearInput): boolean {
  if (!isConflictCheckUserClearCandidate(input) || input.checkUserLabeledAt === null) return false;
  const labeledAt = input.checkUserLabeledAt.getTime();
  const before = input.comments.filter((comment) => Date.parse(comment.created_at) <= labeledAt);
  const after = input.comments.filter((comment) => Date.parse(comment.created_at) > labeledAt);
  const trigger = before.at(-1);
  if (trigger === undefined || !isConflictResolveComment(trigger)) return false;
  return after.every(isConflictResolveComment);
}

/** 外したときにIssueへ残すコメント */
export function conflictCheckUserClearedCommentBody(pullRequestUrl: string): string {
  return [
    `✅ 対象PR（${pullRequestUrl}）のdevelopとのコンフリクトが解消されていることを確認したため、コンフリクト自動解消で付いていた確認待ち（\`00.check-user\`）を外しました。`,
    "",
    "<!-- issue-deck-source:conflict-sweep -->",
  ].join("\n");
}
