import { Prisma } from "@prisma/client";

import { STEP_SCHEMA, type CallModel } from "@/lib/chat/investigation/agent";
import { recordClaudeApiCall } from "@/lib/claude/api-usage";
import { CODEX_LOCAL_MODEL_VALUES } from "@/lib/app-settings";
import { db } from "@/lib/db";
import {
  buildChatTurnActiveKey,
  CHAT_TURN_ISSUE_NUMBER,
  CHAT_TURN_REPOSITORY,
  isDispatchHostOnline,
} from "@/lib/dispatch/dispatch-job";

/**
 * チャット調査のモデル呼び出しを、サブPCのログイン済みCodex CLIで行う（#4109）。
 *
 * **OpenAI APIは呼ばない。** AI実行プロバイダーがCodexのとき、調査の1手ごとに`CHAT_TURN`ジョブを
 * 1件積み、pollerが`codex exec --output-schema`で答えを作って`/api/dispatch/chat-turn`へ返す
 * （ChatGPT/Codexのサブスク枠を使う）。ツール実行のループ（DB・GitHubの読み取り）はサーバーに
 * 残すので、ここが受け渡すのはプロンプトと最終メッセージだけ。
 *
 * 失敗は理由の先頭に`Codex(<種別>)`を付けて返し、`describeUnavailable`が原因ごとの案内へ分ける。
 * **どの失敗でもAPIへ逃がさない**（要件10）。
 */

/** 実行先の表記。利用状況・診断に残す（OpenAI APIの`gpt-*`と混ぜない） */
export const CODEX_CLI_PROVIDER = "codex-cli";

/** Codex経路の調査の上限。受け取り待ち（最大3秒）と`codex exec`の起動が1手ごとに乗る */
export const CODEX_INVESTIGATION_LIMITS = {
  maxDurationMs: 300_000,
  stepTimeoutMs: 120_000,
} as const;

/** 積んだジョブがこの時間内に受け取られなければ、サブPCへ届いていないと判断する */
export const CHAT_TURN_CLAIM_WAIT_MS = 30_000;
const POLL_INTERVAL_MS = 1_000;

/** サブPC側（`scripts/run-chat-codex.sh`）が返す失敗の種別。受け口で既知の語だけを通す */
export const CHAT_TURN_ERROR_KINDS = [
  "not_logged_in",
  "api_key_auth",
  "usage_limit",
  "timeout",
  "bad_output",
  "codex_error",
] as const;
export type ChatTurnErrorKind = (typeof CHAT_TURN_ERROR_KINDS)[number];

export function parseChatTurnErrorKind(value: unknown): ChatTurnErrorKind | null {
  return (CHAT_TURN_ERROR_KINDS as readonly unknown[]).includes(value) ? (value as ChatTurnErrorKind) : null;
}

/** Codex CLIで動かせるモデルか。`-m`へ渡すのはこの4つだけ（計画レビュー指摘2） */
export function isCodexCliModel(model: string): boolean {
  return (CODEX_LOCAL_MODEL_VALUES as readonly string[]).includes(model);
}

/** ジョブの本文。pollerは`GET /api/dispatch/chat-turn`でこれを受け取る */
export type ChatTurnRequest = {
  model: string;
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  schema: unknown;
};

/**
 * Codexへ渡すプロンプト。`codex exec`は会話の配列を受け取らないため、system・履歴・今回の依頼を
 * 1本の文章へ畳む。構造化出力は`--output-schema`が守るので、ここでは役割の区切りだけを付ける。
 */
export function buildCodexPrompt(request: Pick<ChatTurnRequest, "system" | "messages">): string {
  const turns = request.messages
    .map((m) => `<${m.role === "user" ? "user" : "assistant"}>\n${m.content}\n</${m.role === "user" ? "user" : "assistant"}>`)
    .join("\n\n");
  return [
    request.system,
    "# 実行環境の約束",
    "- あなたはファイルを読まず、コマンドも実行しない。必要な情報は会話中の <untrusted_data> にあるものだけを使い、足りなければ action=\"tool\" で次の取得を指定する",
    "- 出力は指定されたJSONスキーマに合う1つのJSONオブジェクトだけ",
    "# 会話（古い順。最後が今回の入力）",
    turns,
  ].join("\n\n");
}

type HostCheck = { ok: true; hostName: string } | { ok: false; reason: string };

/** オンラインかつ`CHAT_TURN`に対応したホストを1台選ぶ（最後に申告したもの） */
export async function pickChatCodexHost(now: Date = new Date()): Promise<HostCheck> {
  const hosts = await db.dispatchHost.findMany({ orderBy: { lastSeenAt: "desc" } });
  const online = hosts.filter((host) => isDispatchHostOnline(host.lastSeenAt, now));
  if (online.length === 0) {
    return { ok: false, reason: "Codex(offline) サブPCがオフラインです" };
  }
  const capable = online.find((host) => host.chatCodexCapable === true);
  if (!capable) {
    return { ok: false, reason: "Codex(unsupported) サブPCのpollerがチャットのCodex実行に未対応です" };
  }
  return { ok: true, hostName: capable.name };
}

