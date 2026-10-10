import { after, NextResponse, type NextRequest } from "next/server";

import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { createIssueForUser, fillIssueTitleByAi } from "@/lib/github/issue-create-service";
import {
  completeIssueCreate,
  parseIdempotencyKey,
  releaseIssueCreate,
  reserveIssueCreate,
} from "@/lib/issues/create-idempotency";
import { previewModeGuard } from "@/lib/preview-mode";
import { authenticateShareToken } from "@/lib/share-token/auth";
import { provisionalTitle } from "@/lib/share-token/token";

const MAX_BODY_LENGTH = 60_000;

/**
 * 共有画面からのIssue作成（#4298）。**共有トークンで呼ぶ。**
 *
 * 作成は`POST /api/issues`と同じ経路（`createIssueForUser`）。冪等キーは必須で、連打・結果不明からの
 * 再送で二重に作らない（同じキーの再送は作成済みの結果を返し、作成中なら409）。タイトルが空なら
 * 仮タイトルで作り、応答後にAIでタイトルを書き換える（AI未設定・失敗なら仮タイトルのまま）。
 * 対象リポジトリは利用者の連携リポジトリに限り、「Issue作成の対象外」は拒否する。
 */
export function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("issue_write", () => handlePOST(request));
}

async function handlePOST(request: NextRequest) {
  const user = await authenticateShareToken(request.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const payload = await request.json().catch(() => null);
  const repositoryFullName = payload?.repositoryFullName;
  const idempotencyKey = parseIdempotencyKey(payload?.idempotencyKey);
  const rawTitle = payload?.title;
  const rawBody = payload?.body;
  if (
    typeof repositoryFullName !== "string" ||
    !repositoryFullName.includes("/") ||
    !idempotencyKey ||
    (rawTitle !== undefined && typeof rawTitle !== "string") ||
    (rawBody !== undefined && typeof rawBody !== "string") ||
    (rawBody ?? "").length > MAX_BODY_LENGTH
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const body = rawBody ?? "";
  const title = (rawTitle ?? "").trim();
  if (!title && !body.trim()) {
    return NextResponse.json({ error: "empty_content" }, { status: 400 });
  }

  const repository = await db.repository.findFirst({
    where: {
      fullName: repositoryFullName,
      archived: false,
      installation: { userInstallations: { some: { userId: user.id } } },
    },
    include: { installation: true },
  });
  if (!repository) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const excluded = await db.issueCreationExcludedRepository.findUnique({
    where: { userId_repositoryId: { userId: user.id, repositoryId: repository.id } },
  });
  if (excluded) return NextResponse.json({ error: "repository_excluded" }, { status: 403 });

  const reservation = await reserveIssueCreate(user.id, idempotencyKey);
  if (reservation.kind === "done") return NextResponse.json({ issue: reservation.result });
  if (reservation.kind === "in_progress") {
    return NextResponse.json({ error: "create_in_progress" }, { status: 409 });
  }

  let result: Awaited<ReturnType<typeof createIssueForUser>>;
  try {
    result = await createIssueForUser(user, repository, {
      repositoryFullName,
      title: title || provisionalTitle(body),
      body,
    });
  } catch (error) {
    // 例外は結果不明（GitHubへ届いたか分からない）。予約は残し、再送は「確認中」になる
    console.error("[POST /api/share/issues] 作成の結果が不明です", error);
    return NextResponse.json({ error: "unknown_result" }, { status: 502 });
  }
  if ("errorResponse" in result) {
    await releaseIssueCreate(user.id, idempotencyKey).catch(() => undefined);
    return result.errorResponse;
  }
  await completeIssueCreate(user.id, idempotencyKey, result.value).catch(() => undefined);

  if (!title) {
    after(() => fillIssueTitleByAi(user, repository, result.value, body));
  }
  return NextResponse.json({ issue: result.value });
}
