import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchLocalStartScriptSupported } from "@/lib/github/local-session-support";

const githubFetch = vi.hoisted(() => vi.fn());

vi.mock("@/lib/github/request", () => ({
  GITHUB_API: "https://api.github.com",
  githubFetch,
}));

/** Contents APIの応答を模す。中身はbase64で返る */
function contentsResponse(script: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      content: Buffer.from(script, "utf-8").toString("base64"),
      encoding: "base64",
    }),
  };
}

const WITH_MARKER = ["#!/usr/bin/env bash", "# issue-deck-local-session: v1", "set -euo pipefail"].join(
  "\n",
);

describe("fetchLocalStartScriptSupported", () => {
  afterEach(() => {
    githubFetch.mockReset();
  });

  it("マーカー行があれば対応済みとみなす", async () => {
    githubFetch.mockResolvedValue(contentsResponse(WITH_MARKER));

    await expect(fetchLocalStartScriptSupported("guchi-apps", "issue-deck", "token")).resolves.toBe(
      true,
    );
  });

  it("scripts/start-issue.sh の内容を取りに行く", async () => {
    githubFetch.mockResolvedValue(contentsResponse(WITH_MARKER));

    await fetchLocalStartScriptSupported("guchi-apps", "dayspan", "token");

    expect(githubFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/guchi-apps/dayspan/contents/scripts/start-issue.sh",
      "token",
    );
  });

  it("ファイルはあるがマーカーが無ければ未対応とみなす", async () => {
    // shopping-listの実例。ファイルはあるが約束を守っていないため、押すとUAC待ちで固まる。
    githubFetch.mockResolvedValue(contentsResponse("#!/usr/bin/env bash\nset -euo pipefail\n"));

    await expect(
      fetchLocalStartScriptSupported("guchi-apps", "shopping-list", "token"),
    ).resolves.toBe(false);
  });

  it("ファイルが無ければ（404）未対応とみなす", async () => {
    githubFetch.mockResolvedValue({ ok: false, status: 404 });

    await expect(fetchLocalStartScriptSupported("guchi-apps", "vps", "token")).resolves.toBe(false);
  });

  it("issue-deck側が扱えるより新しい版数は受け入れない", async () => {
    githubFetch.mockResolvedValue(
      contentsResponse("#!/usr/bin/env bash\n# issue-deck-local-session: v99\n"),
    );

    await expect(fetchLocalStartScriptSupported("guchi-apps", "future", "token")).resolves.toBe(
      false,
    );
  });

  it("contentが返らない場合は未対応とみなす", async () => {
    githubFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });

    await expect(fetchLocalStartScriptSupported("guchi-apps", "issue-deck", "token")).resolves.toBe(
      false,
    );
  });

  it("404以外の失敗は例外にする（呼び出し側でcatchして未対応扱いにする）", async () => {
    githubFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "server error",
    });

    await expect(
      fetchLocalStartScriptSupported("guchi-apps", "issue-deck", "token"),
    ).rejects.toThrow();
  });
});
