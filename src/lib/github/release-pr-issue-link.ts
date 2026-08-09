/**
 * PRのタイトル・本文から参照Issue番号を抽出する。`#`の直後が数字の箇所を全て拾い重複除去する
 * （`#discussion_r123`・`#L10`のようなURLフラグメント識別子は`#`の直後が英字のため誤マッチしない）。
 * `closes #123`のようなクローズキーワードも本文中の`#123`としてこのパターンだけで拾える。
 */
export function extractLinkedIssueNumbers(title: string, body: string | null): number[] {
  const text = `${title}\n${body ?? ""}`;
  const matches = text.matchAll(/#(\d+)/g);
  const numbers = new Set<number>();
  for (const match of matches) {
    numbers.add(Number(match[1]));
  }
  return [...numbers];
}
