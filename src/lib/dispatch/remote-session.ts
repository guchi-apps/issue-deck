import type { DispatchHost, DispatchJob, RemoteSession } from "@prisma/client";

import { db } from "@/lib/db";
import {
  isDispatchHostOnline,
  parseDispatchHostRepositories,
} from "@/lib/dispatch/dispatch-job";
import {
  ACTIVE_REMOTE_SESSION_STATUSES,
  REMOTE_SESSION_ISSUE_NUMBER,
  REMOTE_SESSION_MAX_PER_HOST,
  buildRemoteSessionName,
  describeRemoteSessionRejection,
  parseRemoteSessionStatus,
  pickRemoteSessionHost,
  resolveRemoteSessionRejection,
  type RemoteSessionHostInfo,
  type RemoteSessionRejection,
  type RemoteSessionState,
  type RemoteSessionView,
  type ReportedRemoteSession,
} from "@/lib/dispatch/remote-session-rules";
import { notifyDispatchHostWake } from "@/lib/dispatch/wake-notify";

/**
 * リモートセッション（#4743）のDB側。判定は`remote-session-rules.ts`に寄せ、ここは
 * 積む・反映する・一覧を組み立てるだけを持つ。
 */

/** 終わったセッションを一覧に残す期間。起動に失敗した理由を押した人が読めるようにする */
const ENDED_RETENTION_MS = 30 * 60 * 1000;

/**
 * 起動ジョブが終わったのにセッションの報告が無いまま`running`扱いを続けない猶予。
 * pollerのホスト申告は60秒ごとなので、それより十分長くとる。
 */
const MISSING_GRACE_MS = 3 * 60 * 1000;

const ACTIVE_STATUSES = [...ACTIVE_REMOTE_SESSION_STATUSES];

function toView(session: RemoteSession, stopping: boolean): RemoteSessionView {
  return {
    id: session.id,
    repositoryFullName: session.repositoryFullName,
    host: session.host,
    tmuxSessionName: session.tmuxSessionName,
    status: parseRemoteSessionStatus(session.status),
    remoteControlUrl: session.remoteControlUrl,
    failureMessage: session.failureMessage,
    stopping,
    createdAt: session.createdAt.toISOString(),
    lastSeenAt: session.lastSeenAt?.toISOString() ?? null,
  };
}

function toHostInfo(host: DispatchHost, activeCount: number, now: Date): RemoteSessionHostInfo {
  return {
    name: host.name,
    online: isDispatchHostOnline(host.lastSeenAt, now),
    remoteSessionCapable: host.remoteSessionCapable === true,
    repositories: parseDispatchHostRepositories(host.repositories),
    activeCount,
  };
}

async function loadHostInfos(now: Date): Promise<RemoteSessionHostInfo[]> {
  const [hosts, counts] = await Promise.all([
    db.dispatchHost.findMany({ orderBy: { name: "asc" } }),
    db.remoteSession.groupBy({
      by: ["host"],
      where: { status: { in: ACTIVE_STATUSES } },
      _count: { _all: true },
    }),
  ]);
  const countByHost = new Map(counts.map((row) => [row.host, row._count._all]));
  return hosts.map((host) => toHostInfo(host, countByHost.get(host.name) ?? 0, now));
}

/**
 * 起動ジョブが`FAILED`・`TIMEOUT`などで終わったのに`starting`のまま残ったセッションを畳む。
 * 報告（`applyRemoteSessionJobReport`）が届かなかった場合（5分で`TIMEOUT`になったなど）の受け皿で、
 * 一覧を読むついでに進める（常駐プロセスは置かない。`expireStaleDispatchJobs`と同じ方針）。
 */
async function settleStartingSessions(now: Date): Promise<void> {
  const starting = await db.remoteSession.findMany({
    where: { status: "starting", launchJobId: { not: null } },
    select: { id: true, launchJobId: true },
  });
  if (starting.length === 0) return;
  const jobs = await db.dispatchJob.findMany({
    where: { id: { in: starting.map((row) => row.launchJobId as string) } },
    select: { id: true, status: true, message: true },
  });
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  for (const session of starting) {
    const job = jobById.get(session.launchJobId as string);
    if (!job) continue;
    if (job.status === "QUEUED" || job.status === "CLAIMED" || job.status === "RUNNING") continue;
    if (job.status === "SUCCEEDED") {
      await db.remoteSession.updateMany({
        where: { id: session.id, status: "starting" },
        data: { status: "running", lastSeenAt: now },
      });
      continue;
    }
    await db.remoteSession.updateMany({
      where: { id: session.id, status: "starting" },
      data: {
        status: "failed",
        failureMessage:
          job.message ?? (job.status === "TIMEOUT" ? "サブPCが応答しませんでした。" : "起動できませんでした。"),
        endedAt: now,
      },
    });
  }
}

