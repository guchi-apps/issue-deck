import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { dispatchRepairPropagation } from "@/lib/github/workflow-tags";

/**
 * 置かれていないcallerが有るリポジトリへ、それを追加するPRを一括作成する（#1948・#1475）。
 *
 * **実行中なら409で断る**（タグ配布の`propagate/route.ts`と同じ理由）。起動は数秒で返るのに
 * PRが出来上がるまでは数分かかるため、画面のボタンを無効にするだけでは足りない
 * （リロード後・別のタブからは押せてしまう）。
 *
 * 自動マージの選択肢は無い。**新しいワークフローファイルの追加は、`@workflows/vN`の
 * 機械的な置換（#1602の自動マージ例外）とは別物**のため、常にPRの作成までで止める。
 */
export function POST() {
  return withGithubApiFeature("workflow_tags", () => handlePOST());
}

async function handlePOST() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const result = await dispatchRepairPropagation(userId);
  if (result.reason === "running") {
    return NextResponse.json(result, { status: 409 });
  }
  return NextResponse.json(result);
}
