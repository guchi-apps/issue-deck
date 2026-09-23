import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { githubApiErrorMessage } from "@/lib/github/network-error";
import { fetchPullRequestFiles } from "@/lib/github/pull-requests-api";
import { findPullRequestFilePatch } from "@/lib/pull-request-files";
import type { PullRequestFileDiffResponse } from "@/types/pull-request";

export function GET(request: NextRequest) {
  return withGithubApiFeature("pull_request_file_diff", () => handleGET(request));
}

/**
 * 変更ファイル一覧の1行にある「差分を表示」を押したときに、そのファイルの差分を返す（#3383）。
 *
 * GitHubには1ファイル単体のdiffを取る専用APIが無いため、変更ファイル一覧と同じ
 * `GET /pulls/{number}/files`（`fetchPullRequestFiles`）を呼び直し、該当パスの`patch`だけを
 * 抜き出して返す。**URLが変更ファイル一覧の取得と同じなので、既にそのPRの一覧を開いていれば
 * ETagが効いて304になり、GitHub APIの消費は増えない。**
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
  const path = searchParams.get("path");

  if (!owner || !repo || !numberParam || Number.isNaN(Number(numberParam)) || !path) {
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
    const response: PullRequestFileDiffResponse = {
      patch: findPullRequestFilePatch(files, path) ?? null,
    };
    return NextResponse.json(response);
  } catch (error) {
    console.error(`[GET /api/pull-requests/file-diff] ${owner}/${repo}#${number} ${path}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: githubApiErrorMessage(error) },
      { status: 502 },
    );
  }
}
