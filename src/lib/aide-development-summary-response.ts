import {
  AIDE_SUMMARY_SCHEMA_VERSION,
  SUMMARY_CATEGORIES,
  type DevelopmentSummary,
  type SummaryCategory,
  type SummaryItem,
} from "@/lib/aide-development-summary";
import type { SummarySourceStatus } from "@/lib/aide-development-summary-load";

/**
 * AIDE向け開発状況サマリ（#3999）の応答の組み立て。クエリの解釈・期間・ページングは
 * 純関数で持ち、Route Handlerは認証と材料の取得だけにする。
 */

export const DEFAULT_TIMEZONE = "Asia/Tokyo";
export const DEFAULT_PERIOD_DAYS = 7;
export const MAX_PERIOD_DAYS = 92;
export const DEFAULT_ATTENTION_LIMIT = 10;
export const MAX_PAGE_LIMIT = 100;
const DEFAULT_PAGE_LIMIT = 50;

export type SummaryQuery = {
  repositoryFullName: string | null;
  from: Date;
  to: Date;
  timezone: string;
  category: SummaryCategory | null;
  limit: number;
  offset: number;
  attentionLimit: number;
  includePullRequests: boolean;
  includeDeployEvidence: boolean;
};

export type QueryParseResult =
  | { ok: true; query: SummaryQuery }
  | { ok: false; error: string };

function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** `timezone`でのUTCとの差（ミリ秒）。`instant`時点の値 */
function timeZoneOffsetMs(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * ISO8601（オフセット付き）または日付だけ（`YYYY-MM-DD`）を解釈する。日付だけの場合は
 * `timezone`のその日の0時とする。読めなければnull。
 */
export function parseInstant(value: string, timezone: string): Date | null {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    const guess = Date.UTC(Number(y), Number(m) - 1, Number(d));
    // 0時のオフセットを2回当てて、夏時間をまたぐ日でもずれないようにする
    const first = guess - timeZoneOffsetMs(new Date(guess), timezone);
    const second = guess - timeZoneOffsetMs(new Date(first), timezone);
    const result = new Date(second);
    return Number.isNaN(result.getTime()) ? null : result;
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  // オフセットの無い日時はUTCとして曖昧になるため受け付けない
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(value)) return null;
  const result = new Date(value);
  return Number.isNaN(result.getTime()) ? null : result;
}

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), "utf-8").toString("base64url");
}

export function decodeCursor(cursor: string): number | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8")) as { o?: unknown };
    return typeof parsed.o === "number" && Number.isInteger(parsed.o) && parsed.o >= 0 ? parsed.o : null;
  } catch {
    return null;
  }
}

function parseBoolean(value: string | null, fallback: boolean): boolean {
  if (value === null) return fallback;
  return !["0", "false", "no"].includes(value.toLowerCase());
}

export function parseSummaryQuery(params: URLSearchParams, now: Date): QueryParseResult {
  const timezone = params.get("timezone") ?? DEFAULT_TIMEZONE;
  if (!isValidTimeZone(timezone)) return { ok: false, error: "invalid_timezone" };

  const toParam = params.get("to");
  const fromParam = params.get("from");
  const to = toParam === null ? now : parseInstant(toParam, timezone);
  if (!to) return { ok: false, error: "invalid_to" };
  const from =
    fromParam === null
      ? new Date(to.getTime() - DEFAULT_PERIOD_DAYS * 24 * 60 * 60 * 1000)
      : parseInstant(fromParam, timezone);
  if (!from) return { ok: false, error: "invalid_from" };
  if (from.getTime() >= to.getTime()) return { ok: false, error: "invalid_period" };
  if (to.getTime() - from.getTime() > MAX_PERIOD_DAYS * 24 * 60 * 60 * 1000) {
    return { ok: false, error: "period_too_long" };
  }

  const categoryParam = params.get("category");
  if (categoryParam !== null && !(SUMMARY_CATEGORIES as readonly string[]).includes(categoryParam)) {
    return { ok: false, error: "invalid_category" };
  }

  const repositoryFullName = params.get("repositoryFullName");
  if (
    repositoryFullName !== null &&
    (!/^[\w.-]+\/[\w.-]+$/.test(repositoryFullName) || repositoryFullName.split("/").some((part) => /^\.+$/.test(part)))
  ) {
    return { ok: false, error: "invalid_repository" };
  }

  const limitParam = params.get("limit");
  const limit = limitParam === null ? DEFAULT_PAGE_LIMIT : Number(limitParam);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    return { ok: false, error: "invalid_limit" };
  }
  const attentionParam = params.get("attentionLimit");
  const attentionLimit = attentionParam === null ? DEFAULT_ATTENTION_LIMIT : Number(attentionParam);
  if (!Number.isInteger(attentionLimit) || attentionLimit < 0 || attentionLimit > MAX_PAGE_LIMIT) {
    return { ok: false, error: "invalid_attention_limit" };
  }
  const cursorParam = params.get("cursor");
  const offset = cursorParam === null ? 0 : decodeCursor(cursorParam);
  if (offset === null) return { ok: false, error: "invalid_cursor" };

  return {
    ok: true,
    query: {
      repositoryFullName,
      from,
      to,
      timezone,
      category: categoryParam as SummaryCategory | null,
      limit,
      offset,
      attentionLimit,
      includePullRequests: parseBoolean(params.get("includePullRequests"), true),
      includeDeployEvidence: parseBoolean(params.get("includeDeployEvidence"), true),
    },
  };
}

