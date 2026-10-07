import { Prisma } from "@prisma/client";

import { handleChatMessage, type ChatUser } from "@/lib/chat/handlers";
import {
  CODEX_CLI_PROVIDER,
  CODEX_INVESTIGATION_LIMITS,
  createCodexCallModel,
} from "@/lib/chat/investigation/codex-model";
import type { CallModel } from "@/lib/chat/investigation/agent";
import { describeUnavailable } from "@/lib/chat/investigation/reply";
import { buildRefsText, parseChatMemory, recordFindings } from "@/lib/chat/session";
import { conversationTitle, parseChatContext, toChatMessageView } from "@/lib/chat/store";
import type { ChatCard, ChatMessageView, ChatRunView, ChatStatusCard } from "@/lib/chat/types";
import { db } from "@/lib/db";

/**
 * Codex CLI経由のチャット回答（#4109）。**発言の保存と回答の生成を分ける。**
 *
 * サブPCでの`codex exec`は1手ごとに受け取り待ちと起動が乗り、調査全体で数十秒〜数分かかる。
 * 送信のHTTPを最後まで保持すると、途中で接続が切れたり画面を再読込したりしたときに回答が
 * 失われる。そこで発言と回答待ち（`ChatRun`）を先に保存して返し、回答はサーバー内で非同期に
 * 作って保存する。画面は`GET /api/chat/[id]/run`で待ち状態と結果を取りに来る。
 *
 * 非同期の処理はサーバープロセスの中で走るため、デプロイの再起動で途切れうる。更新が止まった
 * 回答待ちは`sweepStaleChatRuns`が「中断」へ倒し、同じ内容での再試行を出す。
 */

/** 調査へ渡す直近の発言・返信の件数（`POST /api/chat/[id]`と同じ） */
const HISTORY_TURNS = 6;
/** Issue案の材料にする、直近の自分の発言の件数（同上） */
const RECENT_USER_TEXTS = 8;
const MAX_RETRIES = 3;

export type { ChatRunView };
/**
 * この時間更新が無い回答待ちは中断とみなす。調査全体の上限（5分）に、最後の手の待ちと
 * 保存の余裕を足した値。途中経過（`phase`）の更新で`updatedAt`が進むので、動いている間は倒れない
 */
export const CHAT_RUN_STALE_MS = 7 * 60_000;

export function toChatRunView(row: {
  id: string;
  status: string;
  phase: string;
  provider: string;
  model: string | null;
  failureKind: string | null;
  userMessageId: string;
  assistantMessageId: string | null;
  createdAt: Date;
}): ChatRunView {
  const status = (["running", "succeeded", "failed", "interrupted"] as const).find((s) => s === row.status) ?? "failed";
  return {
    id: row.id,
    status,
    phase: row.phase,
    provider: row.provider,
    model: row.model,
    failureKind: row.failureKind,
    userMessageId: row.userMessageId,
    assistantMessageId: row.assistantMessageId,
    createdAt: row.createdAt.toISOString(),
  };
}

class VersionConflict extends Error {}

/**
 * 発言を保存し、回答待ちを作る。会話の`version`を条件にする（他端末の更新と衝突したら読み直す）。
 * 同じ会話で回答待ちが動いている間は受け付けない（文脈の上書きと二重実行を防ぐ）。
 */
export async function startCodexChatRun(params: {
  conversationId: string;
  userId: string;
  text: string;
  clientMessageId: string | null;
  model: string;
}): Promise<
  | { ok: true; userMessage: ChatMessageView; run: ChatRunView }
  | { ok: false; error: "not_found" | "run_in_progress" | "conflict" }
> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const conversation = await db.chatConversation.findFirst({
      where: { id: params.conversationId, userId: params.userId },
    });
    if (!conversation) return { ok: false, error: "not_found" };
    await sweepStaleChatRuns(conversation.id);
    const active = await db.chatRun.findFirst({
      where: { conversationId: conversation.id, status: "running" },
      select: { id: true },
    });
    if (active) return { ok: false, error: "run_in_progress" };

    try {
      const [userRow, runRow] = await db.$transaction(async (tx) => {
        const updated = await tx.chatConversation.updateMany({
          where: { id: conversation.id, version: conversation.version },
          data: {
            version: { increment: 1 },
            ...(conversation.title === "新しい会話" ? { title: conversationTitle(params.text) } : {}),
          },
        });
        if (updated.count !== 1) throw new VersionConflict();
        const userRow = await tx.chatMessage.create({
          data: {
            conversationId: conversation.id,
            role: "user",
            text: params.text,
            clientMessageId: params.clientMessageId,
          },
        });
        const runRow = await tx.chatRun.create({
          data: {
            conversationId: conversation.id,
            userMessageId: userRow.id,
            status: "running",
            phase: "サブPCへ送信しています",
            provider: CODEX_CLI_PROVIDER,
            model: params.model,
          },
        });
        return [userRow, runRow] as const;
      });
      return { ok: true, userMessage: toChatMessageView(userRow), run: toChatRunView(runRow) };
    } catch (error) {
      const duplicate = error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
      if (error instanceof VersionConflict || duplicate) continue;
      throw error;
    }
  }
  return { ok: false, error: "conflict" };
}

