import { renderShareCard, shareCardSize } from "@/lib/share-card-image";
import { loadPullRequestShareCard } from "@/lib/share-card-server";

export const size = shareCardSize;
export const contentType = "image/png";
export const alt = "IssueDeck";
// 公開→非公開の切替を次の取得から反映するため、結果をキャッシュせず毎回DBの公開判定を通す（#5090）
export const dynamic = "force-dynamic";

export default async function Image({
  params,
}: {
  params: Promise<{ owner: string; repo: string; number: string }>;
}) {
  const { owner, repo, number } = await params;
  return renderShareCard("pr", await loadPullRequestShareCard(owner, repo, number));
}
