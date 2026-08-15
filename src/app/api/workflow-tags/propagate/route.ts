import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { dispatchPropagation } from "@/lib/github/workflow-tags";

/**
 * 更新が必要なリポジトリへ、共有ワークフローのタグを上げるPRを一括作成する（#1173）。
 *
 * **実行中なら409で断る**（#1602）。起動は数秒で返るのにPRが出来上がるまでは数分かかるため、
 * 画面のボタンを無効にするだけでは足りない（リロード後・別のタブからは押せてしまう）。
 *
 * `autoMerge`（既定true）が真のとき、配布先ではIssueを作らずPRだけを作り、CI通過後に
 * 自動マージする。偽なら従来どおりPRの作成までで止まる。
 */
export function POST(request: NextRequest) {
  return withGithubApiFeature("workflow_tags", () => handlePOST(request));
}

async function handlePOST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body: { autoMerge?: boolean } = await request.json().catch(() => ({}));
  const autoMerge = body.autoMerge !== false;

  const result = await dispatchPropagation(userId, autoMerge);
  if (result.reason === "running") {
    return NextResponse.json(result, { status: 409 });
  }
  return NextResponse.json(result);
}
