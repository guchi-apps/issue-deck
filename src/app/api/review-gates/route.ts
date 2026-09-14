import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { collectReviewGates } from "@/lib/github/review-gates";

/**
 * 各リポジトリのClaudeレビューの実行条件と、直近のIssue PRでの実行状況を返す（#2948）。
 *
 * **設定＞フリート運用のカードを開いたときに1回だけ取得する。** 共有ワークフローのタグ照会
 * （`/api/workflow-tags`）もcallerの本文を読んでいるが、こちらはPRのチェックまで読むぶん
 * 重いため相乗りさせない（配布カードを開くたびに走らせない）。
 */
export function GET() {
  return withGithubApiFeature("review_gates", () => handleGET());
}

async function handleGET() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const overview = await collectReviewGates(userId);
  return NextResponse.json(overview, { headers: { "Cache-Control": "no-store" } });
}
