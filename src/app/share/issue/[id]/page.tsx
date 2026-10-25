import type { Metadata } from "next";

import { ShareRedirect } from "@/components/share-redirect";
import { buildDashboardPath, buildShareMeta } from "@/lib/share-card";
import { getShareOrigin, loadIssueShareCard } from "@/lib/share-card-server";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const { title, description } = buildShareMeta(await loadIssueShareCard(id), "issue");
  return {
    metadataBase: new URL(await getShareOrigin()),
    title,
    description,
    openGraph: { title, description, siteName: "IssueDeck", type: "website" },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function SharedIssuePage({ params }: Props) {
  const { id } = await params;
  return <ShareRedirect to={buildDashboardPath("issue", id)} />;
}
