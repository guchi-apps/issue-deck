import { AsyncLocalStorage } from "node:async_hooks";

/**
 * GitHub APIの呼び出しを用途（機能）別に集計するためのプロセス内計測。
 *
 * GitHubは`/rate_limit`でもレスポンスヘッダでも「カテゴリ別の合計」しか返さず、どの機能が
 * どれだけ消費したかの内訳を得る手段が無い。そのため、アプリ側で自分の発信を数える。
 *
 * 直近24時間ぶんを5分バケットのリングバッファに保持する（プロセス内メモリが本体）。
 * バケットが繰り上がるたびに直前に閉じたバケットを`onBucketClosed()`のリスナーへ通知し、
 * 呼び出し元（`src/instrumentation.ts`）がDBへ永続化することで、再起動やデプロイをまたいでも
 * 直近24時間ぶんの集計を維持できる（起動時は`loadPersistedBuckets()`でDBの内容をメモリへ
 * 復元する）。DBへの反映は非同期・ベストエフォートであり、メモリ上の集計自体はDBの有無に
 * 依存せず単体でも動作する（既存の単体テストはDB非依存のまま成立する）。
 * 用途の指定は`withGithubApiFeature()`でリクエスト単位に文脈として持たせ、
 * GitHub APIを叩く各関数の引数を増やさずに済ませている。
 *
 * この計測はプロセス単位で、ユーザー・セッション・デバイスによるフィルタを持たない
 * （単一プロセスでデプロイされている前提に暗黙的に依存している。複数インスタンス構成に
 * なるとインスタンスごとに集計が分裂する。DB永続化後もこの制約は変わらない）。
 *
 * 7日・30日規模への集計拡張は本モジュールのスコープ外（別途永続化戦略の検討が必要）。
 */

export const GITHUB_API_FEATURES = [
  { key: "issue_list_workflow_running", label: "一覧の実行状況ポーリング" },
  { key: "issue_detail_workflow_run", label: "詳細の実行状況ポーリング" },
  // 元はCI状態だけを返していたが、#1339でタイトル・状態もあわせて返すようになった。
  // 消費するリクエスト数は変わっていないため、過去の集計と分断しないようキーは据え置く。
  { key: "pull_request_ci", label: "Issueの対応PRの取得" },
  { key: "pull_request_link_fallback", label: "PR紐付けのフォールバック検索" },
  { key: "release_status", label: "リリース進捗ポーリング" },
  // 元は「mainマージ待ち確認」だったが、#1117でリリース状況（実行中・失敗も含む）を返す
  // ようになった。過去の集計と分断しないようキーは据え置き、ラベルだけ実態に合わせている。
  { key: "release_pending_merges", label: "リリース状況の一括確認" },
  { key: "pull_request_list", label: "PR一覧の取得" },
  { key: "branch_flow", label: "ブランチ状況の取得" },
  { key: "deploy_status", label: "本番デプロイ状況の取得" },
  { key: "pull_request_detail", label: "PR詳細（本文・コメント）の取得" },
  { key: "pull_request_files", label: "PR詳細の変更ファイル一覧の取得" },
  { key: "pull_request_changes", label: "マージ確認の変更点の取得" },
  { key: "issue_comments", label: "コメント取得" },
  { key: "sub_issues", label: "子Issueの取得" },
  { key: "repo_meta", label: "ラベル・担当者の取得" },
  { key: "issue_write", label: "Issueの作成・更新・削除・移動" },
  { key: "comment_write", label: "コメントの投稿・編集・削除" },
  { key: "workflow_cancel", label: "実行のキャンセル" },
  { key: "pull_request_merge", label: "PRのマージ" },
  { key: "pull_request_repair", label: "PRの自動修復の起動" },
  // コンフリクトしたPRの巡回検知（#2116）。PR一覧のRESTはETagが効くので、実際に消費するのは
  // コンフリクトしているPRがあるときのGraphQLと起動だけ。
  { key: "conflict_sweep", label: "コンフリクトの巡回検知" },
  { key: "release_dispatch", label: "リリースの起動" },
  { key: "deploy_dispatch", label: "本番デプロイの起動" },
  { key: "secrets_sync", label: "シークレット同期の起動" },
  // 元は「Issueの再同期」(`sync`)として計上していたが、実態は共有ワークフローのタグ確認で、
  // 消費量も大きかったため#1503で分けた（同時にGraphQLへ寄せて消費自体を減らしている）
  { key: "workflow_tags", label: "共有ワークフローのタグ確認" },
  { key: "progress_report", label: "進捗のProject反映" },
  { key: "sync", label: "Issueの再同期" },
  { key: "repo_sync", label: "リポジトリの再同期" },
  { key: "setup", label: "セットアップ・インストール" },
  // 新規アプリの立ち上げ（#2188）。空き確認（vpsのREADMEとvhostの読み取り）と、
  // リポジトリ作成・Issue一式の起票。年に数回の操作なので他とは分けて数える
  { key: "new_app_launch", label: "新規アプリの立ち上げ" },
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

const featureStore = new AsyncLocalStorage<GithubApiFeature>();

export type ClosedGithubApiUsageBucketEntry = {
  feature: GithubApiFeature;
  endpoint: string;
  count: number;
};

export type ClosedGithubApiUsageBucket = {
  /** バケットの開始時刻（BUCKET_MSで切り捨てたepoch ms） */
  startedAt: number;
  entries: ClosedGithubApiUsageBucketEntry[];
};

type BucketClosedListener = (bucket: ClosedGithubApiUsageBucket) => void;

const bucketClosedListeners: BucketClosedListener[] = [];

/**
 * バケットが繰り上がる（新しい5分バケットが作られる）たびに、直前に閉じたバケットを渡して
 * `listener`を呼ぶ。永続化（DB書き込み）など、集計ロジック自体とは独立した副作用の登録に使う。
 */
export function onBucketClosed(listener: BucketClosedListener): void {
  bucketClosedListeners.push(listener);
}

function notifyBucketClosed(bucket: Bucket): void {
  if (bucketClosedListeners.length === 0) return;
  const entries = [...bucket.counts].map(([key, count]) => {
    const [feature, endpoint] = key.split("\t");
    return { feature: feature as GithubApiFeature, endpoint, count };
  });
  for (const listener of bucketClosedListeners) listener({ startedAt: bucket.startedAt, entries });
}

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
 * 例: `https://api.github.com/repos/guchi-apps/issue-deck/issues/123/comments?per_page=100`
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
    // 直前のバケットより後ろに進む場合のみ、そのバケットは書き込みを終えたとみなして通知する
    // （時刻が巻き戻った場合のバックデート挿入では、既存の最新バケットはまだ閉じていない）
    if (bucket && bucket.startedAt < startedAt) notifyBucketClosed(bucket);
    bucket = { startedAt, counts: new Map() };
    buckets.push(bucket);
    // 時刻が巻き戻った場合（NTP補正など）でも昇順を保つ
    buckets.sort((a, b) => a.startedAt - b.startedAt);
  }

  bucket.counts.set(key, (bucket.counts.get(key) ?? 0) + 1);
}

