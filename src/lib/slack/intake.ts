import { randomUUID } from "node:crypto";

import { Prisma, type SlackIntakeRequest } from "@prisma/client";

import { executeConfirmedCard, handleChatMessage, type ChatUser } from "@/lib/chat/handlers";
import { parseChatContext } from "@/lib/chat/store";
import type { ChatConfirmCard, ChatContext, ChatInvestigationCard } from "@/lib/chat/types";
import { db } from "@/lib/db";
import { createComment, fetchCommentsForIssue, fetchIssuesForRepo } from "@/lib/github/issues-api";
import { findRepositoryByFullName } from "@/lib/github/issue-create-service";
import { withUserGithubToken } from "@/lib/github/with-user-github-token";
import { previewModeGuard } from "@/lib/preview-mode";
import {
  ACTION_ISSUE_ATTACH,
  ACTION_ISSUE_CANCEL,
  ACTION_ISSUE_CONFIRM,
  ACTION_REPO_CONFIRM,
  ACTION_REPO_SELECT,
} from "@/lib/slack/blocks";
import { filterCandidates, listRepoCandidates } from "@/lib/slack/candidates";
import { classifyFollowUp } from "@/lib/slack/classify";
import {
  fetchPermalink,
  postBotReply,
  setReaction,
  SlackApiError,
  updateBotMessage,
  type SlackClient,
} from "@/lib/slack/client";
import { isAllowedLocation, resolveIssueDeckUser, type SlackConfig } from "@/lib/slack/config";
import { resolveTarget, type TargetModel } from "@/lib/slack/target";

/**
 * Slackの`#アプリissue起案`からのIssue起案（#4454）。
 *
 * - **依頼単位**は親投稿の`teamId + channelId + parentTs`（DBの一意制約）。処理済みイベントも記録して再送を無視する
 * - **ack前に依頼をDBへ残す**（#4488）。親投稿は処理済み記録と同じトランザクションで`received`の行にし、保存に
 *   失敗したら非2xxを返してSlackに再送させる。ack前にはSlack API・GitHub・AIを呼ばない（3秒制限）。
 *   ack後の処理が途中で止まった行は`resumeStalePendingRequests`が拾い直す
 * - **対象リポジトリが確定するまでIssueは作らない。** 確定はAIの判別（`target.ts`）か、判別できないときに利用者が
 *   スレッドで答えた`owner/repo`で、どちらも許可候補（接続済み・権限あり）の中だけ。確定を`selectedRepo`へ保存する（#4527）
 * - 調査・Issue案づくりは既存のIssueDeck Chat（`handleChatMessage`）を呼ぶだけ。**調査が成立し、重複が無く、案が揃ったら
 *   承認なしで作成する**（#4527）。`confirmState`の`queued`で確認済みの操作を保存し、既存更新を照合してから実行する。
 *   旧フローの確認待ち（`awaiting_confirm`）の「この案で起案する」ボタンも引き続き使える
 * - 返信は全てBot名義・依頼者メンション付き（`postBotReply`）。失敗は⚠️と理由・再開方法を同じスレッドへ返す
 */

export type IntakeContext = { config: SlackConfig; client: SlackClient };

export type SlackMessageEvent = {
  type: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  app_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  channel?: string;
  files?: { name?: string }[];
};

type IssueCard = Extract<ChatConfirmCard, { type: "confirm_issue" }>;

type StoredProposal = {
  card: IssueCard;
  /** 同一スレッドの別成果として分割するとき、分割元のIssue番号 */
  splitFrom: number | null;
  /** 確認済みの追記先。ack前に保存して巡回でも同じ操作を再開する */
  attachTo?: number | null;
  /** 案ごとの外部更新識別子。分割案を作り直しても別の成果を誤って再利用しない */
  confirmationId?: string;
};

type IssueRef = { repo: string; number: number; role: "primary" | "split" | "reused" };

const MAX_REPLY_CHARS = 2800;
const RESUME_WORDS = /^\s*(再開|再試行|retry)\s*$/i;
const FOOTER_MARKER = (r: SlackIntakeRequest) => `<!-- slack-intake: ${r.teamId}/${r.channelId}/${r.parentTs} -->`;

