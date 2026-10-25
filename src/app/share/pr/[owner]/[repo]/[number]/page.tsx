import type { Metadata } from "next";

import { ShareRedirect } from "@/components/share-redirect";
import { buildDashboardPath, buildShareMeta } from "@/lib/share-card";
import { getShareOrigin, loadPullRequestShareCard } from "@/lib/share-card-server";

type Props = { params: Promise<{ owner: string; repo: string; number: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { owner, repo, number } = await params;
  const { title, description } = buildShareMeta(await loadPullRequestShareCard(owner, repo, number), "pr");
  return {
    metadataBase: new URL(await getShareOrigin()),
    title,
    description,
    openGraph: { title, description, siteName: "IssueDeck", type: "website" },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function SharedPullRequestPage({ params }: Props) {
  const { owner, repo, number } = await params;
  return <ShareRedirect to={buildDashboardPath("pr", `${owner}/${repo}#${number}`)} />;
}
