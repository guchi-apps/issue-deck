import { resolveCommentSource } from "@/lib/github/comment-source";
import {
  MERGE_CONFIRM_REQUIRED_LABEL,
  PREVIEW_REQUIRED_LABEL,
  SCREENSHOT_REQUIRED_LABEL,
} from "@/lib/github/start-implementation";
import type { IssueComment, IssueLabel } from "@/types/issue";

/**
 * 「なぜ自動マージされず、ユーザーのマージ操作が要るのか」の出所（#1631）。
 *
 * - `review` … 自動レビュー（`reusable-claude-review-develop.yml`）が投稿した理由コメント
 * - `label` … Issueのラベルから導いた理由（理由コメントが投稿されなかった場合のフォールバック）
 * - `unknown` … どちらも見つからなかった。**理由を作らずに「見つからない」と出す**
 */
export type MergeCheckReasonSource = "review" | "label" | "unknown";

export type MergeCheckReasons = {
  source: MergeCheckReasonSource;
  /** 箇条書き1行ぶんの本文。`unknown`のときも案内の1行が入るため、常に1件以上ある */
  items: string[];
  /** `review`のときだけ、その理由コメントの相対時刻（`IssueComment.createdAtLabel`） */
  postedAtLabel: string | null;
};

/**
 * 自動レビューが投稿する理由コメントの目印。`reusable-claude-review-develop.yml`の
 * `auto-merge`ジョブが組み立てている定型文（「⚠️ 以下の理由により、developへのマージ前に
 * ユーザーの確認が必要と判定しました。」）の一部。
 *
 * **絵文字と読点の位置は将来変わりうるので、変わりにくい中核だけを見る。** それでも文面が
 * 変わればここは黙って`label`／`unknown`へ落ちるため、ワークフロー側の文言を変えるときは
 * `merge-check-reasons.test.ts`の固定文面もあわせて更新する。
 */
const REVIEW_REASON_LEAD = "developへのマージ前にユーザーの確認が必要";

/** 理由コメント中の箇条書き行（`add_reason`が`- <理由>`の形で組み立てる） */
const BULLET_PATTERN = /^\s*[-*]\s+(.+?)\s*$/;

/** ラベルから導ける理由。ワークフローが理由コメントを省いた場合（#594）のフォールバック */
const LABEL_REASONS: readonly { label: string; text: string }[] = [
  {
    label: MERGE_CONFIRM_REQUIRED_LABEL,
    text: `マージ前の確認が必要な設定（\`${MERGE_CONFIRM_REQUIRED_LABEL}\`）が付いています`,
  },
  {
    label: PREVIEW_REQUIRED_LABEL,
    text: `開発環境での確認待ちです（\`${PREVIEW_REQUIRED_LABEL}\`）`,
  },
  {
    label: SCREENSHOT_REQUIRED_LABEL,
    text: `スクリーンショットの確認待ちです（\`${SCREENSHOT_REQUIRED_LABEL}\`）`,
  },
];

/** 出所が1つも見つからなかったときに出す案内 */
const UNKNOWN_REASON_TEXT =
  "理由の記録が見つかりませんでした。PRのレビューコメントを確認してください。";

/** そのコメントが自動レビューの理由コメントか。マーカーの解決は`resolveCommentSource`に任せる */
function isReviewReasonComment(comment: Pick<IssueComment, "body" | "author">): boolean {
  if (!comment.body.includes(REVIEW_REASON_LEAD)) return false;
  const resolved = resolveCommentSource(comment, comment.author.login);
  return resolved?.kind === "source" && resolved.id === "claude-review-develop";
}

/**
 * 理由コメントの本文から箇条書きだけを取り出す。定型文の見出し行より後ろだけを見るので、
 * 見出しより前に別の箇条書きが差し込まれていても拾わない。
 */
function extractReviewReasonItems(body: string): string[] {
  const lines = body.split("\n");
  const leadIndex = lines.findIndex((line) => line.includes(REVIEW_REASON_LEAD));
  if (leadIndex < 0) return [];
  return lines
    .slice(leadIndex + 1)
    .map((line) => line.match(BULLET_PATTERN)?.[1])
    .filter((item): item is string => Boolean(item));
}

/**
 * ユーザーのマージ操作が必要な理由を解決する（#1631）。
 *
 * 進捗ステッパーの「ユーザー確認待ち・PRのマージ」は**何を求めているか**しか表さず、
 * **なぜ自動マージされなかったか**はタイムラインの奥にある理由コメントにしか無い。
 * マージボタンの隣へ出すために、既にある判定結果を読むだけの関数として切り出している。
 * **判定そのものはやり直さない**（issue-deckはPRの差分を持っておらず、パスパターンによる
 * リスク判定を再現するとワークフローの判定と食い違う表示ができてしまう）。
 *
 * @param comments 古い順に並んだIssueコメント。理由コメントが複数あれば最新のものを採る
 */
export function resolveMergeCheckReasons(
  labels: IssueLabel[],
  comments: Pick<IssueComment, "body" | "author" | "createdAtLabel">[],
): MergeCheckReasons {
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    if (!isReviewReasonComment(comment)) continue;
    const items = extractReviewReasonItems(comment.body);
    // 定型文はあるのに箇条書きが1件も無いコメントは判断材料にならないので、次の候補へ進む
    if (items.length === 0) continue;
    return { source: "review", items, postedAtLabel: comment.createdAtLabel };
  }

  const names = new Set(labels.map((label) => label.name));
  const labelItems = LABEL_REASONS.filter((reason) => names.has(reason.label)).map(
    (reason) => reason.text,
  );
  if (labelItems.length > 0) {
    return { source: "label", items: labelItems, postedAtLabel: null };
  }

  return { source: "unknown", items: [UNKNOWN_REASON_TEXT], postedAtLabel: null };
}
