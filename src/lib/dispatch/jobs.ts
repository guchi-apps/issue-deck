import type { DispatchHost, DispatchJob } from "@prisma/client";

import { DISPATCH_CONCURRENCY_DEFAULT } from "@/lib/app-settings";
import { db } from "@/lib/db";
import { listDispatchSessions } from "@/lib/dispatch/sessions";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import {
  ACTIVE_DISPATCH_JOB_STATUSES,
  buildDispatchActiveKey,
  describeDispatchEnqueueRejection,
  describeDispatchTimeout,
  DISPATCH_CLAIM_TIMEOUT_MS,
  DISPATCH_HEARTBEAT_TIMEOUT_MS,
  isDispatchHostOnline,
  normalizeDispatchHostRepositories,
  parseDispatchHostRepositories,
  resolveDispatchConcurrency,
  type DispatchEnqueueRejection,
  type DispatchHostView,
  type DispatchJobView,
  type DispatchReportStatus,
} from "@/lib/dispatch/dispatch-job";

/**
 * ディスパッチのジョブキュー（#1179）のDB操作。
 *
 * 方式はpull型で、issue-deckはジョブを置くだけ。サブPCのpollerが
 * `POST /api/dispatch/claim`で取りに来る（VPSがtailnetに未参加で、Tailscale SSHに
 * forced commandが無いため。#1176）。
 *
 * **定期実行の仕組みを持たない。** タイムアウトはenqueue・claim・一覧取得のたびに
 * `expireStaleDispatchJobs`が掃く遅延評価にしている。VPS上にcronやワーカーを増やすと、
 * それ自体の死活監視が要るようになる。ポーリングが60秒間隔で来るぶん、掃く機会は十分にある。
 */

// 画面へ返す形（`DispatchJobView`・`DispatchHostView`）の定義は`dispatch-job.ts`にある。
// このモジュールはPrismaクライアントを読み込むため、クライアントコンポーネント（#1180）から
// importできない。型だけを再輸出して、サーバー側の呼び出し元が経路を意識せずに使えるようにする。
export type { DispatchHostView, DispatchJobView };

