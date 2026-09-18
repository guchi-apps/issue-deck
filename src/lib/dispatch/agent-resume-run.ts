import { db } from "@/lib/db";
import { AGENT_RESUME_INSTRUCTION, selectStoppedSessions } from "@/lib/dispatch/agent-resume";
import type { DispatchAgent } from "@/lib/dispatch/dispatch-job";
import { resolveIssueImplementationAgent } from "@/lib/dispatch/issue-session";
import {
  enqueueSessionControlJob,
  setAgentDispatchPause,
  type EnqueueSessionControlJobResult,
} from "@/lib/dispatch/jobs";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import { listDispatchSessions } from "@/lib/dispatch/sessions";

/**
 * 一括停止した記録として遡る期間。停止から再開までがこれより長く空いた場合は、C-cの記録が
 * 見つからず対象から外れる（何も送らないだけで、ブロックの解除は行われる）。
 */
const INTERRUPT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export type AgentResumeFailure = {
  repositoryFullName: string;
  issueNumber: number;
  message: string;
};

export type AgentResumeResult = {
  agentPause: Awaited<ReturnType<typeof setAgentDispatchPause>>;
  /** 再開の指示を積めた件数（送出そのものはpollerの次の巡回で行われる） */
  resumed: number;
  failed: AgentResumeFailure[];
};

type Deps = {
  setPaused: typeof setAgentDispatchPause;
  listSessions: () => Promise<DispatchSessionView[]>;
  listInterruptJobs: (since: Date) => Promise<
    {
      kind: "INTERRUPT";
      status: "SUCCEEDED";
      targetHost: string;
      repositoryFullName: string;
      issueNumber: number;
      finishedAt: string | null;
    }[]
  >;
  enqueue: (params: {
    repositoryFullName: string;
    issueNumber: number;
    hostName: string;
    userId: string | null;
  }) => Promise<EnqueueSessionControlJobResult>;
};

const defaultDeps: Deps = {
  setPaused: setAgentDispatchPause,
  listSessions: () => listDispatchSessions(),
  listInterruptJobs: async (since) => {
    const rows = await db.dispatchJob.findMany({
      where: { kind: "INTERRUPT", status: "SUCCEEDED", finishedAt: { gte: since } },
      select: {
        targetHost: true,
        repositoryFullName: true,
        issueNumber: true,
        finishedAt: true,
      },
      orderBy: { finishedAt: "desc" },
      take: 500,
    });
    return rows.map((row) => ({
      kind: "INTERRUPT" as const,
      status: "SUCCEEDED" as const,
      targetHost: row.targetHost,
      repositoryFullName: row.repositoryFullName,
      issueNumber: row.issueNumber,
      finishedAt: row.finishedAt?.toISOString() ?? null,
    }));
  },
  enqueue: (params) =>
    enqueueSessionControlJob({
      repositoryFullName: params.repositoryFullName,
      issueNumber: params.issueNumber,
      hostName: params.hostName,
      kind: "INSTRUCTION",
      instruction: AGENT_RESUME_INSTRUCTION,
      // pollerが許可する状態イベントに`working`を足す（C-cでは`Stop`が飛ばず、止めたセッションの
      // 最後の状態は`working`のまま残るため）。確認待ちの札は`report`が本文を見て外さない
      recovery: true,
      requestedByUserId: params.userId,
    }),
};

/**
 * エージェントの新規実行のブロックを解除し、一括停止で止まっているセッションへ再開の
 * 固定の1行を積む（#3045）。
 *
 * **ブロックの解除を先に行う。** 再開の指示が1件も積めなくても（対象が無い・ホストが落ちている）、
 * 人が押した「再開」の半分である新規実行の再開は成立させる。積めなかったセッションは`failed`で
 * 返し、画面が押した場所に出す。
 */
export async function resumeAgentSessions(
  params: { agent: DispatchAgent; userId: string | null; now?: Date },
  deps: Deps = defaultDeps,
): Promise<AgentResumeResult> {
  const now = params.now ?? new Date();
  const agentPause = await deps.setPaused({ agent: params.agent, paused: false });

  const [sessions, jobs] = await Promise.all([
    deps.listSessions(),
    deps.listInterruptJobs(new Date(now.getTime() - INTERRUPT_LOOKBACK_MS)),
  ]);
  const targets = selectStoppedSessions(
    sessions.filter((session) => resolveIssueImplementationAgent(session) === params.agent),
    jobs,
  );

  let resumed = 0;
  const failed: AgentResumeFailure[] = [];
  for (const session of targets) {
    const result = await deps.enqueue({
      repositoryFullName: session.repositoryFullName,
      issueNumber: session.issueNumber,
      hostName: session.host,
      userId: params.userId,
    });
    if (result.ok) {
      resumed += 1;
    } else {
      failed.push({
        repositoryFullName: session.repositoryFullName,
        issueNumber: session.issueNumber,
        message: result.message,
      });
    }
  }
  return { agentPause, resumed, failed };
}
