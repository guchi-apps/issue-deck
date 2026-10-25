/**
 * Discord Webhookの最小クライアント（#4994）。SDKは入れず`fetch`で呼ぶ。
 *
 * **Webhook URLそのものが資格情報**（URLを知っていれば誰でも投稿できる）。値はサーバー側の
 * 環境変数だけに置き、ログ・エラーメッセージ・Issue本文へ出さない。
 */

export type DiscordEmbed = {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  timestamp?: string;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
};

export class DiscordWebhookError extends Error {
  constructor(
    readonly status: number | "network_error",
    readonly retryable: boolean,
  ) {
    super(`Discord Webhook の投稿が失敗しました（${status}）`);
  }
}

/** URLは`https://discord.com/api/webhooks/<id>/<token>`の形だけ受け付ける（SSRF対策を兼ねる） */
const WEBHOOK_URL_PATTERN = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

/**
 * リリース完了通知の投稿先（#4994）。`DISCORD_RELEASE_WEBHOOK_URL`が無い・形が違うならnull。
 */
export function loadReleaseDiscordTarget(
  env: Record<string, string | undefined> = process.env,
): { webhookUrl: string } | null {
  const webhookUrl = env.DISCORD_RELEASE_WEBHOOK_URL?.trim();
  if (!webhookUrl || !WEBHOOK_URL_PATTERN.test(webhookUrl)) return null;
  return { webhookUrl };
}

/**
 * 共有トークン警告の投稿先（#5043）。専用の`DISCORD_SHARED_TOKEN_ALERT_WEBHOOK_URL`を優先し、
 * 未設定・形が違うときはリリース通知の宛先へ退避する（どちらも無ければnull）。
 */
export function loadSharedTokenAlertDiscordTarget(
  env: Record<string, string | undefined> = process.env,
): { webhookUrl: string } | null {
  const webhookUrl = env.DISCORD_SHARED_TOKEN_ALERT_WEBHOOK_URL?.trim();
  if (webhookUrl && WEBHOOK_URL_PATTERN.test(webhookUrl)) return { webhookUrl };
  return loadReleaseDiscordTarget(env);
}

/** フォーラムの投稿タイトルの上限（Discordの`thread_name`は100文字まで） */
const THREAD_NAME_MAX_LENGTH = 100;

export function clipThreadName(name: string): string {
  const chars = Array.from(name.trim());
  return chars.length <= THREAD_NAME_MAX_LENGTH ? chars.join("") : `${chars.slice(0, THREAD_NAME_MAX_LENGTH - 1).join("")}…`;
}

async function postOnce(webhookUrl: string, body: unknown, fetchImpl: typeof fetch): Promise<Response> {
  try {
    return await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new DiscordWebhookError("network_error", true);
  }
}

/**
 * 投稿する。メンションは一切解決させない（更新内容の`@everyone`等が通知を鳴らさないように）。
 *
 * **`threadName`はフォーラムチャンネルの投稿タイトル**（#5031）。フォーラム宛てのWebhookは
 * これが無いと400になる。送り先がテキストチャンネルのとき`thread_name`が拒否されるかは確かめて
 * いないため、**400のときだけ`thread_name`を外して1回送り直す**。URLの差し替えと
 * コードのマージのどちらが先でも通知が落ちない。
 */
export async function postWebhookMessage(
  webhookUrl: string,
  message: { content?: string; embeds?: DiscordEmbed[]; threadName?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const { threadName, ...rest } = message;
  const base = { ...rest, allowed_mentions: { parse: [] } };
  const thread = threadName ? { ...base, thread_name: clipThreadName(threadName) } : null;
  const first = thread ?? base;

  let response = await postOnce(webhookUrl, first, fetchImpl);
  if (response.status === 400 && thread) {
    response = await postOnce(webhookUrl, base, fetchImpl);
  }
  if (!response.ok) {
    throw new DiscordWebhookError(response.status, response.status === 429 || response.status >= 500);
  }
}
