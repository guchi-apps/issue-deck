import { describe, expect, it } from "vitest";

import {
  canStartSecretsSync,
  describeSecretsSyncResult,
  normalizeOnlyKeys,
  SECRETS_SYNC_COOLDOWN_MS,
  SECRETS_SYNC_MAX_ONLY_KEYS,
  type SecretSyncRunView,
} from "@/lib/secrets-sync";

function run(overrides: Partial<SecretSyncRunView> = {}): SecretSyncRunView {
  return {
    id: "run-1",
    repositoryFullName: "guchi-apps/issue-deck",
    only: "",
    status: "SUCCEEDED",
    startedAt: "2026-08-14T10:00:00.000Z",
    finishedAt: "2026-08-14T10:01:00.000Z",
    syncedCount: 26,
    skippedCount: 2,
    failedCount: 0,
    failedKeys: [],
    runUrl: null,
    message: null,
    ...overrides,
  };
}

describe("normalizeOnlyKeys", () => {
  it("空の指定は全件を意味する空文字になる", () => {
    expect(normalizeOnlyKeys("")).toBe("");
    expect(normalizeOnlyKeys(undefined)).toBe("");
    expect(normalizeOnlyKeys(null)).toBe("");
    expect(normalizeOnlyKeys("  ,  ")).toBe("");
  });

  it("前後の空白を落とし、大文字へ揃える", () => {
    expect(normalizeOnlyKeys(" signaly_webhook_url , port ")).toBe("SIGNALY_WEBHOOK_URL,PORT");
  });

  it("同じKEYを2回書いても1回ぶんにする（日次枠を無駄に消費しないため）", () => {
    expect(normalizeOnlyKeys("PORT,PORT")).toBe("PORT");
  });

  it("シェルの引数に入るため、KEY名として不正な文字は拒否する", () => {
    expect(normalizeOnlyKeys("PORT;rm -rf /")).toBeNull();
    expect(normalizeOnlyKeys("op://apps/Server/host")).toBeNull();
    expect(normalizeOnlyKeys("PORT DB_NAME")).toBeNull();
  });

  it("上限を超える件数は拒否する", () => {
    const keys = Array.from({ length: SECRETS_SYNC_MAX_ONLY_KEYS + 1 }, (_, i) => `KEY_${i}`);
    expect(normalizeOnlyKeys(keys.join(","))).toBeNull();
  });

  it("文字列以外は拒否する", () => {
    expect(normalizeOnlyKeys(123)).toBeNull();
    expect(normalizeOnlyKeys({ only: "PORT" })).toBeNull();
  });
});

describe("canStartSecretsSync", () => {
  const now = new Date("2026-08-14T10:05:00.000Z");

  it("実行履歴が無ければ起動できる", () => {
    expect(canStartSecretsSync(null, now)).toEqual({ allowed: true });
  });

  it("未完了の実行がある間は二重に起動しない", () => {
    const decision = canStartSecretsSync(run({ status: "QUEUED", finishedAt: null }), now);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toBe("running");
  });

  it("直近の成功から間もない場合はクールダウンで断る（1Passwordの日次枠の保護）", () => {
    const decision = canStartSecretsSync(run(), now);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toBe("cooldown");
    expect(decision.allowed === false && decision.message).toContain("あと約6分");
  });

  it("クールダウンが明ければ起動できる", () => {
    const after = new Date(new Date("2026-08-14T10:01:00.000Z").getTime() + SECRETS_SYNC_COOLDOWN_MS);
    expect(canStartSecretsSync(run(), after)).toEqual({ allowed: true });
  });

  it("直近が失敗ならすぐ再実行できる（1Password側を直して試す場面のため）", () => {
    expect(canStartSecretsSync(run({ status: "FAILED", failedCount: 1 }), now)).toEqual({
      allowed: true,
    });
    expect(canStartSecretsSync(run({ status: "TIMEOUT" }), now)).toEqual({ allowed: true });
  });

  it("finishedAtが無い成功はstartedAtを基準にする", () => {
    const decision = canStartSecretsSync(run({ finishedAt: null }), now);
    expect(decision.allowed).toBe(false);
  });
});

describe("describeSecretsSyncResult", () => {
  it("件数を要素に分けて返す（値も値の長さも出さない）", () => {
    expect(describeSecretsSyncResult(run())).toEqual({
      kind: "counts",
      synced: 26,
      skipped: 2,
      failed: 0,
      failedKeys: [],
    });
  });

  it("失敗があれば項目名だけを添える", () => {
    const result = describeSecretsSyncResult(
      run({ status: "FAILED", failedCount: 2, failedKeys: ["SIGNALY_WEBHOOK_URL", "DB_NAME"] }),
    );
    expect(result).toEqual({
      kind: "counts",
      synced: 26,
      skipped: 2,
      failed: 2,
      failedKeys: ["SIGNALY_WEBHOOK_URL", "DB_NAME"],
    });
  });

  it("未完了・時間切れはその旨を出す", () => {
    expect(describeSecretsSyncResult(run({ status: "QUEUED" }))).toEqual({ kind: "running" });
    const timeout = describeSecretsSyncResult(run({ status: "TIMEOUT" }));
    expect(timeout.kind === "message" && timeout.message).toContain("報告がありませんでした");
  });

  it("時間切れにmessageがあればそれを出す", () => {
    const result = describeSecretsSyncResult(
      run({ status: "TIMEOUT", message: "カスタムの時間切れ理由" }),
    );
    expect(result).toEqual({ kind: "message", message: "カスタムの時間切れ理由" });
  });

  it("件数が全て0の失敗はmessageを出す（同期処理が始まる前に落ちた場合、件数だけでは何も伝わらない）", () => {
    const result = describeSecretsSyncResult(
      run({
        status: "FAILED",
        syncedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        message: "sync-secrets.yml がこのリポジトリで見つかりませんでした。",
      }),
    );
    expect(result).toEqual({
      kind: "message",
      message: "sync-secrets.yml がこのリポジトリで見つかりませんでした。",
    });
  });

  it("件数がある失敗はmessageがあっても件数側を優先する（項目名の方が具体的なため）", () => {
    const result = describeSecretsSyncResult(
      run({
        status: "FAILED",
        failedCount: 1,
        failedKeys: ["PORT"],
        message: "何かの補足",
      }),
    );
    expect(result).toEqual({
      kind: "counts",
      synced: 26,
      skipped: 2,
      failed: 1,
      failedKeys: ["PORT"],
    });
  });
});
