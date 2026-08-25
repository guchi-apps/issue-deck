import {
  addTotals,
  type ClaudeApiFeature,
  type ClaudeApiTokens,
  type ClaudeApiTotals,
  type ClaudeApiUsageFeature,
  type ClaudeApiUsageModel,
  type ClaudeApiUsageSummary,
  emptyTotals,
  featureLabel,
  totalTokens,
} from "@/lib/claude/api-usage-totals";

/**
 * issue-deck自身が投げたAnthropic API（`/v1/messages`）の呼び出しを、機能別・モデル別に
 * 集計するためのプロセス内計測（#2347）。
 *
 * Anthropicはレート制限ヘッダで「プラン枠を何%使ったか」しか返さず（`usage.ts`）、
 * どの機能がどれだけ消費したかの内訳を得る手段が無い。そのため、アプリ側で自分の発信を数える。
 * 数えるのは推計ではなく、応答の`usage`が返す実測のトークン数。
 *
 * 直近7日ぶんを5分バケットのリングバッファに保持し、**呼び出しを1件数えるたびに
 * `onBucketUpdated()`のリスナーへ現在のバケットを渡す**（`src/instrumentation.ts`がDBへ
 * 永続化し、起動時は`loadPersistedBuckets()`で復元する）。
 *
 * **GitHub版（`lib/github/api-usage.ts`）と違い、バケットが繰り上がったときではなく毎回書く。**
 * あちらは常時ポーリングがあり5分以内に必ず次のバケットへ進むが、AIの呼び出しは9つとも
 * ボタン起点で、次の呼び出しまで数時間空くことがある。繰り上がりを待つと**いちばん見たい
 * 直近の消費が書かれないまま**再起動・デプロイで消える。1日数十件の書き込みは無視できる。
 *
 * DBへの反映は非同期・ベストエフォートで、メモリ上の集計自体はDBの有無に依存しない。
 *
 * **ここに入るのはissue-deckのサーバーが投げた呼び出しだけ。** GitHub Actionsの無人実行や
 * サブPCのローカルセッション（Claude Code本体）の消費は入らない。それらは同じプランを
 * 共有しているため、プラン枠のメーター（`usage.ts`）には合算で表れる。
 *
 * GitHub版と同じく、この計測はプロセス単位でユーザー・デバイスによるフィルタを持たない
 * （単一プロセスでデプロイされている前提）。
 */

export type {
  ClaudeApiFeature,
  ClaudeApiTokens,
  ClaudeApiTotals,
  ClaudeApiUsageFeature,
  ClaudeApiUsageModel,
  ClaudeApiUsageSummary,
};
export { CLAUDE_API_FEATURES, totalTokens } from "@/lib/claude/api-usage-totals";

/** 集計の時間分解能。GitHub版と揃える */
const BUCKET_MS = 5 * 60_000;

const DAY_MS = 24 * 60 * 60_000;

/** 保持する期間。プラン枠の週間ウィンドウに合わせて7日ぶん持つ */
export const USAGE_WINDOW_MS = 7 * DAY_MS;

type Bucket = {
  /** バケットの開始時刻（BUCKET_MSで切り捨てたepoch ms） */
  startedAt: number;
  /** `feature\tmodel` -> 集計 */
  totals: Map<string, ClaudeApiTotals>;
};

/**
 * 集計とリスナーの置き場。**`globalThis`へ載せる**（#2347）。
 *
 * Next.jsは`instrumentation.ts`とRoute Handlerを別のバンドルへ入れるため、素朴に
 * モジュールスコープへ持つと**同じファイルの実体が2つでき、起動時に登録した永続化の
 * リスナーが記録側から見えない**（実測でリスナー0件のまま、DBへ1行も書かれなかった）。
 * 開発時のHMRでも実体が増える。`lib/db.ts`のPrismaClientと同じ形で1つに寄せる。
 *
 * `buckets`は開始時刻の昇順に保つ。
 */
type ClaudeApiUsageState = {
  buckets: Bucket[];
  listeners: BucketUpdatedListener[];
};

const globalForUsage = globalThis as unknown as { claudeApiUsage?: ClaudeApiUsageState };

const state: ClaudeApiUsageState = (globalForUsage.claudeApiUsage ??= {
  buckets: [],
  listeners: [],
});

type BucketUpdatedListener = (bucket: ClaudeApiUsageBucketSnapshot) => void;

export type ClaudeApiUsageBucketEntry = ClaudeApiTotals & {
  feature: ClaudeApiFeature;
  model: string;
};

export type ClaudeApiUsageBucketSnapshot = {
  /** バケットの開始時刻（BUCKET_MSで切り捨てたepoch ms） */
  startedAt: number;
  entries: ClaudeApiUsageBucketEntry[];
};

/**
 * 呼び出しを1件数えるたびに、そのバケットの現在の中身を渡して`listener`を呼ぶ。
 * 永続化（DB書き込み）の登録に使う。**保存はupsertなので、同じバケットを何度渡してもよい。**
 */
export function onBucketUpdated(listener: BucketUpdatedListener): void {
  state.listeners.push(listener);
}

