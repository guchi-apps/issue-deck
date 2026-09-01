import { db } from "@/lib/db";
import {
  buildDeployLaunchDispatchComment,
  buildDeployLaunchFailedComment,
  decideDeployLaunch,
  deployLaunchGiveUpMinutes,
  deployLaunchGraceSeconds,
  DEPLOY_LAUNCH_RETENTION_DAYS,
  type DeployLaunchWatchInput,
} from "@/lib/deploy-launch";
import { getInstallationToken } from "@/lib/github/app-auth";
import { deployWorkflowExists } from "@/lib/github/deploy-workflow-cache";
import { GithubApiError } from "@/lib/github/github-api-error";
import { createComment } from "@/lib/github/issues-api";
import {
  dispatchDeployWorkflow,
  fetchCommitTreeSha,
  fetchRecentDeployWorkflowRuns,
} from "@/lib/github/release-api";
import { buildPullRequestId } from "@/lib/github-reference";
import {
  isPushConfigured,
  sendPushNotification,
  type PushNotificationPayload,
} from "@/lib/notifications/push";

/**
 * mainへマージしたのに本番デプロイ（`deploy.yml`）が起動していないものを見つけ、
 * `main`から起動し直す巡回（#2703）。
 *
 * 何のためにissue-deck側で見張るのかは[`deploy-launch.ts`](../deploy-launch.ts)の
 * ヘッダーコメントを参照。ここはそのIO側で、起動し直すかどうかの判定は
 * `decideDeployLaunch`に閉じている。
 *
 * ## 他の巡回と違って「間隔」を持たない
 *
 * コンフリクト（5分）・デプロイ失敗（5分）・マージ待ち通知（10分）は、いつ見ても同じ答えが
 * 出る状態を探す巡回なので間隔で間引ける。**こちらは猶予（既定90秒）が過ぎたら即座に
 * 起動し直したい**——遅れがそのまま本番が古いままの時間になる（myroom#315では20分）。
 * pollerの1巡（30秒）ごとにそのまま走らせ、代わりに**見張っている行が1つも無ければ
 * GitHubを1回も叩かない**ようにしてある。平常時はDBの`count`が1回増えるだけ。
 *
 * ## GitHub APIの消費
 *
 * 見張り1件につき、巡回1回あたりREST 1回（`deploy.yml`の直近の実行10件）。見張りは
 * マージ後の猶予（90秒）＝pollerの3巡ほどで畳まれるので、mainへのマージ1回につき
 * 3〜4回で終わる。起動し直すときだけ、そのマージのtree取得・dispatch・コメント投稿が増える。
 */

/** 巡回が行った操作1件ぶん */
export type DeployLaunchSweepAction = {
  repositoryFullName: string;
  pullRequestNumber: number;
  /**
   * `covered`（実行を確認して畳んだ） / `dispatched`（起動し直した） /
   * `unsupported`（`deploy.yml`が無い・手動起動に未対応） / `failed`（起動に失敗した・諦めた）
   */
  kind: "covered" | "dispatched" | "unsupported" | "failed";
  runUrl?: string | null;
};

export type DeployLaunchSweepResult = {
  /** 実際に巡回したか。無効化されている場合は`false` */
  swept: boolean;
  /** `DEPLOY_LAUNCH_GRACE_SECONDS=0`で止めているか */
  disabled: boolean;
  /** 見張っていた（`pending`の）マージの件数 */
  watching: number;
  /** 行った操作 */
  actions: DeployLaunchSweepAction[];
  /** 状況を取得できなかったリポジトリ */
  failedRepositories: string[];
};

function emptyResult(overrides: Partial<DeployLaunchSweepResult> = {}): DeployLaunchSweepResult {
  return {
    swept: false,
    disabled: false,
    watching: 0,
    actions: [],
    failedRepositories: [],
    ...overrides,
  };
}

