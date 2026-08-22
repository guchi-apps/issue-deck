import { extractCommentSourceId } from "@/lib/github/comment-source";
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
 * 定型文の見出し語。ワークフロー（`reusable-claude-review-develop.yml`の`auto-merge`・
 * `claude-review-fallback`・`auto-merge-fallback`）と、この定型に揃えるよう指示してある
 * レビューエージェント（`.github/prompts/review-develop.md`・`scripts/prompts/review-agent.md`）
 * が書く。**この形のコメントに続く箇条書きは、理由だけが並んでいる。**
 *
 * **絵文字と読点の位置は将来変わりうるので、変わりにくい中核だけを見る。** それでも文面が
 * 変わればここは黙って`label`／`unknown`へ落ちるため、ワークフロー側・プロンプト側の文言を
 * 変えるときは`merge-check-reasons.test.ts`の固定文面もあわせて更新する。
 */
const TEMPLATE_LEADS = [
  "developへのマージ前にユーザーの確認が必要",
  // 判定より先にマージされていた場合の文面（#1968）
  "事後の確認が必要",
] as const;

/**
 * 定型文が1件も無かったときだけ見る、自由文の二次判定向けの見出し語（#2062）。
 *
 * 定型を指示する前に投稿された過去コメントを読むためのフォールバックで、**定型文より優先しない。**
 * 自由文の箇条書きには理由以外の行が混ざる（Issue #2042は1つ目が「変更内容自体は…挙動は変えて
 * いません」という該当しない側の補足で、Issue #1849は箇条書きがそのまま理由）。定型文があれば
 * そちらが理由の正なので、この揺れを画面へ出さずに済む。
 */
const FREEFORM_LEADS = ["自動マージ不可"] as const;

/** 理由コメント中の箇条書き行（`add_reason`が`- <理由>`の形で組み立てる） */
const BULLET_PATTERN = /^\s*[-*]\s+(.+?)\s*$/;

/** Markdownの見出し行。理由の範囲は次の見出しの手前で打ち切る */
const HEADING_PATTERN = /^\s{0,3}#{1,6}\s/;

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

/**
 * そのコメントがレビュー経路（`claude-review-develop`）発か。
 *
 * **`resolveCommentSource`ではなく`extractCommentSourceId`を使う。** 前者はagentマーカーを
 * sourceマーカーより先に読むため、両方付いたコメントは`kind: "agent"`になる。ローカルの
 * レビュー・統合セッションはユーザー本人のトークンで投稿するので表示用の
 * `<!-- issue-deck-agent:reviewer -->`が要り（#1346）、そちらの経路が丸ごと弾かれていた（#2062）。
 */
function isReviewComment(comment: Pick<IssueComment, "body">): boolean {
  return extractCommentSourceId(comment) === "claude-review-develop";
}

/**
 * 理由コメントの本文から箇条書きだけを取り出す。
 *
 * 見出し語の行より後ろ・**次の見出し行より前**だけを見る。この範囲の制限が、レビュー本文
 * （「### 総評」「### 気になった点」…）の箇条書きを理由として誤って拾わないための唯一の
 * 歯止めになっている。同じコメントに見出し語が複数あれば、**箇条書きが取れた最初のもの**を
 * 採る（見出しに見出し語が入り、本文の段落にも入る書き方が実際にあるため。#1849）。
 */
function extractReasonItems(body: string, leads: readonly string[]): string[] {
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!leads.some((lead) => lines[i].includes(lead))) continue;
    const items: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (HEADING_PATTERN.test(lines[j])) break;
      const item = lines[j].match(BULLET_PATTERN)?.[1];
      if (item) items.push(item);
    }
    if (items.length > 0) return items;
  }
  return [];
}

/** レビュー経路のコメントを新しい順に見て、`leads`で理由を取り出せた最初の1件を返す */
function findReasonComment(
  comments: Pick<IssueComment, "body" | "createdAtLabel">[],
  leads: readonly string[],
): MergeCheckReasons | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    if (!isReviewComment(comment)) continue;
    const items = extractReasonItems(comment.body, leads);
    // 見出し語はあるのに箇条書きが1件も無いコメントは判断材料にならないので、次の候補へ進む
    // （自動レビューの本文コメントはこれで落ちる。理由は別コメントの方に載っている）
    if (items.length === 0) continue;
    return { source: "review", items, postedAtLabel: comment.createdAtLabel };
  }
  return null;
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
  // 定型文を先に全件見てから、1件も無いときだけ自由文へ落とす（#2062）。
  // 新しい順に1回で見ると、定型文より後に投稿された自由文が定型文を上書きしてしまう。
  const fromTemplate = findReasonComment(comments, TEMPLATE_LEADS);
  if (fromTemplate) return fromTemplate;
  const fromFreeform = findReasonComment(comments, FREEFORM_LEADS);
  if (fromFreeform) return fromFreeform;

  const names = new Set(labels.map((label) => label.name));
  const labelItems = LABEL_REASONS.filter((reason) => names.has(reason.label)).map(
    (reason) => reason.text,
  );
  if (labelItems.length > 0) {
    return { source: "label", items: labelItems, postedAtLabel: null };
  }

  return { source: "unknown", items: [UNKNOWN_REASON_TEXT], postedAtLabel: null };
}
