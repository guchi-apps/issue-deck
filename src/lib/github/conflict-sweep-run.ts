import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { pullRequestRollupKey, type PullRequestRollupTarget } from "@/lib/github/check-rollup";
import {
  CONFLICT_SWEEP_RETRY_COOLDOWN_MINUTES,
  conflictSweepIntervalMinutes,
  decideConflictSweep,
  type ConflictSweepPullRequest,
  type ConflictSweepSkipReason,
} from "@/lib/github/conflict-sweep";
import { GithubApiError } from "@/lib/github/github-api-error";
import {
  CONFLICT_RESOLVE_WORKFLOW_FILE,
  isRepairWorkflowMissing,
  resolveRepairDispatch,
} from "@/lib/github/pull-request-repair";
import {
  fetchLatestConflictRepairRuns,
  recordPullRequestRepairRun,
  repairRunKey,
} from "@/lib/github/pull-request-repair-run";
import { fetchOpenPullRequests } from "@/lib/github/pull-requests-api";
import { fetchPullRequestCiStates, UNKNOWN_PULL_REQUEST_CI_STATE } from "@/lib/github/release-api";
import { fetchRepairWorkflowAvailability } from "@/lib/github/repair-workflow-cache";
import { dispatchWorkflow } from "@/lib/github/workflow-dispatch";
import { checkUserIssueKey, fetchCheckUserIssueReasons } from "@/lib/pull-request-check-user";

/**
 * コンフリクトしたPRを巡回して見つけ、`claude-conflict-resolve.yml`を起動する（#2116）。
 *
 * 何のために巡回するのか・なぜGitHubのトリガーだけでは足りないのかは
 * [`conflict-sweep.ts`](./conflict-sweep.ts)のヘッダーコメントを参照。ここはそのIO側で、
 * 起動するかどうかの判定そのものは`decideConflictSweep`に閉じている。
 *
 * **連携済みリポジトリ全部を1回の巡回で見る。** 呼ぶのはログインセッションを持たない
 * サブPCのpollerなので、`GET /api/pull-requests`のようなユーザー単位の絞り込み
 * （`HiddenRepository`・`userInstallations`）は行わない。画面に出していないリポジトリでも
 * PRが詰まるのは同じで、詰まりを直すのに「誰が見ているか」は関係しないため。
 */

export type ConflictSweepDispatched = {
  repositoryFullName: string;
  pullRequestNumber: number;
  issueNumber: string;
};

export type ConflictSweepResult = {
  /** 実際に巡回したか。間隔に達していない・無効化されている場合は`false` */
  swept: boolean;
  /** `CONFLICT_SWEEP_INTERVAL_MINUTES=0`で止めているか */
  disabled: boolean;
  /** 見たリポジトリ数 */
  repositories: number;
  /** コンフリクトしていた`issue-<番号>`→developのPR数 */
  conflicting: number;
  /** 起動したもの */
  dispatched: ConflictSweepDispatched[];
  /** 起動を見送った理由ごとの件数 */
  skipped: Partial<
    Record<
      ConflictSweepSkipReason | "workflow_missing" | "dispatch_failed" | "recent_failure",
      number
    >
  >;
  /** PRを取得できなかったリポジトリ */
  failedRepositories: string[];
};

/**
 * 最後に巡回した時刻（epoch ms）。**プロセス内にしか持たない。**
 *
 * 再起動で忘れるが、そのとき起きるのは「1回余分に巡回する」だけで、巡回自体が冪等
 * （コンフリクトしていないPRには何もしない）なので実害が無い。DBに持つとテーブルが1つ増える。
 */
let lastSweptAt: number | null = null;

/**
 * 起動そのものに失敗したPRと、その時刻（epoch ms）。**DBではなくプロセス内に持つ。**
 *
 * `PullRequestRepairRun`へ書くと画面に「コンフリクトを自動解消中」のバッジが出てしまうが、
 * 実際には起動できていない。かといって何も覚えないと、**毎回同じ理由で失敗する相手へ巡回の
 * たびに投げ続ける**ことになる（`workflow_dispatch`に`issue_number`入力を持たない世代の
 * callerを置いたままのリポジトリが実際にあり、そこへは常に422が返る）。
 * 抑制の期間は起動できた場合（`CONFLICT_SWEEP_RETRY_COOLDOWN_MINUTES`）と揃える。
 */
const dispatchFailedAt = new Map<string, number>();

/** テスト用。プロセスをまたがないので本番では呼ばない */
export function resetConflictSweepIntervalForTest(): void {
  lastSweptAt = null;
  dispatchFailedAt.clear();
}

