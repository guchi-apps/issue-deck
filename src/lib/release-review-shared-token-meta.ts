/**
 * 全体レビューのランナーへ渡す共有トークンの非機密情報（#4975）。
 * 値・暗号文・説明・移行元参照（op://）は含めない。登録の有無・更新日時・最終利用日時・利用元だけを返す。
 */
export type SharedTokenReviewMeta = {
  name: string;
  updatedAt: string;
  lastUsedAt: string | null;
  consumers: string[];
};

export function buildSharedTokenReviewMeta(
  rows: readonly { id: string; name: string; updatedAt: Date }[],
  usages: readonly { sharedTokenId: string; consumer: string; usedAt: Date | null }[],
): SharedTokenReviewMeta[] {
  const byToken = new Map<string, { consumer: string; usedAt: Date }[]>();
  for (const u of usages) {
    if (!u.usedAt) continue;
    const list = byToken.get(u.sharedTokenId) ?? [];
    list.push({ consumer: u.consumer, usedAt: u.usedAt });
    byToken.set(u.sharedTokenId, list);
  }
  return rows.map((row) => {
    const list = [...(byToken.get(row.id) ?? [])].sort((a, b) => b.usedAt.getTime() - a.usedAt.getTime());
    return {
      name: row.name,
      updatedAt: row.updatedAt.toISOString(),
      lastUsedAt: list[0]?.usedAt.toISOString() ?? null,
      consumers: [...new Set(list.map((u) => u.consumer))],
    };
  });
}
