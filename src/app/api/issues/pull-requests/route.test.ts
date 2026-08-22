import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserId = vi.fn();
const findFirst = vi.fn();
const getInstallationToken = vi.fn();
const fetchPullRequest = vi.fn();
const fetchPullRequestCiStates = vi.fn();
const fetchActivePullRequestRepairRuns = vi.fn();

vi.mock("@/lib/auth-user", () => ({
  get requireUserId() {
    return requireUserId;
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    repository: {
      get findFirst() {
        return findFirst;
      },
    },
  },
}));

vi.mock("@/lib/github/app-auth", () => ({
  get getInstallationToken() {
    return getInstallationToken;
  },
}));

vi.mock("@/lib/github/pull-requests-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/github/pull-requests-api")>();
  return {
    ...actual,
    get fetchPullRequest() {
      return fetchPullRequest;
    },
  };
});

vi.mock("@/lib/github/release-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/github/release-api")>();
  return {
    ...actual,
    get fetchPullRequestCiStates() {
      return fetchPullRequestCiStates;
    },
  };
});

vi.mock("@/lib/github/pull-request-repair-run", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/github/pull-request-repair-run")>();
  return {
    ...actual,
    get fetchActivePullRequestRepairRuns() {
      return fetchActivePullRequestRepairRuns;
    },
  };
});

import type { NextRequest } from "next/server";

import { GET } from "@/app/api/issues/pull-requests/route";
import type { IssuePullRequestListResponse } from "@/types/pull-request";

/** routeは`request.url`しか使わないため、そこだけを持つ最小のリクエストを渡す */
function request(): NextRequest {
  return {
    url: "http://localhost/api/issues/pull-requests?owner=guchi-apps&repo=myroom&numbers=222",
  } as unknown as NextRequest;
}

const RUN = { kind: "conflict" as const, startedAt: "2026-08-22T10:00:00.000Z", runUrl: null };

/** コンフリクト有無だけを差し替える。他は解消後のPR（CI通過・判定済み）の値に固定する */
function ciStates(mergeable: boolean | null) {
  return new Map([
    [
      "guchi-apps/myroom#222",
      {
        ciState: "success",
        mergeable,
        mergeJudgement: { state: "success", conclusion: "success" },
      },
    ],
  ]);
}

describe("GET /api/issues/pull-requests", () => {
  beforeEach(() => {
    requireUserId.mockReset().mockResolvedValue("user-1");
    findFirst.mockReset().mockResolvedValue({
      fullName: "guchi-apps/myroom",
      installation: { installationId: 1 },
    });
    getInstallationToken.mockReset().mockResolvedValue("token");
    fetchPullRequest.mockReset().mockResolvedValue({
      number: 222,
      html_url: "https://github.com/guchi-apps/myroom/pull/222",
      title: "エアコンをダッシュボードから操作できるようにする",
      state: "open",
      draft: false,
      merged: false,
      head: { ref: "issue-213" },
      body: "",
    });
    fetchPullRequestCiStates.mockReset().mockResolvedValue(ciStates(false));
    // 終了の報告が届かず「実行中」のまま残っている行（#2165）。
    fetchActivePullRequestRepairRuns
      .mockReset()
      .mockResolvedValue(new Map([["guchi-apps/myroom#222", RUN]]));
  });

  it("コンフリクトしたままのPRでは自動解消中として返す", async () => {
    const response = await GET(request());
    const body = (await response.json()) as IssuePullRequestListResponse;

    expect(body.pullRequests[0].repairRun).toEqual(RUN);
  });

  // 解消済みなのに「コンフリクトを自動解消中（24分経過）」が出続けていた（#2165）。
  it("コンフリクトが解消されたPRでは、実行中の行が残っていても返さない", async () => {
    fetchPullRequestCiStates.mockResolvedValue(ciStates(true));

    const response = await GET(request());
    const body = (await response.json()) as IssuePullRequestListResponse;

    expect(body.pullRequests[0].mergeable).toBe(true);
    expect(body.pullRequests[0].repairRun).toBeNull();
  });

  // GitHubの判定が出るまで消してしまうと、走っている最中にピルが消える。
  it("コンフリクト有無が未判定なら消さない", async () => {
    fetchPullRequestCiStates.mockResolvedValue(ciStates(null));

    const response = await GET(request());
    const body = (await response.json()) as IssuePullRequestListResponse;

    expect(body.pullRequests[0].repairRun).toEqual(RUN);
  });
});
