import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { fetchWorkflowRunJobs } from "@/lib/github/actions-api";
import type { DeployFailureSkipReason } from "@/lib/deploy-failure";
import {
  buildIosDistributionFailureIssueBody,
  buildIosDistributionFailureIssueTitle,
  buildIosDistributionFailureResolvedComment,
  buildIosDistributionFailureUpdateComment,
  decideIosDistributionFailure,
  iosDistributionFailureSweepIntervalMinutes,
  type IosDistributionFailureMeta,
} from "@/lib/ios-distribution-failure";
import {
  IOS_TESTFLIGHT_WORKFLOW_FILE,
  judgeIosRun,
  summarizeIosStages,
} from "@/lib/ios-testflight-status";
import {
  createComment,
  createIssue,
  fetchIssueState,
  fetchRepositoryLabelNames,
  updateIssue,
} from "@/lib/github/issues-api";
import { fetchFailedJobNames, fetchLatestWorkflowRun, type ReleaseWorkflowRun } from "@/lib/github/release-api";
import { getWebviewIosRepository } from "@/lib/webview-ios-repos";

/**
 * iOS配布（`ios-testflight.yml`）が失敗したまま止まっているリポジトリを巡回し、追跡用のIssueを
 * 起票・更新・クローズする（#3745）。判定の考え方は`deploy-failure-sweep-run.ts`（#2236）と同じ。
 *
 * **入口は`Repository`の行で、固定リストは絞り込みにだけ使う。** 固定リストのキーを回すと、
 * リネーム前の旧名（`guchi-apps/myroom`）と新名が両方あり、同じ失敗でIssueが2件立つため。
 *
 * GitHub APIの消費は、対象リポジトリごとに最新run 1回（ETagの条件付きGETなので、実行が動いて
 * いない間は消費しない）。ジョブ一覧は起票・更新のときだけ取る。
 */

export type IosDistributionFailureSweepAction = {
  repositoryFullName: string;
  kind: "created" | "updated" | "closed";
  issueNumber: number;
};

export type IosDistributionFailureSweepResult = {
  swept: boolean;
  disabled: boolean;
  repositories: number;
  actions: IosDistributionFailureSweepAction[];
  skipped: Partial<Record<DeployFailureSkipReason | "action_failed", number>>;
  failedRepositories: string[];
};

/** 最後に巡回した時刻。プロセス内にしか持たない（再起動で忘れても1回余分に巡回するだけ） */
let lastSweptAt: number | null = null;

export function resetIosDistributionFailureSweepIntervalForTest(): void {
  lastSweptAt = null;
}

function emptyResult(overrides: Partial<IosDistributionFailureSweepResult>): IosDistributionFailureSweepResult {
  return {
    swept: false,
    disabled: false,
    repositories: 0,
    actions: [],
    skipped: {},
    failedRepositories: [],
    ...overrides,
  };
}

export async function runIosDistributionFailureSweep(
  options: { force?: boolean; now?: Date } = {},
): Promise<IosDistributionFailureSweepResult> {
  const now = options.now ?? new Date();
  const intervalMinutes = iosDistributionFailureSweepIntervalMinutes();
  if (intervalMinutes === 0) return emptyResult({ disabled: true });
  if (
    !options.force &&
    lastSweptAt !== null &&
    now.getTime() - lastSweptAt < intervalMinutes * 60_000
  ) {
    return emptyResult({});
  }
  lastSweptAt = now.getTime();

  const repositories = (
    await db.repository.findMany({
      where: { archived: false },
      orderBy: { fullName: "asc" },
      include: { installation: true },
    })
  ).filter((repository) => getWebviewIosRepository(repository.fullName) !== null);
  if (repositories.length === 0) return emptyResult({ swept: true });

  const skipped: IosDistributionFailureSweepResult["skipped"] = {};
  const countSkip = (reason: keyof IosDistributionFailureSweepResult["skipped"]) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };
  const actions: IosDistributionFailureSweepAction[] = [];
  const failedRepositories: string[] = [];
  let seenRepositories = 0;

  await Promise.all(
    repositories.map(async (repository) => {
      const [owner, repo] = [repository.ownerLogin, repository.name];
      try {
        const token = await getInstallationToken(repository.installation.installationId);
        // ワークフローがまだ無いリポジトリは404でnullになり、何もしない
        const run = await fetchLatestWorkflowRun(owner, repo, IOS_TESTFLIGHT_WORKFLOW_FILE, token);
        if (run === null) {
          countSkip("no_run");
          return;
        }
        seenRepositories += 1;
        const tracked = await findOpenTrackedIssue(repository.fullName, owner, repo, token);
        const decision = decideIosDistributionFailure({ run, tracked, now });
        if (decision.kind === "skip") {
          countSkip(decision.reason);
          return;
        }
        try {
          const action = await applyDecision({
            decision,
            repositoryFullName: repository.fullName,
            owner,
            repo,
            token,
            run,
            now,
          });
          if (action) actions.push(action);
        } catch (error) {
          // 1件の起票失敗で巡回を止めない。次の巡回で同じ判定に戻る
          console.error(`[ios-distribution-failure-sweep] ${repository.fullName} (${decision.kind}):`, error);
          countSkip("action_failed");
        }
      } catch (error) {
        console.error(`[ios-distribution-failure-sweep] ${repository.fullName}:`, error);
        failedRepositories.push(repository.fullName);
      }
    }),
  );

  return { swept: true, disabled: false, repositories: seenRepositories, actions, skipped, failedRepositories };
}

