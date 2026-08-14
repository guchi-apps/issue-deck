import type { DispatchSession } from "@prisma/client";

import { db } from "@/lib/db";
import {
  nextEscalatedState,
  resolveSessionState,
  shouldEscalateSession,
  type DispatchSessionActivity,
  type DispatchSessionReport,
  type DispatchSessionState,
  type DispatchSessionView,
} from "@/lib/dispatch/session-state";
import { escalateFailedSession } from "@/lib/dispatch/session-escalation";

/**
 * 起動後のtmuxセッションの状態（#1217）のDB操作。
 *
 * 判定そのものは`session-state.ts`（DBに触らない純粋関数）が持つ。ここは保存と、
 * 報告に含まれなくなった行を`GONE`へ倒す突き合わせを担当する。
 *
 * `jobs.ts`と同じく、このモジュールはPrismaクライアントを読み込むためクライアント
 * コンポーネントからimportできない。型は`session-state.ts`側に置いてある。
 */

export type { DispatchSessionView };

function toSessionView(session: DispatchSession): DispatchSessionView {
  return {
    host: session.host,
    tmuxSessionName: session.tmuxSessionName,
    repositoryFullName: session.repositoryFullName,
    issueNumber: session.issueNumber,
    state: session.state as DispatchSessionState,
    exitStatus: session.exitStatus,
    firstSeenAt: session.firstSeenAt.toISOString(),
    lastReportedAt: session.lastReportedAt.toISOString(),
    activity: (session.activity as DispatchSessionActivity | null) ?? null,
    activityAt: session.activityAt?.toISOString() ?? null,
    remoteControlUrl: session.remoteControlUrl,
  };
}

/**
 * セッション自身がフック（#1219）から報告してくる様子を記録する（#1264）。
 *
 * **pollerの一括報告（`reportDispatchSessions`）とは別の入口にする。** あちらは「そのホストで
 * 今見えているセッションの全て」を前提に、含まれない行を`GONE`へ倒す。フックの1件を同じ
 * 経路へ流すと、他のセッションが全部消えたことになる。
 *
 * **セッションの行が無ければ何もしない。** フックはpollerより先に飛びうるが、行を作ると
 * `host`・`tmuxSessionName`をフック側が知らないため嘘の値が入る。1巡（既定60秒）待てば
 * pollerが作るので、取りこぼしても次のフックで載る。
 */
export async function recordDispatchSessionActivity(params: {
  repositoryFullName: string;
  issueNumber: number;
  activity: DispatchSessionActivity;
  remoteControlUrl: string | null;
  now?: Date;
}): Promise<{ updated: number }> {
  const now = params.now ?? new Date();
  const result = await db.dispatchSession.updateMany({
    where: {
      repositoryFullName: params.repositoryFullName,
      issueNumber: params.issueNumber,
      // 終わったセッションの行に「入力待ち」を後から書かない
      state: "ALIVE",
    },
    data: {
      activity: params.activity,
      activityAt: now,
      // URLが取れなかった回で既存の値を消さない（Claude Codeの内部ファイル依存で欠けうる）
      ...(params.remoteControlUrl ? { remoteControlUrl: params.remoteControlUrl } : {}),
    },
  });
  return { updated: result.count };
}

/**
 * 消えたセッションの行を残しておく期間。
 *
 * すぐ消さないのは、**画面が「さっきまで動いていたセッションが終わった」ことを出せるようにする**
 * ため。無期限に残すと一覧が伸び続けるだけなので、`DispatchJob`の終了済みジョブと同じ感覚で切る。
 */
const GONE_SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * ホストからの報告を1件まとめて受ける。
 *
 * **報告は「そのホストで今見えているセッションの全て」**という前提で扱う。含まれていない行は
 * 消えたとみなして`GONE`へ倒す。そのためpoller側は、セッションが0本でも空配列を送る必要がある
 * （送らないと消失を判定できない）。
 *
 * 戻り値の`escalated`は、このリクエストで引き上げ（Issueコメント＋`00.check-user`）を行った件数。
 */
