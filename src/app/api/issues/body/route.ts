import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";

/**
 * Issue1件の本文を返す（#3390）。
 *
 * 一覧（`GET /api/issues`・初期表示）はclosedのIssueの本文を外している（`bodyOmitted`）ので、
 * 詳細を開いたときにここで1件ぶんを取る。PRのファイル一覧が`patch`を外し、「差分を表示」で
 * 取りに行くのと同じ考え方（`src/lib/pull-request-files.ts`）。
 *
 * 読むのはDBのキャッシュだけで、GitHub APIは消費しない。`updatedAt`を一緒に返すのは、
 * 画面側が「どの版の本文か」を一覧の`updatedAt`と突き合わせ、編集後に古い本文を
 * 出し続けないようにするため（`use-issue-bodies.ts`）。
 */
export async function GET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const issueId = new URL(request.url).searchParams.get("id") ?? "";
  let githubIssueId: bigint;
  try {
    githubIssueId = BigInt(issueId);
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (!issueId || githubIssueId <= BigInt(0)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const issue = await db.issue.findFirst({
    where: {
      githubIssueId,
      repository: { installation: { userInstallations: { some: { userId } } } },
    },
    select: { body: true, githubUpdatedAt: true },
  });
  if (!issue) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json(
    { body: issue.body ?? "", updatedAt: issue.githubUpdatedAt.toISOString() },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
