/**
 * 起案済みスレッドへの追加返信の分類（#4454）。**決まった言い回しだけで判定し、LLMには任せない。**
 * 迷う内容は`supplement`（既存Issueへのコメント追記）に倒す。コメントは後から消せ、新しいIssueを
 * 勝手に増やさない側の失敗になるため。分割（`split`）は「別件」「別Issue」と明示されたときだけ。
 */
export type FollowUpKind = "thanks" | "question" | "split" | "supplement";

const THANKS = /^(?:\s*(?:ありがとう(?:ございます|ございました)?|感謝(?:します)?|助かり(?:ます|ました)|了解(?:です|しました)?|承知(?:しました)?|ok(?:ay)?|thanks?|thx|👍|🙏)[\s!！。.、]*)+$/i;
const QUESTION = /([?？]\s*$)|(?:ですか|ますか|でしょうか|かな|教えて|どうなって|どうなる|いつ頃|いつまで)/;
const SPLIT = /(?:別件|別のissue|別issue|別のIssue|別Issue|別で(?:起案|issue|Issue)|独立した(?:課題|依頼|issue|Issue))/i;

export function classifyFollowUp(rawText: string): FollowUpKind {
  const text = rawText.trim();
  if (!text) return "thanks";
  if (THANKS.test(text)) return "thanks";
  if (SPLIT.test(text)) return "split";
  if (QUESTION.test(text) && text.length <= 200) return "question";
  return "supplement";
}
