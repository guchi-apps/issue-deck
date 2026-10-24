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

/** 投稿する。メンションは一切解決させない（更新内容の`@everyone`等が通知を鳴らさないように） */
export async function postWebhookMessage(
  webhookUrl: string,
  message: { content: string; embeds?: DiscordEmbed[] },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...message, allowed_mentions: { parse: [] } }),
    });
  } catch {
    throw new DiscordWebhookError("network_error", true);
  }
  if (!response.ok) {
    throw new DiscordWebhookError(response.status, response.status === 429 || response.status >= 500);
  }
}
