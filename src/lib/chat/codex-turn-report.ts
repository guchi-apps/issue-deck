import { Prisma } from "@prisma/client";

import {
  buildCodexPrompt,
  findChatCodexSession,
  parseChatTurnErrorKind,
  recordCodexChatUsage,
  type ChatTurnRequest,
} from "@/lib/chat/investigation/codex-model";
import { db } from "@/lib/db";
import { reportDispatchJob } from "@/lib/dispatch/jobs";

/**
 * サブPCのpollerとの受け渡し（`CHAT_TURN`・#4109）。pollerはジョブを取ったら
 * `GET /api/dispatch/chat-turn`でプロンプトを受け取り、`codex exec`の結果を`POST`で返す。
 *
 * **プロンプトはジョブ（`DispatchJob`）ではなく回答待ち（`ChatRun.stepRequest`）に置く。**
 * ジョブの行は実行状況の一覧・掃除の対象で、相談の本文を長く持たせたくないため。受け取りを
 * 許すのは、そのジョブを取ったホストだけ（`claimedByHost`）。
 */

/** 返す最終メッセージの上限。構造化出力の各欄の上限（`parseStep`）の合計より余裕を持たせる */
export const CHAT_TURN_OUTPUT_MAX_LENGTH = 64_000;

type JobCheck =
  | { ok: true; runId: string; request: ChatTurnRequest | null }
  | { ok: false; status: number; error: string };

async function findChatTurn(jobId: string, host: string): Promise<JobCheck> {
  const job = await db.dispatchJob.findUnique({
    where: { id: jobId },
    select: { kind: true, claimedByHost: true, status: true },
  });
  if (!job || job.kind !== "CHAT_TURN") return { ok: false, status: 404, error: "not_found" };
  if (job.claimedByHost !== host) return { ok: false, status: 403, error: "wrong_host" };
  if (job.status !== "CLAIMED" && job.status !== "RUNNING") {
    return { ok: false, status: 409, error: "already_finished" };
  }
  const run = await db.chatRun.findFirst({
    where: { currentJobId: jobId, status: "running" },
    select: { id: true, stepRequest: true },
  });
  if (!run) return { ok: false, status: 409, error: "run_not_waiting" };
  return { ok: true, runId: run.id, request: parseStoredRequest(run.stepRequest) };
}

function parseStoredRequest(value: unknown): ChatTurnRequest | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<ChatTurnRequest>;
  if (typeof v.model !== "string" || typeof v.system !== "string" || !Array.isArray(v.messages)) return null;
  return v as ChatTurnRequest;
}

/** pollerへ渡すプロンプト。受け取った時点でジョブを`RUNNING`にする */
export async function fetchChatTurnRequest(params: { jobId: string; host: string }) {
  const found = await findChatTurn(params.jobId, params.host);
  if (!found.ok) return found;
  if (!found.request) return { ok: false as const, status: 409, error: "request_missing" };
  const session = findChatCodexSession(params.jobId);
  if (session && session.metrics.fetchedAt === null) session.metrics.fetchedAt = Date.now();
  await reportDispatchJob({
    jobId: params.jobId,
    hostName: params.host,
    status: "running",
    message: "Codexで回答を作成しています",
  });
  return {
    ok: true as const,
    body: {
      model: found.request.model,
      prompt: buildCodexPrompt(found.request),
      schema: found.request.schema,
      mode: found.request.mode ?? null,
      tools: found.request.tools ?? [],
    },
  };
}

/**
 * `codex exec`の結果を受け取る。**回答待ちへ先に書き、ジョブを後で閉じる**（待つ側は結果の有無を
 * 先に見るので、ジョブだけが閉じて結果が無い瞬間を「失敗」と読まないようにする）。
 */
export async function reportChatTurnResult(params: {
  jobId: string;
  host: string;
  status: "succeeded" | "failed";
  output: string | null;
  errorKind: unknown;
  usage: unknown;
  /** サブPCが測った起動・実行の所要時間（ミリ秒）。遅延の内訳としてジョブのメッセージへ残す */
  timing?: unknown;
}) {
  const found = await findChatTurn(params.jobId, params.host);
  if (!found.ok) return found;

  const output = params.output?.trim() ?? "";
  const succeeded = params.status === "succeeded" && output !== "" && output.length <= CHAT_TURN_OUTPUT_MAX_LENGTH;
  const errorKind = succeeded ? null : (parseChatTurnErrorKind(params.errorKind) ?? (params.status === "succeeded" ? "bad_output" : "codex_error"));

  await db.chatRun.updateMany({
    where: { id: found.runId, currentJobId: params.jobId },
    data: succeeded ? { stepResult: output } : { stepError: errorKind, stepRequest: Prisma.DbNull },
  });
  if (succeeded && found.request) recordCodexChatUsage(found.request.model, params.usage);
  await reportDispatchJob({
    jobId: params.jobId,
    hostName: params.host,
    status: succeeded ? "succeeded" : "failed",
    message: succeeded
      ? `Codexの回答を受け取りました${describeMetrics(params.jobId, params.timing)}`
      : `Codexの実行に失敗しました（${errorKind}）${describeMetrics(params.jobId, params.timing)}`,
  });
  return { ok: true as const };
}

/**
 * 遅延の内訳（#4199）。配信待ち（ジョブを積んでからpollerがプロンプトを取りに来るまで）・CLI起動〜応答・
 * ツール取得（回数と合計時間）・全体を1行にしてジョブのメッセージへ残す。起動回数は常に1回。
 */
export function describeMetrics(jobId: string, timing: unknown): string {
  const session = findChatCodexSession(jobId);
  if (!session) return "";
  const m = session.metrics;
  const sec = (ms: number) => `${(ms / 1000).toFixed(1)}秒`;
  const now = Date.now();
  const parts = ["CLI起動1回"];
  if (m.fetchedAt !== null) parts.push(`配信待ち${sec(m.fetchedAt - m.queuedAt)}`);
  const t = timing && typeof timing === "object" ? (timing as Record<string, unknown>) : {};
  if (typeof t.codexMs === "number" && Number.isFinite(t.codexMs)) parts.push(`Codex実行${sec(t.codexMs)}`);
  if (typeof t.firstEventMs === "number" && Number.isFinite(t.firstEventMs)) parts.push(`起動〜初回応答${sec(t.firstEventMs)}`);
  parts.push(`ツール${m.toolCalls}回${m.toolCalls ? `（計${sec(m.toolMs)}）` : ""}`);
  parts.push(`全体${sec(now - m.queuedAt)}`);
  return `［${parts.join("・")}］`;
}

/**
 * セッション型の実行中に、Codexが呼んだツールを実行する（#4199）。**他の会話の結果が混ざらないよう**、
 * ジョブを取ったホスト・回答待ちが今そのジョブを待っていること・サーバーのメモリにその実行が
 * あること、の3つを確かめてから、その実行専用の`runTool`（上限・重複・伏せ字つき）へ渡す。
 */
export async function runChatTurnTool(params: {
  jobId: string;
  host: string;
  name: string;
  args: Record<string, unknown>;
}) {
  const found = await findChatTurn(params.jobId, params.host);
  if (!found.ok) return found;
  const session = findChatCodexSession(params.jobId);
  if (!session || session.runId !== found.runId) {
    // サーバーの再起動などで実行の記録が無い。結果を受け取る側がいないので続けさせない
    return { ok: false as const, status: 409, error: "session_missing" };
  }
  const result = await session.runTool(params.name, params.args);
  return { ok: true as const, result };
}