/** イベント・操作の処理済み記録。初めてなら真（再送・連打・併存での二重処理を止める） */
export async function claimEvent(key: string, messageTs: string | null): Promise<boolean> {
  try {
    await db.slackProcessedEvent.create({ data: { eventKey: key.slice(0, 160), messageTs } });
    return true;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * ack後の処理を待っている・処理中の依頼の状態。`received`は受付（選択UIの投稿）前、`resuming`は「再開」の返信を
 * 受けた後、`investigating`は調査（AI）中。どれも処理が終わるまでこの値のまま残るので、処理していたプロセスが
 * 止まった行は`resumeStalePendingRequests`が拾い直す（ack前に書くのは`received`・`resuming`だけ）。
 */
const PENDING_STATUSES = ["received", "resuming", "investigating", "confirming"] as const;
type PendingStatus = (typeof PENDING_STATUSES)[number];
/** この時間より長く`updatedAt`が動いていない行は、処理していたプロセスが止まったものとみなして拾い直す */
const PENDING_STALE_MS: Record<PendingStatus, number> = {
  received: 2 * 60_000,
  // 「再開」と調査は調査（AI）まで同じ処理で走るため、処理中の行を二重に拾わないよう長めに待つ
  resuming: 30 * 60_000,
  investigating: 30 * 60_000,
  confirming: 30 * 60_000,
};

function isPendingStatus(status: string): status is PendingStatus {
  return (PENDING_STATUSES as readonly string[]).includes(status);
}

/**
 * ack前の受付結果。
 * - `queued`: 依頼をDBへ書いた。ack後に`processPendingRequest`で続ける
 * - `followUp`: 起案済みの依頼への返信。ack後に処理する。**返信本文はDBへ残さない**ので、ack後にプロセスが止まると
 *   その返信だけは拾い直せない（依頼とIssueは作成済みで失われない。利用者がもう一度返信すれば続く）。拾い直すには
 *   返信本文を置く列が要り、スキーマ変更になるため見送った（#4488）
 * - `handled`: DBへの反映だけで完了した（起案前の補足）
 */
export type AcceptedEvent =
  | { kind: "duplicate" }
  | { kind: "ignored" }
  | { kind: "handled" }
  | { kind: "queued"; requestId: string }
  | { kind: "followUp"; request: SlackIntakeRequest; text: string; messageTs: string };

function isIntakeMessage(event: SlackMessageEvent): boolean {
  if (event.type !== "message") return false;
  if (event.bot_id || event.app_id) return false;
  if (event.subtype && event.subtype !== "file_share") return false;
  return Boolean(event.user && event.ts && event.channel);
}

/**
 * Slackへ応答する前に行う受付（#4488）。**DBの読み書きだけ**で、処理済み記録と依頼の保存を1つのトランザクションに
 * まとめる。どちらかが失敗したら例外を投げる（受け口は非2xxを返し、Slackが同じイベントを再送する）。
 */
export async function acceptMessageEvent(
  config: SlackConfig,
  teamId: string,
  eventId: string,
  event: SlackMessageEvent,
): Promise<AcceptedEvent> {
  if (!isIntakeMessage(event) || !isAllowedLocation(config, teamId, event.channel!)) return { kind: "ignored" };
  const channel = event.channel!;
  const ts = event.ts!;
  const slackUserId = event.user!;
  const key = `event:${eventId}`.slice(0, 160);
  const isReply = Boolean(event.thread_ts && event.thread_ts !== ts);

  let userId: string | null = null;
  let text = "";
  if (isReply) {
    text = (event.text ?? "").trim();
  } else {
    userId = resolveIssueDeckUser(config, slackUserId);
    if (!userId) {
      console.warn("[slack-intake] IssueDeckに対応付いていないSlackユーザーの投稿を無視しました");
      return { kind: "ignored" };
    }
    const files = (event.files ?? []).map((f) => `添付: ${f.name ?? "名称不明"}（内容は未取得・未確認）`);
    text = [(event.text ?? "").trim(), ...files].filter(Boolean).join("\n\n");
  }
  if (!text) return { kind: "ignored" };

  try {
    return await db.$transaction(async (tx): Promise<AcceptedEvent> => {
      await tx.slackProcessedEvent.create({ data: { eventKey: key, messageTs: ts } });
      if (!isReply) {
        const created = await tx.slackIntakeRequest.create({
          data: { teamId, channelId: channel, parentTs: ts, slackUserId, userId: userId!, text, status: "received", issues: [] },
        });
        return { kind: "queued", requestId: created.id };
      }
      const request = await tx.slackIntakeRequest.findUnique({
        where: { teamId_channelId_parentTs: { teamId, channelId: channel, parentTs: event.thread_ts! } },
      });
      if (!request || request.slackUserId !== slackUserId) return { kind: "ignored" };
      if (request.status === "failed" && RESUME_WORDS.test(text)) {
        await tx.slackIntakeRequest.update({ where: { id: request.id }, data: { status: "resuming", failure: null } });
        return { kind: "queued", requestId: request.id };
      }
      if (request.status === "awaiting_repo") {
        // 対象確認への回答（#4527）。補足として本文へ足し、以前の対象の調査結果・案は流用せず、ack後に判別し直す。
        // 回答で対象が決まれば、承認の操作なしで調査・起案まで進む。決まらなければ再び聞く
        await tx.slackIntakeRequest.update({
          where: { id: request.id },
          data: { text: `${request.text}\n\n（補足）${text}`, status: "resuming", selectedRepo: null, conversationId: null, proposal: Prisma.DbNull, confirmState: null },
        });
        return { kind: "queued", requestId: request.id };
      }
      if (request.status !== "done") {
        // 調査中・確認待ちの補足は、起案の材料へ足す（新しいIssueにはしない）
        await tx.slackIntakeRequest.update({ where: { id: request.id }, data: { text: `${request.text}\n\n（補足）${text}` } });
        return { kind: "handled" };
      }
      return { kind: "followUp", request, text, messageTs: ts };
    });
  } catch (error) {
    // 同じイベントの再送、または同じ親投稿が別のイベントIDで届いた（どちらも依頼は既にある）
    if (isUniqueViolation(error)) return { kind: "duplicate" };
    throw error;
  }
}

/** ack後の処理。受付で保存した依頼を進める */
export async function processAcceptedEvent(ctx: IntakeContext, accepted: AcceptedEvent): Promise<void> {
  if (accepted.kind === "queued") {
    await processPendingRequest(ctx, accepted.requestId);
    return;
  }
  if (accepted.kind !== "followUp") return;
  try {
    await handleFollowUp(ctx, accepted.request, accepted.text, accepted.messageTs);
  } catch (error) {
    console.error("[slack-intake] 起案済みの依頼への返信を処理できませんでした", error);
    await reply(ctx, accepted.request, "⚠️ この返信を処理できませんでした（Issueは変更していません）。もう一度返信してください。").catch(
      () => undefined,
    );
  }
}

/** 受付→処理を続けて行う（テスト・同期処理用）。受け口はack前後に分けて呼ぶ */
export async function handleMessageEvent(
  ctx: IntakeContext,
  teamId: string,
  eventId: string,
  event: SlackMessageEvent,
): Promise<void> {
  await processAcceptedEvent(ctx, await acceptMessageEvent(ctx.config, teamId, eventId, event));
}

/**
 * 待ち状態（`received`・`resuming`）の依頼を1件進める。`staleBefore`を渡すと、それより後に更新された行
 * （他で処理中のもの）は触らない。読んだ時点の`updatedAt`を条件に更新して処理権を取るので、同じ行を2か所で
 * 同時に進めない。途中でプロセスが止まると待ち状態のまま残り、`resumeStalePendingRequests`が拾い直す。
 */
export async function processPendingRequest(ctx: IntakeContext, requestId: string, staleBefore?: Date): Promise<boolean> {
  const request = await db.slackIntakeRequest.findUnique({ where: { id: requestId } });
  if (!request || !isPendingStatus(request.status)) return false;
  if (staleBefore && request.updatedAt > staleBefore) return false;
  const now = new Date();
  const claimed = await db.slackIntakeRequest.updateMany({
    where: { id: request.id, status: request.status, updatedAt: request.updatedAt },
    data: { updatedAt: now },
  });
  if (claimed.count !== 1) return false;
  const current = { ...request, updatedAt: now };
  try {
    if (current.status === "confirming") await runConfirmation(ctx, current);
    else if (current.status === "received") await startRequest(ctx, current);
    else await resumeRequest(ctx, current);
  } catch (error) {
    if (current.status === "confirming") throw error; // 外部更新の成否が不明でも回収対象から外さない
    // 失敗状態として残す（「再開」で続けられる）。ここも失敗したら待ち状態のまま残り、巡回が拾い直す
    await failRequest(ctx, current, "受付", error instanceof SlackApiError ? error.code : "受付の処理に失敗しました", {
      retryable: true,
      unfinished: "対象リポジトリの選択",
      resume: RESUME_HINT,
    });
  }
  return true;
}

/** 処理が止まった待ち状態の依頼を拾い直す（起動時と定期実行。`src/instrumentation.ts`） */
export async function resumeStalePendingRequests(ctx: IntakeContext, now: Date = new Date()): Promise<number> {
  let resumed = 0;
  for (const status of PENDING_STATUSES) {
    const staleBefore = new Date(now.getTime() - PENDING_STALE_MS[status]);
    const stale = await db.slackIntakeRequest.findMany({
      where: { status, updatedAt: { lt: staleBefore } },
      orderBy: { updatedAt: "asc" },
      take: 10,
      select: { id: true },
    });
    for (const { id } of stale) {
      try {
        if (await processPendingRequest(ctx, id, staleBefore)) resumed += 1;
      } catch (error) {
        console.error(`[slack-intake] 止まっていた依頼を再開できませんでした request=${id}`, error);
      }
    }
  }
  try {
    resumed += await resendPendingReplies(ctx, now);
  } catch (error) {
    console.error("[slack-intake] 未送信の結果返信を再送できませんでした", error);
  }
  return resumed;
}

function issuesOf(request: SlackIntakeRequest): IssueRef[] {
  return Array.isArray(request.issues) ? (request.issues as IssueRef[]) : [];
}

function proposalOf(request: SlackIntakeRequest): StoredProposal | null {
  const raw = request.proposal as StoredProposal | null;
  return raw && typeof raw === "object" && raw.card?.type === "confirm_issue" ? raw : null;
}

async function loadChatUser(userId: string): Promise<ChatUser | null> {
  return db.user.findUnique({
    where: { id: userId },
    select: { id: true, githubAccessToken: true, githubRefreshToken: true },
  });
}

function reply(ctx: IntakeContext, request: SlackIntakeRequest, text: string, blocks?: Parameters<typeof postBotReply>[1]["blocks"]) {
  return postBotReply(ctx.client, {
    channel: request.channelId,
    threadTs: request.parentTs,
    slackUserId: request.slackUserId,
    text: text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS)}…` : text,
    blocks,
  });
}

/**
 * 失敗を「完了」と見せない。段階・理由・再開方法を同じスレッドへ返し、⚠️を付ける。
 * 理由にはトークン等を含めない（`SlackApiError`はコードだけ）。
 */
export async function failRequest(
  ctx: IntakeContext,
  request: SlackIntakeRequest,
  stage: string,
  reason: string,
  options: { retryable: boolean; unfinished: string; resume: string },
): Promise<void> {
  console.error(`[slack-intake] 失敗 request=${request.id} stage=${stage} retryable=${options.retryable} reason=${reason}`);
  await db.slackIntakeRequest.update({ where: { id: request.id }, data: { status: "failed", failure: `${stage}: ${reason}` } });
  await setReaction(ctx.client, { channel: request.channelId, ts: request.parentTs, add: "warning", remove: "eyes" });
  try {
    await reply(
      ctx,
      request,
      `⚠️ 完了していません。\n• 段階: ${stage}\n• 理由: ${reason}\n• 未完了: ${options.unfinished}\n• 再試行: ${options.retryable ? "できます" : "そのままでは直りません"}\n• 再開方法: ${options.resume}`,
    );
  } catch (error) {
    console.error("[slack-intake] 失敗の通知も送れませんでした", error instanceof SlackApiError ? error.code : error);
  }
}

const SUPPLEMENT_SEPARATOR = "\n\n（補足）";
const RESUME_HINT = "このスレッドへ「再開」と返信してください。";

/** 受付済み（`received`）の依頼に👀を付け、対象を判別して調査へ進む（判別できないときだけ対象を聞く） */
async function startRequest(ctx: IntakeContext, request: SlackIntakeRequest): Promise<void> {
  const permalink = request.permalink ?? (await fetchPermalink(ctx.client, request.channelId, request.parentTs));
  const next = permalink === request.permalink ? request : await db.slackIntakeRequest.update({ where: { id: request.id }, data: { permalink } });
  await setReaction(ctx.client, { channel: request.channelId, ts: request.parentTs, add: "eyes" });
  await decideTarget(ctx, next);
}

/** テスト用の差し替え口（対象判別のAI呼び出し） */
let targetModelOverride: TargetModel | undefined;
export function setTargetModelForTest(model: TargetModel | undefined) {
  targetModelOverride = model;
}

/**
 * 対象リポジトリを判別する。一意に決まれば`investigating`へ進めて調査まで続け、決まらないときだけ同じスレッドで
 * 候補（名称とowner/repo）を示して聞く（`awaiting_repo`）。回答の返信は`acceptMessageEvent`が本文へ足して`resuming`に
 * するので、ここへもう一度来て判別し直す（承認の操作は挟まない）。
 */
async function decideTarget(ctx: IntakeContext, request: SlackIntakeRequest): Promise<void> {
  let next: SlackIntakeRequest;
  try {
    const candidates = await listRepoCandidates(ctx.config, request.userId);
    if (candidates.length === 0) {
      await failRequest(ctx, request, "対象リポジトリの候補づくり", "選べるリポジトリがありません（IssueDeckに接続済みで、権限のあるものがありません）", {
        retryable: false,
        unfinished: "対象リポジトリの判別",
        resume: "IssueDeckの接続とGitHub権限を確認してから、このスレッドへ「再開」と返信してください。",
      });
      return;
    }
    // 対象確認への回答（最後の補足）が名前・owner/repoで答えていれば、それを最優先する。元の投稿に別のアプリ名が
    // 混ざっていても、利用者が選んだ対象で確定する
    const parts = request.text.split(SUPPLEMENT_SEPARATOR);
    const answer =
      parts.length > 1 && request.targetBasis
        ? await resolveTarget(parts[parts.length - 1], candidates, { callModel: async () => ({ ok: false, reason: "回答の解釈はAIを使わない" }) })
        : null;
    const decision =
      answer && (answer.kind === "resolved" || answer.kind === "denied")
        ? { ...answer, basis: `利用者の回答: ${answer.basis}` }
        : await resolveTarget(request.text, candidates, { callModel: targetModelOverride });
    console.info(`[slack-intake] 対象判別 request=${request.id} kind=${decision.kind} basis=${decision.basis}`);
    if (decision.kind === "denied") {
      await db.slackIntakeRequest.update({ where: { id: request.id }, data: { targetBasis: decision.basis } });
      await failRequest(ctx, request, "対象リポジトリの権限確認", `${decision.repo} には起案できません（接続済みで権限のあるリポジトリではありません）`, {
        retryable: true,
        unfinished: "調査とIssueの作成",
        resume: "対象を書き直して、このスレッドへ返信してください（IssueDeckの接続・権限の確認が要る場合は確認後に「再開」と返信）。",
      });
      return;
    }
    if (decision.kind === "ambiguous") {
      const list = decision.options.map((c) => `• ${c.name === c.fullName ? c.fullName : `${c.name}（${c.fullName}）`}`).join("\n");
      const posted = await reply(
        ctx,
        request,
        `対象のリポジトリを一つに絞れませんでした。どれの依頼か、このスレッドへ返信してください（名前かowner/repoだけで構いません。答えがそろえば、そのまま調査して起案します）。\n${list}`,
      );
      await db.slackIntakeRequest.update({
        where: { id: request.id },
        data: { status: "awaiting_repo", selectorTs: posted.ts, selectedRepo: null, targetBasis: decision.basis },
      });
      return;
    }
    next = { ...request, status: "investigating", selectedRepo: decision.repo, targetBasis: decision.basis };
    await db.slackIntakeRequest.update({
      where: { id: request.id },
      data: { status: "investigating", selectedRepo: decision.repo, targetBasis: decision.basis },
    });
  } catch (error) {
    await failRequest(ctx, request, "対象の判別", error instanceof SlackApiError ? error.message : "予期しないエラー", {
      retryable: !(error instanceof SlackApiError) || error.retryable,
      unfinished: "対象リポジトリの判別",
      resume: RESUME_HINT,
    });
    return;
  }
  await runProposal(ctx, next, request.text, null);
}

/** 外部検索セレクト（`/api/slack/options`）用の候補 */
export async function searchRepoOptions(config: SlackConfig, slackUserId: string, query: string) {
  const userId = resolveIssueDeckUser(config, slackUserId);
  if (!userId) return [];
  return filterCandidates(await listRepoCandidates(config, userId), query);
}

/** 起案済み（`done`）の依頼への返信。補足・質問・分割・お礼を振り分ける（受付は`acceptMessageEvent`） */
async function handleFollowUp(ctx: IntakeContext, request: SlackIntakeRequest, text: string, messageTs: string): Promise<void> {
  const kind = classifyFollowUp(text);
  if (kind === "thanks") return;
  if (issuesOf(request).length === 0) {
    // まだIssueが無い（案にまとまらなかった・やめた）ときの返信は、材料を足して案を作り直す
    const combined = `${request.text}\n\n（補足）${text}`;
    await db.slackIntakeRequest.update({ where: { id: request.id }, data: { text: combined, status: "investigating", confirmState: null } });
    await setReaction(ctx.client, { channel: request.channelId, ts: request.parentTs, add: "eyes", remove: "warning" });
    return runProposal(ctx, { ...request, text: combined, status: "investigating" }, combined, null);
  }
  if (kind === "question") return answerQuestion(ctx, request, text);
  if (kind === "split") {
    const primary = issuesOf(request)[0];
    return runProposal(ctx, request, text, primary ? primary.number : null);
  }
  return attachSupplement(ctx, request, text, messageTs);
}

/**
 * 「再開」（`resuming`）。状態は**処理が終わるまで`resuming`のまま**にする（途中で止まったら巡回が拾い直せるように）。
 * 選択UIを出せば`awaiting_repo`、調査が終われば`awaiting_confirm`・`done`・`failed`へ進む
 */
async function resumeRequest(ctx: IntakeContext, request: SlackIntakeRequest): Promise<void> {
  await setReaction(ctx.client, { channel: request.channelId, ts: request.parentTs, add: "eyes", remove: "warning" });
  if (!request.selectedRepo) {
    await decideTarget(ctx, request);
    return;
  }
  await runProposal(ctx, request, request.text, null);
}

async function answerQuestion(ctx: IntakeContext, request: SlackIntakeRequest, text: string): Promise<void> {
  const user = await loadChatUser(request.userId);
  const conversation = request.conversationId
    ? await db.chatConversation.findUnique({ where: { id: request.conversationId } })
    : null;
  if (!user || !conversation) {
    await reply(ctx, request, "⚠️ 会話の記録が見つからず、質問に答えられませんでした。IssueDeckのチャットから確認してください。");
    return;
  }
  try {
    const result = await handleChatMessage({
      user,
      context: parseChatContext(conversation.context),
      text,
      recentUserTexts: [request.text, text],
      history: [],
    });
    await reply(ctx, request, result.text);
  } catch (error) {
    console.error("[slack-intake] 質問への回答に失敗しました", error);
    await reply(ctx, request, "⚠️ 質問への回答に失敗しました。もう一度送ってください。");
  }
}

/** 補足を既存Issueのコメントとして追記する（本文は書き換えない） */
async function attachSupplement(ctx: IntakeContext, request: SlackIntakeRequest, text: string, messageTs: string): Promise<void> {
  const target = issuesOf(request)[0];
  if (!target) return;
  await appendComment(ctx, request, target, `Slackスレッドでの補足:\n\n${quote(text)}\n\n元投稿: ${request.permalink ?? "（取得できませんでした）"}\n<!-- slack-intake-followup: ${messageTs} -->`, "補足");
}

function quote(text: string): string {
  return text.split("\n").map((line) => `> ${line}`).join("\n");
}

async function appendComment(
  ctx: IntakeContext,
  request: SlackIntakeRequest,
  target: IssueRef,
  body: string,
  label: string,
): Promise<boolean> {
  const user = await loadChatUser(request.userId);
  const repository = user ? await findRepositoryByFullName(user.id, target.repo) : null;
  if (!user || !repository) {
    await failRequest(ctx, request, `${label}の反映`, `${target.repo} へのアクセス権がありません`, {
      retryable: false,
      unfinished: `${target.repo}#${target.number} への${label}の反映`,
      resume: "IssueDeckでリポジトリの権限を確認してから、補足をもう一度返信してください。",
    });
    return false;
  }
  const [owner, repo] = target.repo.split("/");
  const result = await withUserGithubToken(user, `slack-intake comment ${target.repo}#${target.number}`, (token) =>
    createComment(owner, repo, target.number, token, { body }),
  ).catch((error: unknown) => ({ error }));
  if ("errorResponse" in result || "error" in result) {
    await failRequest(ctx, request, `GitHubへの${label}の反映`, "GitHub APIが失敗しました", {
      retryable: true,
      unfinished: `${target.repo}#${target.number} への${label}の反映`,
      resume: `${label}をもう一度返信してください。`,
    });
    return false;
  }
  await setReaction(ctx.client, { channel: request.channelId, ts: request.parentTs, add: "white_check_mark", remove: "warning" });
  await reply(ctx, request, `✅ ${label}を <https://github.com/${target.repo}/issues/${target.number}|${target.repo}#${target.number}> へコメントとして追記しました（新しいIssueは作っていません）。`);
  return true;
}