/**
 * 回答を作って保存する。**呼び出し側は待たない**（`void executeCodexChatRun(...)`）。
 * 例外も含めて必ず回答待ちを終わらせ、利用者には理由と再試行を返す。
 */
export async function executeCodexChatRun(params: {
  runId: string;
  user: ChatUser;
  /** テスト用の差し替え */
  callModel?: CallModel;
}): Promise<void> {
  const run = await db.chatRun.findUnique({ where: { id: params.runId } });
  if (!run || run.status !== "running") return;
  const userMessage = await db.chatMessage.findUnique({ where: { id: run.userMessageId } });
  if (!userMessage) return;

  let lastFailure: string | null = null;
  const codexModel =
    params.callModel ??
    createCodexCallModel({ runId: run.id, model: run.model ?? "", requestedByUserId: params.user.id });
  const callModel: CallModel = async (input) => {
    const result = await codexModel(input);
    lastFailure = result.ok ? null : result.reason;
    return result;
  };

  try {
    const conversation = await db.chatConversation.findUniqueOrThrow({ where: { id: run.conversationId } });
    const turns = await db.chatMessage.findMany({
      where: { conversationId: run.conversationId, createdAt: { lt: userMessage.createdAt } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: HISTORY_TURNS,
      select: { role: true, text: true },
    });
    const history = turns.reverse().map((row) => ({
      role: row.role === "user" ? ("user" as const) : ("assistant" as const),
      content: row.text.slice(0, 1200),
    }));
    const recent = await db.chatMessage.findMany({
      where: { conversationId: run.conversationId, role: "user", createdAt: { lt: userMessage.createdAt } },
      orderBy: { createdAt: "desc" },
      take: RECENT_USER_TEXTS,
      select: { text: true },
    });
    const reply = await handleChatMessage({
      user: params.user,
      context: parseChatContext(conversation.context),
      text: userMessage.text,
      recentUserTexts: [...recent.map((row) => row.text).reverse(), userMessage.text],
      history,
      investigationDeps: { callModel, limits: CODEX_INVESTIGATION_LIMITS },
    });
    await saveRunReply({
      runId: run.id,
      conversationId: run.conversationId,
      userText: userMessage.text,
      reply,
      failureKind: lastFailure ? describeUnavailable(lastFailure).kind : null,
      // AIを呼べずに定型の理由だけを返したときは失敗として残す（診断で成功と混ぜない）
      status: lastFailure && (reply as { unavailable?: boolean }).unavailable ? "failed" : "succeeded",
    });
  } catch (error) {
    console.error("[chat] Codex回答の生成に失敗しました", { runId: run.id, error });
    await finishRunWithError(run.id, run.conversationId, userMessage.text, "failed", "codex_error",
      "回答できませんでした：回答の生成中にエラーが起きました。再試行してください。");
  }
}

async function saveRunReply(params: {
  runId: string;
  conversationId: string;
  userText: string;
  reply: Awaited<ReturnType<typeof handleChatMessage>>;
  failureKind: string | null;
  status: "succeeded" | "failed" | "interrupted";
}): Promise<void> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const conversation = await db.chatConversation.findUnique({ where: { id: params.conversationId } });
    if (!conversation) return;
    const memory = recordFindings(
      parseChatMemory(conversation.memory),
      params.reply.cards.filter((card): card is ChatStatusCard => card.type === "status"),
      new Date(),
    );
    try {
      await db.$transaction(async (tx) => {
        // 回答待ちが既に終わっていれば（中断へ倒された後に遅れて完了した等）保存しない
        const claimed = await tx.chatRun.updateMany({
          where: { id: params.runId, status: "running" },
          data: { status: params.status, failureKind: params.failureKind, phase: "", stepRequest: Prisma.DbNull },
        });
        if (claimed.count !== 1) return;
        const updated = await tx.chatConversation.updateMany({
          where: { id: conversation.id, version: conversation.version },
          data: {
            context: JSON.parse(JSON.stringify(params.reply.nextContext)),
            memory: JSON.parse(JSON.stringify(memory)),
            refsText: buildRefsText(params.reply.nextContext, [params.userText], conversation.refsText),
            repo: params.reply.nextContext.repo,
            version: { increment: 1 },
          },
        });
        if (updated.count !== 1) throw new VersionConflict();
        const assistant = await tx.chatMessage.create({
          data: {
            conversationId: conversation.id,
            role: "assistant",
            text: params.reply.text,
            cards: JSON.parse(JSON.stringify(params.reply.cards)),
            confirmState: params.reply.needsConfirm ? "pending" : null,
          },
        });
        await tx.chatRun.update({ where: { id: params.runId }, data: { assistantMessageId: assistant.id } });
      });
      return;
    } catch (error) {
      if (error instanceof VersionConflict) continue;
      throw error;
    }
  }
  throw new Error("会話の更新が衝突し続けたため、回答を保存できませんでした");
}

