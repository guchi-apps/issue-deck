import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { dispatchSharedFilePropagation } from "@/lib/github/workflow-tags";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * 配布物（ワークフロー以外）が古いリポジトリへ、最新版へ更新するPRを一括作成する（#2240）。
 *
 * **実行中なら409で断る**（タグ配布の`propagate/route.ts`と同じ理由）。起動は数秒で返るのに
 * PRが出来上がるまでは数分かかるため、画面のボタンを無効にするだけでは足りない
 * （リロード後・別のタブからは押せてしまう）。
 *
 * 自動マージの選択肢は無い。**配布先の独自の変更を上書きしうる**ため、常にPRの作成までで止める。
 */
export function POST() {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("workflow_tags", () => handlePOST());
}

async function handlePOST() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const result = await dispatchSharedFilePropagation(userId);
  if (result.reason === "running") {
    return NextResponse.json(result, { status: 409 });
  }
  return NextResponse.json(result);
}
