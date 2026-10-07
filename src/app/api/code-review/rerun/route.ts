import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { parseDispatchTarget } from "@/lib/dispatch/dispatch-job";
import { resolveInstallationToken } from "@/lib/dispatch/installation-token";
import { enqueueCodeReviewRerun } from "@/lib/dispatch/jobs";
import { codeReviewRerunCommentBody, isCodeReviewIssue } from "@/lib/github/code-review";
import { createComment } from "@/lib/github/issues-api";
import { parseRepositoryFullName } from "@/lib/local-session";
import { previewModeGuard } from "@/lib/preview-mode";

/**
 * 結果を返さずに終わったコードレビューを、同じレビューIssueのまま再実行する（#4116）。
 *
 * 1. **先にジョブを積む**（`enqueueCodeReviewRerun`）。未完了の実行が残っていれば`activeKey`で
 *    断るので、押し直し・2画面からの同時押しでも実行は1本になる
 * 2. 積めたら依頼コメント（`codeReviewRerunCommentBody`）を投稿する。これが新しい「依頼」になり、
 *    それより前の結果は今回の結果として数えない（`isCodeReviewPending`）
 *
 * コメントの投稿に失敗しても実行は取り消さない（状態はジョブが正。画面はジョブの状態で
 * 「順番待ち」「実行中」を出す）。旧い結果・ログ・起票済みのIssueはそのまま残る。
 */
export async function POST(request: NextRequest) {
  const guarded = previewModeGuard();
  if (guarded) return guarded;

  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const target = parseDispatchTarget(payload?.repository, payload?.issue);
  const repoParts = target ? parseRepositoryFullName(target.repositoryFullName) : null;
  if (!target || !repoParts) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // レビューIssue以外を、この口から「コードレビュー」として走らせない
  const issue = await db.issue.findFirst({
    where: {
      number: target.issueNumber,
      repository: { fullName: target.repositoryFullName },
    },
    select: { title: true },
  });
  if (!issue || !isCodeReviewIssue(issue)) {
    return NextResponse.json(
      { error: "not_code_review", message: "コードレビューのIssueではありません。" },
      { status: 400 },
    );
  }

  const result = await enqueueCodeReviewRerun({
    repositoryFullName: target.repositoryFullName,
    issueNumber: target.issueNumber,
    requestedByUserId: userId,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.rejection, message: result.message },
      {
        status: result.rejection === "already_queued" ? 409 : 400,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }

  let commentPosted = false;
  try {
    const token = await resolveInstallationToken(target.repositoryFullName);
    if (token) {
      await createComment(repoParts.owner, repoParts.repo, target.issueNumber, token, {
        body: codeReviewRerunCommentBody(),
      });
      commentPosted = true;
    }
  } catch (error) {
    console.error("[POST /api/code-review/rerun] 再実行の依頼コメントを投稿できませんでした", error);
  }

  return NextResponse.json(
    { ok: true, job: result.job, commentPosted },
    { headers: { "Cache-Control": "no-store" } },
  );
}
