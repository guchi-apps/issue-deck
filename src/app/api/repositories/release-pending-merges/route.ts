import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { getInstallationToken } from "@/lib/github/app-auth";
import {
  type CiState,
  fetchLatestDeployWorkflowRun,
  fetchLatestReleaseWorkflowRun,
  fetchOpenPullRequestsForBase,
  fetchRefCiState,
} from "@/lib/github/release-api";
import {
  resolveFailedReleaseWorkflow,
  summarizeReleaseStatus,
  type ReleaseButtonStatus,
  type ReleaseMergeTarget,
  type ReleaseStatusSummaryInput,
} from "@/lib/github/release-button-status";
import { releaseWorkflowExists } from "@/lib/github/release-workflow-cache";

export type ReleasePendingMerge = {
  mergeTarget: ReleaseMergeTarget;
  pullRequestNumber: number;
  pullRequestUrl: string;
  pullRequestTitle: string;
  /**
   * マージ対象PRのCI状態。**`failure`でも一覧から外さない。** マージできない状態にあること自体を
   * 画面へ出し、「マージすればよい」と「CIが落ちていて直す必要がある」を区別するため（#1059）。
   */
  ciState: CiState;
};

/**
 * リポジトリ1件ぶんのリリース状況。`status`が`idle`のリポジトリは返さない
 * （画面側は「返ってきたもの＝動きがあるもの」として扱う）。
 */
export type RepositoryReleaseStatus = {
  repoFullName: string;
  status: ReleaseButtonStatus;
  /** `error`のとき、どちらの実行が失敗しているか */
  failedWorkflow: "deploy" | "release" | null;
  /** 人のマージ操作を待っているPR。待っていなければnull */
  pendingMerge: ReleasePendingMerge | null;
};

export function GET() {
  // 元は「mainマージ待ち」だけを返していたが、#1117でリリース状況のサマリを返すようになった。
  // 消費するリクエスト数の桁は変わっていないため、過去の集計と分断しないようキーは据え置く。
  return withGithubApiFeature("release_pending_merges", handleGET);
}