function emptyResult(overrides: Partial<ConflictSweepResult>): ConflictSweepResult {
  return {
    swept: false,
    disabled: false,
    repositories: 0,
    conflicting: 0,
    dispatched: [],
    skipped: {},
    failedRepositories: [],
    ...overrides,
  };
}

export async function runConflictSweep(
  options: { force?: boolean; now?: Date } = {},
): Promise<ConflictSweepResult> {
  const now = options.now ?? new Date();
  const intervalMinutes = conflictSweepIntervalMinutes();
  if (intervalMinutes === 0) return emptyResult({ disabled: true });
  // **間隔の判定はサーバー側に置く。** pollerは30秒ごとに呼ぶだけにして、どれくらいの
  // 間隔で見に行くか（＝GitHub APIをどれだけ使うか）はissue-deck側の設定だけで決められる
  // ようにする（呼ぶ側が増えても消費が増えない）。
  if (
    !options.force &&
    lastSweptAt !== null &&
    now.getTime() - lastSweptAt < intervalMinutes * 60_000
  ) {
    return emptyResult({});
  }
  lastSweptAt = now.getTime();

  const repositories = await db.repository.findMany({
    where: { archived: false },
    orderBy: { fullName: "asc" },
    include: { installation: true },
  });
  if (repositories.length === 0) return emptyResult({ swept: true });

  const skipped: ConflictSweepResult["skipped"] = {};
  function countSkip(reason: keyof ConflictSweepResult["skipped"]): void {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  }

  // 同一installationのリポジトリ間でトークン取得を使い回す（`GET /api/pull-requests`と同じ）。
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

  type Candidate = {
    repositoryId: string;
    ownerLogin: string;
    name: string;
    fullName: string;
    installationId: number;
    number: number;
    baseRef: string;
    headRef: string;
    draft: boolean;
    issueNumber: string;
  };

  // まずPR一覧（REST。ETagの条件付きGETが効くので、変化が無ければレート制限を消費しない）を
  // 取り、**この時点で`issue-<番号>`→develop以外を落とす。** コンフリクト有無のGraphQLは
  // 残ったPRぶんしか投げない。
  const candidates = (
    await Promise.all(
      repositories.map(async (repository): Promise<Candidate[]> => {
        try {
          const token = await tokenFor(repository.installation.installationId);
          const pullRequests = await fetchOpenPullRequests(
            repository.ownerLogin,
            repository.name,
            token,
          );
          return pullRequests.flatMap((pullRequest) => {
            if (pullRequest.draft) return [];
            const { workflowFile, inputs } = resolveRepairDispatch(
              {
                number: pullRequest.number,
                baseRef: pullRequest.base.ref,
                headRef: pullRequest.head.ref,
              },
              "conflict",
            );
            if (workflowFile !== CONFLICT_RESOLVE_WORKFLOW_FILE) {
              countSkip("no_auto_workflow");
              return [];
            }
            return [
              {
                repositoryId: repository.id,
                ownerLogin: repository.ownerLogin,
                name: repository.name,
                fullName: repository.fullName,
                installationId: repository.installation.installationId,
                number: pullRequest.number,
                baseRef: pullRequest.base.ref,
                headRef: pullRequest.head.ref,
                draft: pullRequest.draft,
                issueNumber: inputs.issue_number,
              },
            ];
          });
        } catch (error) {
          // 1リポジトリの取得失敗で巡回全体を止めない（`GET /api/pull-requests`と同じ扱い）。
          console.error(`[conflict-sweep] ${repository.fullName} のPR取得:`, error);
          failedRepositories.push(repository.fullName);
          return [];
        }
      }),
    )
  ).flat();

  if (candidates.length === 0) {
    return emptyResult({
      swept: true,
      repositories: repositories.length,
      skipped,
      failedRepositories,
    });
  }

  // コンフリクト有無はinstallationごとにまとめて引く（PR件数ではなくinstallation数に比例。#1962）。
  const mergeables = new Map<string, boolean | null>();
  const targetsByInstallation = new Map<number, PullRequestRollupTarget[]>();
  for (const candidate of candidates) {
    const targets = targetsByInstallation.get(candidate.installationId) ?? [];
    targets.push({ owner: candidate.ownerLogin, repo: candidate.name, number: candidate.number });
    targetsByInstallation.set(candidate.installationId, targets);
  }
  await Promise.all(
    [...targetsByInstallation].map(async ([installationId, targets]) => {
      try {
        const token = await tokenFor(installationId);
        for (const [key, state] of await fetchPullRequestCiStates(targets, token)) {
          mergeables.set(key, state.mergeable);
        }
      } catch (error) {
        // 取れなければ`null`のまま＝コンフリクトしていない扱いになり、次の巡回で拾い直す。
        console.error(`[conflict-sweep] installation ${installationId} のコンフリクト判定:`, error);
      }
    }),
  );

  const conflicting = candidates.filter(
    (candidate) =>
      (mergeables.get(
        pullRequestRollupKey(candidate.ownerLogin, candidate.name, candidate.number),
      ) ?? UNKNOWN_PULL_REQUEST_CI_STATE.mergeable) === false,
  );
  if (conflicting.length === 0) {
    return emptyResult({
      swept: true,
      repositories: repositories.length,
      skipped,
      failedRepositories,
    });
  }

  // ここから先はコンフリクトしているPRだけを見る。DBを2回引くが、GitHub APIは消費しない。
  const checkUserReasons = await fetchCheckUserIssueReasons(
    [...new Set(conflicting.map((candidate) => candidate.repositoryId))].map((repositoryId) => ({
      repositoryId,
      issueNumbers: conflicting
        .filter((candidate) => candidate.repositoryId === repositoryId)
        .map((candidate) => Number(candidate.issueNumber)),
    })),
  );
  const repairRuns = await fetchLatestConflictRepairRuns(
    conflicting.map((candidate) => ({
      repositoryFullName: candidate.fullName,
      pullRequestNumber: candidate.number,
    })),
  );

  const dispatched: ConflictSweepDispatched[] = [];
  for (const candidate of conflicting) {
    const pullRequest: ConflictSweepPullRequest = {
      repositoryFullName: candidate.fullName,
      number: candidate.number,
      baseRef: candidate.baseRef,
      headRef: candidate.headRef,
      state: "open",
      draft: candidate.draft,
      mergeable: false,
      checkUser: checkUserReasons.has(
        checkUserIssueKey(candidate.repositoryId, Number(candidate.issueNumber)),
      ),
    };
    const decision = decideConflictSweep(pullRequest, {
      repairRun: repairRuns.get(repairRunKey(candidate.fullName, candidate.number)) ?? null,
      now,
    });
    if (!decision.dispatch) {
      countSkip(decision.reason);
      continue;
    }

    const failureKey = repairRunKey(candidate.fullName, candidate.number);
    const failedAt = dispatchFailedAt.get(failureKey);
    if (
      failedAt !== undefined &&
      now.getTime() - failedAt < CONFLICT_SWEEP_RETRY_COOLDOWN_MINUTES * 60_000
    ) {
      countSkip("recent_failure");
      continue;
    }

    try {
      const token = await tokenFor(candidate.installationId);

      // **配ってないリポジトリへは投げない。** callerが無ければ404になるだけだが、巡回は
      // 人の操作と違って毎回同じ結果を繰り返すため、判定（プロセス内にキャッシュされる）を
      // 挟んでログとAPI消費が延々と積まれるのを避ける。
      const availability = await fetchRepairWorkflowAvailability(
        candidate.ownerLogin,
        candidate.name,
        { number: candidate.number, baseRef: candidate.baseRef, headRef: candidate.headRef },
        ["conflict"],
        token,
      );
      if (isRepairWorkflowMissing(availability, "conflict")) {
        countSkip("workflow_missing");
        continue;
      }

      const { ref, inputs } = decision.target;
      await dispatchWorkflow(
        candidate.ownerLogin,
        candidate.name,
        CONFLICT_RESOLVE_WORKFLOW_FILE,
        ref,
        inputs,
        token,
      );

      // 画面へ「コンフリクトを自動解消中」を出すため、起動できた時点で記録する
      // （`POST /api/pull-requests/repair`と同じ。実行ログのURLはワークフロー側が上書きする）。
      // **この行は再試行の抑制も兼ねる**ので、失敗しても巡回自体は止めない。
      await recordPullRequestRepairRun({
        repositoryFullName: candidate.fullName,
        pullRequestNumber: candidate.number,
        kind: "conflict",
        status: "running",
        now,
      }).catch((error: unknown) => {
        console.warn(`[conflict-sweep] ${candidate.fullName}#${candidate.number} の記録:`, error);
      });

      dispatchFailedAt.delete(failureKey);
      dispatched.push({
        repositoryFullName: candidate.fullName,
        pullRequestNumber: candidate.number,
        issueNumber: candidate.issueNumber,
      });
    } catch (error) {
      dispatchFailedAt.set(failureKey, now.getTime());
      countSkip("dispatch_failed");
      const detail = error instanceof GithubApiError ? `HTTP ${error.status}` : String(error);
      console.error(
        `[conflict-sweep] ${candidate.fullName}#${candidate.number} の起動に失敗しました: ${detail}`,
      );
    }
  }

  return {
    swept: true,
    disabled: false,
    repositories: repositories.length,
    conflicting: conflicting.length,
    dispatched,
    skipped,
    failedRepositories,
  };
}