/**
 * 起動し直したことをPush通知する中身。
 *
 * **鳴らすのは起動し直したときと諦めたときだけ**で、正常に起動していれば黙って畳む。
 * 「勝手にデプロイが走った」と見えると調べ直す手間になるため、1行目でリポジトリ、
 * 2行目でどのPRなのかが分かるようにする（マージ待ち通知#2376と同じ形）。
 */
export function buildDeployLaunchPushPayload(params: {
  repositoryFullName: string;
  pullRequestNumber: number;
  pullRequestTitle: string;
  kind: "dispatched" | "failed";
}): PushNotificationPayload {
  const repositoryName = params.repositoryFullName.split("/")[1] ?? params.repositoryFullName;
  const pullRequestId = buildPullRequestId(params.repositoryFullName, params.pullRequestNumber);
  const state = params.kind === "dispatched" ? "デプロイを起動し直しました" : "デプロイを起動できません";
  return {
    title: `${repositoryName} ・ ${state}`,
    body: `#${params.pullRequestNumber} ${params.pullRequestTitle}`,
    url: `/dashboard?pane=pull-requests&pr=${encodeURIComponent(pullRequestId)}&mscreen=pull-requests`,
    tag: `deploy-launch:${pullRequestId}`,
  };
}

export async function runDeployLaunchSweep(
  options: { now?: Date } = {},
): Promise<DeployLaunchSweepResult> {
  const now = options.now ?? new Date();
  const graceSeconds = deployLaunchGraceSeconds();
  if (graceSeconds === 0) return emptyResult({ disabled: true });

  await forgetSettledWatches(now);

  const watches = await db.deployLaunchWatch.findMany({
    where: { state: "pending" },
    orderBy: { mergedAt: "asc" },
  });
  if (watches.length === 0) return emptyResult({ swept: true });

  const result = emptyResult({ swept: true, watching: watches.length });

  // 同一installationのリポジトリ間でトークン取得を使い回す（他の巡回と同じ）。
  const tokenPromises = new Map<number, Promise<string>>();
  function tokenFor(installationId: number): Promise<string> {
    let token = tokenPromises.get(installationId);
    if (!token) {
      token = getInstallationToken(installationId);
      tokenPromises.set(installationId, token);
    }
    return token;
  }

  for (const watch of watches) {
    try {
      const repository = await db.repository.findFirst({
        where: { fullName: watch.repositoryFullName },
        select: {
          id: true,
          ownerLogin: true,
          name: true,
          installationId: true,
          installation: { select: { installationId: true } },
        },
      });
      // 連携が外れたリポジトリの見張りは畳む（トークンが取れず、永久に決着しないため）。
      if (!repository) {
        await settle(watch.id, "unsupported", now, null);
        result.actions.push({
          repositoryFullName: watch.repositoryFullName,
          pullRequestNumber: watch.pullRequestNumber,
          kind: "unsupported",
        });
        continue;
      }

      const token = await tokenFor(repository.installation.installationId);
      const action = await handleWatch({
        watch,
        repository,
        token,
        now,
        graceSeconds,
      });
      if (action) result.actions.push(action);
    } catch (error) {
      // 1件の失敗で巡回を止めない。次の巡回で同じ判定に戻るので拾い直せる。
      console.error(
        `[deploy-launch-sweep] ${watch.repositoryFullName}#${watch.pullRequestNumber}:`,
        error,
      );
      result.failedRepositories.push(watch.repositoryFullName);
    }
  }

  return result;
}

type WatchRow = {
  id: string;
  repositoryFullName: string;
  pullRequestNumber: number;
  pullRequestTitle: string;
  mergeCommitSha: string;
  mergedAt: Date;
  attempts: number;
};

type RepositoryRow = {
  id: string;
  ownerLogin: string;
  name: string;
  installationId: string;
  installation: { installationId: number };
};

