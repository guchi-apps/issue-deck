import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { toPullRequestSummary } from "@/lib/github/pull-request-summary";
import {
  fetchOpenPullRequests,
  type GithubApiOpenPullRequest,
} from "@/lib/github/pull-requests-api";
import { fetchRefCiState } from "@/lib/github/release-api";
import type { OpenPullRequestsResponse, PullRequestSummary } from "@/types/pull-request";

export function GET() {
  return withGithubApiFeature("pull_request_list", handleGET);
}

async function handleGET() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 一覧の母集団はIssue一覧と揃えて「連携済みリポジトリ」全体とし、そこからユーザーが
  // 左メニューで非表示にしたもの（HiddenRepository）とアーカイブ済みを除く。
  // 1リポジトリにつき1回GitHub APIを呼ぶため、母集団の広さがそのまま取得コストになる。
  // 自動ポーリングを持たせていない（画面を開いたときと手動更新のみ）のはこのため。
  const hiddenRepositoryIds = (
    await db.hiddenRepository.findMany({ where: { userId }, select: { repositoryId: true } })
  ).map((row) => row.repositoryId);

  const repositories = await db.repository.findMany({
    where: {
      archived: false,
      id: { notIn: hiddenRepositoryIds },
      installation: { userInstallations: { some: { userId } } },
    },
    orderBy: { fullName: "asc" },
    include: { installation: true },
  });

  if (repositories.length === 0) {
    const empty: OpenPullRequestsResponse = {
      pullRequests: [],
      fetchedAt: new Date().toISOString(),
      failedRepositories: [],
    };
    return NextResponse.json(empty);
  }

  // 同一installationのリポジトリ間でトークン取得を使い回す（release-pending-mergesと同じ方針）。
  const tokenPromises = new Map<number, Promise<string>>();
  function tokenFor(installationId: number): Promise<string> {
    let token = tokenPromises.get(installationId);
    if (!token) {
      token = getInstallationToken(installationId);
      tokenPromises.set(installationId, token);
    }
    return token;
  }

  const failedRepositories: string[] = [];

  const results = await Promise.all(
    repositories.map(async (repository): Promise<PullRequestSummary[]> => {
      try {
        const token = await tokenFor(repository.installation.installationId);
        const pullRequests = await fetchOpenPullRequests(
          repository.ownerLogin,
          repository.name,
          token,
        );

        return await Promise.all(
          pullRequests.map((pullRequest) =>
            toOpenPullRequest(pullRequest, {
              ownerLogin: repository.ownerLogin,
              name: repository.name,
              fullName: repository.fullName,
              private: repository.private,
              token,
            }),
          ),
        );
      } catch (error) {
        // 1リポジトリの取得失敗で一覧全体を落とさない。取れなかったことは画面へ返す。
        console.error(`[GET /api/pull-requests] ${repository.fullName}:`, error);
        failedRepositories.push(repository.fullName);
        return [];
      }
    }),
  );

  const response: OpenPullRequestsResponse = {
    pullRequests: results.flat(),
    fetchedAt: new Date().toISOString(),
    failedRepositories: failedRepositories.sort((a, b) => a.localeCompare(b)),
  };
  return NextResponse.json(response);
}

async function toOpenPullRequest(
  pullRequest: GithubApiOpenPullRequest,
  repository: {
    ownerLogin: string;
    name: string;
    fullName: string;
    private: boolean;
    token: string;
  },
): Promise<PullRequestSummary> {
  // CI状態はPR1件につき1回（check-runsが100件を超えるrefではページ数ぶん）APIを消費する。
  // draftはまだレビュー・マージの対象ではないため、その分の呼び出しを省いてunknownにする。
  const ciState = pullRequest.draft
    ? "unknown"
    : await fetchRefCiState(
        repository.ownerLogin,
        repository.name,
        pullRequest.head.sha,
        repository.token,
      );

  // この一覧はopenのPRしか取得しないため、マージ済みは存在しない。
  return toPullRequestSummary(pullRequest, repository, { merged: false, ciState });
}