/** 失敗の種別を、利用者に出す理由の文字列へ */
export function describeChatTurnError(kind: ChatTurnErrorKind | null): string {
  switch (kind) {
    case "not_logged_in":
      return "Codex(not_logged_in) サブPCのCodex CLIがログインしていません";
    case "api_key_auth":
      return "Codex(api_key_auth) サブPCのCodex CLIがAPIキーでログインしています（従量課金になるため使いません）";
    case "usage_limit":
      return "Codex(usage_limit) Codexの利用枠の上限に達しています";
    case "timeout":
      return "Codex(timeout) Codexの応答が時間切れになりました";
    case "bad_output":
      return "Codex(bad_output) Codexの応答を読み取れませんでした";
    default:
      return "Codex(codex_error) Codexの実行に失敗しました";
  }
}

type Sleep = (ms: number) => Promise<void>;
const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 回答待ち（`ChatRun`）1件ぶんの`CallModel`を作る。`onPhase`は画面に出す途中経過の更新。
 */
export function createCodexCallModel(params: {
  runId: string;
  model: string;
  requestedByUserId: string | null;
  sleep?: Sleep;
  clock?: () => number;
}): CallModel {
  const sleep = params.sleep ?? defaultSleep;
  const clock = params.clock ?? Date.now;
  let step = 0;

  return async ({ system, messages, timeoutMs }) => {
    step++;
    if (!isCodexCliModel(params.model)) {
      return { ok: false, reason: `Codex(unsupported_model) モデル ${params.model} はCodex実行に未対応です` };
    }
    const host = await pickChatCodexHost();
    if (!host.ok) return { ok: false, reason: host.reason };

    const request: ChatTurnRequest = { model: params.model, system, messages, schema: STEP_SCHEMA };
    const job = await db.dispatchJob.create({
      data: {
        repositoryFullName: CHAT_TURN_REPOSITORY,
        issueNumber: CHAT_TURN_ISSUE_NUMBER,
        targetHost: host.hostName,
        kind: "CHAT_TURN",
        agent: "codex",
        codexModel: params.model,
        status: "QUEUED",
        // 1つの回答待ちにつき未完了は1件。前の手のジョブは結果を受け取った時点で閉じている
        activeKey: buildChatTurnActiveKey(params.runId),
        requestedByUserId: params.requestedByUserId,
      },
    });
    await db.chatRun.update({
      where: { id: params.runId },
      data: {
        currentJobId: job.id,
        stepRequest: JSON.parse(JSON.stringify(request)) as Prisma.InputJsonValue,
        stepResult: null,
        stepError: null,
        phase: `サブPCの受け取り待ち（${step}手目）`,
      },
    });

    const startedAt = clock();
    let claimedPhaseSet = false;
    for (;;) {
      await sleep(POLL_INTERVAL_MS);
      const [run, current] = await Promise.all([
        db.chatRun.findUnique({
          where: { id: params.runId },
          select: { stepResult: true, stepError: true, currentJobId: true },
        }),
        db.dispatchJob.findUnique({ where: { id: job.id }, select: { status: true } }),
      ]);
      if (!run || run.currentJobId !== job.id || !current) {
        return { ok: false, reason: "Codex(codex_error) 回答待ちが見つからなくなりました" };
      }
      if (run.stepResult !== null) {
        await db.chatRun.update({ where: { id: params.runId }, data: { stepRequest: Prisma.DbNull } });
        return { ok: true, text: run.stepResult };
      }
      if (run.stepError !== null || ["FAILED", "TIMEOUT", "SKIPPED", "CANCELED"].includes(current.status)) {
        await db.chatRun.update({ where: { id: params.runId }, data: { stepRequest: Prisma.DbNull } });
        return {
          ok: false,
          reason:
            current.status === "TIMEOUT" && run.stepError === null
              ? "Codex(not_claimed) サブPCが応答しませんでした"
              : describeChatTurnError(parseChatTurnErrorKind(run.stepError)),
        };
      }
      const elapsed = clock() - startedAt;
      if (current.status === "QUEUED" && elapsed >= CHAT_TURN_CLAIM_WAIT_MS) {
        await abandonChatTurnJob(job.id, "サブPCに受け取られませんでした");
        return { ok: false, reason: "Codex(not_claimed) サブPCがジョブを受け取りませんでした" };
      }
      if (elapsed >= timeoutMs) {
        await abandonChatTurnJob(job.id, "チャットの回答待ちが時間切れになりました");
        return { ok: false, reason: "Codex(timeout) Codexの応答が時間切れになりました" };
      }
      if (!claimedPhaseSet && (current.status === "CLAIMED" || current.status === "RUNNING")) {
        claimedPhaseSet = true;
        await db.chatRun.update({
          where: { id: params.runId },
          data: { phase: `Codexで回答中（${step}手目）` },
        });
      }
    }
  };
}

/** 待つのをやめたジョブを閉じる。遅れて届いた結果は`currentJobId`の不一致で捨てられる */
async function abandonChatTurnJob(jobId: string, message: string): Promise<void> {
  await db.dispatchJob.updateMany({
    where: { id: jobId, status: { in: ["QUEUED", "CLAIMED", "RUNNING"] } },
    data: { status: "CANCELED", activeKey: null, finishedAt: new Date(), message },
  });
}

/** サブPCの`codex exec --json`が返した使用量を、OpenAI APIとは別の実行先として計上する */
export function recordCodexChatUsage(model: string, usage: unknown): void {
  const u = (usage && typeof usage === "object" ? usage : {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  recordClaudeApiCall({
    feature: "chat_investigation",
    model: `${CODEX_CLI_PROVIDER}/${model}`,
    tokens: {
      inputTokens: n(u.input_tokens),
      outputTokens: n(u.output_tokens),
      cacheReadTokens: n(u.cached_input_tokens),
      cacheCreationTokens: 0,
    },
  });
}
