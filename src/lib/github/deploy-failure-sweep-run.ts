import { MAIN_BRANCH, releaseVersionFromTitle } from "@/lib/branch-flow";
import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import {
  buildDeployFailureIssueBody,
  buildDeployFailureIssueTitle,
  buildDeployFailureResolvedComment,
  buildDeployFailureUpdateComment,
  decideDeployFailure,
  deployFailureSweepIntervalMinutes,
  type DeployFailureMeta,
  type DeployFailureSkipReason,
} from "@/lib/deploy-failure";
import { deployWorkflowExists } from "@/lib/github/deploy-workflow-cache";
import {
  createComment,
  createIssue,
  fetchIssueState,
  fetchRepositoryLabelNames,
  updateIssue,
} from "@/lib/github/issues-api";
import { fetchClosedPullRequestsForBase } from "@/lib/github/pull-requests-api";
import {
  fetchFailedJobNames,
  fetchLatestDeployWorkflowRun,
  type ReleaseWorkflowRun,
} from "@/lib/github/release-api";

/**
 * 本番デプロイが失敗したまま止まっているリポジトリを巡回し、追跡用のIssueを起票・更新・
 * クローズする（#2236）。
 *
 * 何のために巡回するのか・なぜGitHub Actions側で立てないのかは
 * [`deploy-failure.ts`](../deploy-failure.ts)のヘッダーコメントを参照。
 * ここはそのIO側で、起票するかどうかの判定は`decideDeployFailure`に閉じている。
 *
 * **連携済みリポジトリ全部を1回の巡回で見る。** 呼ぶのはログインセッションを持たない
 * サブPCのpollerなので、ユーザー単位の絞り込み（`HiddenRepository`・`userInstallations`）は
 * 行わない。画面に出していないリポジトリの本番が古いままなのは同じことで、
 * それを直すのに「誰が見ているか」は関係しない（コンフリクト巡回#2116と同じ方針）。
 *
 * ## GitHub APIの消費
 *
 * 巡回1回あたり、`deploy.yml`を持つリポジトリごとにREST 1回（最新runの取得。**ETagの
 * 条件付きGETを通すので、実行が動いていない間はレート制限を消費しない**）。
 * 起票・更新のときだけ、そのリポジトリで追加のRESTが数回走る（失敗ジョブ名・main側のPR一覧・
 * ラベル一覧・Issueの作成）。**失敗しているリポジトリは常にごく少数**なので、
 * 平常時の消費は最初の1回ぶんだけになる。
 */

/** 起票・更新・クローズしたもの1件ぶん */
export type DeployFailureSweepAction = {
  repositoryFullName: string;
  kind: "created" | "updated" | "closed";
  issueNumber: number;
};

export type DeployFailureSweepResult = {
  /** 実際に巡回したか。間隔に達していない・無効化されている場合は`false` */
  swept: boolean;
  /** `DEPLOY_FAILURE_SWEEP_INTERVAL_MINUTES=0`で止めているか */
  disabled: boolean;
  /** `deploy.yml`を持っていて実際に見たリポジトリ数 */
  repositories: number;
  /** 起票・更新・クローズしたもの */
  actions: DeployFailureSweepAction[];
  /** 見送った理由ごとの件数 */
  skipped: Partial<Record<DeployFailureSkipReason | "action_failed", number>>;
  /** 状況を取得できなかったリポジトリ */
  failedRepositories: string[];
};

/**
 * 最後に巡回した時刻（epoch ms）。**プロセス内にしか持たない**（コンフリクト巡回と同じ）。
 * 再起動で忘れても起きるのは「1回余分に巡回する」だけで、巡回自体は冪等。
 */
let lastSweptAt: number | null = null;

/** テスト用。プロセスをまたがないので本番では呼ばない */
export function resetDeployFailureSweepIntervalForTest(): void {
  lastSweptAt = null;
}