/** 選択UIの操作。block_actionsのペイロードを受ける */
export type SlackInteractionPayload = {
  type: string;
  team?: { id?: string };
  user?: { id?: string };
  channel?: { id?: string };
  container?: { message_ts?: string; thread_ts?: string };
  message?: { ts?: string; thread_ts?: string };
  trigger_id?: string;
  state?: { values?: Record<string, Record<string, { selected_option?: { value?: string } | null }>> };
  actions?: { action_id?: string; value?: string; selected_option?: { value?: string } }[];
};

export async function handleInteraction(ctx: IntakeContext, payload: SlackInteractionPayload): Promise<void> {
  const action = payload.actions?.[0];
  const teamId = payload.team?.id;
  const channelId = payload.channel?.id;
  const slackUserId = payload.user?.id;
  if (!action?.action_id || !teamId || !channelId || !slackUserId) return;
  if (!isAllowedLocation(ctx.config, teamId, channelId)) return;
  const requestId = (action.value ?? "").split(":")[0] || blockRequestId(payload);
  if (!requestId) return;
  const request = await db.slackIntakeRequest.findUnique({ where: { id: requestId } });
  // 依頼者本人の操作だけを受ける（他の人が押しても何も起きない）
  if (!request || request.channelId !== channelId || request.teamId !== teamId || request.slackUserId !== slackUserId) return;

  const id = action.action_id;
  if (id === ACTION_REPO_SELECT) {
    const value = action.selected_option?.value;
    if (value) await db.slackIntakeRequest.updateMany({ where: { id: request.id, status: "awaiting_repo" }, data: { selectedRepo: value } });
    return;
  }
  if (id === ACTION_REPO_CONFIRM) return confirmRepo(ctx, request, payload);
  if (id === ACTION_ISSUE_CONFIRM) return confirmIssue(ctx, request, null);
  if (id === ACTION_ISSUE_CANCEL) return cancelProposal(ctx, request);
  if (id.startsWith(ACTION_ISSUE_ATTACH)) {
    const number = Number((action.value ?? "").split(":")[1]);
    if (Number.isInteger(number)) return confirmIssue(ctx, request, number);
  }
}

