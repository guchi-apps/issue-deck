import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { githubApiErrorMessage } from "@/lib/github/network-error";
import {
  fetchPullRequestFiles,
  PULL_REQUEST_FILES_PER_PAGE,
} from "@/lib/github/pull-requests-api";
import { toPullRequestFiles } from "@/lib/pull-request-files";
import type { PullRequestFileListResponse } from "@/types/pull-request";

export function GET(request: NextRequest) {
  return withGithubApiFeature("pull_request_files", () => handleGET(request));
}

/**
 * PR1件の変更ファイル一覧を返す（#1987）。
 *
 * PR詳細（`/api/pull-requests/detail`）に相乗りさせず別のエンドポイントにしているのは、
 * **画面で「変更ファイル」を開いたときだけ呼ぶ**ため。既定は畳んだ状態なので、相乗りさせると
 * 見られないもののために全PRで1リクエストを消費することになる。
 *
 * 消費するのはGitHub REST 1回（`GET /pulls/{number}/files`）。ページングはせず
 * `PULL_REQUEST_FILES_PER_PAGE`件で打ち切り、打ち切ったことは`truncated`で画面へ伝える。
 */
async function handleGET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const owner = searchParams.get("owner");
  const repo = searchParams.get("repo");
  const numberParam = searchParams.get("number");

  if (!owner || !repo || !numberParam || Number.isNaN(Number(numberParam))) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const number = Number(numberParam);

  const repository = await db.repository.findFirst({
    where: {
      fullName: `${owner}/${repo}`,
      installation: { userInstallations: { some: { userId } } },
    },
    include: { installation: true },
  });
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const files = await fetchPullRequestFiles(owner, repo, number, token);
    const response: PullRequestFileListResponse = {
      files: toPullRequestFiles(files),
      truncated: files.length >= PULL_REQUEST_FILES_PER_PAGE,
    };
    return NextResponse.json(response);
  } catch (error) {
    console.error(`[GET /api/pull-requests/files] ${owner}/${repo}#${number}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: githubApiErrorMessage(error) },
      { status: 502 },
    );
  }
}
