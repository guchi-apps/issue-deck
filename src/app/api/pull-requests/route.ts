import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { repairKindsFor } from "@/lib/github/pull-request-repair";
import { toPullRequestSummary } from "@/lib/github/pull-request-summary";
import {
  fetchClosedPullRequests,
  fetchOpenPullRequests,
  type GithubApiOpenPullRequest,
} from "@/lib/github/pull-requests-api";
import { fetchPullRequestCiState } from "@/lib/github/release-api";
import { fetchRepairWorkflowAvailability } from "@/lib/github/repair-workflow-cache";
import { checkUserIssueKey, fetchCheckUserIssueReasons } from "@/lib/pull-request-check-user";
import type {
  PullRequestListResponse,
  PullRequestListScope,
  PullRequestSummary,
} from "@/types/pull-request";

export function GET(request: Request) {
  return withGithubApiFeature("pull_request_list", () => handleGET(request));
}

async function handleGET(request: Request) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 既定はマージ待ち（open）のみ。`scope=all`のときだけクローズ済みも足す（#1312）。
  const scope: PullRequestListScope =
    new URL(request.url).searchParams.get("scope") === "all" ? "all" : "open";

  // 一覧の母集団はIssue一覧と揃えて「連携済みリポジトリ」全体とし、そこからユーザーが
  // 左メニューで非表示にしたもの（HiddenRepository）とアーカイブ済みを除く。
  // 1リポジトリにつき1回（`scope=all`なら2回）GitHub APIを呼ぶため、母集団の広さがそのまま
  // 取得コストになる。自動更新を常時は回さず、「完了したPR」ビューの表示中（10秒。#1531）と
  // ブランチ画面でユーザーが間隔を選んだ間（既定は自動更新しない。#1767）に限っているのはこのため。
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
    const empty: PullRequestListResponse = {
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
    repositories.map(async (repository): Promise<RepositoryPullRequests> => {
      try {
        const token = await tokenFor(repository.installation.installationId);
        const context = {
          ownerLogin: repository.ownerLogin,
          name: repository.name,
          fullName: repository.fullName,
          private: repository.private,
          token,
        };

        // クローズ済みはCI状態を取りに行かないぶん、増えるAPI呼び出しはリポジトリあたり1回だけ。
        // openと並行に投げて、`scope=all`のときだけ待ち時間が伸びることのないようにする。
        const [openPullRequests, closedPullRequests] = await Promise.all([
          fetchOpenPullRequests(repository.ownerLogin, repository.name, token),
          scope === "all"
            ? fetchClosedPullRequests(repository.ownerLogin, repository.name, token)
            : Promise.resolve<GithubApiOpenPullRequest[]>([]),
        ]);

        return {
          repositoryId: repository.id,
          pullRequests: [
            ...(await Promise.all(
              openPullRequests.map((pullRequest) => toOpenPullRequest(pullRequest, context)),
            )),
            ...closedPullRequests.map((pullRequest) => toClosedPullRequest(pullRequest, context)),
          ],
        };
      } catch (error) {
        // 1リポジトリの取得失敗で一覧全体を落とさない。取れなかったことは画面へ返す。
        console.error(`[GET /api/pull-requests] ${repository.fullName}:`, error);
        failedRepositories.push(repository.fullName);
        return { repositoryId: repository.id, pullRequests: [] };
      }
    }),
  );

  // 対応Issueの`00.check-user`と、その理由（#1490）を合流させる（#1469）。GitHub APIは
  // 消費せず、DBキャッシュを全リポジトリぶんまとめて1クエリ引くだけ。
  const checkUserReasons = await fetchCheckUserIssueReasons(
    results.map((result) => ({
      repositoryId: result.repositoryId,
      issueNumbers: result.pullRequests
        .map((pullRequest) => pullRequest.linkedIssueNumber)
        .filter((number): number is number => number !== null),
    })),
  );
  for (const result of results) {
    for (const pullRequest of result.pullRequests) {
      const key =
        pullRequest.linkedIssueNumber === null
          ? null
          : checkUserIssueKey(result.repositoryId, pullRequest.linkedIssueNumber);
      pullRequest.linkedIssueCheckUser = key !== null && checkUserReasons.has(key);
      pullRequest.linkedIssueCheckReason = key === null ? null : (checkUserReasons.get(key) ?? null);
    }
  }

  const response: PullRequestListResponse = {
    pullRequests: results.flatMap((result) => result.pullRequests),
    fetchedAt: new Date().toISOString(),
    failedRepositories: failedRepositories.sort((a, b) => a.localeCompare(b)),
  };
  return NextResponse.json(response);
}

/**
 * リポジトリ1件ぶんの取得結果。`00.check-user`の合流に`repositoryId`が要るため、
 * summaryの配列だけでなくどのリポジトリのものかも持たせる（#1469）。
 */
type RepositoryPullRequests = {
  repositoryId: string;
  pullRequests: PullRequestSummary[];
};

type RepositoryContext = {
  ownerLogin: string;
  name: string;
  fullName: string;
  private: boolean;
  token: string;
};

async function toOpenPullRequest(
  pullRequest: GithubApiOpenPullRequest,
  repository: RepositoryContext,
): Promise<PullRequestSummary> {
  // CI状態とコンフリクト有無（#1742）はPR1件につきGraphQL 1回で**まとめて**取る。
  // draftはまだレビュー・マージの対象ではないため、その分の呼び出しを省いて未取得にする。
  const { ciState, mergeable } = pullRequest.draft
    ? { ciState: "unknown" as const, mergeable: null }
    : await fetchPullRequestCiState(
        repository.ownerLogin,
        repository.name,
        pullRequest.number,
        repository.token,
      );

  // 自動修復ワークフローが配られているかは、**修復ボタンを出すPRでだけ**確かめる（#1960）。
  // 押せるのに404で起動しないボタンを出さないためで、判定結果はプロセス内に10分キャッシュ
  // されるため、CI失敗・コンフリクトのPRが並んでいてもGitHub APIの消費はごく小さい。
  const repairWorkflowAvailability = await fetchRepairWorkflowAvailability(
    repository.ownerLogin,
    repository.name,
    {
      number: pullRequest.number,
      baseRef: pullRequest.base.ref,
      headRef: pullRequest.head.ref,
    },
    repairKindsFor({ state: "open", draft: pullRequest.draft, ciState }, mergeable),
    repository.token,
  );

  // openのPRにマージ済みは存在しない。
  return toPullRequestSummary(pullRequest, repository, {
    merged: false,
    ciState,
    mergeable,
    repairWorkflowAvailability,
  });
}

/**
 * クローズ済み（マージ済み・却下）のPRを一覧の形へ変換する（#1312）。
 *
 * **CI状態とコンフリクト有無は取得せず`unknown` / `null`のまま返す。** 取得にはPR1件あたり
 * 1回APIを消費するのに対し、既に閉じたPRのCIは「見て何かする」対象ではないため。マージ済みかどうかは
 * 一覧APIが返す`merged_at`から決める（単体取得の`merged`は一覧のレスポンスに含まれない）。
 */
function toClosedPullRequest(
  pullRequest: GithubApiOpenPullRequest,
  repository: RepositoryContext,
): PullRequestSummary {
  return toPullRequestSummary(pullRequest, repository, {
    merged: pullRequest.merged_at !== null,
    ciState: "unknown",
  });
}
