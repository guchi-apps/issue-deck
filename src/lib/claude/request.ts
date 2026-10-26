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
import {
  CODEX_APP_AI_TOKEN,
  CODEX_EXCLUDED_FEATURES,
  runAppAiOnCodex,
} from "@/lib/claude/app-ai-codex";
import { db } from "@/lib/db";

/**
 * アプリ内AIからAnthropic APIを呼ぶ唯一の入口（#2347・#2568）。
 *
 * **OpenAI API（従量課金）は呼ばない**（#4147）。設定でGPT系を選んだ機能は、サブPCのログイン済み
 * Codex CLI（ChatGPTサブスク枠）で実行する（#5067。`app-ai-codex.ts`）。Codex経路の失敗は
 * `AppAiCodexError`として投げ、Claudeへは戻さない。Codexへ回さない機能（`CODEX_EXCLUDED_FEATURES`）だけは
 * 従来どおりClaude系の既定モデルで実行する。機能ごとの実行先は設定画面の実行フロー（`execution-flow-settings.ts`）に表示する
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

/**
 * サブスク枠のOAuthトークンは、`system`の**独立した最初のブロック**がこの名乗りでないと、
 * Sonnet・Opusを`429 rate_limit_error`（message `"Error"`。利用枠ヘッダは`allowed`のまま）で拒否する
 * （Haikuは通る。#5006）。文字列へ連結しても通らないため、機能ごとの`system`はこの後ろのブロックに置く
 */
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

type SystemBlock = { type: "text"; text: string } & Record<string, unknown>;

/** 機能が渡した`system`（無し・文字列・ブロック配列）の前に名乗りブロックを差し込む */
export function withClaudeCodeIdentity(system: unknown): SystemBlock[] {
  const identity: SystemBlock = { type: "text", text: CLAUDE_CODE_IDENTITY };
  if (typeof system === "string") return system ? [identity, { type: "text", text: system }] : [identity];
  if (Array.isArray(system)) {
    const blocks = system as SystemBlock[];
    return blocks[0]?.text === CLAUDE_CODE_IDENTITY ? blocks : [identity, ...blocks];
  }
  return [identity];
}

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
  /** 429などで再試行できるようになる時刻（epochミリ秒）。ヘッダから読めなければnull */
  retryAt: number | null;
};

/** `retry-after`（秒）か統合レート制限のリセット時刻（epoch秒）から、再試行できる時刻を読む */
export function readRetryAt(headers: Headers, now: number = Date.now()): number | null {
  const retryAfterRaw = headers.get("retry-after");
  const retryAfter = Number(retryAfterRaw);
  if (retryAfterRaw && Number.isFinite(retryAfter) && retryAfter >= 0) return now + retryAfter * 1000;
  // 窓ごとのヘッダ（usage.tsと同じ名前）。拒否された窓があればそのリセットを、無ければ最も近いリセットを使う
  const resets: { at: number; rejected: boolean }[] = [];
  for (const key of ["5h", "7d", ""]) {
    const prefix = key ? `anthropic-ratelimit-unified-${key}` : "anthropic-ratelimit-unified";
    const raw = headers.get(`${prefix}-reset`);
    const at = Number(raw) * 1000;
    if (raw && Number.isFinite(at) && at > now) resets.push({ at, rejected: headers.get(`${prefix}-status`) === "rejected" });
  }
  const rejected = resets.filter((r) => r.rejected);
  if (rejected.length > 0) return Math.max(...rejected.map((r) => r.at));
  return resets.length > 0 ? Math.min(...resets.map((r) => r.at)) : null;
}

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
  return { code, requestId: response.headers.get("x-request-id"), retryAt: readRetryAt(response.headers) };
}

const REASONING_FEATURES = new Set<ClaudeApiFeature>([
  "manual_step_fix",
  "new_app_consult",
  "chat_investigation",
  // 全体レビューの採否の推奨（#4676）。公開前の判断を支えるため推論側。対象ごとに1回しか呼ばない
  "release_review_recommend",
]);

/** 保存済みの設定から、その機能に選ばれているモデル（GPT系もそのまま）を読む */
async function getSelectedAppAiModel(feature: ClaudeApiFeature): Promise<AppAiModel> {
  const reasoning = REASONING_FEATURES.has(feature);
  try {
    const setting = await db.appSetting.findUnique({
      where: { id: 1 },
      select: { appAiModel: true, appAiModelReasoning: true, aiExecutionProvider: true },
    });
    return reasoning
      ? resolveAppAiModel(setting?.appAiModelReasoning, setting?.aiExecutionProvider, true)
      : resolveAppAiModel(setting?.appAiModel, setting?.aiExecutionProvider);
  } catch {
    return resolveAppAiModel(undefined, undefined, reasoning);
  }
}

/** 実際の実行先。GPT系が選ばれた機能はCodex CLI、それ以外はAnthropic API（#5067） */
export type AppAiRoute = { runtime: "codex"; model: AppAiModel } | { runtime: "claude"; model: AppAiModel };

export function routeAppAi(feature: ClaudeApiFeature, selected: AppAiModel): AppAiRoute {
  if (appAiProvider(selected) === "anthropic") return { runtime: "claude", model: selected };
  if (CODEX_EXCLUDED_FEATURES.has(feature)) {
    // Codexへ回さない機能は、OpenAI APIへは送らずClaude系の既定モデルへ固定する（#4147）
    return { runtime: "claude", model: REASONING_FEATURES.has(feature) ? APP_AI_MODEL_REASONING_DEFAULT : APP_AI_MODEL_DEFAULT };
  }
  return { runtime: "codex", model: selected };
}

async function resolveAppAiRoute(feature: ClaudeApiFeature): Promise<AppAiRoute> {
  return routeAppAi(feature, await getSelectedAppAiModel(feature));
}

/**
 * アプリ内AIの認証情報を返す。Codex経路ではClaudeのOAuthトークンを前提にしない（#5067）ので、
 * 呼び出し元の「未設定なら501」を通す目印（`CODEX_APP_AI_TOKEN`）を返す
 */
export async function getAppAiToken(feature: ClaudeApiFeature): Promise<string | null> {
  const route = await resolveAppAiRoute(feature);
  if (route.runtime === "codex") return CODEX_APP_AI_TOKEN;
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
  const route = await resolveAppAiRoute(options.feature);
  if (route.runtime === "codex") {
    // 失敗は`AppAiCodexError`として投げる（Claudeへは戻さない）。使用量は受け口が`codex-cli/<model>`で記録する
    const result = await runAppAiOnCodex({
      feature: options.feature,
      model: route.model,
      body: options.body,
      timeoutMs: options.timeoutMs,
    });
    const json = { content: [{ type: "text", text: result.text }], stop_reason: "end_turn", model: result.model };
    return { response: new Response(null, { status: 200 }), json: json as T, error: null };
  }
  const model = route.model;
  const response = await fetch(`${ANTHROPIC_API}/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.token}`,
      "anthropic-beta": OAUTH_BETA,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...options.body, system: withClaudeCodeIdentity(options.body.system), model }),
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