/** 要対応の上位項目に載せる区分と、そのうち人が動くべき理由コード */
const ATTENTION_RULES: { category: SummaryCategory; exclude?: readonly string[]; only?: readonly string[] }[] = [
  { category: "problems" },
  { category: "checkUser", exclude: ["agent-running"] },
  { category: "manualStep", only: ["actionable"] },
  { category: "pullRequests", only: ["merge-waiting", "fix-waiting", "ci-failed", "conflict"] },
];

function byUpdatedAtDesc(a: SummaryItem, b: SummaryItem): number {
  const at = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
  const bt = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
  return bt - at || a.id.localeCompare(b.id);
}

function inRepository(item: SummaryItem, repositoryFullName: string | null): boolean {
  return repositoryFullName === null || item.repositoryFullName === repositoryFullName;
}

/** 要対応の全件（絞り込み後・同じ項目はidで一意にしない＝区分ごとの理由を残す） */
export function selectAttentionItems(
  summary: DevelopmentSummary,
  repositoryFullName: string | null,
): SummaryItem[] {
  return ATTENTION_RULES.flatMap((rule) =>
    summary.items[rule.category].filter(
      (item) =>
        inRepository(item, repositoryFullName) &&
        (!rule.exclude || !rule.exclude.includes(item.reasonCode)) &&
        (!rule.only || rule.only.includes(item.reasonCode)),
    ),
  ).sort(byUpdatedAtDesc);
}

export function paginate<T>(all: readonly T[], offset: number, limit: number) {
  const items = all.slice(offset, offset + limit);
  const next = offset + items.length;
  return {
    items,
    total: all.length,
    truncated: next < all.length,
    nextCursor: next < all.length ? encodeCursor(next) : null,
  };
}

export function buildSummaryResponse(
  summary: DevelopmentSummary,
  source: SummarySourceStatus,
  query: SummaryQuery,
  userLogin: string,
) {
  const repo = query.repositoryFullName;
  const base = {
    schemaVersion: AIDE_SUMMARY_SCHEMA_VERSION,
    generatedAt: source.generatedAt,
    sourceUpdatedAt: source.sourceUpdatedAt,
    complete: source.complete,
    stale: source.stale,
    staleRepositories: source.staleRepositories,
    unavailable: source.unavailable,
    warnings: summary.warnings,
    scope: {
      userLogin,
      repositoryFullName: repo,
      population: summary.population,
      period: { ...summary.recentCompletions, timezone: query.timezone },
    },
  };

  if (query.category !== null) {
    const all = summary.items[query.category]
      .filter((item) => inRepository(item, repo))
      .sort(byUpdatedAtDesc);
    return {
      ...base,
      category: query.category,
      ...paginate(all, query.offset, query.limit),
    };
  }

  if (repo !== null && !summary.byRepository[repo]) {
    return null;
  }
  const attention = selectAttentionItems(summary, repo);
  return {
    ...base,
    totals: repo === null ? summary.totals : summary.byRepository[repo],
    byRepository: repo === null ? summary.byRepository : { [repo]: summary.byRepository[repo] },
    reservation: summary.reservation,
    pullRequestsAvailable: summary.pullRequestsAvailable,
    overlapNotes: summary.overlapNotes,
    attention: paginate(attention, query.offset, query.attentionLimit),
  };
}
