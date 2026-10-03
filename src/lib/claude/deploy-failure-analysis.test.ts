import { describe, expect, it } from "vitest";

import {
  DEPLOY_FAILURE_LOG_MAX_LENGTH,
  parseDeployFailureAnalysis,
  sanitizeDeployLog,
  tailDeployLog,
} from "@/lib/claude/deploy-failure-analysis";

describe("sanitizeDeployLog", () => {
  it("トークン・KEY=value・op参照・認証付きURLを伏せ、時刻とANSIを落とす", () => {
    const raw = [
      "2026-10-03T01:02:03.456Z \u001b[31mError\u001b[0m",
      "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123",
      "DATABASE_URL: mysql://user:pass@host/db",
      "op://vault/item/field",
      "Authorization: Bearer abcdefghijklmnop12345",
    ].join("\n");
    const out = sanitizeDeployLog(raw);
    expect(out).toContain("Error");
    expect(out).not.toMatch(/ghp_|pass@|vault\/item|abcdefghijklmnop12345|\u001b|2026-10-03T/);
    expect(out).toContain("GITHUB_TOKEN=***");
  });
});

describe("tailDeployLog", () => {
  it("上限を超えたら末尾を残す", () => {
    const log = `${"a".repeat(DEPLOY_FAILURE_LOG_MAX_LENGTH)}END`;
    const out = tailDeployLog(log);
    expect(out.startsWith("...(先頭を省略)")).toBe(true);
    expect(out.endsWith("END")).toBe(true);
  });
});

describe("parseDeployFailureAnalysis", () => {
  it("JSONを検証して取り出す", () => {
    const result = parseDeployFailureAnalysis(
      '前置き {"cause":"列が重複","retryMayFix":false,"excerpt":"Duplicate column","advice":null} 後書き',
    );
    expect(result).toEqual({
      cause: "列が重複",
      retryMayFix: false,
      excerpt: "Duplicate column",
      advice: null,
    });
  });

  it("読めない・causeが無い応答はnull", () => {
    expect(parseDeployFailureAnalysis("原因不明")).toBeNull();
    expect(parseDeployFailureAnalysis('{"retryMayFix":true}')).toBeNull();
  });
});
