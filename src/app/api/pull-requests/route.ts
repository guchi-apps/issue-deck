import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import { pullRequestRollupKey, type PullRequestRollupTarget } from "@/lib/github/check-rollup";
import { repairKindsFor } from "@/lib/github/pull-request-repair";
import {
  fetchActivePullRequestRepairRuns,
  repairRunKey,
  visibleRepairRun,
} from "@/lib/github/pull-request-repair-run";
import { toPullRequestSummary } from "@/lib/github/pull-request-summary";
import {
  fetchClosedPullRequests,
  fetchOpenPullRequests,
  type GithubApiOpenPullRequest,
} from "@/lib/github/pull-requests-api";
import {
  fetchPullRequestCiStates,
  UNKNOWN_PULL_REQUEST_CI_STATE,
  type PullRequestCiState,
} from "@/lib/github/release-api";
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
  // 取得コストになる（このRESTはETagの条件付きGETが効くので、変化が無ければレート制限を
  // 消費しない）。CI状態のGraphQLはPR件数ではなくinstallationごとの回数で済ませている（#1962）。
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

  // まずPR一覧そのもの（REST。ETagの条件付きGETが効く）をリポジトリごとに取る。CI状態は
  // ここでは取りに行かず、全リポジトリぶんのPRが揃ってからまとめて引く（#1962）。
  const fetched = await Promise.all(
    repositories.map(async (repository): Promise<FetchedRepository> => {
      const context: RepositoryContext = {
        ownerLogin: repository.ownerLogin,
        name: repository.name,
        fullName: repository.fullName,
        private: repository.private,
        installationId: repository.installation.installationId,
      };
      try {
        const token = await tokenFor(repository.installation.installationId);

        // クローズ済みはCI状態を取りに行かないぶん、増えるAPI呼び出しはリポジトリあたり1回だけ。
        // openと並行に投げて、`scope=all`のときだけ待ち時間が伸びることのないようにする。
        const [openPullRequests, closedPullRequests] = await Promise.all([
          fetchOpenPullRequests(repository.ownerLogin, repository.name, token),
          scope === "all"
            ? fetchClosedPullRequests(repository.ownerLogin, repository.name, token)
            : Promise.resolve<GithubApiOpenPullRequest[]>([]),
        ]);

        return { repositoryId: repository.id, context, token, openPullRequests, closedPullRequests };
      } catch (error) {
        // 1リポジトリの取得失敗で一覧全体を落とさない。取れなかったことは画面へ返す。
        console.error(`[GET /api/pull-requests] ${repository.fullName}:`, error);
        failedRepositories.push(repository.fullName);
        return {
          repositoryId: repository.id,
          context,
          token: null,
          openPullRequests: [],
          closedPullRequests: [],
        };
      }
    }),
  );

  const ciStates = await fetchCiStates(fetched, tokenFor);

  const results: RepositoryPullRequests[] = fetched.map((repository) => ({
    repositoryId: repository.repositoryId,
    context: repository.context,
    token: repository.token,
    pullRequests: [
      ...repository.openPullRequests.map((pullRequest) =>
        toOpenPullRequest(pullRequest, repository.context, ciStates),
      ),
      ...repository.closedPullRequests.map((pullRequest) =>
        toClosedPullRequest(pullRequest, repository.context),
      ),
    ],
  }));

  // 修復ボタンを出すPRにだけ、起動先ワークフローの配布状況を埋める（#1960）。コンフリクト有無
  // （`mergeable`）が決まってからでないと対象が定まらないため、CI状態のまとめ取りより後に置く。
  await Promise.all(
    results.map((result) =>
      result.token === null
        ? Promise.resolve()
        : attachRepairWorkflowAvailability(result.pullRequests, result.context, result.token),
    ),
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

  // いま走っている自動修復（#2072）を合流させる。GitHub APIは消費せず、全リポジトリぶんを
  // まとめてDBへ1クエリ引くだけ。走っていないPRはキーが無いのでnullのままになる。
  const allPullRequests = results.flatMap((result) => result.pullRequests);
  const repairRuns = await fetchActivePullRequestRepairRuns(
    allPullRequests
      .filter((pullRequest) => pullRequest.state === "open" && !pullRequest.draft)
      .map((pullRequest) => ({
        repositoryFullName: pullRequest.repositoryFullName,
        pullRequestNumber: pullRequest.number,
      })),
  );
  for (const pullRequest of allPullRequests) {
    // 症状（コンフリクト・CI失敗）が消えたPRでは出さない（#2165）。終了の報告が届かなかった
    // 修復がDBに`running`のまま残るため、行の有無だけで出すと解消後もピルが消えない。
    pullRequest.repairRun = visibleRepairRun(
      repairRuns.get(repairRunKey(pullRequest.repositoryFullName, pullRequest.number)) ?? null,
      pullRequest,
    );
  }

  const response: PullRequestListResponse = {
    pullRequests: allPullRequests,
    fetchedAt: new Date().toISOString(),
    failedRepositories: failedRepositories.sort((a, b) => a.localeCompare(b)),
  };
  return NextResponse.json(response);
}

/**
 * リポジトリ1件ぶんの取得結果。`00.check-user`の合流に`repositoryId`が要るため、
 * summaryの配列だけでなくどのリポジトリのものかも持たせる（#1469）。
 * 修復ワークフローの配布状況（#1960）を後から埋めるのに、リポジトリとトークンも要る。
 */
