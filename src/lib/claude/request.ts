import {
  type ClaudeApiFeature,
  recordClaudeApiCall,
} from "@/lib/claude/api-usage";
import {
  APP_AI_MODEL_DEFAULT,
  APP_AI_MODEL_REASONING_DEFAULT,
  appAiProvider,
  type AppAiModel,
  resolveAppAiModel,
} from "@/lib/app-settings";
import { db } from "@/lib/db";

/**
 * アプリ内AIからAnthropic APIを呼ぶ唯一の入口（#2347・#2568）。
 *
 * **OpenAI API（従量課金）は呼ばない**（#4147）。設定でGPT系を選んでいても、この入口を通る機能は
 * Claude系（サブスク枠のOAuth）の既定モデルで実行する。GPT系をサブスク枠（Codex CLI）で動かせるのは
 * チャット調査だけ（#4143）。どの機能がClaude固定かは設定画面の実行フロー（`execution-flow-settings.ts`）に表示する
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
  /** 失敗応答に含まれる、利用者へ出してよい機械可読な原因。 */
  error: AiApiError | null;
};

export type AiApiError = {
  code: string | null;
  requestId: string | null;
};

function readTokenCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function readAiApiError(response: Response): Promise<AiApiError> {
  let code: string | null = null;
  try {
    const body: unknown = await response.clone().json();
    if (typeof body === "object" && body !== null && "error" in body) {
      const error = (body as { error?: unknown }).error;
      if (typeof error === "object" && error !== null) {
        const details = error as { code?: unknown; type?: unknown };
        if (typeof details.code === "string") code = details.code;
        else if (typeof details.type === "string") code = details.type;
      }
    }
  } catch {
    // 失敗本文がJSONでなくても、HTTPステータスを扱う呼び出し元は継続できる。
  }
  return { code, requestId: response.headers.get("x-request-id") };
}

const REASONING_FEATURES = new Set<ClaudeApiFeature>([
  "manual_step_fix",
  "new_app_consult",
  "chat_investigation",
]);

async function getAppAiModel(feature: ClaudeApiFeature): Promise<AppAiModel> {
  try {
    const setting = await db.appSetting.findUnique({
      where: { id: 1 },
      select: { appAiModel: true, appAiModelReasoning: true, aiExecutionProvider: true },
    });
    const reasoning = REASONING_FEATURES.has(feature);
    const model = reasoning
      ? resolveAppAiModel(setting?.appAiModelReasoning, setting?.aiExecutionProvider, true)
      : resolveAppAiModel(setting?.appAiModel, setting?.aiExecutionProvider);
    return claudeModelFor(model, reasoning);
  } catch {
    return resolveAppAiModel(undefined, undefined, REASONING_FEATURES.has(feature));
  }
}

/** GPT系が選ばれていても、OpenAI APIへは送らずClaude系の既定モデルへ固定する（#4147）。 */
function claudeModelFor(model: AppAiModel, reasoning: boolean): AppAiModel {
  if (appAiProvider(model) === "anthropic") return model;
  return reasoning ? APP_AI_MODEL_REASONING_DEFAULT : APP_AI_MODEL_DEFAULT;
}

/** アプリ内AIの認証情報（Claudeのサブスク枠OAuth）を返す。 */
export async function getAppAiToken(feature: ClaudeApiFeature): Promise<string | null> {
  void feature; // 認証情報は機能によらず共通。呼び出し側のシグネチャを保つ
  return process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null;
}

/**
 * Anthropic APIへPOSTし、消費したトークンを機能別に計上する。
 *
 * `body`は`max_tokens`・`messages`のほか、`system`や`output_config`など
 * 機能ごとの指定をそのまま渡してよい。`model`は保存済みの共通設定をここで加える。
 */
export async function callClaudeMessages<T extends ClaudeMessagesResponse = ClaudeMessagesResponse>(
  options: {
    feature: ClaudeApiFeature;
    token: string;
    body: Record<string, unknown>;
    /**
     * 応答を待つ上限（ミリ秒）。**巡回の途中から呼ぶものは必ず指定する**（#2995）。
     * `POST /api/dispatch/claim`の相乗り処理は同期で走るため、ここが返らないとジョブの
     * 払い出しごと待たされる。省略時は待ち続ける（画面から呼ぶ長い生成のため）
     */
    timeoutMs?: number;
  },
): Promise<ClaudeMessagesResult<T>> {
  const model = await getAppAiModel(options.feature);
  const response = await fetch(`${ANTHROPIC_API}/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.token}`,
      "anthropic-beta": OAUTH_BETA,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...options.body, model }),
    cache: "no-store",
    ...(options.timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(options.timeoutMs) }),
  });
  const error = response.ok ? null : await readAiApiError(response);

  // 拒否された呼び出し（レート制限の429など）はプラン枠を消費しないため計上しない。
  if (!response.ok) {
    console.error(`[AI API] ${options.feature} ${response.status}`, {
      code: error?.code,
      requestId: error?.requestId,
    });
    return { response, json: null, error };
  }

  let json: T | null = null;
  try {
    const raw: unknown = await response.json();
    json = raw as T;
  } catch {
    // 応答が壊れていても計測のためだけに機能を落とさない。呼び出し元が扱えるようnullで返す。
    return { response, json: null, error: null };
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

  return { response, json, error: null };
}
