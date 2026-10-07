import { Prisma } from "@prisma/client";

import {
  buildCodexPrompt,
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
    message: succeeded ? "Codexの回答を受け取りました" : `Codexの実行に失敗しました（${errorKind}）`,
  });
  return { ok: true as const };
}
