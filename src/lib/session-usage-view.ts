import { startOfJstDayMs, toJstParts } from "@/lib/format-date-time";

/**
 * 「AI使用量」画面（#2504）が読むかたちへ、`SessionUsage`の行を畳む純粋関数。
 *
 * **DBから読んだ行を渡すだけで組み立てられるようにしてある。** 期間の切り出し・日別の
 * バケット・リポジトリ別／種別別／Issue別のまとめは、どれもここで完結する。
 *
 * **日付の境界は日本時間で切る**（`format-date-time.ts`）。本番VPSとCIはUTCで動くため、
 * `getDate()`のようなローカルタイムの読み出しを使うと日別の棒が9時間ずれる。
 *
 * **金額はAPI換算の目安で、サブスクの実費ではない。** 単価は集計する
 * `scripts/lib/session-usage.sh`の表が正で、ここでは再計算しない。
 */

/** APIが返す（＝画面が受け取る）セッション1本ぶん。DBのBigIntはここでnumberへ落とす */
export type SessionUsageEntry = {
  agent: "claude" | "codex";
  source?: "local" | "github-actions";
  sessionId: string;
  host: string;
  kind: string;
  repository: string | null;
  issueNumber: number | null;
  responses: number;
  inputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  /** 入力・キャッシュ書き込み・キャッシュ読み出しの合計。「どれだけ読ませたか」の指標 */
  contextTokens: number;
  costUsd: number;
  models: string[];
  startedAt: string;
  endedAt: string;
  workflowName?: string | null;
  runUrl?: string | null;
};

export type UsageTotals = {
  sessions: number;
  responses: number;
  /**
   * 入力側の内訳（#2628）。**単価が区分ごとに違う**ので、合計の`contextTokens`だけでは
   * 「量は多いが安い」キャッシュ読み出しが見分けられない。倍率は素の入力を1.0として
   * キャッシュ書き込みが1.25〜2.0、読み出しが0.1（`scripts/lib/session-usage.sh`が正）。
   */
  inputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  contextTokens: number;
  outputTokens: number;
  costUsd: number;
};

export type UsageByAgent = Record<SessionUsageEntry["agent"], UsageTotals>;
export type UsageBySource = Record<"local" | "github-actions", UsageTotals>;
export type UsageDay = UsageTotals & { date: string; byAgent: UsageByAgent; bySource: UsageBySource };
export type UsageGroup = UsageTotals & { key: string; byAgent: UsageByAgent; bySource: UsageBySource };

export type UsageIssue = UsageTotals & {
  repository: string | null;
  issueNumber: number | null;
  /** そのIssueで走った種別（金額の多い順） */
  kinds: string[];
  /** そのIssueで最も新しいセッションの開始日時。Issueの表示順に使う */
  latestStartedAt: string;
  /** 転記1本ごとの明細（開始日時の新しい順）。画面は行を開いたときだけ出す */
  entries: SessionUsageEntry[];
  byAgent: UsageByAgent;
  bySource: UsageBySource;
};

/**
 * プラン枠への換算（#2504の追加要望）。
 *
 * **Anthropicは枠の絶対量を出さない。** `anthropic-ratelimit-unified-*`ヘッダが返すのは
 * 「その窓を何%使ったか」だけで、トークン数でもドルでもない（`lib/claude/usage.ts`）。
 * そこで**同じ窓のあいだにローカルセッションが使ったAPI換算**を実測の%で割り、
 * 「1%あたり何ドルぶん」を逆算して換算の物差しにする。
 *
 * **これは目安の上に立つ目安。** 同じ枠はGitHub Actionsの無人実行とissue-deck自身のAPI
 * 呼び出しも使っており、それらはこの表に入らない。したがって逆算した「1%あたり」は本来より
 * 小さく出て、**枠換算の%は実際よりやや大きめに出る。** 画面でそう断る。
 */
export type QuotaScale = {
  /** 物差しに使った窓（`lib/claude/usage.ts`の`key`。`5h` / `7d`） */
  windowKey: string;
  windowLabel: string;
  /** 窓の実測使用率(%) */
  usedPercent: number;
  /** 窓の開始・終了（ISO） */
  windowStart: string;
  windowEnd: string;
  /** その窓のあいだにローカルセッションが使ったAPI換算(USD) */
  windowCostUsd: number;
  /** 枠1%あたりのAPI換算(USD)。これで割ると「枠の何%相当か」になる */
  usdPerPercent: number;
};

