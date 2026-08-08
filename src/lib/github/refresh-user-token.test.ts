import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { refreshGithubUserToken } from "@/lib/github/refresh-user-token";

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("refreshGithubUserToken", () => {
  beforeEach(() => {
    vi.stubEnv("GITHUB_OAUTH_CLIENT_ID", "client-id");
    vi.stubEnv("GITHUB_OAUTH_CLIENT_SECRET", "client-secret");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("client_id/client_secret未設定の場合はfetchせずnullを返す", async () => {
    vi.stubEnv("GITHUB_OAUTH_CLIENT_ID", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await refreshGithubUserToken("refresh-token");

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("成功時はaccess_token・refresh_tokenを返す", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { access_token: "new-access", refresh_token: "new-refresh" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await refreshGithubUserToken("refresh-token");

    expect(result).toEqual({ accessToken: "new-access", refreshToken: "new-refresh" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://github.com/login/oauth/access_token",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("HTTPステータスがエラーの場合はnullを返す", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(401, { message: "Bad credentials" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await refreshGithubUserToken("refresh-token");

    expect(result).toBeNull();
  });

  it("HTTP 200でもerrorフィールドを含む場合はnullを返す", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { error: "bad_refresh_token", error_description: "The refresh token is invalid." }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await refreshGithubUserToken("refresh-token");

    expect(result).toBeNull();
  });

  it("fetch自体が例外を投げた場合はnullを返す", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("network error"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await refreshGithubUserToken("refresh-token");

    expect(result).toBeNull();
  });
});
