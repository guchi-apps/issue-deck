import { CHECK_USER_LABEL, type CheckUserReason } from "@/lib/github/approval-labels";
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
 * | 最後に`00.check-user`を付けたイベントの直前のコメントが`issue-deck-source:claude-conflict-resolve` | 確認待ちを付けたのがコンフリクト解消であること |
 * | そのコメントの投稿者と、ラベルを付けた者が同じ | 人が手で付けた確認待ちを、直前のワークフローのコメントに結び付けない |
 * | それより後のコメントもすべて同じ出所で、`00.check-user`が外されていない | 確認待ちの後に人や別の実行体が書いていれば、それが新しい起点かもしれない |
 *
 * **最新コメントの出所だけでは足りない。** 同じマーカーは着手・成功報告・フォールバック・断念の
 * すべてに付くので、CI修正が断念して付けた`01.check-blocked`の後にコンフリクト解消が着手・成功
 * すると、最新コメントだけ見れば条件を満たしてしまう（計画レビューの指摘）。そこで、ワークフローが
 * 「コメント→ラベル」の順で付ける（`.github/prompts/conflict-resolve.md`・フォールバック）ことを
 * 使い、ラベルが付いた時点の直前のコメントで起点を確かめる。
 *
 * **付与の時点はGitHubのtimeline（`labeled`イベント）で取り、DBの`Issue.checkUserLabeledAt`は
 * 使わない**（#4931）。あの列は同期でラベルを初めて見た時刻なので、別の実行体が付けてから同期
 * までの間にコンフリクト解消がコメントすると、そのコメントが「付与直前」に見えてしまう。timeline
 * はコメントとラベル付与を同じ並びで返すので、秒単位で同時刻になっても前後を取り違えない。
 * 付与イベントが見つからなければ起点が分からないので外さない。
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
  /** 対応Issueのtimeline（GitHubが返す順＝古い順） */
  timeline: readonly ConflictCheckUserTimelineEvent[];
};

/** GitHubの`/issues/{number}/timeline`のうち、この判定が読むフィールド */
export type ConflictCheckUserTimelineEvent = {
  event?: string;
  /** `commented`の本文 */
  body?: string | null;
  /** `labeled`・`unlabeled`のラベル */
  label?: { name: string } | null;
  /** 操作した者。`commented`では投稿者 */
  actor?: { login: string } | null;
};

/** コメントを取りに行く前に絞り込む条件（GitHub APIを消費しないもの） */
export function isConflictCheckUserClearCandidate(
  input: Omit<ConflictCheckUserClearInput, "timeline">,
): boolean {
  if (input.mergeable !== true || input.repairRunning) return false;
  return input.checkUserReason === "blocked";
}

function isConflictResolveComment(event: ConflictCheckUserTimelineEvent): boolean {
  return extractCommentSourceId({ body: event.body ?? "" }) === "claude-conflict-resolve";
}

function isCheckUserLabelEvent(event: ConflictCheckUserTimelineEvent, kind: string): boolean {
  return event.event === kind && event.label?.name === CHECK_USER_LABEL;
}

export function shouldClearConflictCheckUser(input: ConflictCheckUserClearInput): boolean {
  if (!isConflictCheckUserClearCandidate(input)) return false;
  const { timeline } = input;
  const labeledIndex = timeline.findLastIndex((event) => isCheckUserLabelEvent(event, "labeled"));
  if (labeledIndex < 0) return false;

  const before = timeline.slice(0, labeledIndex).filter((event) => event.event === "commented");
  const after = timeline.slice(labeledIndex + 1);
  const trigger = before.at(-1);
  if (trigger === undefined || !isConflictResolveComment(trigger)) return false;

  const labeler = timeline[labeledIndex].actor?.login;
  if (labeler === undefined || labeler !== trigger.actor?.login) return false;

  if (after.some((event) => isCheckUserLabelEvent(event, "unlabeled"))) return false;
  return after
    .filter((event) => event.event === "commented")
    .every(isConflictResolveComment);
}

/** 外したときにIssueへ残すコメント */
export function conflictCheckUserClearedCommentBody(pullRequestUrl: string): string {
  return [
    `✅ 対象PR（${pullRequestUrl}）のdevelopとのコンフリクトが解消されていることを確認したため、コンフリクト自動解消で付いていた確認待ち（\`00.check-user\`）を外しました。`,
    "",
    "<!-- issue-deck-source:conflict-sweep -->",
  ].join("\n");
}
