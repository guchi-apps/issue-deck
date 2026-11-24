import { describe, expect, it } from "vitest";

import { classifyDeployFailureLog, isMigrationFailureKind } from "@/lib/deploy-failure-kind";

// asset-manager v9.0.0 の本番デプロイ（#5632）のログから取った形。
const P3018_LOG = `94 migrations found in prisma/migrations
Error: P3018

A migration failed to apply. New migrations cannot be applied before the error is recovered from.

Migration name: 20261227120000_fix_tag_groups

Database error code: 1044

Database error:
Access denied for user '***'@'***' to database '***'

Please check the query number 2 from the migration file.

##[error]Process completed with exit code 1.`;

const P3009_LOG = `94 migrations found in prisma/migrations

Error: P3009

migrate found failed migrations in the target database, new migrations will not be applied.
The \`20261227120000_fix_tag_groups\` migration started at 2026-11-23 22:24:25.646 UTC failed

##[error]Process completed with exit code 1.`;

describe("classifyDeployFailureLog（#5632）", () => {
  it("P3009は失敗記録が残っている種類で、マイグレーション名を読む", () => {
    expect(classifyDeployFailureLog(P3009_LOG)).toEqual({
      kind: "migration_failed_record",
      migrationName: "20261227120000_fix_tag_groups",
      failedQueryNumber: null,
      evidence: "Error: P3009",
    });
  });

  it("P3018はSQLの失敗で、失敗した文の番号を読む", () => {
    const result = classifyDeployFailureLog(P3018_LOG);
    expect(result.kind).toBe("migration_error");
    expect(result.migrationName).toBe("20261227120000_fix_tag_groups");
    expect(result.failedQueryNumber).toBe(2);
  });

  it("行頭の時刻を根拠から外す", () => {
    expect(classifyDeployFailureLog("2026-11-24T08:21:28.2116154Z Error: P3009").evidence).toBe("Error: P3009");
  });

  it("両方を含むときはP3009（記録の解消が先）を優先する", () => {
    expect(classifyDeployFailureLog(`${P3018_LOG}\n${P3009_LOG}`).kind).toBe("migration_failed_record");
  });

  it("pre-migrate.shの失敗・gate・ビルドを判別する", () => {
    expect(classifyDeployFailureLog("app-deploy-gate: deploy/pre-migrate.sh が失敗しました").kind).toBe("pre_migrate_failed");
    expect(classifyDeployFailureLog("app-deploy-gate: ヘルスチェックに失敗しました（127.0.0.1:3000）")).toMatchObject({
      kind: "gate",
      evidence: "app-deploy-gate: ヘルスチェックに失敗しました（127.0.0.1:3000）",
    });
    expect(classifyDeployFailureLog("Failed to compile.\n./src/a.ts").kind).toBe("build");
  });

  it("手掛かりが無ければunknown", () => {
    expect(classifyDeployFailureLog("").kind).toBe("unknown");
    expect(classifyDeployFailureLog(null).kind).toBe("unknown");
  });

  it("マイグレーションの種類だけをマイグレーションの失敗として扱う", () => {
    expect(isMigrationFailureKind("migration_failed_record")).toBe(true);
    expect(isMigrationFailureKind("pre_migrate_failed")).toBe(true);
    expect(isMigrationFailureKind("gate")).toBe(false);
  });
});