/** 画面が読む状態一式（セッション・ホスト・上限） */
export async function listRemoteSessions(now: Date = new Date()): Promise<RemoteSessionState> {
  await settleStartingSessions(now);
  const [sessions, hosts, stoppingJobs] = await Promise.all([
    db.remoteSession.findMany({
      where: {
        OR: [
          { status: { in: ACTIVE_STATUSES } },
          { updatedAt: { gte: new Date(now.getTime() - ENDED_RETENTION_MS) } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    loadHostInfos(now),
    db.dispatchJob.findMany({
      where: { kind: "REMOTE_SESSION_KILL", status: { in: ["QUEUED", "CLAIMED", "RUNNING"] } },
      select: { tmuxSessionName: true },
    }),
  ]);
  const stopping = new Set(stoppingJobs.map((job) => job.tmuxSessionName));
  return {
    sessions: sessions.map((session) => toView(session, stopping.has(session.tmuxSessionName))),
    hosts,
    maxPerHost: REMOTE_SESSION_MAX_PER_HOST,
  };
}

export type EnqueueRemoteSessionResult =
  | { ok: true; session: RemoteSessionView }
  | { ok: false; rejection: RemoteSessionRejection; message: string };

/**
 * リモートセッションを起動する。`RemoteSession`の行と起動ジョブ（`REMOTE_SESSION`）を1つの
 * トランザクションで作り、tmux名はジョブの`tmuxSessionName`に載せてpollerへ渡す。
 */
export async function enqueueRemoteSession(params: {
  repositoryFullName: string;
  requestedByUserId: string | null;
  now?: Date;
}): Promise<EnqueueRemoteSessionResult> {
  const now = params.now ?? new Date();
  await settleStartingSessions(now);
  const hosts = await loadHostInfos(now);
  const host = pickRemoteSessionHost(hosts, params.repositoryFullName);
  const rejection = resolveRemoteSessionRejection(host, params.repositoryFullName);
  if (rejection || !host) {
    const reason = rejection ?? "no_host";
    return { ok: false, rejection: reason, message: describeRemoteSessionRejection(reason) };
  }

  const tmuxSessionName = buildRemoteSessionName(params.repositoryFullName);
  const session = await db.$transaction(async (tx) => {
    const job = await tx.dispatchJob.create({
      data: {
        repositoryFullName: params.repositoryFullName,
        issueNumber: REMOTE_SESSION_ISSUE_NUMBER,
        targetHost: host.name,
        kind: "REMOTE_SESSION",
        status: "QUEUED",
        activeKey: `remote_session:${tmuxSessionName}`,
        tmuxSessionName,
        requestedByUserId: params.requestedByUserId,
      },
    });
    return tx.remoteSession.create({
      data: {
        repositoryFullName: params.repositoryFullName,
        host: host.name,
        tmuxSessionName,
        status: "starting",
        launchJobId: job.id,
        requestedByUserId: params.requestedByUserId,
      },
    });
  });
  notifyDispatchHostWake(host.name);
  return { ok: true, session: toView(session, false) };
}

export type EnqueueRemoteSessionKillResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "already_ended" | "host_offline" | "already_queued"; message: string };

/** リモートセッションを終了する（`REMOTE_SESSION_KILL`を積む）。worktreeの片付けはpoller側 */
export async function enqueueRemoteSessionKill(params: {
  id: string;
  requestedByUserId: string | null;
  now?: Date;
}): Promise<EnqueueRemoteSessionKillResult> {
  const now = params.now ?? new Date();
  const session = await db.remoteSession.findUnique({ where: { id: params.id } });
  if (!session) return { ok: false, reason: "not_found", message: "セッションが見つかりません。" };
  if (session.status === "ended" || session.status === "failed") {
    return { ok: false, reason: "already_ended", message: "このセッションは既に終了しています。" };
  }
  const host = await db.dispatchHost.findUnique({ where: { name: session.host } });
  if (!host || !isDispatchHostOnline(host.lastSeenAt, now) || host.remoteSessionCapable !== true) {
    return { ok: false, reason: "host_offline", message: "サブPCがオフラインのため終了できません。" };
  }
  try {
    await db.dispatchJob.create({
      data: {
        repositoryFullName: session.repositoryFullName,
        issueNumber: REMOTE_SESSION_ISSUE_NUMBER,
        targetHost: session.host,
        kind: "REMOTE_SESSION_KILL",
        status: "QUEUED",
        activeKey: `remote_session_kill:${session.tmuxSessionName}`,
        tmuxSessionName: session.tmuxSessionName,
        requestedByUserId: params.requestedByUserId,
      },
    });
  } catch {
    return { ok: false, reason: "already_queued", message: "終了の処理を待っています。" };
  }
  notifyDispatchHostWake(session.host);
  return { ok: true };
}

/**
 * pollerからのジョブ報告を`RemoteSession`へ写す（`POST /api/dispatch/report`から呼ぶ）。
 * リモートセッション以外の種別では何もしない。
 */
export async function applyRemoteSessionJobReport(params: {
  job: Pick<DispatchJob, "id" | "kind" | "tmuxSessionName">;
  status: string;
  message: string | null;
  remoteControlUrl: string | null;
  now?: Date;
}): Promise<void> {
  const now = params.now ?? new Date();
  const { job, status } = params;
  if (job.kind === "REMOTE_SESSION") {
    if (status === "succeeded") {
      await db.remoteSession.updateMany({
        where: { launchJobId: job.id, status: { in: ACTIVE_STATUSES } },
        data: {
          status: "running",
          lastSeenAt: now,
          ...(params.remoteControlUrl ? { remoteControlUrl: params.remoteControlUrl } : {}),
        },
      });
    } else if (status !== "running") {
      await db.remoteSession.updateMany({
        where: { launchJobId: job.id, status: "starting" },
        data: { status: "failed", failureMessage: params.message ?? "起動できませんでした。", endedAt: now },
      });
    }
    return;
  }
  if (job.kind === "REMOTE_SESSION_KILL" && status === "succeeded" && job.tmuxSessionName) {
    await db.remoteSession.updateMany({
      where: { tmuxSessionName: job.tmuxSessionName, status: { in: ACTIVE_STATUSES } },
      data: { status: "ended", endedAt: now },
    });
  }
}

/**
 * ホスト申告の`remoteSessions`で生存を突き合わせる。
 *
 * - 申告にあるもの … `running`にし、URLが届いていれば更新する（起動時に90秒で取れなかったURLも
 *   ここで拾う）
 * - 申告に無い`running` … 最後に見えてから猶予を過ぎたら`ended`（tmuxで直接閉じた・ホストの再起動）
 * - `starting` … 起動ジョブの結果を待つので触らない
 *
 * **`reported`が`null`（未申告の古いpoller）のときは何もしない。**
 */
export async function syncRemoteSessionsFromHost(params: {
  hostName: string;
  reported: ReportedRemoteSession[] | null;
  now?: Date;
}): Promise<void> {
  if (params.reported === null) return;
  const now = params.now ?? new Date();
  const reported = new Map(params.reported.map((session) => [session.tmuxSessionName, session]));
  const active = await db.remoteSession.findMany({
    where: { host: params.hostName, status: { in: ACTIVE_STATUSES } },
  });
  for (const session of active) {
    const seen = reported.get(session.tmuxSessionName);
    if (seen) {
      await db.remoteSession.update({
        where: { id: session.id },
        data: {
          status: "running",
          lastSeenAt: now,
          ...(seen.remoteControlUrl && seen.remoteControlUrl !== session.remoteControlUrl
            ? { remoteControlUrl: seen.remoteControlUrl }
            : {}),
        },
      });
      continue;
    }
    if (session.status !== "running") continue;
    const lastSeen = (session.lastSeenAt ?? session.updatedAt).getTime();
    if (now.getTime() - lastSeen < MISSING_GRACE_MS) continue;
    await db.remoteSession.update({
      where: { id: session.id },
      data: { status: "ended", endedAt: now },
    });
  }
}
