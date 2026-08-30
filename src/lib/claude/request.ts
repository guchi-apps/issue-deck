import {
  type ClaudeApiFeature,
  recordClaudeApiCall,
} from "@/lib/claude/api-usage";
import {
  APP_AI_MODEL_DEFAULT,
  appAiProvider,
  type AppAiModel,
  parseAppAiModel,
} from "@/lib/app-settings";
import { db } from "@/lib/db";

/**
 * アプリ内AIからAnthropic／OpenAI APIを呼ぶ唯一の入口（#2347・#2568）。
 *
 * 以前は`lib/claude/`の各機能がそれぞれ`fetch`を書いており、エンドポイント・ヘッダ・
 * ベータ指定が9か所に写っていた。消費量を数えるには**すべての呼び出しが1か所を通る**必要が
 * あるため、送信をここへ寄せて、応答の`usage`をそのまま`api-usage.ts`へ計上する。
 *
 * **応答の解釈（テキストの取り出し・JSONの検証・エラー文言）は呼び出し元に残す。**
 * 機能ごとに必要な形が違い、ここへ寄せると分岐だけが増えるため。
 * この関数は`res.ok`でなくても例外を投げず、`json`をnullにして返す。
 */

const ANTHROPIC_API = "https://api.anthropic.com";
const OPENAI_RESPONSES_API = "https://api.openai.com/v1/responses";
const ANTHROPIC_VERSION = "2023-06-01";
const OAUTH_BETA = "oauth-2025-04-20";

/** 応答のうち、どの機能でも共通して読む部分。 */
export type ClaudeMessagesResponse = {
  content?: { type: string; text?: string }[];
  stop_reason?: string;
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

export type ClaudeMessagesResult<T> = {
  response: Response;
  /** 応答をJSONとして読めた場合のみ入る（`response.ok`でない場合はnull）。 */
  json: T | null;
};

type OpenAiResponsesResponse = {
  model?: string;
  output?: { type?: string; content?: { type?: string; text?: string }[] }[];
  output_text?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
  };
};

function readTokenCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function getAppAiModel(): Promise<AppAiModel> {
  try {
    const setting = await db.appSetting.findUnique({
      where: { id: 1 },
      select: { appAiModel: true },
    });
    return parseAppAiModel(setting?.appAiModel) ?? APP_AI_MODEL_DEFAULT;
  } catch {
    // DBが一時的に読めなくても、従来の固定モデルでAI機能を継続する。
    return APP_AI_MODEL_DEFAULT;
  }
}

/** 選択中のアプリ内AIモデルに対応する認証情報を返す。 */
export async function getAppAiToken(): Promise<string | null> {
  const model = await getAppAiModel();
  return appAiProvider(model) === "openai"
    ? process.env.OPENAI_API_KEY ?? null
    : process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null;
}

function openAiBody(body: Record<string, unknown>, model: AppAiModel): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const outputConfig = body.output_config as
    | { format?: { type?: string; schema?: unknown } }
    | undefined;
  const format = outputConfig?.format;

  return {
    model,
    input: messages,
    ...(typeof body.system === "string" ? { instructions: body.system } : {}),
    ...(typeof body.max_tokens === "number" ? { max_output_tokens: body.max_tokens } : {}),
    ...(format?.type === "json_schema"
      ? {
          text: {
            format: {
              type: "json_schema",
              name: "response",
              strict: true,
              schema: format.schema,
            },
          },
        }
      : {}),
  };
}

function normalizeOpenAiResponse(json: OpenAiResponsesResponse): ClaudeMessagesResponse {
  const text =
    json.output_text ??
    json.output
      ?.flatMap((item) => item.content ?? [])
      .find((content) => content.type === "output_text")
      ?.text;
  return {
    content: text ? [{ type: "text", text }] : [],
    model: json.model,
    usage: {
      input_tokens: json.usage?.input_tokens,
      output_tokens: json.usage?.output_tokens,
      cache_read_input_tokens: json.usage?.input_tokens_details?.cached_tokens,
    },
  };
}

/**
 * 選択モデルに対応するAPIへPOSTし、消費したトークンを機能別に計上する。
 *
 * `body`は`max_tokens`・`messages`のほか、`system`や`output_config`など
 * 機能ごとの指定をそのまま渡してよい。`model`は保存済みの共通設定をここで加える。
 */
export async function callClaudeMessages<T extends ClaudeMessagesResponse = ClaudeMessagesResponse>(
  options: {
    feature: ClaudeApiFeature;
    token: string;
    body: Record<string, unknown>;
  },
): Promise<ClaudeMessagesResult<T>> {
  const model = await getAppAiModel();
  const provider = appAiProvider(model);
  const openAiToken = process.env.OPENAI_API_KEY;
  if (provider === "openai" && !openAiToken) {
    return {
      response: new Response(JSON.stringify({ error: "not_configured" }), { status: 501 }),
      json: null,
    };
  }
  const requestBody =
    provider === "openai" ? openAiBody(options.body, model) : { ...options.body, model };
  const response = await fetch(
    provider === "openai" ? OPENAI_RESPONSES_API : `${ANTHROPIC_API}/v1/messages`,
    {
      method: "POST",
      headers:
        provider === "openai"
          ? {
              Authorization: `Bearer ${openAiToken}`,
              "content-type": "application/json",
            }
          : {
              Authorization: `Bearer ${options.token}`,
              "anthropic-beta": OAUTH_BETA,
              "anthropic-version": ANTHROPIC_VERSION,
              "content-type": "application/json",
            },
      body: JSON.stringify(requestBody),
      cache: "no-store",
    },
  );

  // 拒否された呼び出し（レート制限の429など）はプラン枠を消費しないため計上しない。
  if (!response.ok) return { response, json: null };

  let json: T | null = null;
  try {
    const raw = await response.json();
    json = (provider === "openai" ? normalizeOpenAiResponse(raw as OpenAiResponsesResponse) : raw) as T;
  } catch {
    // 応答が壊れていても計測のためだけに機能を落とさない。呼び出し元が扱えるようnullで返す。
    return { response, json: null };
  }

  const usage = json?.usage;
  recordClaudeApiCall({
    feature: options.feature,
    // モデルは応答が返す実際の値を優先する（別名を指定した場合に実体へ寄せるため）。
    model: json?.model ?? model,
    tokens: {
      inputTokens: readTokenCount(usage?.input_tokens),
      outputTokens: readTokenCount(usage?.output_tokens),
      cacheReadTokens: readTokenCount(usage?.cache_read_input_tokens),
      cacheCreationTokens: readTokenCount(usage?.cache_creation_input_tokens),
    },
  });

  return { response, json };
}
