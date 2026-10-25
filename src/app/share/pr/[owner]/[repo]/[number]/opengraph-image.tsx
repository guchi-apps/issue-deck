import { renderShareCard, shareCardSize } from "@/lib/share-card-image";
import { loadPullRequestShareCard } from "@/lib/share-card-server";

export const size = shareCardSize;
export const contentType = "image/png";
export const alt = "IssueDeck";

export default async function Image({
  params,
}: {
  params: Promise<{ owner: string; repo: string; number: string }>;
}) {
  const { owner, repo, number } = await params;
  return renderShareCard("pr", await loadPullRequestShareCard(owner, repo, number));
}
