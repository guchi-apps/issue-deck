import { AsyncLocalStorage } from "node:async_hooks";

/**
 * GitHub APIの呼び出しを用途（機能）別に集計するためのプロセス内計測。
 *
 * GitHubは`/rate_limit`でもレスポンスヘッダでも「カテゴリ別の合計」しか返さず、どの機能が
 * どれだけ消費したかの内訳を得る手段が無い。そのため、アプリ側で自分の発信を数える。
 *
 * 直近24時間ぶんを5分バケットのリングバッファに保持する（プロセス内メモリのみ。再起動や
 * デプロイで消えるが、消費の偏りを把握し改善の効果を測る用途には足りる）。
 * 用途の指定は`withGithubApiFeature()`でリクエスト単位に文脈として持たせ、
 * GitHub APIを叩く各関数の引数を増やさずに済ませている。
 *
 * この計測はプロセス単位で、ユーザー・セッション・デバイスによるフィルタを持たない
 * （単一プロセスでデプロイされている前提に暗黙的に依存している。複数インスタンス構成に
 * なるとインスタンスごとに集計が分裂する）。
 *
 * 7日・30日規模への集計拡張は、現状のプロセス内メモリ保持のままでは再起動で消えるため
 * 別途永続化の検討が必要になる。
 */

export const GITHUB_API_FEATURES = [
  { key: "issue_list_workflow_running", label: "一覧の実行状況ポーリング" },
  { key: "issue_detail_workflow_run", label: "詳細の実行状況ポーリング" },
  { key: "pull_request_ci", label: "PRのCI状態ポーリング" },
  { key: "release_status", label: "リリース進捗ポーリング" },
  { key: "issue_comments", label: "コメント取得" },
  { key: "repo_meta", label: "ラベル・担当者の取得" },
  { key: "issue_write", label: "Issueの作成・更新・削除・移動" },
  { key: "comment_write", label: "コメントの投稿・編集・削除" },
  { key: "workflow_cancel", label: "実行のキャンセル" },
  { key: "release_dispatch", label: "リリースの起動" },
  { key: "sync", label: "Issueの再同期" },
  { key: "setup", label: "セットアップ・インストール" },
  { key: "other", label: "その他" },
] as const;

export type GithubApiFeature = (typeof GITHUB_API_FEATURES)[number]["key"];

const FEATURE_LABELS = new Map<string, string>(
  GITHUB_API_FEATURES.map((feature) => [feature.key, feature.label]),
);

/** 集計の時間分解能。直近1時間の集計を実際の1時間に近づけるため、1時間より細かく刻む */
const BUCKET_MS = 5 * 60_000;

/** 保持する期間 */
export const USAGE_WINDOW_MS = 24 * 60 * 60_000;

const HOUR_MS = 60 * 60_000;

type Bucket = {
  /** バケットの開始時刻（BUCKET_MSで切り捨てたepoch ms） */
  startedAt: number;
  /** `feature\tendpoint` -> 呼び出し回数 */
  counts: Map<string, number>;
};

/** 開始時刻の昇順に保つ */
let buckets: Bucket[] = [];

/** 計測を開始した時刻。プロセス起動時にリセットされることをUIで示すために保持する */
let measuringSince = Date.now();

const featureStore = new AsyncLocalStorage<GithubApiFeature>();

/**
 * `fn`の実行中に発生したGitHub API呼び出しを`feature`として計上する。
 * ルートハンドラの本体を包んで使う。
 */
export function withGithubApiFeature<T>(feature: GithubApiFeature, fn: () => T): T {
  return featureStore.run(feature, fn);
}

/** 現在の用途。文脈が設定されていない場合は`other`として計上する */
export function currentGithubApiFeature(): GithubApiFeature {
  return featureStore.getStore() ?? "other";
}

/**
 * GitHub APIのURLを、集計しやすい形（可変部分をプレースホルダに置換したパス）へ正規化する。
 * 例: `https://api.github.com/repos/m-guchi/issue-deck/issues/123/comments?per_page=100`
 *     -> `/repos/{owner}/{repo}/issues/{n}/comments`
 */
export function toEndpointLabel(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // 相対URLや不正な値でも計測は落とさない
    pathname = url.split("?")[0];
  }

  const segments = pathname.split("/").filter((segment) => segment !== "");
  const normalized = segments.map((segment, index) => {
    if (segments[0] === "repos" && index === 1) return "{owner}";
    if (segments[0] === "repos" && index === 2) return "{repo}";
    if (/^\d+$/.test(segment)) return "{n}";
    if (/^[0-9a-f]{40}$/i.test(segment)) return "{sha}";
    return segment;
  });

  return `/${normalized.join("/")}`;
}

