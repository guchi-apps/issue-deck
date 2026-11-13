import { describe, expect, it } from "vitest";

import { classifyGithubForbidden, describeGithubError, describeGithubStatus } from "./forbidden-cause";

describe("classifyGithubForbidden", () => {
  it("Appのインストールが停止中", () => {
    const c = classifyGithubForbidden('{"message":"This installation has been suspended"}');
    expect(c.kind).toBe("installation_suspended");
    expect(describeGithubStatus(403, c)).toBe("GitHub APIが403を返しました（Appのインストールが停止中）");
  });
  it("権限不足・対象外のリポジトリ", () => {
    expect(classifyGithubForbidden('{"message":"Resource not accessible by integration"}').kind).toBe("insufficient_permission");
  });
  it("二次レート制限はretry-afterの秒数を添える", () => {
    const c = classifyGithubForbidden('{"message":"You have exceeded a secondary rate limit."}', { retryAfter: "60" });
    expect(c.kind).toBe("secondary_rate_limit");
    expect(c.retryAfterSeconds).toBe(60);
    expect(c.label).toContain("60秒後");
  });
  it("一次レート制限はx-ratelimit-remaining=0とresetから待ち秒を出す", () => {
    const c = classifyGithubForbidden("{}", { rateLimitRemaining: "0", rateLimitReset: "1100" }, 1_000_000);
    expect(c.kind).toBe("primary_rate_limit");
    expect(c.retryAfterSeconds).toBe(100);
  });
  it("見分けられなければunknown", () => {
    expect(classifyGithubForbidden("Forbidden").kind).toBe("unknown");
    expect(describeGithubStatus(403, classifyGithubForbidden("Forbidden"))).toBe("GitHub APIが403を返しました");
  });
  it("エラーオブジェクトのmessageに入った本文からも判定する", () => {
    expect(
      describeGithubError({ status: 403, message: 'GitHub API request failed: 403 https://x {"message":"This installation has been suspended"}' }),
    ).toContain("Appのインストールが停止中");
    expect(describeGithubError(new Error("x"))).toBeNull();
  });
});