function blockRequestId(payload: SlackInteractionPayload): string | null {
  const blockId = Object.keys(payload.state?.values ?? {})[0];
  return blockId?.includes(":") ? blockId.split(":")[1] : null;
}

async function confirmRepo(ctx: IntakeContext, request: SlackIntakeRequest, payload: SlackInteractionPayload): Promise<void> {
  const chosen =
    payload.state?.values?.[`repo:${request.id}`]?.[ACTION_REPO_SELECT]?.selected_option?.value ?? request.selectedRepo;
  if (!chosen) {
    await reply(ctx, request, "⚠️ 対象のリポジトリがまだ選ばれていません。選択メニューで選んでから、もう一度押してください。");
    return;
  }
  // 権限のあるリポジトリだけを受ける（選択肢の改ざん・権限喪失への備え）
  const candidates = await listRepoCandidates(ctx.config, request.userId);
  if (!candidates.some((c) => c.fullName === chosen)) {
    await reply(ctx, request, `⚠️ ${chosen} には起案できません（接続済みで権限のあるリポジトリではありません）。選び直してください。`);
    return;
  }
  const claimed = await db.slackIntakeRequest.updateMany({
    where: { id: request.id, status: "awaiting_repo" },
    data: { status: "investigating", selectedRepo: chosen },
  });
  if (claimed.count !== 1) return;
  const next = { ...request, status: "investigating", selectedRepo: chosen };
  if (request.selectorTs) {
    try {
      await updateBotMessage(ctx.client, {
        channel: request.channelId,
        ts: request.selectorTs,
        slackUserId: request.slackUserId,
        text: `対象リポジトリ: *${chosen}* で確定しました。調査と重複確認を始めます。`,
      });
    } catch {
      // 表示の更新に失敗しても調査は続ける
    }
  }
  await runProposal(ctx, next, request.text, null);
}