function emptyResult(overrides: Partial<DeployFailureSweepResult>): DeployFailureSweepResult {
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

export async function runDeployFailureSweep(
  options: { force?: boolean; now?: Date } = {},
): Promise<DeployFailureSweepResult> {
  const now = options.now ?? new Date();
  const intervalMinutes = deployFailureSweepIntervalMinutes();
  if (intervalMinutes === 0) return emptyResult({ disabled: true });
  // 間隔の判定はサーバー側に置く（pollerは1巡ごとに素直に呼ぶだけでよい）。
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

  const skipped: DeployFailureSweepResult["skipped"] = {};
  function countSkip(reason: keyof DeployFailureSweepResult["skipped"]): void {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  }

  // 同一installationのリポジトリ間でトークン取得を使い回す。
  const tokenPromises = new Map<number, Promise<string>>();
  function tokenFor(installationId: number): Promise<string> {
    let token = tokenPromises.get(installationId);
    if (!token) {
      token = getInstallationToken(installationId);
      tokenPromises.set(installationId, token);
    }
    return token;
  }

  const actions: DeployFailureSweepAction[] = [];
  const failedRepositories: string[] = [];
  let seenRepositories = 0;

  await Promise.all(
    repositories.map(async (repository) => {
      const [owner, repo] = [repository.ownerLogin, repository.name];
      try {
        const token = await tokenFor(repository.installation.installationId);
        // プロセス内に10分キャッシュされ、ブランチ状況・デプロイの起動と共有される（#2020）
        if (!(await deployWorkflowExists(owner, repo, token))) return;
        seenRepositories += 1;

        const run = await fetchLatestDeployWorkflowRun(owner, repo, token);
        const tracked = await findOpenTrackedIssue(repository.fullName, owner, repo, token);

        const decision = decideDeployFailure({ run, tracked, now });
        if (decision.kind === "skip") {
          countSkip(decision.reason);
          return;
        }
        // ここへ来る決定はすべて`run`を見て出しているので、runは必ずある。
        if (run === null) return;

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
          // **1件の起票失敗で巡回を止めない。** 次の巡回で同じ判定に戻るので拾い直せる。
          console.error(`[deploy-failure-sweep] ${repository.fullName} (${decision.kind}):`, error);
          countSkip("action_failed");
        }
      } catch (error) {
        // 1リポジトリの取得失敗で巡回全体を落とさない。
        console.error(`[deploy-failure-sweep] ${repository.fullName}:`, error);
        failedRepositories.push(repository.fullName);
      }
    }),
  );

  return {
    swept: true,
    disabled: false,
    repositories: seenRepositories,
    actions,
    skipped,
    failedRepositories,
  };
}

/**
 * そのリポジトリでいま開いている追跡Issueを返す。
 *
 * **DBの記録だけでは足りない。** 人が画面から先にIssueを閉じることがあり、そのとき
 * DBは`open`のままなので、次の失敗でIssueが二度と立たなくなる。開いている行が
 * 見つかったときだけGitHubの実物を1回見て、閉じられていればDB側も畳む。
 */