export type SessionUsageSummary = {
  /** 集計した期間（ISO）。`days`は日本時間の日数で、今日を含む */
  since: string;
  until: string;
  days: number;
  totals: UsageTotals;
  totalsByAgent: UsageByAgent;
  totalsBySource: UsageBySource;
  byDay: UsageDay[];
  byRepository: UsageGroup[];
  byKind: UsageGroup[];
  byIssue: UsageIssue[];
  /**
   * 明細から落としたIssueの件数と、そのぶんの合計（#2504）。
   * **合計・内訳には入っている**ので、画面は「明細に出していない」ことだけを言う。
   */
  omittedIssues: number;
  omittedIssueCostUsd: number;
  /** 報告してきたホスト名（重複なし） */
  hosts: string[];
  /** いちばん新しい報告の時刻（ISO）。まだ1件も無ければnull */
  reportedAt: string | null;
  /** AIごとのプラン枠への換算。材料が揃わなければnull */
  quotaByAgent: Record<SessionUsageEntry["agent"], QuotaScale | null>;
};

/**
 * 明細（Issue別）に載せる上限。
 *
 * **応答そのものの大きさを抑えるために切る。** 30日ぶんはIssueが1,000件近くになり、転記1本ごとの
 * 明細まで載せると応答が1MBを超える。スマホから開くこともある画面で、上位200件の先を
 * 見たくなることは無い（金額順で、200件目は既に端数）。合計・内訳は全件から作る。
 */
const MAX_DETAIL_ISSUES = 200;

/** 画面に出す種別の名前。シェル側の`KIND_LABELS`と揃える */
const KIND_LABELS: Record<string, string> = {
  implementation: "実装",
  "plan-review": "計画レビュー",
  question: "横断質問",
  other: "その他",
  actions: "GitHub Actions",
};

export function sessionUsageKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

