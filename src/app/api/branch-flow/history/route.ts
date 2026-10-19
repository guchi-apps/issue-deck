import { NextResponse, type NextRequest } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import {
  fetchBranchFlowHistoryPage,
  type BranchFlowHistoryCursor,
  type BranchFlowHistoryResponse,
} from "@/lib/branch-flow-history";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { githubApiErrorMessage } from "@/lib/github/network-error";
import {
  CLOSED_PAGED_PER_PAGE,
  fetchClosedPullRequestsForBasePage,
} from "@/lib/github/pull-requests-api";
import { toClosedPullRequest } from "@/lib/pull-request-list-fetch";

export function GET(request: NextRequest) {
  return withGithubApiFeature("branch_flow_history", () => handleGET(request));
}

/**
 * ブランチ画面の「過去のリリース」で、さらに古い版を取り足す（#4844）。
 *
 * **画面を開いたときには呼ばれない。** 表示済みの版を出し切ったあとの「さらに表示」を
 * 押したときだけ、1リポジトリぶんのクローズ済みPRを1押下ぶん取る
 * （develop宛1ページ＋main宛0〜3ページ。`lib/branch-flow-history.ts`）。
 * サーバーは状態を持たず、次のページ番号は画面が持って送り返す。各ページはETagの
 * 条件付きGETを通るので、開き直して同じページを取り直す分はレート制限を消費しない。
 *
 * クエリ: `repo`（`owner/name`）・`developPage`・`mainPage`（取り切った向きは省く）・
 * `mainOldest`（これまでに取ったmain宛PRの最古の作成時刻。無ければ省く）。
 */
async function handleGET(request: NextRequest) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const fullName = searchParams.get("repo");
  const developPage = parsePage(searchParams.get("developPage"));
  const mainPage = parsePage(searchParams.get("mainPage"));
  const mainOldest = searchParams.get("mainOldest");
  if (
    !fullName ||
    !fullName.includes("/") ||
    developPage === undefined ||
    mainPage === undefined ||
    (mainOldest !== null && Number.isNaN(new Date(mainOldest).getTime()))
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const repository = await db.repository.findFirst({
    where: {
      fullName,
      installation: { userInstallations: { some: { userId } } },
    },
    include: { installation: true },
  });
  if (!repository) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const cursor: BranchFlowHistoryCursor = { developPage, mainPage };
  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const result = await fetchBranchFlowHistoryPage({
      cursor,
      mainOldestCreatedAt: mainOldest,
      perPage: CLOSED_PAGED_PER_PAGE,
      fetchPage: (base, page) =>
        fetchClosedPullRequestsForBasePage(repository.ownerLogin, repository.name, base, token, page),
    });
    const response: BranchFlowHistoryResponse = {
      pullRequests: result.pullRequests.map((pullRequest) =>
        toClosedPullRequest(pullRequest, { fullName: repository.fullName, private: repository.private }),
      ),
      cursor: result.cursor,
      mainOldestCreatedAt: result.mainOldestCreatedAt,
    };
    return NextResponse.json(response);
  } catch (error) {
    console.error(`[GET /api/branch-flow/history] ${fullName}:`, error);
    return NextResponse.json(
      { error: "github_api_error", message: githubApiErrorMessage(error) },
      { status: 502 },
    );
  }
}

/** 省略（＝その向きは取り切った）はnull、1以上の整数でなければundefined（不正） */
function parsePage(value: string | null): number | null | undefined {
  if (value === null) return null;
  const page = Number(value);
  return Number.isInteger(page) && page >= 1 ? page : undefined;
}
