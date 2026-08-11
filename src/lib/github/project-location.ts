/**
 * 進捗管理に使うGitHub Projects v2の場所（#991）。
 *
 * Projectを使わない環境（Project未導入のリポジトリ・プレビュー環境・テスト）でも壊れないよう、
 * 環境変数が欠けているときは黙って何もしない設計にしている。「マージするか」と「有効にするか」を
 * 分離するフィーチャーフラグでもある（設計は docs/progress-status-architecture.md）。
 */
export type ProjectLocation = { owner: string; number: number };

export function getProjectLocation(): ProjectLocation | null {
  const owner = process.env.PROJECT_V2_OWNER;
  const rawNumber = process.env.PROJECT_V2_NUMBER;
  if (!owner || !rawNumber) return null;

  const number = Number(rawNumber);
  if (!Number.isInteger(number) || number <= 0) {
    console.error("[project-location] PROJECT_V2_NUMBER が不正です", rawNumber);
    return null;
  }
  return { owner, number };
}