function emptyTotals(): UsageTotals {
  return {
    sessions: 0,
    responses: 0,
    inputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    contextTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
}

function emptyByAgent(): UsageByAgent {
  return { claude: emptyTotals(), codex: emptyTotals() };
}

function emptyBySource(): UsageBySource {
  return { local: emptyTotals(), "github-actions": emptyTotals() };
}

function addEntryWithAgent(
  totals: UsageTotals & { byAgent: UsageByAgent },
  entry: SessionUsageEntry,
): void {
  addEntry(totals, entry);
  addEntry(totals.byAgent[entry.agent], entry);
}

function addEntryWithSource(
  totals: UsageTotals & { bySource: UsageBySource },
  entry: SessionUsageEntry,
): void {
  addEntry(totals.bySource[entry.source === "github-actions" ? "github-actions" : "local"], entry);
}

function addEntry(totals: UsageTotals, entry: SessionUsageEntry): void {
  totals.sessions += 1;
  totals.responses += entry.responses;
  totals.inputTokens += entry.inputTokens;
  totals.cacheCreateTokens += entry.cacheCreateTokens;
  totals.cacheReadTokens += entry.cacheReadTokens;
  totals.contextTokens += entry.contextTokens;
  totals.outputTokens += entry.outputTokens;
  totals.costUsd += entry.costUsd;
}

/** 日本時間の`YYYY-MM-DD`。解釈できない値は空文字 */
function jstDateKey(iso: string): string {
  const parts = toJstParts(iso);
  if (parts === null) return "";
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

/**
 * 期間の開始（epoch ms）。**今日を含む`days`日**で、日本時間のその日の0:00に切る。
 * `days`が1なら今日の0:00から。
 */
export function sessionUsagePeriodStartMs(nowMs: number, days: number): number {
  const safeDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 1;
  return startOfJstDayMs(nowMs, -(safeDays - 1)) ?? nowMs;
}

/**
 * プラン枠の窓と、同じ窓のあいだの消費から換算の物差しを作る。
 *
 * **窓は「リセット時刻から窓の長さぶん遡ったところ」**として扱う。ヘッダはリセット時刻と
 * 窓の長さしか返さないため、開始時刻はここで引き算する。
 *
 * 次のいずれかに当てはまれば`null`（画面は枠換算を出さない）。
 * - 窓の情報が無い／リセット時刻が取れない
 * - 使用率が0%（割れない）
 * - その窓でローカルセッションの消費が記録されていない（物差しが立たない）
 */
export function buildQuotaScale({
  windows,
  entries,
  nowMs,
}: {
  windows: {
    key: string;
    label: string;
    usedPercent: number;
    resetsAt: number | null;
    durationMs: number;
  }[];
  entries: SessionUsageEntry[];
  nowMs: number;
}): QuotaScale | null {
  // **長いほうの窓を優先する。** 5時間枠は走っているセッション1本で振り切れることがあり、
  // 物差しとしては荒い。週間枠のほうが平均が効く。
  const candidates = [...windows].sort((a, b) => b.durationMs - a.durationMs);

  for (const window of candidates) {
    if (!Number.isFinite(window.usedPercent) || window.usedPercent <= 0) continue;
    if (window.resetsAt === null || !Number.isFinite(window.resetsAt)) continue;

    const endMs = window.resetsAt * 1000;
    const startMs = endMs - window.durationMs;
    // リセット時刻が過去（＝取得が古い）ときは、その窓はもう当てにならない。
    if (endMs < nowMs) continue;

    let windowCostUsd = 0;
    for (const entry of entries) {
      const endedAt = new Date(entry.endedAt).getTime();
      if (Number.isNaN(endedAt)) continue;
      if (endedAt < startMs || endedAt > endMs) continue;
      windowCostUsd += entry.costUsd;
    }
    if (windowCostUsd <= 0) continue;

    return {
      windowKey: window.key,
      windowLabel: window.label,
      usedPercent: window.usedPercent,
      windowStart: new Date(startMs).toISOString(),
      windowEnd: new Date(endMs).toISOString(),
      windowCostUsd,
      usdPerPercent: windowCostUsd / window.usedPercent,
    };
  }

  return null;
}

/**
 * 期間で切ったうえで、画面が読むかたちへ畳む。
 *
 * `entries`は期間の外を含んでいてよい（`quota`の物差しは窓の全体を見るため、
 * **絞り込みはここで行う**）。
 */
export function buildSessionUsageSummary({
  entries,
  nowMs,
  days,
  reportedAt,
  quotaByAgent = { claude: null, codex: null },
}: {
  entries: SessionUsageEntry[];
  nowMs: number;
  days: number;
  reportedAt: string | null;
  quotaByAgent?: Record<SessionUsageEntry["agent"], QuotaScale | null>;
}): SessionUsageSummary {
  const startMs = sessionUsagePeriodStartMs(nowMs, days);
  const inPeriod = entries.filter((entry) => {
    const endedAt = new Date(entry.endedAt).getTime();
    return !Number.isNaN(endedAt) && endedAt >= startMs;
  });

  const totals = emptyTotals();
  const totalsByAgent = emptyByAgent();
  const totalsBySource = emptyBySource();
  const byDay = new Map<string, UsageDay>();
  const byRepository = new Map<string, UsageGroup>();
  const byKind = new Map<string, UsageGroup>();
  const byIssue = new Map<string, UsageIssue>();
  const hosts = new Set<string>();

  for (const entry of inPeriod) {
    addEntry(totals, entry);
    addEntry(totalsByAgent[entry.agent], entry);
    addEntry(totalsBySource[entry.source === "github-actions" ? "github-actions" : "local"], entry);
    hosts.add(entry.host);

    const dateKey = jstDateKey(entry.endedAt);
    if (dateKey) {
      const day = byDay.get(dateKey) ?? {
        date: dateKey,
        ...emptyTotals(),
        byAgent: emptyByAgent(),
        bySource: emptyBySource(),
      };
      addEntryWithAgent(day, entry);
      addEntryWithSource(day, entry);
      byDay.set(dateKey, day);
    }

    // リポジトリを判定できなかったセッションは空文字のキーへまとめ、画面が「（不明）」と出す。
    const repositoryKey = entry.repository ?? "";
    const repository = byRepository.get(repositoryKey) ?? {
      key: repositoryKey,
      ...emptyTotals(),
      byAgent: emptyByAgent(),
      bySource: emptyBySource(),
    };
    addEntryWithAgent(repository, entry);
    addEntryWithSource(repository, entry);
    byRepository.set(repositoryKey, repository);

    const kind = byKind.get(entry.kind) ?? {
      key: entry.kind,
      ...emptyTotals(),
      byAgent: emptyByAgent(),
      bySource: emptyBySource(),
    };
    addEntryWithAgent(kind, entry);
    addEntryWithSource(kind, entry);
    byKind.set(entry.kind, kind);

    // **Issue番号を持たないセッションもリポジトリ単位でまとめて出す。** 計画レビュー・横断質問は
    // 作業ディレクトリにIssue番号を持たないことがあり、落とすと合計と明細が合わなくなる。
    const issueKey = `${repositoryKey}#${entry.issueNumber ?? ""}`;
    const issue =
      byIssue.get(issueKey) ??
      ({
        repository: entry.repository,
        issueNumber: entry.issueNumber,
        kinds: [],
        latestStartedAt: entry.startedAt,
        entries: [],
        byAgent: emptyByAgent(),
        bySource: emptyBySource(),
        ...emptyTotals(),
      } satisfies UsageIssue);
    addEntryWithAgent(issue, entry);
    addEntryWithSource(issue, entry);
    issue.entries.push(entry);
    if (entry.startedAt > issue.latestStartedAt) issue.latestStartedAt = entry.startedAt;
    byIssue.set(issueKey, issue);
  }

  const byCost = (a: { costUsd: number }, b: { costUsd: number }) => b.costUsd - a.costUsd;

  const issues = [...byIssue.values()].map((issue) => {
    // **進行中のセッションほど上へ出す。** 使用量順では、開始直後で金額の小さいセッションが
    // 下へ埋もれ、「今実装しているセッション」を見つけられない（#2560）。
    issue.entries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    // 種別は金額の多い順に並べ、同じ種別は1つにまとめる。
    const kindCost = new Map<string, number>();
    for (const entry of issue.entries) {
      kindCost.set(entry.kind, (kindCost.get(entry.kind) ?? 0) + entry.costUsd);
    }
    issue.kinds = [...kindCost.entries()].sort((a, b) => b[1] - a[1]).map(([kind]) => kind);
    return issue;
  });
  issues.sort((a, b) => b.latestStartedAt.localeCompare(a.latestStartedAt));
  const omitted = issues.slice(MAX_DETAIL_ISSUES);

  return {
    since: new Date(startMs).toISOString(),
    until: new Date(nowMs).toISOString(),
    days,
    totals,
    totalsByAgent,
    totalsBySource,
    byDay: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
    byRepository: [...byRepository.values()].sort(byCost),
    byKind: [...byKind.values()].sort(byCost),
    byIssue: issues.slice(0, MAX_DETAIL_ISSUES),
    omittedIssues: omitted.length,
    omittedIssueCostUsd: omitted.reduce((sum, issue) => sum + issue.costUsd, 0),
    hosts: [...hosts].sort(),
    reportedAt,
    quotaByAgent,
  };
}

/** API換算(USD) → プラン枠の何%相当か。物差しが無ければnull */
export function toQuotaPercent(costUsd: number, quota: QuotaScale | null): number | null {
  if (!quota || quota.usdPerPercent <= 0) return null;
  return costUsd / quota.usdPerPercent;
}

/**
 * 画面に出す数値の整形。**単位の畳み方を1か所に置く**（`scripts/lib/session-usage.sh`の
 * `render_table`が端末側で同じことをしているのと対応する）。
 */

/** API換算(USD)。桁が大きいほど小数を落とす（$10,029 / $995.3 / $0.24） */
export function formatUsageUsd(value: number): string {
  if (!Number.isFinite(value)) return "-";
  if (value >= 1000) return `$${Math.round(value).toLocaleString()}`;
  if (value >= 100) return `$${value.toFixed(1)}`;
  if (value > 0 && value < 0.01) return "$0.01";
  return `$${value.toFixed(2)}`;
}

/** プラン枠の何%相当か。1%未満は小数第2位まで出す（0%と区別が付かなくなるため） */
export function formatQuotaPercent(value: number): string {
  if (!Number.isFinite(value)) return "-";
  if (value >= 10) return `${Math.round(value)}%`;
  if (value >= 1) return `${value.toFixed(1)}%`;
  if (value > 0 && value < 0.01) return "0.01%";
  return `${value.toFixed(2)}%`;
}

/** トークン数。7桁の数字を並べても読めないので単位で畳む */
export function formatUsageTokens(value: number): string {
  if (!Number.isFinite(value)) return "-";
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}G`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(0)}M`;
  if (value >= 1e3) return `${Math.round(value / 1e3).toLocaleString()}k`;
  return String(Math.round(value));
}

/** 選んだ単位で金額を出す。`quota`が無ければ常にドル */
export function formatUsageAmount(
  costUsd: number,
  unit: "usd" | "quota",
  quota: QuotaScale | null,
): string {
  if (unit === "quota") {
    const percent = toQuotaPercent(costUsd, quota);
    if (percent !== null) return formatQuotaPercent(percent);
  }
  return formatUsageUsd(costUsd);
}