async function findOpenTrackedIssue(
  repositoryFullName: string,
  owner: string,
  repo: string,
  token: string,
): Promise<{ issueNumber: number; runId: number } | null> {
  const row = await db.deployFailureIssue.findFirst({
    where: { repositoryFullName, state: "open" },
    orderBy: { detectedAt: "desc" },
  });
  if (!row) return null;

  const state = await fetchIssueState(owner, repo, row.issueNumber, token);
  // 取得に失敗した（null）ときは「開いている」側に倒す。**閉じた扱いにすると同じ失敗で
  // Issueをもう1件立ててしまう**ので、判定できないときは何もしない方が安い。
  if (state === "closed") {
    await db.deployFailureIssue.update({
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
  decision: Exclude<ReturnType<typeof decideDeployFailure>, { kind: "skip" }>;
  repositoryFullName: string;
  owner: string;
  repo: string;
  token: string;
  run: ReleaseWorkflowRun;
  now: Date;
}): Promise<DeployFailureSweepAction | null> {
  if (decision.kind === "close") {
    const versions = await fetchMainVersions(owner, repo, token);
    await createComment(owner, repo, decision.issueNumber, token, {
      body: buildDeployFailureResolvedComment(run.htmlUrl, versions.current),
    });
    await updateIssue(owner, repo, decision.issueNumber, token, {
      state: "closed",
      state_reason: "completed",
    });
    await db.deployFailureIssue.updateMany({
      where: { repositoryFullName, state: "open" },
      data: { state: "closed", resolvedAt: now },
    });
    return { repositoryFullName, kind: "closed", issueNumber: decision.issueNumber };
  }

  const meta = await buildMeta({ repositoryFullName, owner, repo, token, run, now });

  if (decision.kind === "update") {
    await createComment(owner, repo, decision.issueNumber, token, {
      body: buildDeployFailureUpdateComment(meta),
    });
    // 追いかける先をいちばん新しい失敗へ移す。**行は作り直さず更新する**——同時に開く
    // Issueは1件だけ、という取り決めをDBの側でも保つため。
    await db.deployFailureIssue.updateMany({
      where: { repositoryFullName, state: "open" },
      data: { runId: BigInt(run.id), runUrl: run.htmlUrl, version: meta.version, detectedAt: now },
    });
    return { repositoryFullName, kind: "updated", issueNumber: decision.issueNumber };
  }

  const created = await createIssue(owner, repo, token, {
    title: buildDeployFailureIssueTitle(meta),
    body: buildDeployFailureIssueBody(meta),
    labels: await pickExistingLabels(owner, repo, token),
  });
  await db.deployFailureIssue.create({
    data: {
      repositoryFullName,
      runId: BigInt(run.id),
      issueNumber: created.number,
      state: "open",
      version: meta.version,
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
}): Promise<DeployFailureMeta> {
  const [failedJobs, versions] = await Promise.all([
    fetchFailedJobNames(owner, repo, run.id, token),
    fetchMainVersions(owner, repo, token),
  ]);
  return {
    repositoryFullName,
    runId: run.id,
    runUrl: run.htmlUrl,
    version: versions.current,
    previousVersion: versions.previous,
    failedJobs,
    attempt: run.runAttempt,
    detectedAt: now.toISOString(),
  };
}

/**
 * mainへマージ済みのPRのタイトルから「落ちた版」と「1つ前の版」を読む。
 *
 * 判定はブランチ画面（#1579）・PR詳細（#1814）と同じ`releaseVersionFromTitle`を通す。
 * **取れなければnullのままにして、版を書かない。** 間違った版を書くくらいなら書かない方がよい。
 */
async function fetchMainVersions(
  owner: string,
  repo: string,
  token: string,
): Promise<{ current: string | null; previous: string | null }> {
  try {
    const merged = (await fetchClosedPullRequestsForBase(owner, repo, MAIN_BRANCH, token))
      .filter((item): item is typeof item & { merged_at: string } => item.merged_at !== null)
      .sort((a, b) => new Date(b.merged_at).getTime() - new Date(a.merged_at).getTime());
    return {
      current: merged[0] ? releaseVersionFromTitle(merged[0].title) : null,
      previous: merged[1] ? releaseVersionFromTitle(merged[1].title) : null,
    };
  } catch {
    return { current: null, previous: null };
  }
}

/** 起票Issueに付けたいラベル。**そのリポジトリに定義があるものだけ**を返す */
const WANTED_LABELS = ["30.bug", "80.Priority: High"];

/**
 * 存在しないラベルを渡すとGitHubがIssueの作成ごと弾く。**ラベルのために起票が落ちるのは
 * 本末転倒**なので、リポジトリのラベル一覧と突き合わせて、あるものだけを付ける
 * （既存の`gh label list | grep -qx`ガードと同じ考え方。#975）。
 * 一覧を取れなければラベル無しで起票する。
 */
async function pickExistingLabels(
  owner: string,
  repo: string,
  token: string,
): Promise<string[]> {
  try {
    const names = await fetchRepositoryLabelNames(owner, repo, token);
    return WANTED_LABELS.filter((label) => names.has(label));
  } catch {
    return [];
  }
}
