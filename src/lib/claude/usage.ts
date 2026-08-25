import { callClaudeMessages } from "@/lib/claude/request";

/**
 * 取得成功時にレスポンスを保持する時間。
 * 取得自体がわずかにプラン枠を消費するため、GitHub版より長めに取る。
 */
const CACHE_TTL_MS = 5 * 60_000;

/** ヘッダを得るためだけに送る最小の推論リクエスト。 */
const PROBE_REQUEST_BODY = {
  model: "claude-haiku-4-5",
  max_tokens: 1,
  messages: [{ role: "user", content: "ping" }],
};

/** 表示するウィンドウと表示順。キーはヘッダ名に埋め込まれる略称。 */
const USAGE_WINDOWS: { key: string; label: string; durationMs: number }[] = [
  { key: "5h", label: "5時間", durationMs: 5 * 60 * 60_000 },
  { key: "7d", label: "週間", durationMs: 7 * 24 * 60 * 60_000 },
];

export type ClaudeUsageWindow = {
  key: string;
  label: string;
  /** 使用率(0-100)。 */
  usedPercent: number;
  /** 上限までの残り(0-100)。 */
  remainingPercent: number;
  /** リセット時刻(epoch秒)。取得できなかった場合はnull。 */
  resetsAt: number | null;
  /** `allowed` / `allowed_warning` / `rejected` など。取得できなかった場合はnull。 */
  status: string | null;
  /** 固定ウィンドウ長(ミリ秒)。5時間枠・週間枠のいずれも固定値。 */
  durationMs: number;
};

export type ClaudeUsage = {
  windows: ClaudeUsageWindow[];
  /** 実際に取得できた時刻(epoch ms)。 */
  fetchedAt: number;
  /** レート制限等でキャッシュを返した場合にtrue。 */
  stale: boolean;
};

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function readNumberHeader(headers: Headers, name: string): number | null {
  // headers.get()は未設定時にnullを返し、Number(null)は0になってしまうため
  // 存在チェックを先に行う。
  const raw = headers.get(name);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * `anthropic-ratelimit-unified-*` ヘッダからプラン枠の使用状況を取り出す。
 * ヘッダは公開APIとして文書化されていないため、欠けていても例外を投げず
 * 取れたウィンドウだけを返す。
 */
export function parseUnifiedRateLimitHeaders(headers: Headers): ClaudeUsageWindow[] {
  const windows: ClaudeUsageWindow[] = [];

  for (const { key, label, durationMs } of USAGE_WINDOWS) {
    // utilizationは0-1の比率で返る（例: 0.07 は7%）。
    const utilization = readNumberHeader(
      headers,
      `anthropic-ratelimit-unified-${key}-utilization`,
    );
    if (utilization === null) continue;

    const usedPercent = clampPercent(utilization * 100);
    windows.push({
      key,
      label,
      usedPercent,
      remainingPercent: 100 - usedPercent,
      // resetはepoch秒。
      resetsAt: readNumberHeader(headers, `anthropic-ratelimit-unified-${key}-reset`),
      status: headers.get(`anthropic-ratelimit-unified-${key}-status`),
      durationMs,
    });
  }

  return windows;
}

let cache: { windows: ClaudeUsageWindow[]; fetchedAt: number } | null = null;

/** テスト用にモジュールキャッシュを破棄する。 */
export function clearClaudeUsageCache() {
  cache = null;
}

function staleOrThrow(message: string): ClaudeUsage {
  if (cache) {
    return { windows: cache.windows, fetchedAt: cache.fetchedAt, stale: true };
  }
  throw new Error(message);
}

/**
 * Claudeプランの使用量(5時間枠・週次枠)を取得する。
 *
 * 専用エンドポイント`/api/oauth/usage`にも同じ情報があるが、そちらは`user:profile`
 * スコープを要求する。`claude setup-token`で発行できるトークンは`user:inference`のみ
 * のため到達できない。代わりに最小の推論リクエストを送り、レスポンスヘッダから読み取る。
 * `count_tokens`ではこのヘッダが付かないため`/v1/messages`を使う。
 *
 * 取得のたびにわずかにプラン枠を消費するので、必ずキャッシュを介して呼ぶこと。
 */
export async function fetchClaudeUsage(token: string): Promise<ClaudeUsage> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return { windows: cache.windows, fetchedAt: cache.fetchedAt, stale: false };
  }

  let res: Response;
  try {
    // この取得自体もプラン枠を消費するため、他の機能と同じように消費量へ計上する（#2347）。
    const { response } = await callClaudeMessages({
      feature: "plan_usage",
      token,
      body: PROBE_REQUEST_BODY,
    });
    res = response;
  } catch (cause) {
    return staleOrThrow(cause instanceof Error ? cause.message : String(cause));
  }

  // 上限に達して429が返る場合でもレート制限ヘッダは付くため、
  // ステータスコードに関わらずヘッダを読む。
  const windows = parseUnifiedRateLimitHeaders(res.headers);
  if (windows.length === 0) {
    return staleOrThrow(`Claudeの使用量を取得できませんでした (${res.status})`);
  }

  cache = { windows, fetchedAt: Date.now() };
  return { windows, fetchedAt: cache.fetchedAt, stale: false };
}
