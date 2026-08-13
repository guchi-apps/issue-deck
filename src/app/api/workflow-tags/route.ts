import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { collectWorkflowTags } from "@/lib/github/workflow-tags";

/**
 * 各リポジトリが参照している共有ワークフローのタグと、issue-deck 側の最新タグを返す（#985）。
 *
 * **リポジトリ数ぶんのGitHub API呼び出しになるため、画面を開いたときに1回だけ取得する。**
 * ポーリングはしない。タグを上げるのは日に何度もある操作ではない。
 */
export function GET() {
  return withGithubApiFeature("sync", () => handleGET());
}

async function handleGET() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const overview = await collectWorkflowTags(userId);
  return NextResponse.json(overview);
}
