/**
 * 本番デプロイ（`deploy.yml`）の失敗ログから、失敗の種類を機械で判別する（#5632）。
 *
 * 判別は**手掛かり**であって原因の確定ではない。復旧系列は判別結果を修正Issueの本文へ書き、
 * 種類ごとの指示（調べる場所・報告する区分）を添えるだけで、区分の報告は実装セッションが行う。
 * 文面の正は Prisma のエラーコード（P3009・P3018 など）と app-deploy-gate（guchi-apps/vps
 * `scripts/app-deploy-gate.sh`）の `die` の出力（`app-deploy-gate: <理由>`）。
 *
 * 種類ごとの次の一手は `docs/deploy-recovery-runbook.md` に書く。
 */

export const DEPLOY_FAILURE_KINDS = [
  /** 失敗したマイグレーションの記録が残っていて、以降が適用されない（Prisma P3009） */
  "migration_failed_record",
  /** マイグレーションのSQLが本番で失敗した（Prisma P3018 など） */
  "migration_error",
  /** マイグレーション前の補修（`deploy/pre-migrate.sh`）が失敗した */
  "pre_migrate_failed",
  /** ビルド（CIのビルドジョブ・配布物の作成）で失敗した */
  "build",
  /** gate での展開・再起動・稼働確認で失敗した */
  "gate",
  "unknown",
] as const;
export type DeployFailureKind = (typeof DEPLOY_FAILURE_KINDS)[number];

export type DeployFailureClassification = {
  kind: DeployFailureKind;
  /** ログから読めたマイグレーション名（マイグレーションの種類のときだけ） */
  migrationName: string | null;
  /**
   * SQLが失敗した文の番号（Prisma の「Please check the query number N from the migration file.」）。
   * 2以上なら、それより前の文は適用済みのまま残っている可能性がある（MySQLのDDLは自動コミット）。
   */
  failedQueryNumber: number | null;
  /** 判別の根拠にしたログの1行（伏せ字済みのログから取る） */
  evidence: string | null;
};

const MIGRATION_NAME = "[0-9]{8,14}_[A-Za-z0-9_]+";

function firstLine(log: string, pattern: RegExp): string | null {
  for (const line of log.split("\n")) {
    // Actionsのログは行頭に時刻（`2026-11-24T08:21:28.2116154Z `）が付くので外す。
    if (pattern.test(line)) return line.replace(/^.*?\d{4}-\d{2}-\d{2}T[\d:.]+Z\s/, "").trim().slice(0, 300);
  }
  return null;
}

/**
 * 判別の順序は「より具体的なもの」から。P3009 のログは P3018 の再実行で出るため、両方が
 * 含まれるときは P3009（記録の解消が先に要る）を優先する。
 */
export function classifyDeployFailureLog(log: string | null | undefined): DeployFailureClassification {
  const text = log ?? "";
  const query = /check the query number (\d+) from the migration file/.exec(text)?.[1];
  const failedQueryNumber = query ? Number(query) : null;
  if (/\bP3009\b/.test(text)) {
    const name =
      new RegExp(`The \`(${MIGRATION_NAME})\` migration started at`).exec(text)?.[1] ??
      new RegExp(`\`(${MIGRATION_NAME})\``).exec(text)?.[1] ??
      null;
    return { kind: "migration_failed_record", migrationName: name, failedQueryNumber, evidence: firstLine(text, /\bP3009\b/) };
  }
  if (/deploy\/pre-migrate\.sh が失敗しました/.test(text)) {
    return { kind: "pre_migrate_failed", migrationName: null, failedQueryNumber: null, evidence: firstLine(text, /pre-migrate\.sh が失敗しました/) };
  }
  if (/\bP3018\b|\bP3006\b|\bP3005\b|A migration failed to apply/.test(text)) {
    const name = new RegExp(`Migration name: (${MIGRATION_NAME})`).exec(text)?.[1] ?? null;
    return {
      kind: "migration_error",
      migrationName: name,
      failedQueryNumber,
      evidence: firstLine(text, /\bP30(18|06|05)\b|A migration failed to apply/),
    };
  }
  const gate = firstLine(text, /app-deploy-gate: /);
  if (gate) return { kind: "gate", migrationName: null, failedQueryNumber: null, evidence: gate };
  const build = firstLine(text, /Failed to compile|Build error occurred|Type error: |npm run build|next build.*(failed|error)|ELIFECYCLE/i);
  if (build) return { kind: "build", migrationName: null, failedQueryNumber: null, evidence: build };
  return { kind: "unknown", migrationName: null, failedQueryNumber: null, evidence: null };
}

export function deployFailureKindLabel(kind: DeployFailureKind): string {
  switch (kind) {
    case "migration_failed_record":
      return "失敗したマイグレーションの記録が残っている（Prisma P3009）";
    case "migration_error":
      return "マイグレーションのSQLが本番で失敗した";
    case "pre_migrate_failed":
      return "マイグレーション前の補修（deploy/pre-migrate.sh）が失敗した";
    case "build":
      return "ビルドの失敗";
    case "gate":
      return "gate（展開・再起動・稼働確認）での失敗";
    default:
      return "ログからは判別できない";
  }
}

/** マイグレーションの失敗（記録の解消が要る種類）か */
export function isMigrationFailureKind(kind: DeployFailureKind): boolean {
  return kind === "migration_failed_record" || kind === "migration_error" || kind === "pre_migrate_failed";
}