function bucketStartAt(now: number): number {
  return Math.floor(now / BUCKET_MS) * BUCKET_MS;
}

/** 正時（0分）を起点とした、現在の1時間ウィンドウの開始時刻を返す */
function currentHourStartAt(now: number): number {
  return Math.floor(now / HOUR_MS) * HOUR_MS;
}

function pruneBuckets(now: number): void {
  const oldest = now - USAGE_WINDOW_MS;
  buckets = buckets.filter((bucket) => bucket.startedAt >= oldest);
}

/** GitHub APIの呼び出しを1件計上する */
export function recordGithubApiCall(
  url: string,
  options: { feature?: GithubApiFeature; now?: number } = {},
): void {
  const now = options.now ?? Date.now();
  const feature = options.feature ?? currentGithubApiFeature();
  const key = `${feature}\t${toEndpointLabel(url)}`;

  pruneBuckets(now);

  const startedAt = bucketStartAt(now);
  let bucket = buckets.at(-1);
  if (!bucket || bucket.startedAt !== startedAt) {
    bucket = { startedAt, counts: new Map() };
    buckets.push(bucket);
    // 時刻が巻き戻った場合（NTP補正など）でも昇順を保つ
    buckets.sort((a, b) => a.startedAt - b.startedAt);
  }

  bucket.counts.set(key, (bucket.counts.get(key) ?? 0) + 1);
}

export type GithubApiUsageEndpoint = {
  endpoint: string;
  currentHour: number;
  last24h: number;
};

export type GithubApiUsageFeature = {
  key: GithubApiFeature;
  label: string;
  currentHour: number;
  last24h: number;
  /** 呼び出し数の多い順 */
  endpoints: GithubApiUsageEndpoint[];
};

export type GithubApiUsageSummary = {
  /** 計測を開始した時刻(epoch ms)。プロセスの再起動でリセットされる */
  measuringSince: number;
  /** 現在の1時間ウィンドウ（正時起点）の開始時刻(epoch ms) */
  currentHourStartedAt: number;
  totalCurrentHour: number;
  totalLast24h: number;
  /** 直近24時間の呼び出し数が多い順 */
  features: GithubApiUsageFeature[];
};

/** 用途別・エンドポイント別に集計した直近の消費状況を返す */
export function getGithubApiUsageSummary(now: number = Date.now()): GithubApiUsageSummary {
  pruneBuckets(now);

  const currentHourStartedAt = currentHourStartAt(now);
  const totals = new Map<string, { currentHour: number; last24h: number }>();

  for (const bucket of buckets) {
    // バケットの開始時刻が現在の正時起点1時間ウィンドウ内なら数える（ローリング60分ではない）
    const withinCurrentHour = bucket.startedAt >= currentHourStartedAt;
    for (const [key, count] of bucket.counts) {
      const total = totals.get(key) ?? { currentHour: 0, last24h: 0 };
      total.last24h += count;
      if (withinCurrentHour) total.currentHour += count;
      totals.set(key, total);
    }
  }

  const byFeature = new Map<GithubApiFeature, GithubApiUsageFeature>();
  for (const [key, total] of totals) {
    const [featureKey, endpoint] = key.split("\t");
    const feature = featureKey as GithubApiFeature;
    const entry = byFeature.get(feature) ?? {
      key: feature,
      label: FEATURE_LABELS.get(feature) ?? feature,
      currentHour: 0,
      last24h: 0,
      endpoints: [],
    };
    entry.currentHour += total.currentHour;
    entry.last24h += total.last24h;
    entry.endpoints.push({ endpoint, currentHour: total.currentHour, last24h: total.last24h });
    byFeature.set(feature, entry);
  }

  const features = [...byFeature.values()]
    .map((feature) => ({
      ...feature,
      endpoints: feature.endpoints.sort((a, b) => b.last24h - a.last24h),
    }))
    .sort((a, b) => b.last24h - a.last24h);

  return {
    measuringSince,
    currentHourStartedAt,
    totalCurrentHour: features.reduce((sum, feature) => sum + feature.currentHour, 0),
    totalLast24h: features.reduce((sum, feature) => sum + feature.last24h, 0),
    features,
  };
}

/** テスト用に計測結果を空にする */
export function resetGithubApiUsage(now: number = Date.now()): void {
  buckets = [];
  measuringSince = now;
}
