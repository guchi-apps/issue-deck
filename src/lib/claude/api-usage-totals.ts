/**
 * AI API消費量の、**画面が読む形**（機能の一覧・型）と合計の出し方（純粋関数）（#2347）。
 *
 * 集計本体（`api-usage.ts`）はモジュールスコープにバケットを抱えるサーバー側の仕組みで、
 * 画面が要るのはここにあるものだけ。**`lib/github/issues-api.ts`と同じ分け方**で、純粋な
 * ものと外部AI APIを叩くもの（を辿るもの）はファイルを分ける（docs/code-map.md）。
 * クライアントコンポーネント・フックはこちらをimportする。
 */

/** 数える単位。ラベルはそのまま画面に出る */
export const CLAUDE_API_FEATURES = [
  { key: "issue_summary", label: "Issueの要約" },
  { key: "comment_summary", label: "コメントの要約" },
  { key: "issue_search", label: "AI検索" },
  { key: "issue_order", label: "着手順の提案" },
  { key: "issue_suggest", label: "Issueの下書き提案" },
  { key: "issue_body_cleanup", label: "本文の整形" },
  { key: "manual_step_fix", label: "手作業の修正提案" },
  { key: "model_pick", label: "モデルの自動選択" },
  { key: "new_app_consult", label: "新規アプリの相談" },
  // プラン枠の取得（`usage.ts`）自体もわずかにプラン枠を消費する。見えないところで減るのを
  // 避けるため、他の機能と同じように数える。
  { key: "plan_usage", label: "プラン枠の取得" },
  { key: "other", label: "その他" },
] as const;

export type ClaudeApiFeature = (typeof CLAUDE_API_FEATURES)[number]["key"];

const FEATURE_LABELS = new Map<string, string>(
  CLAUDE_API_FEATURES.map((feature) => [feature.key, feature.label]),
);

/** 未知のキー（機能を消したあとに残った古い記録）はキーのまま出す */
export function featureLabel(key: string): string {
  return FEATURE_LABELS.get(key) ?? key;
}

/** 1回の呼び出しで消費したトークン。応答の`usage`をそのまま写す */
export type ClaudeApiTokens = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

/** 呼び出し回数を足したもの。画面へ出すのはこの形 */
export type ClaudeApiTotals = ClaudeApiTokens & {
  calls: number;
};

export function emptyTotals(): ClaudeApiTotals {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

export function addTotals(target: ClaudeApiTotals, source: ClaudeApiTotals): void {
  target.calls += source.calls;
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheCreationTokens += source.cacheCreationTokens;
}

/**
 * 画面に出す「トークン数」。入力・出力に加えてキャッシュの読み書きも足す
 * （どれもプラン枠を消費するため、合計から外すと実態より小さく見える）。
 */
export function totalTokens(totals: ClaudeApiTokens): number {
  return (
    totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheCreationTokens
  );
}

/** 集計を出す期間。画面の切り替えもこの2つ */
export type ClaudeApiUsageWindows = {
  last24h: ClaudeApiTotals;
  last7d: ClaudeApiTotals;
};

export type ClaudeApiUsageModel = ClaudeApiUsageWindows & {
  model: string;
};

export type ClaudeApiUsageFeature = ClaudeApiUsageWindows & {
  key: ClaudeApiFeature;
  label: string;
  /** 直近7日のトークン数が多い順 */
  models: ClaudeApiUsageModel[];
};

export type ClaudeApiUsageSummary = {
  /**
   * 計測を開始した時刻(epoch ms)。現在保持している最古バケットの開始時刻（DBから復元した分を
   * 含む）で、保持データが無ければ現在時刻になる。
   */
  measuringSince: number;
  totalLast24h: ClaudeApiTotals;
  totalLast7d: ClaudeApiTotals;
  /** 直近7日のトークン数が多い順 */
  features: ClaudeApiUsageFeature[];
};
