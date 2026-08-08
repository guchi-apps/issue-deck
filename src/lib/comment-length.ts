/**
 * コメント本文の分量（文字数・読了予想時間）を求めるユーティリティ（#741）。
 *
 * AI要約を生成するかどうかを判断する材料として、コメント本文がどれくらいの分量かを
 * 画面に表示するために使う。
 */

/**
 * 読了予想時間の算出に使う読解速度（文字/分）。
 *
 * 日本語の黙読速度は一般に400〜600文字/分程度とされるため、その中間の500文字/分を採る。
 * コードブロックや箇条書きの多い技術的なコメントでは実際の読了時間と差が出るため、
 * 表示は「約N分」という概算であることが分かる形にしている。
 */
const CHARACTERS_PER_MINUTE = 500;

/**
 * 本文の文字数を数える。
 *
 * `String.prototype.length`はUTF-16のコード単位数を返すため、絵文字などのサロゲートペアが
 * 2文字と数えられてしまう。人が見た文字数に近づけるためコードポイント単位で数える。
 */
export function countCharacters(body: string): number {
  return Array.from(body).length;
}

/** 文字数から読了予想時間（分）を求める。1文字以上ある場合は最低1分とする。 */
export function estimateReadingMinutes(characterCount: number): number {
  if (characterCount <= 0) return 0;
  return Math.max(1, Math.round(characterCount / CHARACTERS_PER_MINUTE));
}

/** コメント本文の分量を「1,234文字・約2分」形式のラベルにする。空文字の場合はnullを返す。 */
export function formatCommentLength(body: string): string | null {
  const characterCount = countCharacters(body);
  if (characterCount <= 0) return null;
  const minutes = estimateReadingMinutes(characterCount);
  return `${characterCount.toLocaleString("ja-JP")}文字・約${minutes}分`;
}