export async function reportDispatchSessions(params: {
  hostName: string;
  sessions: DispatchSessionReport[];
  now?: Date;
}): Promise<{ sessions: DispatchSessionView[]; escalated: number }> {
  const now = params.now ?? new Date();
  const existing = await db.dispatchSession.findMany({ where: { host: params.hostName } });
  const existingByName = new Map(existing.map((row) => [row.tmuxSessionName, row]));

  const reportedNames = new Set<string>();
  const escalations: { repositoryFullName: string; issueNumber: number; session: string; exitStatus: number | null }[] =
    [];

  for (const report of params.sessions) {
    reportedNames.add(report.tmuxSessionName);
    const previous = existingByName.get(report.tmuxSessionName) ?? null;
    const state = resolveSessionState(report);
    const previousEscalated = (previous?.escalatedState ?? null) as DispatchSessionState | null;
    const escalate = shouldEscalateSession(previousEscalated, state);
    const escalatedState = nextEscalatedState(previousEscalated, state, escalate);

    await db.dispatchSession.upsert({
      where: {
        host_tmuxSessionName: {
          host: params.hostName,
          tmuxSessionName: report.tmuxSessionName,
        },
      },
      create: {
        host: params.hostName,
        tmuxSessionName: report.tmuxSessionName,
        repositoryFullName: report.repositoryFullName,
        issueNumber: report.issueNumber,
        state,
        exitStatus: report.paneDeadStatus,
        firstSeenAt: now,
        lastReportedAt: now,
        escalatedState,
        escalatedAt: escalate ? now : null,
      },
      update: {
        repositoryFullName: report.repositoryFullName,
        issueNumber: report.issueNumber,
        state,
        exitStatus: report.paneDeadStatus,
        lastReportedAt: now,
        escalatedState,
        ...(escalate ? { escalatedAt: now } : {}),
      },
    });

    if (escalate) {
      escalations.push({
        repositoryFullName: report.repositoryFullName,
        issueNumber: report.issueNumber,
        session: report.tmuxSessionName,
        exitStatus: report.paneDeadStatus,
      });
    }
  }

  // 報告に含まれなくなった行はGONEへ倒す。**削除しない。**
  // 引き上げ済みかどうか（escalatedState）を覚えておく必要があるのと、画面が「終わった
  // セッション」を出せるようにするため。
  const goneNames = existing
    .filter((row) => !reportedNames.has(row.tmuxSessionName) && row.state !== "GONE")
    .map((row) => row.tmuxSessionName);
  if (goneNames.length > 0) {
    await db.dispatchSession.updateMany({
      where: { host: params.hostName, tmuxSessionName: { in: goneNames } },
      data: {
        state: "GONE",
        lastReportedAt: now,
        // 消えた時点で引き上げの記録は落とす。同じ名前で起動し直して再び落ちたときに、
        // 前回の記録が残っていると2回目の引き上げが起きない
        escalatedState: null,
      },
    });
  }

  await db.dispatchSession.deleteMany({
    where: {
      host: params.hostName,
      state: "GONE",
      lastReportedAt: { lt: new Date(now.getTime() - GONE_SESSION_RETENTION_MS) },
    },
  });

  // **引き上げの失敗で報告APIを失敗させない。** pollerは報告の失敗で処理を止めない取り決めなので、
  // ここで500を返しても状態は既に保存済みで、pollerにできることは何も無い。
  let escalated = 0;
  for (const target of escalations) {
    const ok = await escalateFailedSession({
      repositoryFullName: target.repositoryFullName,
      issueNumber: target.issueNumber,
      hostName: params.hostName,
      tmuxSessionName: target.session,
      exitStatus: target.exitStatus,
    });
    if (ok) escalated += 1;
  }

  const saved = await db.dispatchSession.findMany({
    where: { host: params.hostName },
    orderBy: { lastReportedAt: "desc" },
  });
  return { sessions: saved.map(toSessionView), escalated };
}

/** 画面へ返すセッション一覧。`listDispatchState`から呼ぶ */
export async function listDispatchSessions(now: Date = new Date()): Promise<DispatchSessionView[]> {
  const sessions = await db.dispatchSession.findMany({
    where: {
      OR: [
        { state: { in: ["ALIVE", "EXITED", "FAILED"] } },
        { lastReportedAt: { gte: new Date(now.getTime() - GONE_SESSION_RETENTION_MS) } },
      ],
    },
    orderBy: { lastReportedAt: "desc" },
    take: 100,
  });
  return sessions.map(toSessionView);
}