/** Slackの起案を調査へ渡すときの指示。Slack専用の定型本文は作らず、既存のChat調査の品質で案を作らせる（#4527） */
const SLACK_PROPOSAL_INSTRUCTION = [
  "上の依頼を {repo} のIssueとして起案したい。承認の前に確認する人はいないので、次を守って調べたうえでIssue案（proposal_kind=\"issue\"）にまとめて。",
  "- 対象リポジトリの現在のコード・関連ドキュメント・規約、open／最近closedの関連Issue、関連PRを実際に読み、現状と要望の差を確かめる。読めなかったものは「確認できなかった」と書き、推測で「実装がない」と断定しない",
  "- マージ済み・本番未反映・実装中・未実装を区別する。同じ成果を扱うIssueやPRが既にあるなら、Issue案は作らず（proposal_kind=\"none\"）、そのリンクと状態を返信で報告する",
  "- 未解決の部分だけを、目的・背景・要件・対象範囲・観測可能な完了条件に整理し、根拠リンクと未確認事項を本文へ残す。依頼にない仕様を足さない",
  "- タイトルは元投稿の切り取りにせず、調査結果と依頼の目的から「何を直す／実現するか」が分かる簡潔な日本語にし、このリポジトリの既存Issueの命名慣例に合わせる",
  "- 添付は名称しか取得していない。画像などの内容を読んだ根拠にしない",
].join("\n");

/** 返信用に、案の本文から要点（見出し以外の先頭数行）を取り出す */
function summarizeBody(body: string): string {
  const lines = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("<!--") && !line.startsWith("---"));
  return lines.slice(0, 3).join("\n").slice(0, 400);
}

/**
 * 調査→重複確認→Issue案→**承認なしの自動起案**（#4527）。調査が成立しなかったとき（AI停止・調査の中断・定型の
 * フォールバック案・根拠ゼロ）は、未調査の案を作らず理由と再開方法を返す。案に似た既存Issueがあるときも作らず、
 * そのリンクと状態を返して止める（`splitFrom`の別成果として明示された案は、元のIssueを除いて照合する）。
 */