/**
 * DBなど外部から読み込んだバケットの内容をメモリへ流し込む。起動時に一度呼ぶ想定
 * （既存のメモリ上の集計へ加算するため、複数回呼んでも壊れないが通常は起動時の1回のみ）。
 */
export function loadPersistedBuckets(persisted: ClosedGithubApiUsageBucket[], now: number = Date.now()): void {
  for (const persistedBucket of persisted) {
    const startedAt = bucketStartAt(persistedBucket.startedAt);
    let bucket = buckets.find((candidate) => candidate.startedAt === startedAt);
    if (!bucket) {
      bucket = { startedAt, counts: new Map() };
      buckets.push(bucket);
    }
    for (const entry of persistedBucket.entries) {
      const key = `${entry.feature}\t${entry.endpoint}`;
      bucket.counts.set(key, (bucket.counts.get(key) ?? 0) + entry.count);
    }
  }
  buckets.sort((a, b) => a.startedAt - b.startedAt);
  pruneBuckets(now);
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
  /**
   * 計測を開始した時刻(epoch ms)。現在保持している最古バケットの開始時刻（DBから復元した分を
   * 含む）で、保持データが無ければ現在時刻になる。24時間より古いデータは持たないため、
   * 最大でも「現在時刻の24時間前」までしか遡らない。
   */
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
    measuringSince: buckets[0]?.startedAt ?? now,
    currentHourStartedAt,
    totalCurrentHour: features.reduce((sum, feature) => sum + feature.currentHour, 0),
    totalLast24h: features.reduce((sum, feature) => sum + feature.last24h, 0),
    features,
  };
}

/** テスト用に計測結果・`onBucketClosed`のリスナー登録を空にする */
export function resetGithubApiUsage(): void {
  buckets = [];
  bucketClosedListeners.length = 0;
}
