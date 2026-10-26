/**
 * ブランチ画面でのリポジトリ表示（#5087）。
 *
 * `HiddenRepository`（全体非表示。Issue一覧・PR一覧・通知・作成候補からも消える）とは独立で、
 * ブランチ画面の**並べ方だけ**を変える。サーバーの進捗取得と一括リリースの対象は狭めないため、
 * 絞り込みは取得済みの一覧に対して画面側で行う。
 *
 * - `always`: 常に表示（未設定の既定。DBには行を持たない）
 * - `active`: 動きがある時だけ表示
 * - `never`: 表示しない（一時表示でだけ見える）
 */
export const BRANCH_VIEW_MODES = ["always", "active", "never"] as const;
export type BranchViewMode = (typeof BRANCH_VIEW_MODES)[number];

export const BRANCH_VIEW_MODE_LABELS: Record<BranchViewMode, string> = {
  always: "常に表示",
  active: "動きがある時だけ表示",
  never: "表示しない",
};

export function isBranchViewMode(value: unknown): value is BranchViewMode {
  return typeof value === "string" && (BRANCH_VIEW_MODES as readonly string[]).includes(value);
}

export type BranchViewSelection<T> = {
  /** 画面に並べるもの（元の順序を保つ） */
  visible: T[];
  /** 設定により省いたもの。一時表示で出せる */
  hidden: T[];
};

/**
 * ブランチ画面に並べるリポジトリを決める。
 *
 * - `always`（未設定を含む）は常に並べる
 * - `active`は`hasActivity`のとき並べる。**動きの有無を判断できないとき（`isUnknown`。取得失敗・
 *   読み込み中）は並べる**——「動きなし」と断定して重要な行を消さない
 * - `never`は省く
 * - `showAll`（一時表示）のときは全件を並べる。設定は変えない
 */
export function selectBranchViewRepositories<T>(
  repositories: readonly T[],
  options: {
    modeOf: (repository: T) => BranchViewMode;
    hasActivity: (repository: T) => boolean;
    isUnknown: (repository: T) => boolean;
    showAll: boolean;
  },
): BranchViewSelection<T> {
  const visible: T[] = [];
  const hidden: T[] = [];
  for (const repository of repositories) {
    const mode = options.modeOf(repository);
    const show =
      options.showAll ||
      mode === "always" ||
      (mode === "active" && (options.isUnknown(repository) || options.hasActivity(repository)));
    (show ? visible : hidden).push(repository);
  }
  return { visible, hidden };
}
