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
  /**
   * 対象PR番号（#2650）。issueNumberが取れないPR起点の実行（developへのPRレビュー等）で使う。
   * issueNumberがあるときはそちらを優先して表示するため、両方入ることは基本無い
   */
  prNumber: number | null;
  responses: number;
  inputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  /** 入力・キャッシュ書き込み・キャッシュ読み出しの合計。「どれだけ読ませたか」の指標 */
  contextTokens: number;
  costUsd: number;
  /**
   * `costUsd`の入力側・出力側の内訳（#2626）。集計側が単価から割ったもので、**ここでは割り直さない。**
   * 内訳を持たない行（列の追加より前に報告されたローカルセッション・内訳の出ないGitHub Actions）は
   * null／undefined。その場合だけ`sessionUsageCostSplit`がトークン比の近似へ落とす。
   */
  inputCostUsd?: number | null;
  outputCostUsd?: number | null;
  /**
   * `costUsd`の計画（Plan mode）・実装の内訳（#2646）。転記に残る`ExitPlanMode`の最後の
   * 呼び出し時刻を境に、集計側（`scripts/lib/session-usage.sh`）が振り分けたもの。
   * Plan modeを使っていないセッション・Codexの行はnull（`sessionUsagePhaseSplit`が
   * 「区分なし」として扱う）。**近似は行わない**——入力/出力の内訳と違い、境界が分からない
   * セッションを他の数値から按分する手立てが無いため
   */
  planCostUsd?: number | null;
  implementationCostUsd?: number | null;
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
  prNumber: number | null;
  /** そのIssueで走った種別（金額の多い順） */
  kinds: string[];
  /** そのIssueで最も新しいセッションの開始日時。Issueの表示順に使う */
  latestStartedAt: string;
  /** 転記1本ごとの明細（開始日時の新しい順）。画面は行を開いたときだけ出す */
  entries: SessionUsageEntry[];
  byAgent: UsageByAgent;
  bySource: UsageBySource;
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

/**
 * モデルIDの短縮表示（#2646）。前方一致で拾う（`scripts/lib/session-usage.sh`の`price_for`と
 * 同じ考え方）。日付・世代のサフィックスは画面では要らないので落とす。
 */
const MODEL_LABEL_PATTERNS: [pattern: string, label: string][] = [
  ["claude-opus", "Opus"],
  ["claude-sonnet", "Sonnet"],
  ["claude-haiku", "Haiku"],
  ["claude-fable", "Fable"],
  ["claude-mythos", "Mythos"],
];

export function sessionUsageModelLabel(model: string): string {
  for (const [pattern, label] of MODEL_LABEL_PATTERNS) {
    if (model.startsWith(pattern)) return label;
  }
  // Codexのモデル名（`gpt-5.6-sol`等）はすでに短い名前なのでそのまま出す。
  return model;
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
 * 期間で切ったうえで、画面が読むかたちへ畳む。
 */
export function buildSessionUsageSummary({
  entries,
  nowMs,
  days,
  reportedAt,
}: {
  entries: SessionUsageEntry[];
  nowMs: number;
  days: number;
  reportedAt: string | null;
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
    // **issueNumberがあればそれだけでキーを作る**（#2653）。同じIssueのローカルセッションと、
    // そこから派生したPRのGitHub Actions実行（ブランチ名`issue-<N>`から`identify-issue`ジョブが
    // issueNumberを解決できたもの）は、prNumberの有無・値が違っても同じIssueの活動としてまとめる。
    // **issueNumberが無いときだけprNumberを使う**（#2650）。Issueへ紐付かないPR起点の実行
    // （developへのPRレビュー等）を、複数のPRが1つの「Issue未特定」行へ潰れないよう区別するため
    const issueKey =
      entry.issueNumber !== null
        ? `${repositoryKey}#${entry.issueNumber}`
        : `${repositoryKey}##${entry.prNumber ?? ""}`;
    const issue =
      byIssue.get(issueKey) ??
      ({
        repository: entry.repository,
        issueNumber: entry.issueNumber,
        prNumber: entry.prNumber,
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
  };
}

export type SessionUsageCostSplit = {
  inputCostUsd: number;
  outputCostUsd: number;
  /** トークン比で按分した近似か。画面はこのとき「約」と断る */
  approximate: boolean;
};

/**
 * セッション1本の金額を入力側・出力側へ分ける（#2626）。
 *
 * **集計側が単価から割った内訳があればそれをそのまま使う。** ここで単価表を持たない方針
 * （このファイル冒頭）に従い、金額を割り直すことはしない。
 *
 * **内訳を持たない行だけ、トークン比の按分へ落として`approximate`を立てる。** キャッシュ
 * 読み出しは入力単価の0.1倍・書き込みは1.25〜2.0倍なので、トークン比の按分は入力側を大きく
 * 見せる。Claude Codeのセッションはキャッシュ読み出しがトークンの大半を占めるため、
 * 出力側が実際の1/20ほどに出ることもある。近似だと分かる形でしか出さない。
 */
export function sessionUsageCostSplit(
  entry: Pick<
    SessionUsageEntry,
    "contextTokens" | "outputTokens" | "costUsd" | "inputCostUsd" | "outputCostUsd"
  >,
): SessionUsageCostSplit {
  const { inputCostUsd, outputCostUsd } = entry;
  if (
    typeof inputCostUsd === "number" &&
    Number.isFinite(inputCostUsd) &&
    typeof outputCostUsd === "number" &&
    Number.isFinite(outputCostUsd)
  ) {
    return { inputCostUsd, outputCostUsd, approximate: false };
  }

  const totalTokens = entry.contextTokens + entry.outputTokens;
  if (totalTokens <= 0) {
    return { inputCostUsd: entry.costUsd, outputCostUsd: 0, approximate: true };
  }
  return {
    inputCostUsd: entry.costUsd * (entry.contextTokens / totalTokens),
    outputCostUsd: entry.costUsd * (entry.outputTokens / totalTokens),
    approximate: true,
  };
}

export type SessionUsagePhaseSplit = {
  planCostUsd: number;
  implementationCostUsd: number;
};

/**
 * セッション1本の金額を計画（Plan mode）・実装へ分ける（#2646）。
 *
 * **`sessionUsageCostSplit`と違い、内訳が無いときの近似は行わない。** 入力/出力はトークン比
 * から按分できるが、計画/実装の境界はトークン量からは分からない（Plan modeを使ったかどうか
 * 自体が転記を読まないと分からない）。区分が無ければnullを返し、画面は「区分なし」として
 * 合算のみ出す。
 */
export function sessionUsagePhaseSplit(
  entry: Pick<SessionUsageEntry, "planCostUsd" | "implementationCostUsd">,
): SessionUsagePhaseSplit | null {
  const { planCostUsd, implementationCostUsd } = entry;
  if (
    typeof planCostUsd !== "number" ||
    !Number.isFinite(planCostUsd) ||
    typeof implementationCostUsd !== "number" ||
    !Number.isFinite(implementationCostUsd)
  ) {
    return null;
  }
  return { planCostUsd, implementationCostUsd };
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

/** トークン数。7桁の数字を並べても読めないので単位で畳む */
export function formatUsageTokens(value: number): string {
  if (!Number.isFinite(value)) return "-";
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}G`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(0)}M`;
  if (value >= 1e3) return `${Math.round(value / 1e3).toLocaleString()}k`;
  return String(Math.round(value));
}