/** 開いている追跡Issueを返す。人が先に閉じていたらDBも畳む（取得失敗は「開いている」側に倒す） */
async function findOpenTrackedIssue(
  repositoryFullName: string,
  owner: string,
  repo: string,
  token: string,
): Promise<{ issueNumber: number; runId: number } | null> {
  const row = await db.iosDistributionFailureIssue.findFirst({
    where: { repositoryFullName, state: "open" },
    orderBy: { detectedAt: "desc" },
  });
  if (!row) return null;
  const state = await fetchIssueState(owner, repo, row.issueNumber, token);
  if (state === "closed") {
    await db.iosDistributionFailureIssue.update({
      where: { id: row.id },
      data: { state: "closed", resolvedAt: new Date() },
    });
    return null;
  }
  return { issueNumber: row.issueNumber, runId: Number(row.runId) };
}

async function applyDecision({
  decision,
  repositoryFullName,
  owner,
  repo,
  token,
  run,
  now,
}: {
  decision: Exclude<ReturnType<typeof decideIosDistributionFailure>, { kind: "skip" }>;
  repositoryFullName: string;
  owner: string;
  repo: string;
  token: string;
  run: ReleaseWorkflowRun;
  now: Date;
}): Promise<IosDistributionFailureSweepAction | null> {
  if (decision.kind === "close") {
    await createComment(owner, repo, decision.issueNumber, token, {
      body: buildIosDistributionFailureResolvedComment(run.htmlUrl),
    });
    await updateIssue(owner, repo, decision.issueNumber, token, {
      state: "closed",
      state_reason: "completed",
    });
    await db.iosDistributionFailureIssue.updateMany({
      where: { repositoryFullName, state: "open" },
      data: { state: "closed", resolvedAt: now },
    });
    return { repositoryFullName, kind: "closed", issueNumber: decision.issueNumber };
  }

  const meta = await buildMeta({ repositoryFullName, owner, repo, token, run, now });

  if (decision.kind === "update") {
    await createComment(owner, repo, decision.issueNumber, token, {
      body: buildIosDistributionFailureUpdateComment(meta),
    });
    await db.iosDistributionFailureIssue.updateMany({
      where: { repositoryFullName, state: "open" },
      data: { runId: BigInt(run.id), runUrl: run.htmlUrl, failedStage: meta.failedStage, detectedAt: now },
    });
    return { repositoryFullName, kind: "updated", issueNumber: decision.issueNumber };
  }

  const created = await createIssue(owner, repo, token, {
    title: buildIosDistributionFailureIssueTitle(meta),
    body: buildIosDistributionFailureIssueBody(meta),
    labels: await pickExistingLabels(owner, repo, token),
  });
  await db.iosDistributionFailureIssue.create({
    data: {
      repositoryFullName,
      runId: BigInt(run.id),
      issueNumber: created.number,
      state: "open",
      failedStage: meta.failedStage,
      runUrl: run.htmlUrl,
      detectedAt: now,
    },
  });
  return { repositoryFullName, kind: "created", issueNumber: created.number };
}

async function buildMeta({
  repositoryFullName,
  owner,
  repo,
  token,
  run,
  now,
}: {
  repositoryFullName: string;
  owner: string;
  repo: string;
  token: string;
  run: ReleaseWorkflowRun;
  now: Date;
}): Promise<IosDistributionFailureMeta> {
  const [failedJobs, failedStage] = await Promise.all([
    fetchFailedJobNames(owner, repo, run.id, token),
    fetchFailedStage(owner, repo, run, token),
  ]);
  return {
    repositoryFullName,
    runId: run.id,
    runUrl: run.htmlUrl,
    failedStage,
    failedJobs,
    detectedAt: now.toISOString(),
  };
}

/** 失敗した段階の表示名。ジョブを取れない・名前から推定できないときはnull（内訳より起票を優先する） */
async function fetchFailedStage(
  owner: string,
  repo: string,
  run: ReleaseWorkflowRun,
  token: string,
): Promise<string | null> {
  try {
    const jobs = await fetchWorkflowRunJobs(owner, repo, run.id, token);
    const verdict = judgeIosRun(run, summarizeIosStages(jobs));
    return verdict.kind === "failed" ? verdict.failedStage : null;
  } catch {
    return null;
  }
}

// 存在しないラベルを渡すとGitHubがIssueの作成ごと弾くので、そのリポジトリにあるものだけを付ける
const WANTED_LABELS = ["30.bug", "80.Priority: High"];

async function pickExistingLabels(owner: string, repo: string, token: string): Promise<string[]> {
  try {
    const names = await fetchRepositoryLabelNames(owner, repo, token);
    return WANTED_LABELS.filter((label) => names.has(label));
  } catch {
    return [];
  }
}
