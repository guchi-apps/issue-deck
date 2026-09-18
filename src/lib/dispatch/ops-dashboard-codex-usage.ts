import type { CodexUsage, CodexUsageWindow } from "@/lib/dispatch/codex-usage";

/**
 * Codexのプラン枠を、ops-dashboardの`GET /api/ai-usage`から読む（#3037）。
 *
 * 転記（`token_count.rate_limits`）はCodexを動かしたときにしか更新されず、Codexを使わない日は
 * リセット時刻を過ぎた古い使用率が出続けていた。ops-dashboardはCodex CLIの`/status`と同じ
 * `chatgpt.com/backend-api/wham/usage`を、リフレッシュトークンのローテーション込みで読んでいる。
 * **同じエンドポイントをこちらでも叩くと、ローテーションでどちらかのトークンが失効する**ため、
 * 値はops-dashboardから受け取るだけにする。
 *
 * `OPS_DASHBOARD_URL`と`OPS_API_TOKEN`（ops-dashboardの読み取り用トークン）が揃っているときだけ
 * 使う。揃っていない・取れないときはnullを返し、呼び出し側が転記のスナップショットへ戻る。
 */

const CACHE_TTL_MS = 5 * 60_000;
/** 失敗を5分抱えると転記の値へ戻ったままになるため、失敗は短くだけ覚える。 */
const ERROR_CACHE_TTL_MS = 30_000;
const TIMEOUT_MS = 5_000;

type OpsAiUsageWindow = {
  label?: unknown;
  usedPercent?: unknown;
  resetsAt?: unknown;
  windowSeconds?: unknown;
};

function toWindow(value: unknown, key: CodexUsageWindow["key"]): CodexUsageWindow | null {
  if (typeof value !== "object" || value === null) return null;
  const input = value as OpsAiUsageWindow;
  const { usedPercent, windowSeconds } = input;
  const resetsAt = typeof input.resetsAt === "string" ? Date.parse(input.resetsAt) : Number.NaN;
  if (
    typeof usedPercent !== "number" ||
    !Number.isFinite(usedPercent) ||
    typeof windowSeconds !== "number" ||
    !Number.isFinite(windowSeconds) ||
    windowSeconds <= 0 ||
    Number.isNaN(resetsAt)
  ) {
    return null;
  }
  const used = Math.min(100, Math.max(0, usedPercent));
  return {
    key,
    label: typeof input.label === "string" && input.label ? input.label : `${Math.round(windowSeconds / 60)}分`,
    usedPercent: used,
    remainingPercent: 100 - used,
    resetsAt: Math.floor(resetsAt / 1000),
    durationMs: windowSeconds * 1000,
    expired: false,
  };
}

/** `GET /api/ai-usage`の応答から、ChatGPT（=Codex）の枠だけを画面用へ変換する。 */
export function parseOpsDashboardCodexUsage(value: unknown): CodexUsage | null {
  if (typeof value !== "object" || value === null) return null;
  const snapshot = value as { providers?: unknown; fetchedAt?: unknown };
  if (!Array.isArray(snapshot.providers)) return null;
  const provider = snapshot.providers.find(
    (entry): entry is { status?: unknown; plan?: unknown; windows?: unknown } =>
      typeof entry === "object" && entry !== null && (entry as { id?: unknown }).id === "chatgpt",
  );
  if (!provider || provider.status !== "ok" || !Array.isArray(provider.windows)) return null;

  // ops-dashboardは短い枠（5時間）→長い枠（週間）の順に並べる。転記と同じく先頭をprimaryとし、
  // 枠が1つしか返らないときはそれを週間側（画面が表示するsecondary）として扱う。
  const raw = provider.windows;
  const windows =
    raw.length >= 2
      ? [toWindow(raw[0], "primary"), toWindow(raw[1], "secondary")]
      : [toWindow(raw[0], "secondary")];
  if (windows.some((window) => window === null)) return null;

  const fetchedAt = typeof snapshot.fetchedAt === "string" ? Date.parse(snapshot.fetchedAt) : Number.NaN;
  return {
    windows: windows as CodexUsageWindow[],
    planType: typeof provider.plan === "string" ? provider.plan : null,
    host: "ops-dashboard",
    source: "ops-dashboard",
    fetchedAt: Number.isNaN(fetchedAt) ? Date.now() : fetchedAt,
    stale: false,
  };
}

let cache: { usage: CodexUsage | null; expiresAt: number } | null = null;

/** テスト用にモジュールキャッシュを破棄する。 */
export function clearOpsDashboardCodexUsageCache() {
  cache = null;
}

export async function fetchOpsDashboardCodexUsage(now = Date.now()): Promise<CodexUsage | null> {
  const baseUrl = process.env.OPS_DASHBOARD_URL?.trim();
  const token = process.env.OPS_API_TOKEN?.trim();
  if (!baseUrl || !token) return null;
  if (cache && cache.expiresAt > now) return cache.usage;

  let usage: CodexUsage | null = null;
  try {
    const res = await fetch(new URL("/api/ai-usage", baseUrl), {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) {
      usage = parseOpsDashboardCodexUsage(await res.json());
    } else {
      console.error(`ops-dashboardからCodex使用量を取得できませんでした (${res.status})`);
    }
  } catch (cause) {
    console.error("ops-dashboardからCodex使用量を取得できませんでした", cause);
  }
  cache = { usage, expiresAt: now + (usage ? CACHE_TTL_MS : ERROR_CACHE_TTL_MS) };
  return usage;
}
