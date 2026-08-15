import { afterEach, describe, expect, it, vi } from "vitest";

import { isDevLoginEnabled } from "./dev-login";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isDevLoginEnabled", () => {
  it("開発環境でシークレットが設定されていれば有効", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CI_LOGIN_BYPASS_SECRET", "dev-secret");
    expect(isDevLoginEnabled()).toBe(true);
  });

  it("シークレットが未設定なら無効", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CI_LOGIN_BYPASS_SECRET", "");
    expect(isDevLoginEnabled()).toBe(false);
  });

  it("本番ではシークレットが設定されていても無効", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CI_LOGIN_BYPASS_SECRET", "dev-secret");
    expect(isDevLoginEnabled()).toBe(false);
  });
});
