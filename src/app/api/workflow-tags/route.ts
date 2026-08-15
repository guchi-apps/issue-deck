import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { collectWorkflowTags } from "@/lib/github/workflow-tags";

/**
 * 各リポジトリが参照している共有ワークフローのタグと、issue-deck 側の最新タグを返す（#985）。
 *
 * **画面を開いたときに1回だけ取得する。** ポーリングはしない。タグを上げるのは日に何度も
 * ある操作ではない。取得はGraphQLでまとめて行うためリクエスト数はリポジトリ数に比例しない
 * （#1503）。
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
  return NextResponse.json(overview);
}
