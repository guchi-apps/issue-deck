import type { IssueLabel } from "@/types/issue";

// 「どんな種類のIssueか」が分かるラベルの番号帯（#3285）。30〜69番台は不具合・調査・新機能・
// 改善・雑務など、Issueの中身を分類するラベル（`.github/labels.json`の`problem`・`change`・
// `maintenance`）。00〜29番台の要対応・実行オプション、70番台以降の状態・優先度・Closeは
// 「種類」ではなく運用上の札なので含めない。
const KIND_MIN_BAND = 30;
const KIND_MAX_BAND = 69;
const NUMBER_BAND_PATTERN = /^(\d{2})\./;

/** 種類ラベル（30〜69番台）かどうか。番号プレフィックスの無いラベルは対象外 */
export function isKindLabel(labelName: string): boolean {
  const match = NUMBER_BAND_PATTERN.exec(labelName);
  if (!match) return false;
  const band = Number(match[1]);
  return band >= KIND_MIN_BAND && band <= KIND_MAX_BAND;
}

/** 一覧の行に出す種類ラベルを、番号の小さい順に並べて返す。同じ番号は元の順序を保つ */
export function selectKindLabels(labels: IssueLabel[]): IssueLabel[] {
  return labels
    .filter((label) => isKindLabel(label.name))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
}