type RepositoryPullRequests = {
  repositoryId: string;
  context: RepositoryContext;
  /** 取得に失敗したリポジトリではnull（後続の問い合わせもしない） */
  token: string | null;
  pullRequests: PullRequestSummary[];
};

type RepositoryContext = {
  ownerLogin: string;
  name: string;
  fullName: string;
  private: boolean;
  /** CI状態のまとめ取りを同じinstallationのPRごとに束ねるために持つ（#1962） */
  installationId: number;
};

/** CI状態を引く前の、リポジトリ1件ぶんのPR一覧（#1962） */
type FetchedRepository = {
  repositoryId: string;
  context: RepositoryContext;
  /** 取得に失敗したリポジトリではnull */
  token: string | null;
  openPullRequests: GithubApiOpenPullRequest[];
  closedPullRequests: GithubApiOpenPullRequest[];
};

/**
 * draft以外のopen PRのCI状態とコンフリクト有無を、**installationごとにまとめて**取る（#1962）。
 *
 * 以前はPR1件につきGraphQLを1回投げていたため、10秒間隔の自動更新（#1947）と合わせると
 * 消費が「360巡/時 × draft以外のopen PR数」になり、PRが14件前後で上限（5,000ポイント/時）に
 * 触れる形になっていた。共有ワークフローの参照タグを配ると14リポジトリ前後へ一斉にPRが出るので、
 * いちばん見たい場面がいちばん危ないという状態だった。
 *
 * トークンはリポジトリではなくinstallation単位なので、**別リポジトリのPRも同じ1クエリに
 * 混ぜられる**（`fetchPullRequestCiStates`がさらに件数で分割する）。
 *
 * 取得に失敗したPRはMapに現れず、呼び出し側で`unknown` / `null`へ縮退する。CI状態が取れない
 * だけで一覧そのものは返す（1件ずつ引いていたときと同じ扱い）。
 */
async function fetchCiStates(
  repositories: FetchedRepository[],
  tokenFor: (installationId: number) => Promise<string>,
): Promise<Map<string, PullRequestCiState>> {
  const targetsByInstallation = new Map<number, PullRequestRollupTarget[]>();
  for (const repository of repositories) {
    for (const pullRequest of repository.openPullRequests) {
      // draftはまだレビュー・マージの対象ではないため取りに行かない（未取得のまま返す）。
      if (pullRequest.draft) continue;
      const { installationId, ownerLogin, name } = repository.context;
      const targets = targetsByInstallation.get(installationId) ?? [];
      targets.push({ owner: ownerLogin, repo: name, number: pullRequest.number });
      targetsByInstallation.set(installationId, targets);
    }
  }

  const ciStates = new Map<string, PullRequestCiState>();
  await Promise.all(
    [...targetsByInstallation].map(async ([installationId, targets]) => {
      try {
        const token = await tokenFor(installationId);
        for (const [key, ciState] of await fetchPullRequestCiStates(targets, token)) {
          ciStates.set(key, ciState);
        }
      } catch (error) {
        // トークンが取れないなど。CI状態が出ないだけで一覧は返す。
        console.error(`[GET /api/pull-requests] installation ${installationId} のCI状態:`, error);
      }
    }),
  );
  return ciStates;
}

function toOpenPullRequest(
  pullRequest: GithubApiOpenPullRequest,
  repository: RepositoryContext,
  ciStates: Map<string, PullRequestCiState>,
): PullRequestSummary {
  // CI状態・コンフリクト有無（#1742）・自動マージ可否の判定の進み具合（#1968）は前段で
  // まとめて取ってある（#1962）。draftと、取得できなかったPRはここに無いため未取得
  // （`unknown` / `null`）のままになる。
  const { ciState, mergeable, mergeJudgement, ciRunId, ciChecks } =
    ciStates.get(pullRequestRollupKey(repository.ownerLogin, repository.name, pullRequest.number)) ??
    UNKNOWN_PULL_REQUEST_CI_STATE;

  // openのPRにマージ済みは存在しない。
  return toPullRequestSummary(pullRequest, repository, {
    merged: false,
    ciState,
    mergeable,
    mergeJudgement,
    ciRunId,
    ciChecks,
  });
}

/**
 * 修復ボタンを出すPRに、起動先ワークフローの配布状況を埋める（#1960）。
 *
 * **PR1件ずつの変換（`toOpenPullRequest`）ではなく、summaryが揃ってから別の一巡で埋める。**
 * CI状態はPRごとではなくまとめて取るようになった（#1962）ため、コンフリクト有無が分かるのは
 * summaryが揃った後になる。対応Issueの`00.check-user`を合流させるのと同じ「揃ってから足す」形。
 *
 * 判定するのはボタンが出るPRだけで、結果はプロセス内にキャッシュされる。CI失敗・コンフリクトの
 * PRが並んでいてもGitHub APIの消費はごく小さい。
 */
async function attachRepairWorkflowAvailability(
  pullRequests: PullRequestSummary[],
  repository: RepositoryContext,
  token: string,
): Promise<void> {
  await Promise.all(
    pullRequests.map(async (pullRequest) => {
      const kinds = repairKindsFor(pullRequest, pullRequest.mergeable);
      if (kinds.length === 0) return;

      pullRequest.repairWorkflowAvailability = await fetchRepairWorkflowAvailability(
        repository.ownerLogin,
        repository.name,
        {
          number: pullRequest.number,
          baseRef: pullRequest.baseRef,
          headRef: pullRequest.headRef,
        },
        kinds,
        token,
      );
    }),
  );
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
