const CLAUDE_OAUTH_API = "https://api.anthropic.com";
const USAGE_PATH = "/api/oauth/usage";

/** 取得成功時にレスポンスを保持する時間。 */
const CACHE_TTL_MS = 60_000;

/**
 * 表示するウィンドウと表示順。キーはレスポンスのプロパティ名。
 * レスポンスに存在しないキーは単に表示されない。
 */
const USAGE_WINDOWS: { key: string; label: string }[] = [
  { key: "five_hour", label: "5時間" },
  { key: "seven_day", label: "週間" },
  { key: "seven_day_opus", label: "週間 (Opus)" },
  { key: "seven_day_sonnet", label: "週間 (Sonnet)" },
];

export type ClaudeUsageWindow = {
  key: string;
  label: string;
  /** 使用率(0-100)。 */
  usedPercent: number;
  /** 上限までの残り(0-100)。 */
  remainingPercent: number;
  /** リセット時刻(ISO 8601)。取得できなかった場合はnull。 */
  resetsAt: string | null;
};

export type ClaudeUsage = {
  windows: ClaudeUsageWindow[];
  /** 実際にAPIから取得できた時刻(epoch ms)。 */
  fetchedAt: number;
  /** レート制限等でキャッシュを返した場合にtrue。 */
  stale: boolean;
};

type RawUsageWindow = {
  utilization?: unknown;
  percent?: unknown;
  resets_at?: unknown;
  is_enabled?: unknown;
};

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/**
 * 使用率をパーセント(0-100)に正規化する。
 *
 * `utilization`が比率(0-1)とパーセント(0-100)のどちらで返るかは実レスポンスで未確認のため、
 * 1以下なら比率とみなして100倍する。`percent`があればそちらを優先する。
 */
export function toUsedPercent(raw: RawUsageWindow): number | null {
  if (typeof raw.percent === "number" && Number.isFinite(raw.percent)) {
    return clampPercent(raw.percent);
  }
  if (typeof raw.utilization === "number" && Number.isFinite(raw.utilization)) {
    return clampPercent(raw.utilization <= 1 ? raw.utilization * 100 : raw.utilization);
  }
  return null;
}

/**
 * `/api/oauth/usage`のレスポンスから表示対象のウィンドウを取り出す。
 * 非公開エンドポイントのため、想定外の形でも例外を投げず取れたものだけを返す。
 */
export function parseClaudeUsage(payload: unknown): ClaudeUsageWindow[] {
  if (typeof payload !== "object" || payload === null) return [];
  const record = payload as Record<string, unknown>;

  const windows: ClaudeUsageWindow[] = [];
  for (const { key, label } of USAGE_WINDOWS) {
    const raw = record[key];
    if (typeof raw !== "object" || raw === null) continue;

    const rawWindow = raw as RawUsageWindow;
    if (rawWindow.is_enabled === false) continue;

    const usedPercent = toUsedPercent(rawWindow);
    if (usedPercent === null) continue;

    windows.push({
      key,
      label,
      usedPercent,
      remainingPercent: 100 - usedPercent,
      resetsAt: typeof rawWindow.resets_at === "string" ? rawWindow.resets_at : null,
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
 * このエンドポイントはレート制限が厳しく、Claude Code自身も制限時は直近のキャッシュを
 * 表示する設計になっている。同じ挙動に倣い、取得できない場合は最後に成功した値を
 * stale扱いで返す。
 */
export async function fetchClaudeUsage(token: string): Promise<ClaudeUsage> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return { windows: cache.windows, fetchedAt: cache.fetchedAt, stale: false };
  }

  let res: Response;
  try {
    res = await fetch(`${CLAUDE_OAUTH_API}${USAGE_PATH}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });
  } catch (cause) {
    return staleOrThrow(cause instanceof Error ? cause.message : String(cause));
  }

  if (!res.ok) {
    return staleOrThrow(`Claudeの使用量を取得できませんでした (${res.status})`);
  }

  const windows = parseClaudeUsage(await res.json());
  cache = { windows, fetchedAt: Date.now() };
  return { windows, fetchedAt: cache.fetchedAt, stale: false };
}
