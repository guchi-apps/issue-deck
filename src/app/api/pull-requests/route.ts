import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { fetchPullRequestListForUser } from "@/lib/pull-request-list-fetch";
import type { PullRequestListScope } from "@/types/pull-request";

export function GET(request: Request) {
  return withGithubApiFeature("pull_request_list", () => handleGET(request));
}

async function handleGET(request: Request) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 既定はマージ待ち（open）のみ。`scope=all`のときだけクローズ済みも足す（#1312）。
  const scope: PullRequestListScope =
    new URL(request.url).searchParams.get("scope") === "all" ? "all" : "open";

  return NextResponse.json(await fetchPullRequestListForUser(userId, scope));
}
