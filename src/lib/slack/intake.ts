import { Prisma, type SlackIntakeRequest } from "@prisma/client";

import { executeConfirmedCard, handleChatMessage, type ChatUser } from "@/lib/chat/handlers";
import { parseChatContext } from "@/lib/chat/store";
import type { ChatConfirmCard, ChatContext } from "@/lib/chat/types";
import { db } from "@/lib/db";
import { createComment } from "@/lib/github/issues-api";
import { findRepositoryByFullName } from "@/lib/github/issue-create-service";
import { withUserGithubToken } from "@/lib/github/with-user-github-token";
import { previewModeGuard } from "@/lib/preview-mode";
import {
  ACTION_ISSUE_ATTACH,
  ACTION_ISSUE_CANCEL,
  ACTION_ISSUE_CONFIRM,
  ACTION_REPO_CONFIRM,
  ACTION_REPO_SELECT,
  proposalBlocks,
  repoSelectorBlocks,
} from "@/lib/slack/blocks";
import { filterCandidates, guessRepo, listRepoCandidates } from "@/lib/slack/candidates";
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

/**
 * Slackの`#アプリissue起案`からのIssue起案（#4454）。
 *
 * - **依頼単位**は親投稿の`teamId + channelId + parentTs`（DBの一意制約）。処理済みイベントも記録して再送を無視する
 * - **対象リポジトリが確定するまでIssueは作らない。** 確定は利用者が選択UIで押した`owner/repo`だけが正本
 * - 調査・Issue案づくりは既存のIssueDeck Chat（`handleChatMessage`）を呼ぶだけ。**作成は人が押す「この案で起案する」**
 *   で初めて走り、`confirmState`の`pending`→`done`を取れた1回だけ`executeConfirmedCard`を呼ぶ
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
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
    throw error;
  }
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

const RESUME_HINT = "このスレッドへ「再開」と返信してください。";

/** 新規の親投稿を受けて、受付→対象選択UIまでを出す */
export async function handleNewRequest(ctx: IntakeContext, teamId: string, event: SlackMessageEvent): Promise<void> {
  const { config, client } = ctx;
  if (!event.channel || !event.ts || !event.user) return;
  if (!isAllowedLocation(config, teamId, event.channel)) return;
  const userId = resolveIssueDeckUser(config, event.user);
  if (!userId) {
    console.warn("[slack-intake] IssueDeckに対応付いていないSlackユーザーの投稿を無視しました");
    return;
  }
  const files = (event.files ?? []).map((f) => `添付: ${f.name ?? "名称不明"}（内容は未取得・未確認）`);
  const text = [(event.text ?? "").trim(), ...files].filter(Boolean).join("\n\n");
  if (!text) return;

  let request: SlackIntakeRequest;
  try {
    request = await db.slackIntakeRequest.create({
      data: {
        teamId,
        channelId: event.channel,
        parentTs: event.ts,
        slackUserId: event.user,
        userId,
        text,
        status: "awaiting_repo",
        issues: [],
        permalink: await fetchPermalink(client, event.channel, event.ts),
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return;
    throw error;
  }
  await setReaction(client, { channel: event.channel, ts: event.ts, add: "eyes" });
  await postSelector(ctx, request);
}

async function postSelector(ctx: IntakeContext, request: SlackIntakeRequest): Promise<void> {
  try {
    const candidates = await listRepoCandidates(ctx.config, request.userId);
    if (candidates.length === 0) {
      await failRequest(ctx, request, "対象リポジトリの候補づくり", "選べるリポジトリがありません（IssueDeckに接続済みで、権限のあるものがありません）", {
        retryable: false,
        unfinished: "対象リポジトリの選択",
        resume: "IssueDeckの接続とGitHub権限を確認してから、このスレッドへ「再開」と返信してください。",
      });
      return;
    }
    const guess = guessRepo(request.text, candidates);
    const posted = await reply(
      ctx,
      request,
      "受け付けました。起案する*対象リポジトリ*を選んでください。選ぶまでIssueは作りません。",
      repoSelectorBlocks({ requestId: request.id, candidates, selected: guess, guessed: guess !== null }),
    );
    await db.slackIntakeRequest.update({ where: { id: request.id }, data: { selectorTs: posted.ts, selectedRepo: null } });
  } catch (error) {
    await failRequest(ctx, request, "対象選択UIの投稿", error instanceof SlackApiError ? error.message : "予期しないエラー", {
      retryable: !(error instanceof SlackApiError) || error.retryable,
      unfinished: "対象リポジトリの選択",
      resume: RESUME_HINT,
    });
  }
}

/** 外部検索セレクト（`/api/slack/options`）用の候補 */
export async function searchRepoOptions(config: SlackConfig, slackUserId: string, query: string) {
  const userId = resolveIssueDeckUser(config, slackUserId);
  if (!userId) return [];
  return filterCandidates(await listRepoCandidates(config, userId), query);
}

/** スレッド返信 */
export async function handleThreadReply(ctx: IntakeContext, teamId: string, event: SlackMessageEvent): Promise<void> {
  if (!event.channel || !event.ts || !event.thread_ts || !event.user) return;
  if (!isAllowedLocation(ctx.config, teamId, event.channel)) return;
  const request = await db.slackIntakeRequest.findUnique({
    where: { teamId_channelId_parentTs: { teamId, channelId: event.channel, parentTs: event.thread_ts } },
  });
  if (!request || request.slackUserId !== event.user) return;
  const text = (event.text ?? "").trim();
  if (!text) return;

  if (request.status === "failed" && RESUME_WORDS.test(text)) {
    await resumeRequest(ctx, request);
    return;
  }
  if (request.status !== "done") {
    // 選択前・調査中・確認待ちの補足は、起案の材料へ足す（新しいIssueにはしない）
    await db.slackIntakeRequest.update({ where: { id: request.id }, data: { text: `${request.text}\n\n（補足）${text}` } });
    return;
  }

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
  return attachSupplement(ctx, request, text, event.ts);
}

async function resumeRequest(ctx: IntakeContext, request: SlackIntakeRequest): Promise<void> {
  await setReaction(ctx.client, { channel: request.channelId, ts: request.parentTs, add: "eyes", remove: "warning" });
  if (!request.selectedRepo) {
    await db.slackIntakeRequest.update({ where: { id: request.id }, data: { status: "awaiting_repo", failure: null } });
    await postSelector(ctx, request);
    return;
  }
  await db.slackIntakeRequest.update({ where: { id: request.id }, data: { status: "investigating", failure: null } });
  await runProposal(ctx, { ...request, status: "investigating" }, request.text, null);
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

/** 調査→重複確認→Issue案の提示。**ここではIssueを作らない** */
async function runProposal(ctx: IntakeContext, request: SlackIntakeRequest, text: string, splitFrom: number | null): Promise<void> {
  const repo = request.selectedRepo;
  const user = await loadChatUser(request.userId);
  if (!repo || !user || !(await findRepositoryByFullName(user.id, repo))) {
    await failRequest(ctx, request, "対象リポジトリの権限確認", `${repo ?? "対象"} にアクセスできません`, {
      retryable: false,
      unfinished: "調査とIssue案の作成",
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
  try {
    const conversation = await ensureConversation(request, repo);
    const context = parseChatContext(conversation.context);
    const prompt = `${text}\n\n上の依頼を ${repo} のIssueとして起案したい。実装の現状と重複するIssueを調べて、Issue案にまとめて。`;
    const result = await handleChatMessage({ user, context, text: prompt, recentUserTexts: [text], history: [] });
    await saveTurn(conversation.id, text, result.text, result.cards, result.nextContext);
    const card = result.cards.find((c): c is IssueCard => c.type === "confirm_issue");
    if (!card) {
      await db.slackIntakeRequest.update({ where: { id: request.id }, data: { status: "done" } });
      await setReaction(ctx.client, { channel: request.channelId, ts: request.parentTs, add: "warning", remove: "eyes" });
      await reply(ctx, request, `⚠️ Issue案にはまとまりませんでした（Issueは作っていません）。\n${result.text}\n\n追加の情報をこのスレッドへ返信すると、続けてIssue案を作り直します。`);
      return;
    }
    const stored: StoredProposal = { card, splitFrom };
    await db.slackIntakeRequest.update({
      where: { id: request.id },
      data: { status: "awaiting_confirm", proposal: JSON.parse(JSON.stringify(stored)), confirmState: "pending" },
    });
    await setReaction(ctx.client, { channel: request.channelId, ts: request.parentTs, add: "warning", remove: "eyes" });
    const duplicates = card.duplicates ?? [];
    const dupText = duplicates.length
      ? `\n\n*似た既存Issue*\n${duplicates.map((d) => `• <${d.htmlUrl}|#${d.number} ${d.title}>（${d.state}）`).join("\n")}`
      : "";
    const splitText = splitFrom ? `\n\n同じスレッドの別成果として、#${splitFrom} とは別のIssueにする案です（独立して実装・検証できるため）。` : "";
    await reply(
      ctx,
      request,
      `⚠️ 確認をお願いします。起案先: *${repo}*\n*${card.title}*\n${card.body.slice(0, 1500)}${dupText}${splitText}\n\nこの案で作ってよければ「この案で起案する」を押してください（押すまでIssueは作りません）。`,
      proposalBlocks({ requestId: request.id, duplicates }),
    );
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
    if (existing) return existing;
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

/** 「この案で起案する」（`attachTo`があれば既存Issueへ追記）。**`pending`→`done`を取れた1回だけ**実行する */
async function confirmIssue(ctx: IntakeContext, request: SlackIntakeRequest, attachTo: number | null): Promise<void> {
  const guard = previewModeGuard();
  if (guard) {
    await reply(ctx, request, "⚠️ この環境（プレビュー）では書き込みを止めています。");
    return;
  }
  const stored = proposalOf(request);
  const repo = request.selectedRepo;
  if (!stored || !repo) return;
  const claimed = await db.slackIntakeRequest.updateMany({
    where: { id: request.id, confirmState: "pending" },
    data: { confirmState: "done" },
  });
  if (claimed.count !== 1) return;
  const revert = () => db.slackIntakeRequest.update({ where: { id: request.id }, data: { confirmState: "pending" } });

  const user = await loadChatUser(request.userId);
  if (!user || !(await findRepositoryByFullName(user.id, repo))) {
    await revert();
    await failRequest(ctx, request, "対象リポジトリの権限確認", `${repo} にアクセスできません`, {
      retryable: false,
      unfinished: "Issueの作成",
      resume: "権限を確認してから、このスレッドへ「再開」と返信してください。",
    });
    return;
  }

  if (attachTo !== null) {
    const ok = await appendComment(
      ctx,
      request,
      { repo, number: attachTo, role: "reused" },
      `Slackの依頼を既存Issueへの追記として受けました。\n\n${quote(request.text)}\n\n元投稿: ${request.permalink ?? "（取得できませんでした）"}\n${FOOTER_MARKER(request)}`,
      "依頼内容",
    );
    if (!ok) await revert();
    else
      await db.slackIntakeRequest.update({
        where: { id: request.id },
        data: { status: "done", issues: [...issuesOf(request), { repo, number: attachTo, role: "reused" }] },
      });
    return;
  }

  const splitNote = stored.splitFrom
    ? `\n\n分割元: #${stored.splitFrom}（同一Slackスレッドで、既存Issueと独立して実装・検証できる別成果のため分割）`
    : "";
  const body = `${stored.card.body}${splitNote}\n\n---\nSlackの元投稿: ${request.permalink ?? "（取得できませんでした）"}\n${FOOTER_MARKER(request)}`;
  const outcome = await executeConfirmedCard(user, stored.card, { body });
  if (!outcome.ok || outcome.action.number === null) {
    await revert();
    await failRequest(ctx, request, "GitHubへのIssue作成", outcome.text.slice(0, 300), {
      retryable: true,
      unfinished: "Issueの作成",
      resume: "もう一度「この案で起案する」を押してください（押し直せます）。",
    });
    return;
  }
  const created: IssueRef = { repo, number: outcome.action.number, role: stored.splitFrom ? "split" : "primary" };
  await db.slackIntakeRequest.update({
    where: { id: request.id },
    data: { status: "done", issues: [...issuesOf(request), created] },
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
  await setReaction(ctx.client, { channel: request.channelId, ts: request.parentTs, add: "white_check_mark", remove: "warning" });
  await reply(ctx, request, `✅ ${outcome.text}\n<https://github.com/${repo}/issues/${created.number}|${repo}#${created.number}>${stored.splitFrom ? `（#${stored.splitFrom} と相互にリンクしました）` : ""}\n同じスレッドへ補足を返信すると、このIssueへコメントとして追記します。`);
}

async function linkSplit(ctx: IntakeContext, request: SlackIntakeRequest, user: ChatUser, repo: string, from: number, to: number): Promise<void> {
  const [owner, name] = repo.split("/");
  await withUserGithubToken(user, `slack-intake split-link ${repo}`, (token) =>
    createComment(owner, name, from, token, {
      body: `同じSlackスレッドの別成果を #${to} として分割しました（独立して実装・検証できるため）。\n${FOOTER_MARKER(request)}`,
    }),
  ).catch((error: unknown) => console.error("[slack-intake] 分割元へのリンクコメントに失敗しました", error));
}

/** スレッド返信・新規投稿のイベント振り分け（Botの投稿・編集・リンク展開は無視する） */
export async function handleMessageEvent(ctx: IntakeContext, teamId: string, event: SlackMessageEvent): Promise<void> {
  if (event.type !== "message") return;
  if (event.bot_id || event.app_id) return;
  if (event.subtype && event.subtype !== "file_share") return;
  if (!event.user || !event.ts) return;
  if (event.thread_ts && event.thread_ts !== event.ts) return handleThreadReply(ctx, teamId, event);
  return handleNewRequest(ctx, teamId, event);
}
