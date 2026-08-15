import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { collectWorkflowTags } from "@/lib/github/workflow-tags";

/**
 * 各リポジトリが参照している共有ワークフローのタグと、issue-deck 側の最新タグを返す（#985）。
 *
 * **画面を開いたときに1回だけ取得する。** タグを上げるのは日に何度もある操作ではない。
 * 例外は配布ワークフローが動いている間で、そのときだけ画面がポーリングする（#1602）。
 * 取得はGraphQLでまとめて行うためリクエスト数はリポジトリ数に比例しない（#1503）。
 */
export function GET() {
  return withGithubApiFeature("workflow_tags", () => handleGET());
}

async function handleGET() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const overview = await collectWorkflowTags(userId);
  // 実行中はポーリングで繰り返し読むため、途中の状態がキャッシュに固定されないようにする
  return NextResponse.json(overview, { headers: { "Cache-Control": "no-store" } });
}
