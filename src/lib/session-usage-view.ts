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
  /**
   * `implementationCostUsd`をさらに割った内訳（#2779）。境界はどれも転記のツール呼び出しで、
   * 調査＝最初のファイル編集まで／実装＝最初の`git commit`まで／仕上げ＝それ以降。
   * **3つ揃っていなければ3つともnull**（境界を1つも拾えなかったセッション・Codexの行）。
   * `sessionUsageImplementationPhases`が「フェーズ未集計」として扱う
   */
  researchCostUsd?: number | null;
  codingCostUsd?: number | null;
  wrapupCostUsd?: number | null;
  /**
   * 実装・仕上げの中で、テスト・Lint・型チェック・ビルド・curlを呼んだ応答の金額（#3064）。
   * **上の3つと足して実装の合計になる**（検証ぶんは実装・仕上げから抜いてある）。
   * この列より前に報告された行はnull／undefinedで、そのぶんは実装・仕上げに含まれたまま（0として扱う）
   */
  verifyCostUsd?: number | null;
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
  /**
   * IssueまたはPRのタイトル（#2686）。**この純粋関数はDBを読まないためnull固定**——
   * `/api/session-usage`が`buildSessionUsageSummary`の呼び出し後に、DBの`Issue`テーブルや
   * GitHub APIから解決した値をここへ詰め直す。解決できなかった行もnullのまま返す
   * （画面は番号のみの表示にフォールバックする）。
   */
  title: string | null;
  /** そのIssueで走った種別（金額の多い順） */
  kinds: string[];
  /** そのIssueで最も新しいセッションの開始日時。Issueの表示順に使う */
  latestStartedAt: string;
  /** 転記1本ごとの明細（開始日時の新しい順）。画面は行を開いたときだけ出す */
  entries: SessionUsageEntry[];
  byAgent: UsageByAgent;
  bySource: UsageBySource;
  /** 計画・実装・Actionの3分類サマリー（#2670）。 */
  phases: UsagePhaseBreakdown;
  /**
   * 直近5時間枠の実測ウィンドウ内での、このIssueの消費が枠の何%に相当するかの目安（#2988）。
   * ウィンドウ内に活動が無い、または換算レート自体が求まらない場合はnull。
   * `/api/session-usage`が`buildIssueQuotaPercents`で計算して詰め直す（この純粋関数はDBも
   * プラン枠APIも読まないため、デフォルトはnullのまま）。
   */
  quotaPercent: number | null;
};

export type UsagePhaseKey = "plan" | "implementation" | "action";

export type UsagePhaseTotals = {
  costUsd: number;
  /**
   * トークンの入力側内訳（#2628と同じ4区分）。**Actionは実測。計画・実装は按分の近似**で、
   * 画面は計画・実装のバーをあえて単色にし、内訳（この4区分）までは出さない
   * （`buildPhaseBreakdown`のコメント参照）。
   */
  inputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  contextTokens: number;
  outputTokens: number;
  sessions: number;
  /**
   * そのフェーズで使われたモデル（重複除去。出現順）。**フェーズ単位のモデル情報はDBに無い**ため、
   * 按分元セッション（`entry.models`）をそのまま流用する。1セッション内でモデルが切り替わっていた
   * 場合は、計画・実装の両方に同じモデルが出る
   */
  models: string[];
};

export type UsagePhaseBreakdown = Record<UsagePhaseKey, UsagePhaseTotals>;

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
  /**
   * 種別別。**実装だけはフェーズごとの行へ割ってある**（#2779）ので、`implementation`の
   * キーは入っていない（`phase-*`と`implementation-unsplit`に分かれる）
   */
  byKind: UsageGroup[];
  /** 実装セッションの本数（#2779）。`byKind`はフェーズへ割れて数えられないので別に持つ */
  implementationSessions: number;
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

/**
 * 実装セッションのフェーズ（#2779）。**「セッション種別別」では実装の行をこれらのフェーズへ置き換える（#3064で検証を足して5つ）。**
 * 実装は全体の9割を占める1行になっていて、そのままでは「実装が多い」以上のことが読めない。
 */
export const USAGE_PHASE_ORDER = ["plan", "research", "coding", "verify", "wrapup"] as const;
export type UsageImplementationPhase = (typeof USAGE_PHASE_ORDER)[number];

