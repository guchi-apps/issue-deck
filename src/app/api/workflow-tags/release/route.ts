import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { createNextWorkflowTag, dispatchPropagation } from "@/lib/github/workflow-tags";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * 次の版数のタグを `main` に切り、そのまま配布まで流す（#1876）。
 *
 * **配布（`/propagate`）は既に自動化されていて、残っていたのはタグを切る1操作だけだった。**
 * そのためだけに `71.manual-step` のIssueが v20・v21・v22 と毎回起票されていたので、
 * 画面の配布導線に統合する。
 *
 * **タグを切ってから配布を起動するまでを1回の操作にする。** 分けると「タグは切ったが配って
 * いない」状態が生まれ、どのリポジトリが古い版を参照しているかが分かりにくくなる。
 *
 * **既にタグがある場合も配布へ進む**（`already_exists`）。二重クリックや別タブからの操作で
 * 切り直せなかっただけで、狙った版数が存在していれば配る目的は果たせる。
 */
export function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("workflow_tags", () => handlePOST(request));
}

async function handlePOST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body: { autoMerge?: boolean } = await request.json().catch(() => ({}));
  const autoMerge = body.autoMerge !== false;

  const tag = await createNextWorkflowTag(userId);
  // タグが無い状態では配れない。**`already_exists`だけは進む**（上のコメント参照）
  if (!tag.created && tag.reason !== "already_exists") {
    return NextResponse.json({ tag, propagation: null }, { status: 409 });
  }

  // **配布はタグを切った直後に起動する。** `collectWorkflowTags`を取り直すため、
  // いま切ったタグが`latest`として拾われる
  const propagation = await dispatchPropagation(userId, autoMerge);
  if (propagation.reason === "running") {
    return NextResponse.json({ tag, propagation }, { status: 409 });
  }
  return NextResponse.json({ tag, propagation });
}
