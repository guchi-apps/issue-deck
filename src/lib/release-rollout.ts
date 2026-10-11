import {
  describeIntegrationNotApplicable,
  describeIntegrationSetupGap,
  describeMacSetupGap,
  getReleaseVerificationConfig,
  isRegisteredForReleaseVerification,
} from "@/lib/release-verification-config";

/**
 * リリース検証（統合検証・全体レビュー）の導入状態（#4365）。
 *
 * **宣言（`release-verification-config.ts`）と既存の記録・ホスト申告から導出する純関数**で、状態の保存先は増やさない。
 * 設定が無いだけのものを「対象外」や「必須化済み」に見せない。優先順は上から:
 *
 * 1. `excluded` … 根拠付きで検証の対象にしない（アーカイブ・本番リリース経路なし）
 * 2. `not_registered` … 管理対象なのに台帳が無い（導入漏れ。今後追加された対象もここで検出する）
 * 3. `setup_missing` … 検証コマンド・前提・Mac検証スクリプトが足りない
 * 4. `awaiting_distribution` … 実行できるホストが申告していない（配布・登録待ち）
 * 5. `enforced` … 通常の本番マージの必須条件になっている
 * 6. `verified` … 実リリース候補で統合検証・全体レビューが合格済み（必須化の判断待ち）
 * 7. `awaiting_verification` … 宣言は揃ったが実走の合格証跡が無い
 */
export const ROLLOUT_STATUSES = [
  "not_registered",
  "setup_missing",
  "awaiting_distribution",
  "awaiting_verification",
  "verified",
  "enforced",
  "excluded",
] as const;
export type RolloutStatus = (typeof ROLLOUT_STATUSES)[number];

export const ROLLOUT_STATUS_LABELS: Record<RolloutStatus, string> = {
  not_registered: "未導入（台帳に未登録）",
  setup_missing: "設定不足",
  awaiting_distribution: "配布待ち",
  awaiting_verification: "検証待ち",
  verified: "検証済み（必須化待ち）",
  enforced: "必須化済み",
  excluded: "対象外",
};

export type RolloutHost = {
  name: string;
  online: boolean;
  repositories: string[];
  releaseVerifyCapable: boolean;
  releaseReviewCapable: boolean;
};

/** リポジトリのいずれかのリリース候補で、種別ごとに最新の記録 */
export type RolloutLatestRecords = {
  integration?: RolloutRecord;
  ai_review?: RolloutRecord;
};

/** `prNumber`・`baseSha`は省略可。両方の記録が持つときは同じ候補かどうかの照合に使う */
export type RolloutRecord = { state: string; headSha: string; prNumber?: number; baseSha?: string };

/** 統合検証と全体レビューが、同じリリース候補（PR・base・head）の記録か */
function isSameCandidate(a: RolloutRecord, b: RolloutRecord): boolean {
  return a.headSha === b.headSha && a.prNumber === b.prNumber && a.baseSha === b.baseSha;
}

export type RolloutRow = {
  fullName: string;
  status: RolloutStatus;
  stack: string | null;
  /** 状態の理由・残作業。空にしない（成功以外はなぜかを示す） */
  reasons: string[];
  /** 実行できるホスト。申告していないときは空 */
  hosts: string[];
  macRequired: boolean;
  commandCount: number;
};

export type RolloutInput = {
  fullName: string;
  archived?: boolean;
  hosts: RolloutHost[];
  latest: RolloutLatestRecords;
};

export function evaluateRollout(input: RolloutInput): RolloutRow {
  const { fullName } = input;
  const config = getReleaseVerificationConfig(fullName);
  const base = {
    fullName,
    stack: config.stack ?? null,
    macRequired: config.macBuildCheck === true,
    commandCount: config.integrationCommands?.length ?? 0,
  };

  const exclusion = describeIntegrationNotApplicable(fullName);
  if (exclusion !== null) return { ...base, status: "excluded", reasons: [exclusion], hosts: [] };
  if (!isRegisteredForReleaseVerification(fullName)) {
    if (input.archived) {
      return { ...base, status: "excluded", reasons: ["GitHub上でアーカイブ済み（台帳へ根拠を追記してください）"], hosts: [] };
    }
    return {
      ...base,
      status: "not_registered",
      reasons: ["リリース検証の導入台帳に載っていません。検証コマンドを宣言するか、対象外の根拠を記録してください"],
      hosts: [],
    };
  }

  const gaps = [describeIntegrationSetupGap(fullName), describeMacSetupGap(fullName)].filter(
    (gap): gap is string => gap !== null,
  );
  if (gaps.length > 0) return { ...base, status: "setup_missing", reasons: gaps, hosts: [] };

  const capable = input.hosts.filter(
    (host) =>
      host.repositories.includes(fullName) && host.releaseVerifyCapable && host.releaseReviewCapable,
  );
  if (capable.length === 0) {
    const declared = input.hosts.filter((host) => host.repositories.includes(fullName));
    return {
      ...base,
      status: "awaiting_distribution",
      reasons: [
        declared.length > 0
          ? "リポジトリを申告しているホストが、統合検証・全体レビューに未対応です（pollerの更新が必要）"
          : "このリポジトリで統合検証・全体レビューを実行できるサブPCが申告していません（チェックアウトとホスト登録が必要）",
      ],
      hosts: [],
    };
  }
  const hosts = capable.map((host) => host.name);
  const online = capable.some((host) => host.online);

  if (config.enforced) {
    return {
      ...base,
      status: "enforced",
      reasons: online ? [] : ["実行できるホストが現在オフラインです（検証が始まらないため本番マージが止まります）"],
      hosts,
    };
  }

  const { integration, ai_review: aiReview } = input.latest;
  // 別々の候補で1種類ずつ成功した組み合わせは、検証済みとして扱わない
  const passed =
    integration?.state === "passed" &&
    aiReview?.state === "passed" &&
    isSameCandidate(integration, aiReview);
  if (passed) {
    return { ...base, status: "verified", reasons: ["実リリース候補で統合検証・全体レビューが合格済みです。必須化を判断できます"], hosts };
  }
  const missing = (["integration", "ai_review"] as const)
    .filter((kind) => input.latest[kind]?.state !== "passed")
    .map((kind) => {
      const label = kind === "integration" ? "統合検証" : "全体レビュー";
      const state = input.latest[kind]?.state;
      if (state === "passed") return `${label}: 合格済みだが、もう一方と別のリリース候補の結果です`;
      return state ? `${label}: 直近の結果は「${state}」` : `${label}: 実リリース候補での実走記録がありません`;
    });
  return { ...base, status: "awaiting_verification", reasons: missing, hosts };
}

/** 一覧の並び順: 対応が要るものを上に、必須化済み・対象外を下に */
export function sortRolloutRows(rows: RolloutRow[]): RolloutRow[] {
  const order: Record<RolloutStatus, number> = {
    not_registered: 0,
    setup_missing: 1,
    awaiting_distribution: 2,
    awaiting_verification: 3,
    verified: 4,
    enforced: 5,
    excluded: 6,
  };
  return [...rows].sort((a, b) => order[a.status] - order[b.status] || a.fullName.localeCompare(b.fullName));
}

/** 台帳に載せた全リポジトリの完了判定: 対象外以外がすべて`enforced`か */
export function isRolloutComplete(rows: RolloutRow[]): boolean {
  return rows.every((row) => row.status === "enforced" || row.status === "excluded");
}