/** フェーズ1つぶんの行のキー。種別のキー（`implementation`など）と混ざらないよう接頭辞を付ける */
export function usagePhaseKindKey(phase: UsageImplementationPhase): string {
  return `phase-${phase}`;
}

/**
 * フェーズを拾えなかった実装セッションの行（#2779）。**合計を変えないために置く。**
 * pollerを入れ替える前に集計された行はフェーズを持たず、落とすとカードの合計が
 * 「従量課金相当」タイルと合わなくなる。数日で保持期間の外へ出て消える。
 */
export const IMPLEMENTATION_UNSPLIT_KIND_KEY = "implementation-unsplit";

/** 画面に出す種別の名前。シェル側の`KIND_LABELS`と揃える */
const KIND_LABELS: Record<string, string> = {
  implementation: "実装",
  "plan-review": "計画レビュー",
  "code-review": "コードレビュー",
  question: "横断質問",
  other: "その他",
  // 種別別ではCI（`claude-review`など）とレビューが中心なので、実行経路の名前ではなく
  // 何をしているかで呼ぶ（#3064）。Issue・PR別の明細は実行経路として「GitHub Actions」のまま
  actions: "CI/CD・レビュー",
  // 計画レビュー（別セッションの点検）と区別できるよう、立てる側は「立案」と呼ぶ（#3064）
  "phase-plan": "計画立案",
  "phase-research": "調査",
  "phase-coding": "実装",
  "phase-verify": "検証（テスト・Lint・型）",
  "phase-wrapup": "仕上げ（コミット・PR・報告）",
  [IMPLEMENTATION_UNSPLIT_KIND_KEY]: "実装（フェーズ未集計）",
};

export function sessionUsageKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/**
 * 「セッション種別別」の行の並び（#2954）。**金額順ではなく、Issueが進む順に固定する。**
 * 金額順では期間を切り替えるたびに行の位置が入れ替わり、作業の流れに沿って読めなかった。
 */
const USAGE_WORK_FLOW_KIND_ORDER: readonly string[] = [
  usagePhaseKindKey("plan"),
  "plan-review",
  usagePhaseKindKey("research"),
  usagePhaseKindKey("coding"),
  usagePhaseKindKey("verify"),
  IMPLEMENTATION_UNSPLIT_KIND_KEY,
  usagePhaseKindKey("wrapup"),
  "code-review",
  "actions",
];

/** Issueの作業の流れに属さない種別。流れの後ろに置き、画面は手前に区切りを入れる */
const USAGE_KIND_ORDER: readonly string[] = [...USAGE_WORK_FLOW_KIND_ORDER, "question", "other"];

/**
 * 種別の行がIssueの作業の流れに入るか（#2954）。**未知の種別は流れの外として扱う**
 * （どの工程か分からないものを、工程の途中へ紛れ込ませない）。
 */
export function isUsageKindInWorkFlow(kind: string): boolean {
  return USAGE_WORK_FLOW_KIND_ORDER.includes(kind);
}

/**
 * 「セッション種別別」の並べ替え（#2954）。作業の流れ → 横断質問・その他 → 未知の種別の順。
 * **未知の種別は落とさず末尾に金額の多い順で置く**（落とすとカードの合計が合わなくなる）。
 */
