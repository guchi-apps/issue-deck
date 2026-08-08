import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GithubApiError } from "@/lib/github/github-api-error";
import { refreshGithubUserToken } from "@/lib/github/refresh-user-token";
import { withUserGithubToken } from "@/lib/github/with-user-github-token";

const update = vi.fn();
const findUnique = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    user: {
      get update() {
        return update;
      },
      get findUnique() {
        return findUnique;
      },
    },
  },
}));

vi.mock("@/lib/crypto/secret-cipher", () => ({
  encryptSecret: (plain: string) => `enc:${plain}`,
  decryptSecret: (cipher: string) => cipher.replace(/^enc:/, ""),
}));

vi.mock("@/lib/github/refresh-user-token", () => ({
  refreshGithubUserToken: vi.fn(),
}));

const mockedRefresh = vi.mocked(refreshGithubUserToken);

function makeUser(overrides: Partial<{ githubAccessToken: string | null; githubRefreshToken: string | null }> = {}) {
  return {
    id: "user-1",
    githubAccessToken: "enc:old-access",
    githubRefreshToken: "enc:old-refresh",
    ...overrides,
  };
}

describe("withUserGithubToken", () => {
  beforeEach(() => {
    update.mockReset();
    findUnique.mockReset();
    mockedRefresh.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("トークン未保存の場合は409を返しfnを呼ばない", async () => {
    const fn = vi.fn();

    const result = await withUserGithubToken(makeUser({ githubAccessToken: null }), "ctx", fn);

    expect(fn).not.toHaveBeenCalled();
    expect("errorResponse" in result).toBe(true);
    if ("errorResponse" in result) {
      expect(result.errorResponse.status).toBe(409);
    }
  });

  it("成功時はvalueを返す", async () => {
    const fn = vi.fn().mockResolvedValue("ok");

    const result = await withUserGithubToken(makeUser(), "ctx", fn);

    expect(fn).toHaveBeenCalledWith("old-access");
    expect(result).toEqual({ value: "ok" });
  });

  it("401以外のエラーは502を返す", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("boom"));

    const result = await withUserGithubToken(makeUser(), "ctx", fn);

    expect("errorResponse" in result).toBe(true);
    if ("errorResponse" in result) {
      expect(result.errorResponse.status).toBe(502);
    }
    expect(update).not.toHaveBeenCalled();
  });

  it("401かつrefreshTokenが無い場合は両トークンをクリアして409を返す", async () => {
    const fn = vi.fn().mockRejectedValue(new GithubApiError(401, "unauthorized"));

    const result = await withUserGithubToken(makeUser({ githubRefreshToken: null }), "ctx", fn);

    expect("errorResponse" in result).toBe(true);
    if ("errorResponse" in result) {
      expect(result.errorResponse.status).toBe(409);
    }
    expect(update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { githubAccessToken: null, githubRefreshToken: null },
    });
  });

  it("401でrefresh成功時は新トークンを保存しリトライして成功する", async () => {
    mockedRefresh.mockResolvedValue({ accessToken: "new-access", refreshToken: "new-refresh" });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new GithubApiError(401, "unauthorized"))
      .mockResolvedValueOnce("ok-after-retry");

    const result = await withUserGithubToken(makeUser(), "ctx", fn);

    expect(mockedRefresh).toHaveBeenCalledWith("old-refresh");
    expect(update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { githubAccessToken: "enc:new-access", githubRefreshToken: "enc:new-refresh" },
    });
    expect(fn).toHaveBeenNthCalledWith(2, "new-access");
    expect(result).toEqual({ value: "ok-after-retry" });
  });

  it("401でrefresh成功後のリトライも401なら両トークンをクリアして409を返す", async () => {
    mockedRefresh.mockResolvedValue({ accessToken: "new-access" });
    const fn = vi.fn().mockRejectedValue(new GithubApiError(401, "unauthorized"));

    const result = await withUserGithubToken(makeUser(), "ctx", fn);

    expect("errorResponse" in result).toBe(true);
    if ("errorResponse" in result) {
      expect(result.errorResponse.status).toBe(409);
    }
    expect(update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { githubAccessToken: null, githubRefreshToken: null },
    });
  });

  it("refresh失敗時、別リクエストが既にトークン更新済みならその値でリトライする", async () => {
    mockedRefresh.mockResolvedValue(null);
    findUnique.mockResolvedValue({ githubAccessToken: "enc:updated-by-other-request" });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new GithubApiError(401, "unauthorized"))
      .mockResolvedValueOnce("ok-after-retry");

    const result = await withUserGithubToken(makeUser(), "ctx", fn);

    expect(fn).toHaveBeenNthCalledWith(2, "updated-by-other-request");
    expect(result).toEqual({ value: "ok-after-retry" });
    expect(update).not.toHaveBeenCalled();
  });

  it("refresh失敗かつDBも更新されていない場合は両トークンをクリアして409を返す", async () => {
    mockedRefresh.mockResolvedValue(null);
    findUnique.mockResolvedValue({ githubAccessToken: "enc:old-access" });
    const fn = vi.fn().mockRejectedValue(new GithubApiError(401, "unauthorized"));

    const result = await withUserGithubToken(makeUser(), "ctx", fn);

    expect("errorResponse" in result).toBe(true);
    if ("errorResponse" in result) {
      expect(result.errorResponse.status).toBe(409);
    }
    expect(update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { githubAccessToken: null, githubRefreshToken: null },
    });
  });
});