async function handleGET() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 母集団は「ブランチ」画面（`/api/branch-flow`）と揃え、リリースworkflowを持つかどうかは
  // 後段の`releaseWorkflowExists`だけで決める（#1727）。
  // 元は`hasClaudeWorkflow: true`で先に絞っていたが、これは`claude-issue-dispatch.yml`の有無で
  // 「リリースworkflow導入済み」を代用していたもので、#1538が「ブランチ」画面のボタンについて
  // 既に取り除いた代用と同じものだった。無人実行（計画〜実装）を入れずにリリースフローだけを
  // 載せたリポジトリ（`subpc`・`vps`）では、ボタンは出るのに通知ベルとスマホのバッジにだけ
  // 出てこない、という食い違いになる。
  const repositories = await db.repository.findMany({
    where: {
      archived: false,
      installation: { userInstallations: { some: { userId } } },
    },
    orderBy: { fullName: "asc" },
    include: { installation: true },
  });

  if (repositories.length === 0) {
    return NextResponse.json({ releaseStatuses: [] });
  }

  // 同一installationのリポジトリ間でトークン取得を使い回し、無駄なAPI呼び出しを避ける。
  const tokenPromises = new Map<number, Promise<string>>();
  function tokenFor(installationId: number): Promise<string> {
    let token = tokenPromises.get(installationId);
    if (!token) {
      token = getInstallationToken(installationId);
      tokenPromises.set(installationId, token);
    }
    return token;
  }

  const results = await Promise.all(
    repositories.map(async (repository): Promise<RepositoryReleaseStatus | null> => {
      try {
        const token = await tokenFor(repository.installation.installationId);
        const available = await releaseWorkflowExists(repository.ownerLogin, repository.name, token);
        if (!available) return null;

        const [developBasePullRequests, mainBasePullRequests, workflowRun, deployWorkflowRun] =
          await Promise.all([
            fetchOpenPullRequestsForBase(repository.ownerLogin, repository.name, "develop", token),
            fetchOpenPullRequestsForBase(repository.ownerLogin, repository.name, "main", token),
            // 実行中・失敗の検出にはPRだけでは足りないため、リリースworkflowと本番デプロイの
            // 最新runも取る（#1117）。リリースworkflowを持たないリポジトリはこの行まで来ない。
            fetchLatestReleaseWorkflowRun(repository.ownerLogin, repository.name, token),
            fetchLatestDeployWorkflowRun(repository.ownerLogin, repository.name, token),
          ]);

        // mainへのマージ待ち（develop→mainのPRがオープン中）を最優先で検出する。
        const releasePr = mainBasePullRequests.find((pr) => pr.head.ref === "develop") ?? null;
        const bumpPr =
          developBasePullRequests.find((pr) => pr.head.ref.startsWith("release/v")) ?? null;

        // CI状態は「今マージ待ちにあたるPR」の分だけ取る（1リポジトリにつき最大1回）。
        //
        // リリースPRのheadは`develop`そのもののため、`develop`のチェックがそのままこのPRの
        // 状態になる。**見るのはGitHubがPRのChecksとして数えるものだけ**で、`issues`や
        // `workflow_dispatch`で起動した無人実行のワークフローは入らない（#1578。
        // `lib/github/check-rollup.ts`）。ワークフロー名でCIを特定する方式はファイル名が
        // リポジトリごとに違う（asset-managerはtest.yml）ため採らず、集約値をそのまま使う。
        // 画面側の表記を「CI失敗」ではなく「チェック失敗」にしているのはこのため。
        const releaseCiState = releasePr
          ? await fetchRefCiState(repository.ownerLogin, repository.name, "develop", token)
          : null;
        const bumpCiState =
          !releasePr && bumpPr
            ? await fetchRefCiState(repository.ownerLogin, repository.name, bumpPr.head.ref, token)
            : null;

        // `release_pending`（developだけbump済みでdevelop→mainのPRが未作成）は判定しない。
        // 判定には`package.json`の版数取得が1リポジトリあたり2回増えるのに対し、その状態は
        // ほぼ常にリリースworkflowのrunが実行中か失敗として現れるため（#1117）。
        const summaryInput: ReleaseStatusSummaryInput = {
          workflowRun,
          deployWorkflowRun,
          // develop→mainのPRを優先する上記の方針に合わせ、そちらがオープン中の間は
          // バンプPRを見ない（`/api/repositories/release`の`phase`とは優先順位が逆になる）。
          bumpPullRequest: !releasePr && bumpPr ? { ciState: bumpCiState } : null,
          releasePullRequest: releasePr ? { ciState: releaseCiState } : null,
          releasePending: false,
        };
        const status = summarizeReleaseStatus(summaryInput);
        if (status === "idle") return null;

        let pendingMerge: ReleasePendingMerge | null = null;
        if (releasePr && releaseCiState && releaseCiState !== "pending") {
          // CI実行中はまだマージできないため、マージ待ちとして数えない（#1433）。
          // `summarizeReleaseStatus`のaction_required判定基準・バンプPR側の条件と揃える。
          pendingMerge = {
            mergeTarget: "main",
            pullRequestNumber: releasePr.number,
            pullRequestUrl: releasePr.html_url,
            pullRequestTitle: releasePr.title,
            ciState: releaseCiState,
          };
        } else if (bumpPr && bumpCiState && bumpCiState !== "pending") {
          // developへのマージ待ち（バンプPRがCI通過後も残っている＝auto-merge滞留）を検出する。
          // `summarizeReleaseStatus`のaction_required判定基準（CIがpendingでなくなった時点）と揃える。
          pendingMerge = {
            mergeTarget: "develop",
            pullRequestNumber: bumpPr.number,
            pullRequestUrl: bumpPr.html_url,
            pullRequestTitle: bumpPr.title,
            ciState: bumpCiState,
          };
        }

        return {
          repoFullName: repository.fullName,
          status,
          failedWorkflow: resolveFailedReleaseWorkflow(summaryInput),
          pendingMerge,
        };
      } catch (error) {
        // 1リポジトリの取得失敗で他リポジトリの表示まで巻き込まないよう、ログのみ残してスキップする。
        console.error(
          `[GET /api/repositories/release-pending-merges] ${repository.fullName}:`,
          error,
        );
        return null;
      }
    }),
  );

  return NextResponse.json({
    releaseStatuses: results.filter((result): result is RepositoryReleaseStatus => result !== null),
  });
}