async function runProposal(ctx: IntakeContext, request: SlackIntakeRequest, text: string, splitFrom: number | null): Promise<void> {
  const repo = request.selectedRepo;
  const user = await loadChatUser(request.userId);
  const candidates = await listRepoCandidates(ctx.config, request.userId);
  if (!repo || !user || !candidates.some((c) => c.fullName === repo) || !(await findRepositoryByFullName(user.id, repo))) {
    await failRequest(ctx, request, "対象リポジトリの権限確認", `${repo ?? "対象"} にアクセスできません`, {
      retryable: false,
      unfinished: "調査とIssueの作成",
      resume: "IssueDeckで権限を確認してから、このスレッドへ「再開」と返信してください。",
    });
    return;
  }
  // 元投稿のpermalinkで既存Issueを探す（併存する自動処理が先に起案した分も拾う）
  if (splitFrom === null && request.permalink) {
    const existing = await db.issue.findFirst({
      where: { body: { contains: request.permalink }, repository: { fullName: repo } },
      select: { number: true, title: true, htmlUrl: true, state: true },
    });
    if (existing) {
      await db.slackIntakeRequest.update({
        where: { id: request.id },
        data: { status: "done", issues: [{ repo, number: existing.number, role: "reused" }] },
      });
      await setReaction(ctx.client, { channel: request.channelId, ts: request.parentTs, add: "white_check_mark", remove: "eyes" });
      await reply(ctx, request, `✅ この投稿は既に <${existing.htmlUrl}|${repo}#${existing.number}>（${existing.state === "OPEN" ? "open" : "closed"}）として起案済みです。新しいIssueは作りません。`);
      return;
    }
  }
  const stopInvestigation = async (stage: string, reason: string) =>
    failRequest(ctx, request, stage, reason, {
      retryable: true,
      unfinished: "調査とIssueの作成（未調査の案は作成していません）",
      resume: "時間をおいて、このスレッドへ「再開」と返信してください（補足を返信すると、その内容を加えて調べ直します）。",
    });
  try {
    const conversation = await ensureConversation(request, repo);
    const context = parseChatContext(conversation.context);
    const prompt = `${text}\n\n${SLACK_PROPOSAL_INSTRUCTION.replace("{repo}", repo)}`;
    const result = await handleChatMessage({ user, context, text: prompt, recentUserTexts: [text], history: [] });
    await saveTurn(conversation.id, text, result.text, result.cards, result.nextContext);
    if (result.unavailable) {
      await stopInvestigation("調査", `AIが使えず調査できませんでした: ${result.text.slice(0, 200)}`);
      return;
    }
    const investigation = result.cards.find((c): c is ChatInvestigationCard => c.type === "investigation");
    if (investigation && investigation.stopReason) {
      await stopInvestigation("調査", `調査が途中で止まりました: ${investigation.stopReason.slice(0, 200)}`);
      return;
    }
    const card = result.cards.find((c): c is IssueCard => c.type === "confirm_issue");
    if (!card) {
      // 案にならなかった。既存の対応で足りる・情報不足のどちらもあり得るので、調査の説明をそのまま返す
      await db.slackIntakeRequest.update({ where: { id: request.id }, data: { status: "done" } });
      await setReaction(ctx.client, { channel: request.channelId, ts: request.parentTs, add: "warning", remove: "eyes" });
      await reply(ctx, request, `⚠️ 新しいIssueは作りませんでした（既に対応中・対応済みの内容か、案にまとめる情報が足りない場合です）。\n${result.text}\n\n追加の情報をこのスレッドへ返信すると、続けて調べ直します。`);
      return;
    }
    if (result.draftFallback || !investigation || investigation.evidence.length === 0) {
      await stopInvestigation("調査", "実装・関連Issueを読んだ根拠を得られず、調査済みの案にできませんでした");
      return;
    }
    if (card.repo !== repo) {
      await failRequest(ctx, request, "Issue案の起案先確認", "選択したリポジトリとIssue案の起案先が一致しません", {
        retryable: true,
        unfinished: "選択したリポジトリでのIssue案の作成",
        resume: RESUME_HINT,
      });
      return;
    }
    const duplicates = (card.duplicates ?? []).filter((d) => d.number !== splitFrom);
    if (duplicates.length > 0) {
      // 重複の判定はコード側に置く。似た既存Issueがあるときは作らず、状態とリンクを返す（先頭へ以後の補足を反映する）
      await db.slackIntakeRequest.update({
        where: { id: request.id },
        data: { status: "done", issues: [...issuesOf(request), { repo, number: duplicates[0].number, role: "reused" }] },
      });
      await setReaction(ctx.client, { channel: request.channelId, ts: request.parentTs, add: "white_check_mark", remove: "eyes" });
      await reply(
        ctx,
        request,
        `✅ 同じ内容を扱っていそうな既存のIssueがあるため、新しいIssueは作りませんでした。\n${duplicates.map((d) => `• <${d.htmlUrl}|${repo}#${d.number} ${d.title}>（${d.state === "OPEN" ? "open" : d.state}）`).join("\n")}\n補足はこのスレッドへ返信すると #${duplicates[0].number} へコメントとして追記します。別の成果なら「別件」と書いて返信してください。`,
      );
      return;
    }
    if (previewModeGuard()) {
      await failRequest(ctx, request, "Issueの作成", "この環境（プレビュー）では書き込みを止めています", {
        retryable: false,
        unfinished: "Issueの作成",
        resume: "本番の環境で投稿してください。",
      });
      return;
    }
    // 承認は挟まず、確認済みの操作として保存してから作成する（保存後にプロセスが止まっても巡回が照合して再開する）
    const stored: StoredProposal = { card, splitFrom, attachTo: null, confirmationId: randomUUID() };
    const proposal = JSON.parse(JSON.stringify(stored));
    const claimed = await db.slackIntakeRequest.updateMany({
      where: { id: request.id, status: { in: ["investigating", "resuming"] } },
      data: { status: "confirming", confirmState: "queued", proposal, failure: null },
    });
    if (claimed.count !== 1) return;
    await runConfirmation(ctx, { ...request, status: "confirming", confirmState: "queued", proposal });
  } catch (error) {
    await failRequest(ctx, request, "調査・Issue案の作成", error instanceof SlackApiError ? error.message : "予期しないエラー", {
      retryable: true,
      unfinished: "調査とIssue案の作成",
      resume: RESUME_HINT,
    });
  }
}

async function ensureConversation(request: SlackIntakeRequest, repo: string) {
  if (request.conversationId) {
    const existing = await db.chatConversation.findUnique({ where: { id: request.conversationId } });
    // 対象が変わったときは、以前のリポジトリの調査結果・案を流用しない
    if (existing && existing.repo === repo) return existing;
  }
  const created = await db.chatConversation.create({
    data: {
      userId: request.userId,
      title: `Slack起案: ${request.text.replace(/\s+/g, " ").slice(0, 60)}`,
      repo,
      context: { repo, targets: [], actions: [] },
      memory: {},
    },
  });
  await db.slackIntakeRequest.update({ where: { id: request.id }, data: { conversationId: created.id } });
  return created;
}

async function saveTurn(conversationId: string, userText: string, replyText: string, cards: unknown[], context: ChatContext) {
  await db.$transaction([
    db.chatMessage.create({ data: { conversationId, role: "user", text: userText.slice(0, 2000) } }),
    db.chatMessage.create({
      data: { conversationId, role: "assistant", text: replyText, cards: JSON.parse(JSON.stringify(cards)) },
    }),
    db.chatConversation.update({
      where: { id: conversationId },
      data: { context: JSON.parse(JSON.stringify(context)), version: { increment: 1 } },
    }),
  ]);
}

