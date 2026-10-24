import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/lib/db";
import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { buildSharedTokenReviewMeta } from "@/lib/release-review-shared-token-meta";
import { BLOCKING_POLICY_LINES, checklistPromptText } from "@/lib/release-review-checklist";
import { loadReleaseReviewContext } from "@/lib/release-review-context-load";

/**
 * 全体レビューのランナーへ、再レビューの文脈（前回の対象・確認結果・指摘・修正の対応内容）を返す（#4559）。
 * 認証はpollerの共有シークレット。対象はジョブ（`RELEASE_REVIEW`）の記録から決め、クエリでは受け取らない。
 *
 * `GET /api/dispatch/release-review-context?jobId=<ジョブID>`
 */
export async function GET(request: NextRequest) {
  const auth = authorizeDispatch(request.headers.get("authorization"));
  if (auth === "not_configured") return NextResponse.json({ error: "not_configured" }, { status: 503 });
  if (auth === "unauthorized") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const jobId = request.nextUrl.searchParams.get("jobId");
  if (!jobId) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const job = await db.dispatchJob.findUnique({ where: { id: jobId } });
  if (!job || job.kind !== "RELEASE_REVIEW" || job.prNumber == null || !job.baseSha || !job.headSha) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const context = await loadReleaseReviewContext({
    repoFullName: job.repositoryFullName,
    prNumber: job.prNumber,
    baseSha: job.baseSha,
    headSha: job.headSha,
  });
  // 共有トークンの非機密情報（登録有無・利用先）。読めなければnull＝「未確認」であり「未登録」ではない（#4975）
  const sharedTokens = await Promise.all([
    db.sharedToken.findMany({ select: { id: true, name: true, updatedAt: true } }),
    db.sharedTokenUsage.groupBy({ by: ["sharedTokenId", "consumer"], _max: { usedAt: true } }),
  ])
    .then(([rows, grouped]) =>
      buildSharedTokenReviewMeta(rows, grouped.map((g) => ({ sharedTokenId: g.sharedTokenId, consumer: g.consumer, usedAt: g._max.usedAt }))),
    )
    .catch(() => null);
  // プロンプトへ入れる確認項目と止める／止めないの基準も一緒に返す（正はTypeScript側の定義1か所）
  return NextResponse.json(
    { ...context, sharedTokens, checklistPrompt: checklistPromptText(), blockingPolicy: BLOCKING_POLICY_LINES.map((l) => `- ${l}`).join("\n") },
    { headers: { "Cache-Control": "no-store" } },
  );
}