export function compareUsageKinds(
  a: { key: string; costUsd: number },
  b: { key: string; costUsd: number },
): number {
  const rank = (key: string) => {
    const index = USAGE_KIND_ORDER.indexOf(key);
    return index === -1 ? USAGE_KIND_ORDER.length : index;
  };
  return rank(a.key) - rank(b.key) || b.costUsd - a.costUsd;
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

function emptyPhaseTotals(): UsagePhaseTotals {
  return {
    costUsd: 0,
    inputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    contextTokens: 0,
    outputTokens: 0,
    sessions: 0,
    models: [],
  };
}

function emptyPhaseBreakdown(): UsagePhaseBreakdown {
  return { plan: emptyPhaseTotals(), implementation: emptyPhaseTotals(), action: emptyPhaseTotals() };
}

/**
 * セッション1本の金額を、実装のフェーズ（計画・調査・実装・検証・仕上げ）へ割る（#2779・#3064）。
 * フェーズを拾えなかった行はnull。検証を持たない古い行は検証0として扱う。
 *
 * **計画は引き算で出す。** 集計側は`ExitPlanMode`が無いセッションの`planCostUsd`をnullで送る
 * （#2646の「区分なし」の意味を変えないため）が、その場合の計画は0であって不明ではない。
 * 残りとの差から出すと、**全フェーズの合計が必ず`costUsd`と一致する**ので、カードの合計が動かない。
 */
export function sessionUsageImplementationPhases(
  entry: Pick<
    SessionUsageEntry,
    "costUsd" | "planCostUsd" | "researchCostUsd" | "codingCostUsd" | "verifyCostUsd" | "wrapupCostUsd"
  >,
): Record<UsageImplementationPhase, number> | null {
  const { researchCostUsd, codingCostUsd, wrapupCostUsd } = entry;
  if (
    typeof researchCostUsd !== "number" ||
    !Number.isFinite(researchCostUsd) ||
    typeof codingCostUsd !== "number" ||
    !Number.isFinite(codingCostUsd) ||
    typeof wrapupCostUsd !== "number" ||
    !Number.isFinite(wrapupCostUsd)
  ) {
    return null;
  }
  // **3つの合計が金額を超えていたら、その比のまま金額へ収める。** 集計し直した内訳が、
  // 先に書き込まれた金額（走っている途中のセッションの行）より新しいことがあり、そのままだと
  // カードの合計が「従量課金相当」タイルを上回る。
  const verifyCostUsd =
    typeof entry.verifyCostUsd === "number" && Number.isFinite(entry.verifyCostUsd) && entry.verifyCostUsd > 0
      ? entry.verifyCostUsd
      : 0;
  const rest = researchCostUsd + codingCostUsd + verifyCostUsd + wrapupCostUsd;
  const scale = rest > entry.costUsd && rest > 0 ? entry.costUsd / rest : 1;
  return {
    plan: Math.max(0, entry.costUsd - rest * scale),
    research: researchCostUsd * scale,
    coding: codingCostUsd * scale,
    verify: verifyCostUsd * scale,
    wrapup: wrapupCostUsd * scale,
  };
}

/**
 * セッション1本を、そのフェーズぶんの大きさへ縮めた行として作り直す（#2779）。
 *
 * **トークン・応答数は金額比の按分**（#2670のフェーズ内訳と同じ扱い）。DBに持っているのは
 * フェーズ別の金額だけで、トークンは分かれていない。金額だけは按分ではなく実測値を入れる。
 */
function scaleEntryToPhase(entry: SessionUsageEntry, costUsd: number): SessionUsageEntry {
  const ratio = entry.costUsd > 0 ? costUsd / entry.costUsd : 0;
  return {
    ...entry,
    responses: Math.round(entry.responses * ratio),
    inputTokens: entry.inputTokens * ratio,
    cacheCreateTokens: entry.cacheCreateTokens * ratio,
    cacheReadTokens: entry.cacheReadTokens * ratio,
    contextTokens: entry.contextTokens * ratio,
    outputTokens: entry.outputTokens * ratio,
    costUsd,
  };
}

/**
 * セッション1本が「セッション種別別」のどの行へ入るか（#2779）。
 * **実装だけは1本が最大5行へ分かれる**。ほかの種別は今までどおり1行。
 */
function kindRowsForEntry(entry: SessionUsageEntry): { key: string; entry: SessionUsageEntry }[] {
  if (entry.kind !== "implementation") return [{ key: entry.kind, entry }];
  const phases = sessionUsageImplementationPhases(entry);
  if (phases === null) return [{ key: IMPLEMENTATION_UNSPLIT_KIND_KEY, entry }];
  const rows = USAGE_PHASE_ORDER.filter((phase) => phases[phase] > 0).map((phase) => ({
    key: usagePhaseKindKey(phase),
    entry: scaleEntryToPhase(entry, phases[phase]),
  }));
  // 金額が全て0のセッション（`<synthetic>`だけの行など）は、按分しても意味が無いのでまとめて出す。
  return rows.length > 0 ? rows : [{ key: IMPLEMENTATION_UNSPLIT_KIND_KEY, entry }];
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

/**
 * Issue（またはPR）単位のグルーピングキー。`buildSessionUsageSummary`の集計と、
 * 窓（期間の外にはみ出しうる）から計算するIssue別の枠%按分（#2988）の両方で使う——
 * 期間で絞った`UsageIssue.entries`だけでは窓の全体を拾えないことがあるため、
 * 集計とは別に「このセッションはどのIssue行に属するか」を判定できる形で公開する。
 */
export function sessionUsageIssueKey(
  entry: Pick<SessionUsageEntry, "repository" | "issueNumber" | "prNumber">,
): string {
  const repositoryKey = entry.repository ?? "";
  return entry.issueNumber !== null
    ? `${repositoryKey}#${entry.issueNumber}`
    : `${repositoryKey}##${entry.prNumber ?? ""}`;
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

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 日別の並びを、期間の全日（`since`の日〜`until`の日。日本時間）へ埋める（#3038）。
 *
 * **`buildSessionUsageSummary`の`byDay`は記録のあった日しか持たない**（セッションが1本も終わらな
 * かった日は行が無い）。縦棒の日別は横軸が日付なので、間の日が抜けると隣り合う棒が連続した日に
 * 見えてしまう。0の日を空の行で足して、日付を残す。集計側（API・既存テスト）は変えない。
 *
 * 期間の外に出た日（時計のずれで`until`より先になった記録など）は落とさず、そのまま並べる
 * （落とすと合計と棒の総和が合わなくなる）。
 */
export function fillUsageDays(days: UsageDay[], since: string, until: string): UsageDay[] {
  const startMs = startOfJstDayMs(since);
  const endMs = startOfJstDayMs(until);
  if (startMs === null || endMs === null) return days;

  const byDate = new Map(days.map((day) => [day.date, day]));
  // 日本時間には夏時間が無く、1日は常に24時間。0:00を起点に足していけば日付がずれない。
  for (let ms = startMs; ms <= endMs; ms += DAY_MS) {
    const date = jstDateKey(new Date(ms).toISOString());
    if (date && !byDate.has(date)) {
      byDate.set(date, {
        date,
        ...emptyTotals(),
        byAgent: emptyByAgent(),
        bySource: emptyBySource(),
      });
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 縦軸の目盛り（#3038）。**最大値を含む「切りの良い」上限と間隔を返す**。目盛りは4本前後
 * （0を含めて5本以下）で、間隔は1・2・5の10のべき乗倍から選ぶ。最大が0（全日が0）のときは
 * 目盛りだけ描けるよう`$1`を上限にする。
 */
export function niceAxisScale(maxValue: number): { max: number; step: number; ticks: number[] } {
  if (!Number.isFinite(maxValue) || maxValue <= 0) return { max: 1, step: 1, ticks: [0, 1] };
  const raw = maxValue / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((factor) => factor * power).find((value) => value >= raw) ?? power * 10;
  const max = step * Math.ceil(maxValue / step - 1e-9);
  const ticks: number[] = [];
  for (let index = 0; index * step <= max + step / 1e6; index += 1) {
    // 掛け算で出して足し込みの誤差（0.1+0.2）を持ち込まない。
    ticks.push(Number((index * step).toPrecision(12)));
  }
  return { max, step, ticks };
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
  let implementationSessions = 0;

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

    // **実装はフェーズごとの行へ割る**（#2779）。ほかの種別は1本＝1行のまま。
    if (entry.kind === "implementation") implementationSessions += 1;
    for (const row of kindRowsForEntry(entry)) {
      const kind = byKind.get(row.key) ?? {
        key: row.key,
        ...emptyTotals(),
        byAgent: emptyByAgent(),
        bySource: emptyBySource(),
      };
      addEntryWithAgent(kind, row.entry);
      addEntryWithSource(kind, row.entry);
      byKind.set(row.key, kind);
    }

    // **Issue番号を持たないセッションもリポジトリ単位でまとめて出す。** 計画レビュー・横断質問は
    // 作業ディレクトリにIssue番号を持たないことがあり、落とすと合計と明細が合わなくなる。
    // **issueNumberがあればそれだけでキーを作る**（#2653）。同じIssueのローカルセッションと、
    // そこから派生したPRのGitHub Actions実行（ブランチ名`issue-<N>`から`identify-issue`ジョブが
    // issueNumberを解決できたもの）は、prNumberの有無・値が違っても同じIssueの活動としてまとめる。
    // **issueNumberが無いときだけprNumberを使う**（#2650）。Issueへ紐付かないPR起点の実行
    // （developへのPRレビュー等）を、複数のPRが1つの「Issue未特定」行へ潰れないよう区別するため
    const issueKey = sessionUsageIssueKey(entry);
    const issue =
      byIssue.get(issueKey) ??
      ({
        repository: entry.repository,
        issueNumber: entry.issueNumber,
        prNumber: entry.prNumber,
        title: null,
        kinds: [],
        latestStartedAt: entry.startedAt,
        entries: [],
        byAgent: emptyByAgent(),
        bySource: emptyBySource(),
        phases: emptyPhaseBreakdown(),
        quotaPercent: null,
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
    issue.phases = buildPhaseBreakdown(issue.entries);
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
    byKind: [...byKind.values()].sort(compareUsageKinds),
    implementationSessions,
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

function addPhaseModels(target: string[], models: string[]): void {
  for (const model of models) {
    if (!target.includes(model)) target.push(model);
  }
}

/** リポジトリ別の円グラフの1切れ（#3060） */
export type RepositoryPieSlice = {
  /** リポジトリ名。「その他」は空文字（`isOther`で見分ける） */
  key: string;
  label: string;
  costUsd: number;
  /** 全体に対する割合（0〜1） */
  fraction: number;
  /** 「その他」にまとめたリポジトリの数。上位の切れは1 */
  repositoryCount: number;
  isOther: boolean;
};

/** リポジトリ別の円グラフに名前を出す上位の件数。これより下は「その他」にまとめる */
export const REPOSITORY_PIE_TOP_COUNT = 5;

/**
 * リポジトリ別の内訳を、**金額の上位5件と「その他」**の切れへ畳む（#3060）。
 * エージェント（Claude・Codex・GitHub Actions）とトークン量の区別は持たない（金額だけを見る）。
 * 金額が0のリポジトリは切れにしない。割合は金額0を除いた合計に対する比。
 */
export function buildRepositoryPieSlices(
  groups: Pick<UsageGroup, "key" | "costUsd">[],
  topCount = REPOSITORY_PIE_TOP_COUNT,
): RepositoryPieSlice[] {
  const ranked = groups.filter((group) => group.costUsd > 0).sort((a, b) => b.costUsd - a.costUsd);
  const total = ranked.reduce((sum, group) => sum + group.costUsd, 0);
  if (total <= 0) return [];

  const slices: RepositoryPieSlice[] = ranked.slice(0, topCount).map((group) => ({
    key: group.key,
    label: group.key || "(不明)",
    costUsd: group.costUsd,
    fraction: group.costUsd / total,
    repositoryCount: 1,
    isOther: false,
  }));
  const rest = ranked.slice(topCount);
  if (rest.length > 0) {
    const restCost = rest.reduce((sum, group) => sum + group.costUsd, 0);
    slices.push({
      key: "",
      label: "その他",
      costUsd: restCost,
      fraction: restCost / total,
      repositoryCount: rest.length,
      isOther: true,
    });
  }
  return slices;
}

/**
 * Issue1件ぶんの明細（`UsageIssue["entries"]`）を、計画・実装・Actionの3分類へ畳む（#2670）。
 *
 * **Actionは`source`で正確に分離できる**（トークンも実測）。ローカル実行のうち
 * `sessionUsagePhaseSplit`が区分を持つ行（Plan modeを使ったセッション）は、**金額は正確**
 * （集計側が単価から割ったもの）だが、**トークンはDBに計画/実装別の内訳が無いため、
 * 金額比でセッション全体のトークンを按分する**（近似）。区分を持たない行（Plan mode未使用）は
 * 全額・全トークンをそのまま実装へ計上する（按分不要で正確）。
 *
 * モデルはフェーズ単位の記録が無いため、按分元セッションの`models`をそのまま両フェーズへ流用する。
 */
export function buildPhaseBreakdown(entries: SessionUsageEntry[]): UsagePhaseBreakdown {
  const breakdown = emptyPhaseBreakdown();

  for (const entry of entries) {
    if (entry.source === "github-actions") {
      const action = breakdown.action;
      action.costUsd += entry.costUsd;
      action.inputTokens += entry.inputTokens;
      action.cacheCreateTokens += entry.cacheCreateTokens;
      action.cacheReadTokens += entry.cacheReadTokens;
      action.contextTokens += entry.contextTokens;
      action.outputTokens += entry.outputTokens;
      action.sessions += 1;
      addPhaseModels(action.models, entry.models);
      continue;
    }

    const split = sessionUsagePhaseSplit(entry);
    if (split === null) {
      const implementation = breakdown.implementation;
      implementation.costUsd += entry.costUsd;
      implementation.inputTokens += entry.inputTokens;
      implementation.cacheCreateTokens += entry.cacheCreateTokens;
      implementation.cacheReadTokens += entry.cacheReadTokens;
      implementation.contextTokens += entry.contextTokens;
      implementation.outputTokens += entry.outputTokens;
      implementation.sessions += 1;
      addPhaseModels(implementation.models, entry.models);
      continue;
    }

    // トークンの按分は「概算」であることを画面が単色バーで示すだけで足りる
    // （ユーザー判断・#2670）ため、入力/キャッシュ/出力の区分ごとには割らず、
    // 合計（contextTokens／outputTokens）だけを金額比で按分する。
    const planRatio = entry.costUsd > 0 ? split.planCostUsd / entry.costUsd : 0;
    const plan = breakdown.plan;
    plan.costUsd += split.planCostUsd;
    plan.contextTokens += entry.contextTokens * planRatio;
    plan.outputTokens += entry.outputTokens * planRatio;
    plan.sessions += 1;
    addPhaseModels(plan.models, entry.models);

    const implementation = breakdown.implementation;
    implementation.costUsd += split.implementationCostUsd;
    implementation.contextTokens += entry.contextTokens * (1 - planRatio);
    implementation.outputTokens += entry.outputTokens * (1 - planRatio);
    implementation.sessions += 1;
    addPhaseModels(implementation.models, entry.models);
  }

  return breakdown;
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

/**
 * 5時間枠の実測換算レート（#2988）。
 *
 * **算出方法。** 5時間枠のヘッダには使用率(%)とリセット時刻はあるが、絶対量（トークン数・金額）は
 * 非公開。そこで「リセット時刻から5時間引いた時刻」をウィンドウ開始とみなし、そこから現在までに
 * issue-deckが把握しているClaudeの消費（ローカル・GitHub Actions問わず。どちらも同じ
 * `CLAUDE_CODE_OAUTH_TOKEN`を使うため同じ枠を消費する）の合計金額を、実測の使用率(%)で割る。
 * これで「1%あたり約$X」という、直近ウィンドウ内でだけ意味を持つ相対レートが求まる。
 * `entries`は`buildIssueQuotaPercents`にも使うウィンドウ全体をカバーする範囲（期間の開始と
 * ウィンドウ開始の早い方）で渡すこと——`/api/session-usage`が取得範囲を決める。
 *
 * **これは#2666（`de23eb8e`）で削除した`buildQuotaScale`/`toQuotaPercent`と同じ考え方の
 * 再導入で、「向きが違うから別物」ではない。** 計算式は当時と同一（窓内の実測消費÷使用率）。
 * ただし2点変えている。(1) 当時は「5時間枠は1セッションで振り切れて物差しとして荒い」として
 * 週間枠を優先していたが、**今回のIssueの要求は5時間枠そのものの内訳**なので、荒さ（＝1つの
 * Issueが枠のほとんどを占めることがある）はむしろ「今どのIssueが枠を圧迫しているか」を知りたい
 * 目的に対しては有用な情報であり、週間枠で薄めると見えなくなる。5時間枠限定とし、求まらなければ
 * 出さない（フォールバックで週間枠へ逃げない）。(2) 当時は`source !== "github-actions"`を除外
 * していたが、GitHub Actionsも同じ`CLAUDE_CODE_OAUTH_TOKEN`を使い同じ枠を消費するため含める
 * （計上漏れを1つ減らす）。
 *
 * **それでも把握できない消費（issue-deck以外でのClaude利用、`lib/claude/api-usage.ts`が数える
 * アプリ内AI機能の呼び出し）は`entries`に入らない。** 分母（windowCostUsd）が実際より小さくなる
 * ため`usdPerPercent`は本来より低く出て、**この換算を使って出すIssue別の枠%は実際より大きめに
 * 出る**（画面はそう断る。#2666時点のコメントと向きは同じで、GitHub Actionsを含めたぶんだけ
 * 当時よりは実際に近づく）。
 */
export type QuotaEstimate = {
  /** 5時間枠1%あたりの従量課金相当額(USD)。 */
  usdPerPercent: number;
  /** 換算の元にしたウィンドウの開始時刻(epoch ms)。 */
  windowStartMs: number;
  /** ウィンドウ内の合計費用(USD)。 */
  windowCostUsd: number;
};

export function buildQuotaEstimate({
  entries,
  usedPercent,
  resetsAt,
  windowDurationMs,
}: {
  entries: Pick<SessionUsageEntry, "agent" | "costUsd" | "endedAt">[];
  usedPercent: number;
  /** epoch秒。取得できていなければnull。 */
  resetsAt: number | null;
  windowDurationMs: number;
}): QuotaEstimate | null {
  if (resetsAt === null || !(usedPercent > 0)) return null;

  const windowStartMs = resetsAt * 1000 - windowDurationMs;
  const windowCostUsd = entries
    .filter((entry) => entry.agent === "claude" && new Date(entry.endedAt).getTime() >= windowStartMs)
    .reduce((sum, entry) => sum + entry.costUsd, 0);
  if (!(windowCostUsd > 0)) return null;

  return { usdPerPercent: windowCostUsd / usedPercent, windowStartMs, windowCostUsd };
}

/**
 * Issue（PR）別に、直近5時間枠のウィンドウ内消費を「およそ何%」へ変換する（#2988）。
 *
 * **`UsageIssue.entries`ではなく、DB取得段階の`entries`全体から計算し直す。** 期間の切り出し
 * （`sessionUsagePeriodStartMs`。「1日」は日本時間0:00始まり）とウィンドウの開始
 * （`quota.windowStartMs`）は別の基準で決まり、ウィンドウが期間の外へはみ出すことがある
 * （深夜〜早朝に開くと5時間枠の前半が前日にかかる）。`/api/session-usage`は取得範囲を
 * `Math.min(期間の開始, ウィンドウの開始)`まで広げて`entries`を渡す——`buildSessionUsageSummary`
 * 側は従来どおり期間でしか集計しないため、`UsageIssue.entries`だけを見るとウィンドウ前半の
 * 消費が漏れて按分が過大に出る。ここではその広げたentriesを直接畳んで漏れを無くす。
 */
export function buildIssueQuotaPercents(
  entries: Pick<SessionUsageEntry, "agent" | "costUsd" | "endedAt" | "repository" | "issueNumber" | "prNumber">[],
  quota: QuotaEstimate | null,
): Map<string, number> {
  const percentByIssueKey = new Map<string, number>();
  if (quota === null) return percentByIssueKey;

  const costByIssueKey = new Map<string, number>();
  for (const entry of entries) {
    if (entry.agent !== "claude") continue;
    if (new Date(entry.endedAt).getTime() < quota.windowStartMs) continue;
    const key = sessionUsageIssueKey(entry);
    costByIssueKey.set(key, (costByIssueKey.get(key) ?? 0) + entry.costUsd);
  }

  for (const [key, costUsd] of costByIssueKey) {
    if (costUsd > 0) percentByIssueKey.set(key, costUsd / quota.usdPerPercent);
  }
  return percentByIssueKey;
}

/**
 * 「実行中のセッション」欄（#3084）の状態の出し分け。**文言はAPI側で`summarizeIssueSession`から
 * 作って渡し、ここでは色の区別だけを持つ**（画面ごとに同じ状態を別の言い方で出さないため）。
 * `idle`は「応答を終えています」（作業が終わったか、次の指示を待っている）。
 */
export type CurrentSessionTone = "running" | "waiting" | "idle";

/** 突き合わせに使う、生きているセッション1本ぶん（`DispatchSession`のALIVEの行） */
export type CurrentSessionInput = {
  host: string;
  tmuxSessionName: string;
  repositoryFullName: string;
  issueNumber: number;
  /** pollerが最初にそのtmuxセッションを見た時刻（ISO）。「開始から」の起点 */
  firstSeenAt: string;
  agent: "claude" | "codex";
  statusLabel: string;
  statusTone: CurrentSessionTone;
  /** 転記から引いたモデル（`listDispatchSessions`が埋める）。使用量の行に無いときの補い */
  models: string[];
};

/** 画面に出す実行中のセッション1本ぶん */
export type CurrentSessionUsage = {
  host: string;
  tmuxSessionName: string;
  /** ownerを除いた短い名前（`SessionUsage.repository`・`onOpenIssue`と同じ形） */
  repository: string;
  issueNumber: number;
  /** 常にnull。Issue・PR別のタイトル解決（`resolveIssueTitles`）をそのまま通すために持つ */
  prNumber: null;
  title: string | null;
  agent: "claude" | "codex";
  statusLabel: string;
  statusTone: CurrentSessionTone;
  startedAt: string;
  models: string[];
  /** 使用量の行が1件でも当たったか。falseなら「集計待ち」 */
  reported: boolean;
  responses: number;
  contextTokens: number;
  outputTokens: number;
  costUsd: number;
  /** 直近5時間枠のおよそ何%か。Codex・換算できないときはnull */
  quotaPercent: number | null;
};

/**
 * 生きているセッションと`SessionUsage`の行を突き合わせる（#3084）。
 *
 * **突き合わせはホスト・リポジトリ名・Issue番号・種別（実装）で行い、`endedAt`がそのセッションの
 * `firstSeenAt`以降の行だけを見る**（`sessions.ts`の`resolveSessionModels`と同じ基準。同じIssueの
 * 前回のセッションを拾わない）。当たった行はすべて足す——サブエージェントの転記は別の行として
 * 報告されるが、同じセッションの消費に違いない。`--continue`で再開した転記は開始からの累計になる。
 *
 * 並びは金額の多い順で、まだ報告の無いセッション（集計待ち）は末尾へ回す。
 */
export function buildCurrentSessionUsage({
  sessions,
  entries,
  quota,
}: {
  sessions: readonly CurrentSessionInput[];
  entries: readonly SessionUsageEntry[];
  quota: QuotaEstimate | null;
}): CurrentSessionUsage[] {
  const rows = sessions.map((session): CurrentSessionUsage => {
    const repository = session.repositoryFullName.split("/")[1] ?? session.repositoryFullName;
    const startedMs = new Date(session.firstSeenAt).getTime();
    const matched = entries.filter(
      (entry) =>
        (entry.source ?? "local") === "local" &&
        entry.kind === "implementation" &&
        entry.host === session.host &&
        entry.repository === repository &&
        entry.issueNumber === session.issueNumber &&
        new Date(entry.endedAt).getTime() >= startedMs,
    );

    const costUsd = matched.reduce((sum, entry) => sum + entry.costUsd, 0);
    // 5時間枠の換算はClaudeだけ（`buildIssueQuotaPercents`と同じ基準）
    const windowCostUsd =
      quota === null
        ? 0
        : matched
            .filter(
              (entry) =>
                entry.agent === "claude" && new Date(entry.endedAt).getTime() >= quota.windowStartMs,
            )
            .reduce((sum, entry) => sum + entry.costUsd, 0);
    const models = [...new Set(matched.flatMap((entry) => entry.models))];

    return {
      host: session.host,
      tmuxSessionName: session.tmuxSessionName,
      repository,
      issueNumber: session.issueNumber,
      prNumber: null,
      title: null,
      agent: session.agent,
      statusLabel: session.statusLabel,
      statusTone: session.statusTone,
      startedAt: session.firstSeenAt,
      models: models.length > 0 ? models : session.models,
      reported: matched.length > 0,
      responses: matched.reduce((sum, entry) => sum + entry.responses, 0),
      contextTokens: matched.reduce((sum, entry) => sum + entry.contextTokens, 0),
      outputTokens: matched.reduce((sum, entry) => sum + entry.outputTokens, 0),
      costUsd,
      quotaPercent: quota !== null && windowCostUsd > 0 ? windowCostUsd / quota.usdPerPercent : null,
    };
  });

  return rows.sort((a, b) => {
    if (a.reported !== b.reported) return a.reported ? -1 : 1;
    return b.costUsd - a.costUsd;
  });
}

/** 「開始から」の経過。1時間未満は分だけ、それ以上は「1時間18分」の形。1分未満は「1分未満」 */
export function formatSessionElapsed(startedAt: string, nowMs: number): string {
  const elapsedMs = nowMs - new Date(startedAt).getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs < 60_000) return "1分未満";
  const totalMinutes = Math.floor(elapsedMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}分`;
  if (hours >= 24) return `${Math.floor(hours / 24)}日${hours % 24}時間`;
  return minutes === 0 ? `${hours}時間` : `${hours}時間${minutes}分`;
}