async function cancelProposal(ctx: IntakeContext, request: SlackIntakeRequest): Promise<void> {
  const claimed = await db.slackIntakeRequest.updateMany({
    where: { id: request.id, confirmState: "pending" },
    data: { confirmState: "cancelled", status: "done" },
  });
  if (claimed.count !== 1) return;
  await setReaction(ctx.client, { channel: request.channelId, ts: request.parentTs, add: "white_check_mark", remove: "warning" });
  await reply(ctx, request, "やめました。Issueは作っていません。");
}

/** 「この案で起案する」（`attachTo`があれば既存Issueへ追記）。**`pending`→`queued`を取れた1回だけ**保存して実行する */
async function confirmIssue(ctx: IntakeContext, request: SlackIntakeRequest, attachTo: number | null): Promise<void> {
  const guard = previewModeGuard();
  if (guard) {
    await reply(ctx, request, "⚠️ この環境（プレビュー）では書き込みを止めています。");
    return;
  }
  const stored = proposalOf(request);
  const repo = request.selectedRepo;
  if (!stored || !repo) return;
  // 保存済みの案も信用せず、確認ボタンからGitHubを更新する前に再検証する。
  if (stored.card.repo !== repo) {
    await failRequest(ctx, request, "Issue案の起案先確認", "選択したリポジトリと保存済みのIssue案の起案先が一致しません", {
      retryable: true,
      unfinished: "選択したリポジトリでのIssue案の作成",
      resume: RESUME_HINT,
    });
    return;
  }
  const queued = await queueConfirmation(request, attachTo);
  if (!queued) return;
  await runConfirmation(ctx, queued);
}

async function queueConfirmation(request: SlackIntakeRequest, attachTo: number | null): Promise<SlackIntakeRequest | null> {
  const stored = proposalOf(request);
  if (!stored || !request.selectedRepo) return null;
  const proposal = JSON.parse(JSON.stringify({ ...stored, attachTo, confirmationId: stored.confirmationId ?? randomUUID() }));
  const claimed = await db.slackIntakeRequest.updateMany({
    where: { id: request.id, status: { in: ["awaiting_confirm", "failed"] }, confirmState: "pending" },
    data: { status: "confirming", confirmState: "queued", proposal, failure: null },
  });
  return claimed.count === 1 ? { ...request, status: "confirming", confirmState: "queued", proposal } : null;
}

/** 起案確定だけはack前にDBへ保存する。戻り値undefinedは対象外、nullは無視、文字列は処理待ちの依頼ID。 */
export async function acceptIssueConfirmation(config: SlackConfig, payload: SlackInteractionPayload): Promise<string | null | undefined> {
  const action = payload.actions?.[0];
  const actionId = action?.action_id ?? "";
  if (actionId !== ACTION_ISSUE_CONFIRM && !actionId.startsWith(ACTION_ISSUE_ATTACH)) return undefined;
  if (previewModeGuard()) return null;
  const team = payload.team?.id, channel = payload.channel?.id, user = payload.user?.id;
  if (!team || !channel || !user || !isAllowedLocation(config, team, channel)) return null;
  const requestId = (action?.value ?? "").split(":")[0];
  if (!requestId) return null;
  const request = await db.slackIntakeRequest.findUnique({ where: { id: requestId } });
  if (!request || request.teamId !== team || request.channelId !== channel || request.slackUserId !== user) return null;
  const attachTo = actionId === ACTION_ISSUE_CONFIRM ? null : Number((action?.value ?? "").split(":")[1]);
  if (attachTo !== null && (!Number.isInteger(attachTo) || attachTo <= 0)) return null;
  return (await queueConfirmation(request, attachTo))?.id ?? null;
}

async function runConfirmation(ctx: IntakeContext, request: SlackIntakeRequest): Promise<void> {
  try {
    await performConfirmation(ctx, request);
  } catch (error) {
    const latest = await db.slackIntakeRequest.findUnique({ where: { id: request.id } });
    if (latest?.status === "done") {
      console.error(`[slack-intake] 保存済みの完了結果の通知に失敗しました request=${request.id}`, error);
      return;
    }
    // GitHub側だけ成功した可能性がある。状態を残し、次の巡回でRESTから照合する。
    await db.slackIntakeRequest.update({ where: { id: request.id }, data: { failure: "Issue確定の処理が中断しました。既存の更新を確認して再開します。" } });
    console.error(`[slack-intake] Issue確定を再開待ちにします request=${request.id}`, error);
    await reply(ctx, request, "⚠️ 起案確定の完了を確認できませんでした。依頼と確認した操作は保存済みです。30分以上停止した処理は巡回が既存Issue・コメントを確認して再開します。");
  }
}