async function handleWatch({
  watch,
  repository,
  token,
  now,
  graceSeconds,
}: {
  watch: WatchRow;
  repository: RepositoryRow;
  token: string;
  now: Date;
  graceSeconds: number;
}): Promise<DeployLaunchSweepAction | null> {
  const { ownerLogin: owner, name: repo } = repository;

  // `deploy.yml`を持たないリポジトリは見張っても意味が無い（本番デプロイの仕組み自体が無い）。
  // プロセス内に10分キャッシュされ、ブランチ状況・デプロイ失敗巡回と共有される（#2020）。
  if (!(await deployWorkflowExists(owner, repo, token))) {
    await settle(watch.id, "unsupported", now, null);
    return {
      repositoryFullName: watch.repositoryFullName,
      pullRequestNumber: watch.pullRequestNumber,
      kind: "unsupported",
    };
  }

  const runs = await fetchRecentDeployWorkflowRuns(owner, repo, token);
  const input: DeployLaunchWatchInput = {
    repositoryFullName: watch.repositoryFullName,
    pullRequestNumber: watch.pullRequestNumber,
    pullRequestTitle: watch.pullRequestTitle,
    mergeCommitSha: watch.mergeCommitSha,
    mergedAt: watch.mergedAt,
    attempts: watch.attempts,
  };
  const giveUpMinutes = deployLaunchGiveUpMinutes();
  const first = decideDeployLaunch({ watch: input, runs, now, graceSeconds, giveUpMinutes });

  if (first.kind === "covered") {
    await settle(watch.id, "covered", now, first.runUrl);
    return {
      repositoryFullName: watch.repositoryFullName,
      pullRequestNumber: watch.pullRequestNumber,
      kind: "covered",
      runUrl: first.runUrl,
    };
  }

  if (first.kind === "wait") {
    await db.deployLaunchWatch.update({ where: { id: watch.id }, data: { checkedAt: now } });
    return null;
  }

  if (first.kind === "give_up") {
    await settle(watch.id, "failed", now, null);
    await notifyFailure({
      watch,
      repository,
      token,
      reason: first.reason === "attempts" ? "起動を試みた回数の上限に達しました" : "猶予の時間内に起動できませんでした",
    });
    return {
      repositoryFullName: watch.repositoryFullName,
      pullRequestNumber: watch.pullRequestNumber,
      kind: "failed",
    };
  }

  // **起動し直す直前にだけ**treeで照合し直す。別のrefから起動された手動デプロイが
  // 同じ中身を出している場合、head_shaは一致しないがtreeは一致する。
  const mergeTreeSha = await fetchCommitTreeSha(owner, repo, watch.mergeCommitSha, token);
  const second = decideDeployLaunch({
    watch: input,
    runs,
    now,
    graceSeconds,
    giveUpMinutes,
    mergeTreeSha,
  });
  if (second.kind === "covered") {
    await settle(watch.id, "covered", now, second.runUrl);
    return {
      repositoryFullName: watch.repositoryFullName,
      pullRequestNumber: watch.pullRequestNumber,
      kind: "covered",
      runUrl: second.runUrl,
    };
  }

  // **試行を先に数えてから起動する。** dispatchが成功したのにこの後で落ちた場合でも、
  // 次の巡回が同じマージで無限に起動し直すことはない。
  await db.deployLaunchWatch.update({
    where: { id: watch.id },
    data: { attempts: { increment: 1 }, checkedAt: now },
  });

  try {
    await dispatchDeployWorkflow(owner, repo, token);
  } catch (error) {
    // `deploy.yml`はあるが`workflow_dispatch`を書いていないリポジトリは422で落ちる
    // （`guchi-apps/portfolio`）。**押し直しても直らない**ので、そこで見張りを畳む。
    const unsupported = error instanceof GithubApiError && error.status === 422;
    await settle(watch.id, unsupported ? "unsupported" : "failed", now, null);
    if (!unsupported) {
      await notifyFailure({
        watch,
        repository,
        token,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    return {
      repositoryFullName: watch.repositoryFullName,
      pullRequestNumber: watch.pullRequestNumber,
      kind: unsupported ? "unsupported" : "failed",
    };
  }

  await settle(watch.id, "dispatched", now, null);
  // **記録を残すのは畳んだ後**。コメント投稿やPush通知が落ちても、起動し直した事実は残る。
  await safely(() =>
    createComment(owner, repo, watch.pullRequestNumber, token, {
      body: buildDeployLaunchDispatchComment({
        mergeCommitSha: watch.mergeCommitSha,
        graceSeconds,
      }),
    }),
  );
  await safely(() =>
    sendPush(repository, {
      repositoryFullName: watch.repositoryFullName,
      pullRequestNumber: watch.pullRequestNumber,
      pullRequestTitle: watch.pullRequestTitle,
      kind: "dispatched",
    }),
  );

  return {
    repositoryFullName: watch.repositoryFullName,
    pullRequestNumber: watch.pullRequestNumber,
    kind: "dispatched",
  };
}

/** 起動し直せなかったことをPRとPush通知へ残す。**ここから先は人が押しに行くしかない** */
async function notifyFailure({
  watch,
  repository,
  token,
  reason,
}: {
  watch: WatchRow;
  repository: RepositoryRow;
  token: string;
  reason: string;
}): Promise<void> {
  await safely(() =>
    createComment(repository.ownerLogin, repository.name, watch.pullRequestNumber, token, {
      body: buildDeployLaunchFailedComment({
        mergeCommitSha: watch.mergeCommitSha,
        repositoryFullName: watch.repositoryFullName,
        reason,
      }),
    }),
  );
  await safely(() =>
    sendPush(repository, {
      repositoryFullName: watch.repositoryFullName,
      pullRequestNumber: watch.pullRequestNumber,
      pullRequestTitle: watch.pullRequestTitle,
      kind: "failed",
    }),
  );
}

/** そのリポジトリを見ているユーザーだけへ送る（マージ待ち通知#2376・#2279と同じ絞り込み） */
async function sendPush(
  repository: RepositoryRow,
  params: Parameters<typeof buildDeployLaunchPushPayload>[0],
): Promise<void> {
  if (!isPushConfigured()) return;
  const targets = await db.pushSubscription.findMany({
    where: {
      user: {
        userInstallations: { some: { installationId: repository.installationId } },
        hiddenRepositories: { none: { repositoryId: repository.id } },
      },
    },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });
  if (targets.length === 0) return;
  await sendPushNotification(targets, buildDeployLaunchPushPayload(params));
}

async function settle(
  id: string,
  state: DeployLaunchSweepAction["kind"],
  now: Date,
  runUrl: string | null,
): Promise<void> {
  await db.deployLaunchWatch.update({
    where: { id },
    data: { state, resolvedAt: now, checkedAt: now, runUrl },
  });
}

/** 決着した行を保持期間ぶんだけ残して捨てる。**巡回のたびに1クエリで済ませる** */
async function forgetSettledWatches(now: Date): Promise<void> {
  const threshold = new Date(now.getTime() - DEPLOY_LAUNCH_RETENTION_DAYS * 24 * 60 * 60_000);
  await db.deployLaunchWatch.deleteMany({
    where: { state: { not: "pending" }, resolvedAt: { lt: threshold } },
  });
}

/**
 * 記録・通知の失敗で巡回を落とさない。
 *
 * **起動し直したこと自体はDBに残っている**ので、ここで落ちても次の巡回が同じマージを
 * もう一度起動することはない。落ちるとしたらコメント投稿の権限やPush送信で、
 * どちらも「知らせ方」の問題であってデプロイの成否ではない。
 */
async function safely(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    console.error("[deploy-launch-sweep] 記録・通知に失敗しました:", error);
  }
}
