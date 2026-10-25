import { renderShareCard, shareCardSize } from "@/lib/share-card-image";
import { loadIssueShareCard } from "@/lib/share-card-server";

export const size = shareCardSize;
export const contentType = "image/png";
export const alt = "IssueDeck";

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return renderShareCard("issue", await loadIssueShareCard(id));
}
