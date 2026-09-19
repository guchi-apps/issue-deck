import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { updatePullRequest } from "@/lib/github/actions-api";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { GithubApiError } from "@/lib/github/issues-api";
import { previewModeGuard } from "@/lib/preview-mode";

async function findRepository(userId: string, owner: string, repo: string) {
  return db.repository.findFirst({
    where: {
      fullName: `${owner}/${repo}`,
      installation: { userInstallations: { some: { userId } } },
    },
    include: { installation: true },
  });
}

export function POST(request: NextRequest) {
  const guard = previewModeGuard();
  if (guard) return guard;
  return withGithubApiFeature("pull_request_update", () => handlePOST(request));
}

/**
 * PR詳細の「編集」（#3161）。タイトルと本文をまとめて書き換える。
 *
 * **両方を必ず受け取る。** 片方だけを送れる形にすると、本文を空にしたいのか送り忘れたのかを
 * 区別できない。タイトルは空を受け付けない（GitHubも422で弾く）。
 */
async function handlePOST(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload: { owner?: unknown; repo?: unknown; number?: unknown; title?: unknown; body?: unknown } =
    await request.json().catch(() => ({}));
  const { owner, repo, number, title, body } = payload;

  if (
    typeof owner !== "string" ||
    !owner ||
    typeof repo !== "string" ||
    !repo ||
    typeof number !== "number" ||
    !Number.isInteger(number) ||
    number <= 0 ||
    typeof title !== "string" ||
    !title.trim() ||
    typeof body !== "string"
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await findRepository(userId, owner, repo);
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    await updatePullRequest(owner, repo, number, { title: title.trim(), body }, token);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof GithubApiError && error.status === 404) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    console.error(`[POST /api/pull-requests/update] ${owner}/${repo}#${number}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
