/**
 * Slack Web APIの最小クライアント（#4454）。SDKは入れず`fetch`で呼ぶ。
 *
 * **投稿はBotトークンのBot名義だけ**。人間へのなりすまし（`as_user`・`username`の上書き）はしない。
 * 全ての返信は`postBotReply`を通り、依頼者へのメンション（`<@USER_ID>`）が必ず付く。
 * トークンは`Authorization`ヘッダーにだけ載せ、エラーメッセージ・ログへ出さない。
 */

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(`Slack API ${method} が失敗しました（${code}）`);
  }
}

const RETRYABLE = new Set(["ratelimited", "service_unavailable", "internal_error", "fatal_error", "request_timeout"]);

export type SlackBlock = Record<string, unknown>;

export type SlackClient = {
  call<T = Record<string, unknown>>(method: string, body: Record<string, unknown>): Promise<T>;
};

export function createSlackClient(botToken: string, fetchImpl: typeof fetch = fetch): SlackClient {
  return {
    async call<T = Record<string, unknown>>(method: string, body: Record<string, unknown>): Promise<T> {
      let response: Response;
      try {
        response = await fetchImpl(`https://slack.com/api/${method}`, {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${botToken}` },
          body: JSON.stringify(body),
        });
      } catch {
        throw new SlackApiError(method, "network_error", true);
      }
      if (response.status === 429 || response.status >= 500) {
        throw new SlackApiError(method, `http_${response.status}`, true);
      }
      const json = (await response.json().catch(() => null)) as ({ ok?: boolean; error?: string } & T) | null;
      if (!json || json.ok !== true) {
        const code = json?.error ?? "invalid_response";
        throw new SlackApiError(method, code, RETRYABLE.has(code));
      }
      return json;
    },
  };
}

/** 本文の先頭へ依頼者のメンションを付ける（既に付いていれば重ねない） */
export function withMention(slackUserId: string, text: string): string {
  const mention = `<@${slackUserId}>`;
  return text.startsWith(mention) ? text : `${mention} ${text}`;
}

export async function postBotReply(
  client: SlackClient,
  params: { channel: string; threadTs: string; slackUserId: string; text: string; blocks?: SlackBlock[] },
): Promise<{ ts: string }> {
  const text = withMention(params.slackUserId, params.text);
  const blocks = params.blocks
    ? [{ type: "section", text: { type: "mrkdwn", text } }, ...params.blocks]
    : undefined;
  const result = await client.call<{ ts: string }>("chat.postMessage", {
    channel: params.channel,
    thread_ts: params.threadTs,
    text,
    ...(blocks ? { blocks } : {}),
    unfurl_links: false,
    unfurl_media: false,
  });
  return { ts: result.ts };
}

/**
 * チャンネルへの直接投稿（スレッドなし・メンションなし）。リリース完了のような、誰かの依頼への返信ではない
 * 通知用。依頼者への返信は従来どおり`postBotReply`を使う。
 */
export async function postChannelMessage(
  client: SlackClient,
  params: { channel: string; text: string; blocks?: SlackBlock[] },
): Promise<{ ts: string }> {
  const result = await client.call<{ ts: string }>("chat.postMessage", {
    channel: params.channel,
    text: params.text,
    ...(params.blocks ? { blocks: params.blocks } : {}),
    unfurl_links: false,
    unfurl_media: false,
  });
  return { ts: result.ts };
}

export async function updateBotMessage(
  client: SlackClient,
  params: { channel: string; ts: string; slackUserId: string; text: string; blocks?: SlackBlock[] },
): Promise<void> {
  const text = withMention(params.slackUserId, params.text);
  await client.call("chat.update", {
    channel: params.channel,
    ts: params.ts,
    text,
    blocks: [{ type: "section", text: { type: "mrkdwn", text } }, ...(params.blocks ?? [])],
  });
}

/** リアクションの付け外し。**失敗しても処理は止めない**（`already_reacted`・`no_reaction`も無視） */
export async function setReaction(
  client: SlackClient,
  params: { channel: string; ts: string; add?: string; remove?: string },
): Promise<void> {
  for (const [method, name] of [
    ["reactions.remove", params.remove],
    ["reactions.add", params.add],
  ] as const) {
    if (!name) continue;
    try {
      await client.call(method, { channel: params.channel, timestamp: params.ts, name });
    } catch (error) {
      console.warn("[slack] リアクションの更新に失敗しました（処理は続行）", method, name, error instanceof SlackApiError ? error.code : "unknown");
    }
  }
}

export async function fetchPermalink(client: SlackClient, channel: string, ts: string): Promise<string | null> {
  try {
    const result = await client.call<{ permalink?: string }>("chat.getPermalink", { channel, message_ts: ts });
    return result.permalink ?? null;
  } catch {
    return null;
  }
}