async function performConfirmation(ctx: IntakeContext, request: SlackIntakeRequest): Promise<void> {
  const stored = proposalOf(request);
  const repo = request.selectedRepo;
  if (!stored || !repo || stored.card.repo !== repo) {
    await failRequest(ctx, request, "Issue案の起案先確認", "選択したリポジトリと保存済みのIssue案の起案先が一致しません", { retryable: true, unfinished: "Issue案の作成", resume: RESUME_HINT });
    return;
  }
  await db.slackIntakeRequest.update({ where: { id: request.id }, data: { confirmState: "processing" } });
  const attachTo = stored.attachTo ?? null;
  if (!stored.confirmationId) throw new Error("確認済み操作の識別子がありません");
  const marker = `<!-- slack-intake-confirm: ${request.id}/${stored.confirmationId} -->`;
  const revert = () => db.slackIntakeRequest.update({ where: { id: request.id }, data: { confirmState: "pending" } });

  const user = await loadChatUser(request.userId);
  const allowed = (await listRepoCandidates(ctx.config, request.userId)).some((c) => c.fullName === repo);
  if (!user || !allowed || !(await findRepositoryByFullName(user.id, repo))) {
    await revert();
    await failRequest(ctx, request, "対象リポジトリの権限確認", `${repo} にアクセスできません`, {
      retryable: false,
      unfinished: "Issueの作成",
      resume: "権限を確認してから、このスレッドへ「再開」と返信してください。",
    });
    return;
  }

  if (attachTo !== null) {
    const [owner, name] = repo.split("/");
    const comments = await withUserGithubToken(user, `slack-intake reconcile-comment ${repo}`, (token) => fetchCommentsForIssue(owner, name, attachTo, token));
    if (!("value" in comments)) throw new Error("GitHubコメントの既存更新を確認できません");
    const existing = comments.value.some((comment) => comment.body?.includes(marker));
    if (!existing) {
      const result = await withUserGithubToken(user, `slack-intake confirm-comment ${repo}`, (token) => createComment(owner, name, attachTo, token, {
        body: `Slackの依頼を既存Issueへの追記として受けました。\n\n${quote(request.text)}\n\n元投稿: ${request.permalink ?? "（取得できませんでした）"}\n${FOOTER_MARKER(request)}\n${marker}`,
      }));
      if (!("value" in result)) throw new Error("GitHubへの追記結果を確認できません");
    }
    const attached = { ...request, issues: [...issuesOf(request), { repo, number: attachTo, role: "reused" }] };
    await db.slackIntakeRequest.update({
      where: { id: request.id },
      data: { status: "done", confirmState: "reply_pending", issues: attached.issues },
    });
    await deliverResult(ctx, attached);
    return;
  }

  const splitNote = stored.splitFrom
    ? `\n\n分割元: #${stored.splitFrom}（同一Slackスレッドで、既存Issueと独立して実装・検証できる別成果のため分割）`
    : "";
  const body = `${stored.card.body}${splitNote}\n\n---\nSlackの元投稿: ${request.permalink ?? "（取得できませんでした）"}\n${FOOTER_MARKER(request)}\n${marker}`;
  const [owner, name] = repo.split("/");
  // 検索索引・ローカルDBは遅延するため、closedを含むREST一覧から識別子を照合する。
  const issues = await withUserGithubToken(user, `slack-intake reconcile-issue ${repo}`, (token) => fetchIssuesForRepo(owner, name, token));
  if (!("value" in issues)) throw new Error("GitHub Issueの既存更新を確認できません");
  const matches = issues.value.filter((issue) => issue.body?.includes(marker));
  if (matches.length > 1) throw new Error("同じ起案操作に複数のIssueが対応しています");
  const existing = matches[0];
  const outcome = existing ? {
    ok: true,
    text: `Issue #${existing.number} の作成済み結果を回復しました。`,
    action: { type: "create_issue", status: "created", repo, number: existing.number, at: new Date().toISOString(), message: "中断したSlack起案を回復" },
  } : await executeConfirmedCard(user, stored.card, { body });
  if (!outcome.ok || outcome.action.number === null) {
    throw new Error(outcome.text.slice(0, 300));
  }
  const created: IssueRef = { repo, number: outcome.action.number, role: stored.splitFrom ? "split" : "primary" };
  const finished = { ...request, issues: [...issuesOf(request), created] };
  // Issue番号とdoneを先に保存する。結果返信だけが失敗しても`reply_pending`で残り、巡回が返信だけを再送する（Issueは作り直さない）
  await db.slackIntakeRequest.update({
    where: { id: request.id },
    data: { status: "done", confirmState: "reply_pending", issues: finished.issues },
  });
  if (request.conversationId) {
    const latest = await db.chatConversation.findUnique({ where: { id: request.conversationId } });
    if (latest) {
      const context = parseChatContext(latest.context);
      await db.chatConversation.update({
        where: { id: latest.id },
        data: { context: JSON.parse(JSON.stringify({ ...context, actions: [...context.actions, outcome.action].slice(-20) })), version: { increment: 1 } },
      });
    }
  }
  if (stored.splitFrom) await linkSplit(ctx, request, user, repo, stored.splitFrom, created.number);
  await deliverResult(ctx, finished);
}

/** 起案・追記の結果をSlackへ返す。成功したら`confirmState`を`done`にし、失敗したら`reply_pending`のまま残す（#4527） */
async function deliverResult(ctx: IntakeContext, request: SlackIntakeRequest): Promise<void> {
  try {
    await setReaction(ctx.client, { channel: request.channelId, ts: request.parentTs, add: "white_check_mark", remove: "warning" });
    await reply(ctx, request, resultText(request));
  } catch (error) {
    console.error(`[slack-intake] 結果の返信に失敗しました（Issueは作成済み。巡回が返信だけ再送します） request=${request.id}`, error instanceof SlackApiError ? error.code : error);
    return;
  }
  await db.slackIntakeRequest.update({ where: { id: request.id }, data: { confirmState: "done" } });
}

/** 完了返信の本文。保存済みの案とIssue記録だけから組み立てるので、再送でも同じ内容になる */
function resultText(request: SlackIntakeRequest): string {
  const ref = issuesOf(request).at(-1);
  const stored = proposalOf(request);
  if (!ref) return "✅ 完了しました。";
  const link = `<https://github.com/${ref.repo}/issues/${ref.number}|${ref.repo}#${ref.number}>`;
  if (ref.role === "reused") return `✅ 依頼を ${link} への追記として確認しました（新しいIssueは作っていません）。`;
  const lines = [`✅ こういう内容で起案しました。`, `• 対象: ${ref.repo}`];
  if (stored) {
    lines.push(`• タイトル: ${stored.card.title}`);
    const summary = summarizeBody(stored.card.body);
    if (summary) lines.push(`• 要点:\n${summary.split("\n").map((line) => `  ${line}`).join("\n")}`);
  }
  lines.push(`• Issue: ${link}${stored?.splitFrom ? `（#${stored.splitFrom} と相互にリンクしました）` : ""}`);
  lines.push("同じスレッドへ補足を返信すると、このIssueへコメントとして追記します。");
  return lines.join("\n");
}

/** 結果返信だけが未送信（`reply_pending`）の依頼へ、返信だけを再送する。処理権は`updatedAt`で取る */
export async function resendPendingReplies(ctx: IntakeContext, now: Date = new Date()): Promise<number> {
  const staleBefore = new Date(now.getTime() - PENDING_STALE_MS.received);
  const rows = await db.slackIntakeRequest.findMany({
    where: { status: "done", confirmState: "reply_pending", updatedAt: { lt: staleBefore } },
    orderBy: { updatedAt: "asc" },
    take: 10,
  });
  let sent = 0;
  for (const row of rows) {
    const claimed = await db.slackIntakeRequest.updateMany({
      where: { id: row.id, status: "done", confirmState: "reply_pending", updatedAt: row.updatedAt },
      data: { updatedAt: now },
    });
    if (claimed.count !== 1) continue;
    await deliverResult(ctx, row);
    sent += 1;
  }
  return sent;
}

async function linkSplit(ctx: IntakeContext, request: SlackIntakeRequest, user: ChatUser, repo: string, from: number, to: number): Promise<void> {
  const [owner, name] = repo.split("/");
  await withUserGithubToken(user, `slack-intake split-link ${repo}`, (token) =>
    createComment(owner, name, from, token, {
      body: `同じSlackスレッドの別成果を #${to} として分割しました（独立して実装・検証できるため）。\n${FOOTER_MARKER(request)}`,
    }),
  ).catch((error: unknown) => console.error("[slack-intake] 分割元へのリンクコメントに失敗しました", error));
}
