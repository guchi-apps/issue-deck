import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { dispatchPropagation } from "@/lib/github/workflow-tags";

/**
 * 更新が必要なリポジトリへ、共有ワークフローのタグを上げるPRを一括作成する（#1173）。
 *
 * **マージは自動化しない。** Actionsの変更は自動マージ不可カテゴリに該当する。
 * ここで作るのはPRまでで、内容を見てマージするのは人間の操作。
 */
export function POST() {
  return withGithubApiFeature("workflow_tags", () => handlePOST());
}

async function handlePOST() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const result = await dispatchPropagation(userId);
  return NextResponse.json(result);
}