function snapshot(bucket: Bucket): ClaudeApiUsageBucketSnapshot {
  const entries = [...bucket.totals].map(([key, totals]) => {
    const [feature, model] = key.split("\t");
    return { feature: feature as ClaudeApiFeature, model, ...totals };
  });
  return { startedAt: bucket.startedAt, entries };
}

function notifyBucketUpdated(bucket: Bucket): void {
  if (state.listeners.length === 0) return;
  const updated = snapshot(bucket);
  for (const listener of state.listeners) listener(updated);
}

function bucketStartAt(now: number): number {
  return Math.floor(now / BUCKET_MS) * BUCKET_MS;
}

function pruneBuckets(now: number): void {
  const oldest = now - USAGE_WINDOW_MS;
  state.buckets = state.buckets.filter((bucket) => bucket.startedAt >= oldest);
}

function bucketFor(now: number): Bucket {
  pruneBuckets(now);

  const startedAt = bucketStartAt(now);
  let bucket = state.buckets.find((candidate) => candidate.startedAt === startedAt);
  if (!bucket) {
    bucket = { startedAt, totals: new Map() };
    state.buckets.push(bucket);
    // 時刻が巻き戻った場合（NTP補正など）でも昇順を保つ
    state.buckets.sort((a, b) => a.startedAt - b.startedAt);
  }
  return bucket;
}

/** Anthropic APIの呼び出しを1件計上する */
export function recordClaudeApiCall(options: {
  feature: ClaudeApiFeature;
  model: string;
  tokens: ClaudeApiTokens;
  now?: number;
}): void {
  const now = options.now ?? Date.now();
  const key = `${options.feature}\t${options.model}`;
  const bucket = bucketFor(now);

  const totals = bucket.totals.get(key) ?? emptyTotals();
  addTotals(totals, { calls: 1, ...options.tokens });
  bucket.totals.set(key, totals);

  notifyBucketUpdated(bucket);
}

/**
 * DBなど外部から読み込んだバケットの内容をメモリへ流し込む。起動時に一度呼ぶ想定
 * （既存のメモリ上の集計へ加算するため、複数回呼んでも壊れないが通常は起動時の1回のみ）。
 */
export function loadPersistedBuckets(
  persisted: ClaudeApiUsageBucketSnapshot[],
  now: number = Date.now(),
): void {
  for (const persistedBucket of persisted) {
    const startedAt = bucketStartAt(persistedBucket.startedAt);
    let bucket = state.buckets.find((candidate) => candidate.startedAt === startedAt);
    if (!bucket) {
      bucket = { startedAt, totals: new Map() };
      state.buckets.push(bucket);
    }
    for (const entry of persistedBucket.entries) {
      const key = `${entry.feature}\t${entry.model}`;
      const totals = bucket.totals.get(key) ?? emptyTotals();
      addTotals(totals, entry);
      bucket.totals.set(key, totals);
    }
  }
  state.buckets.sort((a, b) => a.startedAt - b.startedAt);
  pruneBuckets(now);
}

/** 機能別・モデル別に集計した直近の消費状況を返す */
export function getClaudeApiUsageSummary(now: number = Date.now()): ClaudeApiUsageSummary {
  pruneBuckets(now);

  const dayAgo = now - DAY_MS;
  const totals = new Map<string, { last24h: ClaudeApiTotals; last7d: ClaudeApiTotals }>();

  for (const bucket of state.buckets) {
    const withinDay = bucket.startedAt >= dayAgo;
    for (const [key, bucketTotals] of bucket.totals) {
      const total = totals.get(key) ?? { last24h: emptyTotals(), last7d: emptyTotals() };
      addTotals(total.last7d, bucketTotals);
      if (withinDay) addTotals(total.last24h, bucketTotals);
      totals.set(key, total);
    }
  }

  const byFeature = new Map<ClaudeApiFeature, ClaudeApiUsageFeature>();
  for (const [key, total] of totals) {
    const [featureKey, model] = key.split("\t");
    const feature = featureKey as ClaudeApiFeature;
    const entry = byFeature.get(feature) ?? {
      key: feature,
      label: featureLabel(feature),
      last24h: emptyTotals(),
      last7d: emptyTotals(),
      models: [],
    };
    addTotals(entry.last24h, total.last24h);
    addTotals(entry.last7d, total.last7d);
    entry.models.push({ model, last24h: total.last24h, last7d: total.last7d });
    byFeature.set(feature, entry);
  }

  const features = [...byFeature.values()]
    .map((feature) => ({
      ...feature,
      models: feature.models.sort((a, b) => totalTokens(b.last7d) - totalTokens(a.last7d)),
    }))
    .sort((a, b) => totalTokens(b.last7d) - totalTokens(a.last7d));

  const totalLast24h = emptyTotals();
  const totalLast7d = emptyTotals();
  for (const feature of features) {
    addTotals(totalLast24h, feature.last24h);
    addTotals(totalLast7d, feature.last7d);
  }

  return {
    measuringSince: state.buckets[0]?.startedAt ?? now,
    totalLast24h,
    totalLast7d,
    features,
  };
}

/** テスト用に計測結果・`onBucketUpdated`のリスナー登録を空にする */
export function resetClaudeApiUsage(): void {
  state.buckets = [];
  state.listeners.length = 0;
}
