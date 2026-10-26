import { renderShareCard, shareCardSize } from "@/lib/share-card-image";
import { loadIssueShareCard } from "@/lib/share-card-server";

export const size = shareCardSize;
export const contentType = "image/png";
export const alt = "IssueDeck";
// 公開→非公開の切替を次の取得から反映するため、結果をキャッシュせず毎回DBの公開判定を通す（#5090）
export const dynamic = "force-dynamic";

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return renderShareCard("issue", await loadIssueShareCard(id));
}