function toJobView(job: DispatchJob): DispatchJobView {
  return {
    id: job.id,
    repositoryFullName: job.repositoryFullName,
    issueNumber: job.issueNumber,
    targetHost: job.targetHost,
    status: job.status,
    message: job.message,
    tmuxSessionName: job.tmuxSessionName,
    createdAt: job.createdAt.toISOString(),
    claimedAt: job.claimedAt?.toISOString() ?? null,
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

function toHostView(host: DispatchHost, now: Date): DispatchHostView {
  return {
    name: host.name,
    repositories: parseDispatchHostRepositories(host.repositories),
    contractVersion: host.contractVersion,
    online: isDispatchHostOnline(host.lastSeenAt, now),
    lastSeenAt: host.lastSeenAt.toISOString(),
  };
}

async function getDispatchConcurrency(): Promise<number> {
  const setting = await db.appSetting.findUnique({ where: { id: 1 } });
  return setting?.dispatchConcurrency ?? DISPATCH_CONCURRENCY_DEFAULT;
}

/**
 * 期限切れのジョブをTIMEOUTへ落とす。**呼ばれたときにだけ動く**（上のコメント参照）。
 *
 * `activeKey`をnullへ戻すのが要点で、これをしないと同じIssueに次のジョブを積めなくなる。
 * サブPCが落ちたまま復帰しない場合に、ジョブが滞留して以降の起動を封じるのを防ぐ。
 */
export async function expireStaleDispatchJobs(now: Date = new Date()): Promise<number> {
  const claimDeadline = new Date(now.getTime() - DISPATCH_CLAIM_TIMEOUT_MS);
  const heartbeatDeadline = new Date(now.getTime() - DISPATCH_HEARTBEAT_TIMEOUT_MS);

  const stale = await db.dispatchJob.findMany({
    where: {
      OR: [
        { status: "CLAIMED", claimedAt: { lt: claimDeadline } },
        { status: "RUNNING", heartbeatAt: { lt: heartbeatDeadline } },
        // heartbeatが一度も届かないままRUNNINGになっている場合はstartedAtで測る
        { status: "RUNNING", heartbeatAt: null, startedAt: { lt: heartbeatDeadline } },
      ],
    },
    select: { id: true, status: true },
  });

  let expired = 0;
  for (const job of stale) {
    if (job.status !== "CLAIMED" && job.status !== "RUNNING") continue;
    // 掃いている間にpollerが報告してくる可能性があるため、状態を条件に含めて更新する。
    // 0件で落ちるのは「先に報告が届いた」ということなので、そのまま無視してよい。
    const result = await db.dispatchJob.updateMany({
      where: { id: job.id, status: job.status },
      data: {
        status: "TIMEOUT",
        activeKey: null,
        finishedAt: now,
        message: describeDispatchTimeout(job.status),
      },
    });
    expired += result.count;
  }
  return expired;
}

export type EnqueueDispatchJobResult =
  | { ok: true; job: DispatchJobView }
  | { ok: false; rejection: DispatchEnqueueRejection; message: string };

/**
 * ジョブを積む（画面から呼ぶ）。
 *
 * **実行できない組み合わせはここで弾き、理由を返す**（#1179のコメントの決定
 * 「ディスパッチ前に弾く」）。投げたのに何も起きない状態を作らないための要。
 */
export async function enqueueDispatchJob(params: {
  repositoryFullName: string;
  issueNumber: number;
  hostName: string;
  requestedByUserId: string | null;
  now?: Date;
}): Promise<EnqueueDispatchJobResult> {
  const now = params.now ?? new Date();
  await expireStaleDispatchJobs(now);

  const host = await db.dispatchHost.findUnique({ where: { name: params.hostName } });
  const reject = (rejection: DispatchEnqueueRejection): EnqueueDispatchJobResult => ({
    ok: false,
    rejection,
    message: describeDispatchEnqueueRejection(rejection, {
      hostName: params.hostName,
      repositoryFullName: params.repositoryFullName,
    }),
  });

  if (!host) return reject("host_unknown");
  if (!isDispatchHostOnline(host.lastSeenAt, now)) return reject("host_offline");
  if (!parseDispatchHostRepositories(host.repositories).includes(params.repositoryFullName)) {
    return reject("repository_not_runnable");
  }

  try {
    const job = await db.dispatchJob.create({
      data: {
        repositoryFullName: params.repositoryFullName,
        issueNumber: params.issueNumber,
        targetHost: params.hostName,
        status: "QUEUED",
        activeKey: buildDispatchActiveKey(params.repositoryFullName, params.issueNumber),
        requestedByUserId: params.requestedByUserId,
      },
    });
    return { ok: true, job: toJobView(job) };
  } catch {
    // activeKeyのunique制約違反＝同じIssueの未完了ジョブが既にある。二重クリックの競合を
    // 含めてここで確実に止まる（アプリ側の存在チェックだけでは競合をすり抜ける）
    return reject("already_queued");
  }
}

/**
 * サブPCがジョブを取る。
 *
 * **`updateMany`の更新件数で確定させる楽観的な取り方**にしている。`where`に
 * `status: QUEUED`を含めるため、取り合いが起きても片方が0件で落ちるだけで、
 * トランザクションもロックも要らない。
 */
export async function claimDispatchJobs(params: {
  hostName: string;
  maxJobs: number;
  now?: Date;
}): Promise<DispatchJobView[]> {
  const now = params.now ?? new Date();
  await expireStaleDispatchJobs(now);

  const host = await db.dispatchHost.findUnique({ where: { name: params.hostName } });
  const limit = resolveDispatchConcurrency(
    await getDispatchConcurrency(),
    host?.maxConcurrency ?? null,
  );

  const running = await db.dispatchJob.count({
    where: { targetHost: params.hostName, status: { in: ["CLAIMED", "RUNNING"] } },
  });
  const available = Math.min(limit - running, params.maxJobs);
  if (available <= 0) return [];

  const candidates = await db.dispatchJob.findMany({
    where: { targetHost: params.hostName, status: "QUEUED" },
    orderBy: { createdAt: "asc" },
    take: available,
  });

  const claimed: DispatchJobView[] = [];
  for (const candidate of candidates) {
    const result = await db.dispatchJob.updateMany({
      where: { id: candidate.id, status: "QUEUED" },
      data: { status: "CLAIMED", claimedByHost: params.hostName, claimedAt: now },
    });
    if (result.count === 0) continue;
    claimed.push(
      toJobView({
        ...candidate,
        status: "CLAIMED",
        claimedByHost: params.hostName,
        claimedAt: now,
      }),
    );
  }
  return claimed;
}

export type ReportDispatchJobResult =
  | { ok: true; job: DispatchJobView }
  | { ok: false; reason: "not_found" | "wrong_host" | "already_finished" };

/**
 * pollerからの状態報告を受ける。
 *
 * **`succeeded`が意味するのは「tmuxセッションが立ち上がった」まで**で、実装の完了ではない
 * （以降の進捗はProject Statusが持つ唯一の正）。ここで実装完了まで追おうとすると、
 * セッションの終了検知という別の仕組みが要るうえ、Project Statusと情報が重複する。
 */
export async function reportDispatchJob(params: {
  jobId: string;
  hostName: string;
  status: DispatchReportStatus;
  message?: string | null;
  tmuxSessionName?: string | null;
  now?: Date;
}): Promise<ReportDispatchJobResult> {
  const now = params.now ?? new Date();
  const job = await db.dispatchJob.findUnique({ where: { id: params.jobId } });
  if (!job) return { ok: false, reason: "not_found" };
  // claimしたホスト以外からの報告は受け付けない。ジョブIDを知っていても、別ホストが
  // 他人のジョブの状態を書き換えられないようにする
  if (job.claimedByHost !== params.hostName) return { ok: false, reason: "wrong_host" };

  const data: Parameters<typeof db.dispatchJob.update>[0]["data"] = {
    message: params.message ?? job.message,
    tmuxSessionName: params.tmuxSessionName ?? job.tmuxSessionName,
  };

  if (params.status === "running") {
    data.status = "RUNNING";
    data.startedAt = job.startedAt ?? now;
    data.heartbeatAt = now;
  } else {
    data.status = params.status === "succeeded" ? "SUCCEEDED" : "FAILED";
    data.finishedAt = now;
    // 終了したら次のジョブを積めるようにする
    data.activeKey = null;
  }

  // タイムアウトで既に終了扱いになったジョブへ遅れて報告が届くことがある。**上書きしない。**
  // 上書きすると、終了済みのジョブのactiveKeyが復活して次を積めなくなる場合がある
  const result = await db.dispatchJob.updateMany({
    where: { id: job.id, status: { in: ["CLAIMED", "RUNNING"] } },
    data,
  });
  if (result.count === 0) return { ok: false, reason: "already_finished" };

  const updated = await db.dispatchJob.findUnique({ where: { id: job.id } });
  return updated ? { ok: true, job: toJobView(updated) } : { ok: false, reason: "not_found" };
}

export type CancelDispatchJobResult =
  | { ok: true; job: DispatchJobView }
  | { ok: false; reason: "not_found" | "not_cancelable"; message?: string };

/**
 * 画面からジョブを取り消す。
 *
 * **取り消せるのは`queued`と`claimed`まで。** `running`はworktreeの作成や依存インストールの
 * 最中で、途中で止めると中途半端なworktreeとブランチが残る（後始末は
 * `scripts/cleanup-worktrees.sh`の仕事になる）。止めたい場合はサブPC側でtmuxセッションを
 * 落とす必要があるため、その旨を理由として返す。
 */
export async function cancelDispatchJob(params: {
  jobId: string;
  now?: Date;
}): Promise<CancelDispatchJobResult> {
  const now = params.now ?? new Date();
  const job = await db.dispatchJob.findUnique({ where: { id: params.jobId } });
  if (!job) return { ok: false, reason: "not_found" };

  if (job.status === "RUNNING") {
    return {
      ok: false,
      reason: "not_cancelable",
      message:
        "起動処理中のジョブは取り消せません。止める場合は起動先で tmux セッションを終了してください。",
    };
  }
  if (job.status !== "QUEUED" && job.status !== "CLAIMED") {
    return { ok: false, reason: "not_cancelable", message: "このジョブは既に終了しています。" };
  }

  const result = await db.dispatchJob.updateMany({
    where: { id: job.id, status: job.status },
    data: {
      status: "CANCELED",
      activeKey: null,
      finishedAt: now,
      message: "画面から取り消されました。",
    },
  });
  if (result.count === 0) {
    return { ok: false, reason: "not_cancelable", message: "このジョブは既に終了しています。" };
  }

  const updated = await db.dispatchJob.findUnique({ where: { id: job.id } });
  return updated ? { ok: true, job: toJobView(updated) } : { ok: false, reason: "not_found" };
}

/** 終了したジョブを画面に残す期間。押した結果がすぐ消えると、失敗に気づけない */
const FINISHED_JOB_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * 画面が必要とするディスパッチの状態一式（#1180の起動先選択・状態表示が使う）。
 * ホストの申告と未完了ジョブ、直近に終わったジョブをまとめて返す。
 */
export async function listDispatchState(now: Date = new Date()): Promise<{
  hosts: DispatchHostView[];
  jobs: DispatchJobView[];
  sessions: DispatchSessionView[];
  concurrency: number;
}> {
  await expireStaleDispatchJobs(now);

  // セッション（#1217）を専用のエンドポイントではなくここへ足しているのは、画面側が
  // `GET /api/dispatch`と`use-dispatch-state.ts`の1本で状態を読んでいるため。取得口を
  // 増やすと、同じ画面のためにポーリングが2本走ることになる。
  const [hosts, jobs, sessions, concurrency] = await Promise.all([
    db.dispatchHost.findMany({ orderBy: { name: "asc" } }),
    db.dispatchJob.findMany({
      where: {
        OR: [
          { status: { in: [...ACTIVE_DISPATCH_JOB_STATUSES] } },
          { finishedAt: { gte: new Date(now.getTime() - FINISHED_JOB_RETENTION_MS) } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    listDispatchSessions(now),
    getDispatchConcurrency(),
  ]);

  return {
    hosts: hosts.map((host) => toHostView(host, now)),
    jobs: jobs.map(toJobView),
    sessions,
    concurrency,
  };
}

/**
 * ホストからの申告を保存する（実行可能リポジトリ＋生存報告）。
 *
 * 申告する内容はサブPC側が`~/.config/issue-deck/local-repos.conf`を走査し、
 * `scripts/start-local-session.sh`と同じ検証を通ったものだけ
 * （`scripts/lib/local-repo-resolve.sh`で共有）。issue-deck側はここで検証をやり直さず、
 * 受け取った一覧をそのまま「割り当ててよい対象」として使う。
 *
 * **`Repository.hasLocalStartScript`（GitHub上のマーカー行）とは無関係**（#1224）。マーカー行を
 * 持たないリポジトリもサブPC側の汎用ランチャーで起動できるため、そちらで絞り込むと
 * 「実際には起動できるのに割り当てられない」ことになる。実際にcloneされ起動できるかを
 * 知っているのは申告する側だけ。
 */
export async function announceDispatchHost(params: {
  hostName: string;
  repositories: unknown;
  contractVersion: number | null;
  maxConcurrency: number | null;
  agentVersion: string | null;
  now?: Date;
}): Promise<DispatchHostView> {
  const now = params.now ?? new Date();
  const repositories = JSON.stringify(normalizeDispatchHostRepositories(params.repositories));
  const values = {
    repositories,
    contractVersion: params.contractVersion,
    maxConcurrency: params.maxConcurrency,
    agentVersion: params.agentVersion,
    lastSeenAt: now,
  };

  const host = await db.dispatchHost.upsert({
    where: { name: params.hostName },
    create: { name: params.hostName, ...values },
    update: values,
  });
  return toHostView(host, now);
}