function retryCards(text: string): ChatCard[] {
  return [{ type: "choice", question: "同じ内容でもう一度送れます。", options: [{ label: "同じ内容で再試行", send: text }] }];
}

async function finishRunWithError(
  runId: string,
  conversationId: string,
  userText: string,
  status: "failed" | "interrupted",
  failureKind: string,
  text: string,
): Promise<void> {
  const conversation = await db.chatConversation.findUnique({ where: { id: conversationId } });
  if (!conversation) return;
  await saveRunReply({
    runId,
    conversationId,
    userText,
    reply: {
      text: `${text}\n相談内容は会話に残っています。`,
      cards: retryCards(userText),
      needsConfirm: false,
      nextContext: parseChatContext(conversation.context),
    },
    failureKind,
    status,
  }).catch((error) => console.error("[chat] 回答待ちの終了を保存できませんでした", { runId, error }));
}

/** 更新が止まった回答待ちを「中断」へ倒す（デプロイでの再起動など）。再試行の導線を残す */
export async function sweepStaleChatRuns(conversationId: string, now: Date = new Date()): Promise<void> {
  const stale = await db.chatRun.findMany({
    where: { conversationId, status: "running", updatedAt: { lt: new Date(now.getTime() - CHAT_RUN_STALE_MS) } },
    select: { id: true, userMessageId: true, currentJobId: true },
  });
  for (const run of stale) {
    const message = await db.chatMessage.findUnique({ where: { id: run.userMessageId }, select: { text: true } });
    if (run.currentJobId) {
      await db.dispatchJob.updateMany({
        where: { id: run.currentJobId, status: { in: ["QUEUED", "CLAIMED", "RUNNING"] } },
        data: { status: "CANCELED", activeKey: null, finishedAt: now, message: "チャットの回答待ちが中断されました" },
      });
    }
    await finishRunWithError(run.id, conversationId, message?.text ?? "", "interrupted", "interrupted",
      "回答できませんでした：回答の生成が途中で止まりました（サーバーの再起動など）。");
  }
}

/** 画面の取得用。終わっていれば返信と会話の文脈も返す */
export async function loadChatRun(params: { conversationId: string; userId: string; runId: string }) {
  const conversation = await db.chatConversation.findFirst({
    where: { id: params.conversationId, userId: params.userId },
  });
  if (!conversation) return null;
  await sweepStaleChatRuns(conversation.id);
  const run = await db.chatRun.findFirst({ where: { id: params.runId, conversationId: conversation.id } });
  if (!run) return null;
  const assistant = run.assistantMessageId
    ? await db.chatMessage.findUnique({ where: { id: run.assistantMessageId } })
    : null;
  const latest = assistant
    ? await db.chatConversation.findUnique({ where: { id: conversation.id } })
    : null;
  return {
    run: toChatRunView(run),
    message: assistant ? toChatMessageView(assistant) : null,
    context: latest ? parseChatContext(latest.context) : null,
    memory: latest ? parseChatMemory(latest.memory) : null,
    version: latest?.version ?? null,
  };
}

/** 会話を開いたときの、動いている回答待ち（再読込後に「回答中」を戻すため） */
export async function findActiveChatRun(conversationId: string): Promise<ChatRunView | null> {
  await sweepStaleChatRuns(conversationId);
  const run = await db.chatRun.findFirst({
    where: { conversationId, status: "running" },
    orderBy: { createdAt: "desc" },
  });
  return run ? toChatRunView(run) : null;
}
