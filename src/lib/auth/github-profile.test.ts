import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchVerifiedGithubProfile } from "./github-profile";
afterEach(() => vi.unstubAllGlobals());
describe("GitHub本人確認", () => {
  it("トークンが無ければ問い合わせない", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(fetchVerifiedGithubProfile(null)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([null, {}, { id: "42", login: "user" }, { id: -1, login: "user" }, { id: 42, login: "" }])("不正な応答を拒否する: %j", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
    await expect(fetchVerifiedGithubProfile("test-token")).rejects.toThrow();
  });
});
