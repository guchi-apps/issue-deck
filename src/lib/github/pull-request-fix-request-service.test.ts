import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} }));

import {
  FIX_REQUEST_MARKER,
  requestPullRequestFix,
  findCurrentFixRequest,
  findInterruptedFixRequest,
} from "@/lib/github/pull-request-fix-request-service";

const HEAD = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
const OLD = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";

describe("findCurrentFixRequest（#4482）", () => {
  it("現在のHEADへの依頼だけを、最新の1件として返す", () => {
    const comments = [
      { body: `前の依頼\n<!-- ${FIX_REQUEST_MARKER}:aaaa sha=${OLD} -->`, html_url: "https://x/old", created_at: "2026-10-12T00:00:00Z" },
      { body: "無関係なコメント", html_url: "https://x/other", created_at: "2026-10-12T00:30:00Z" },
      { body: `今の依頼\n<!-- ${FIX_REQUEST_MARKER}:bbbb sha=${HEAD} -->`, html_url: "https://x/now", created_at: "2026-10-12T01:00:00Z" },
    ];
    expect(findCurrentFixRequest(comments, HEAD)).toEqual({ commentUrl: "https://x/now", createdAt: "2026-10-12T01:00:00Z" });
  });

  it("HEADが進んだら前の依頼は現在の依頼として扱わない", () => {
    const comments = [{ body: `<!-- ${FIX_REQUEST_MARKER}:aaaa sha=${OLD} -->`, html_url: null, created_at: null }];
    expect(findCurrentFixRequest(comments, HEAD)).toBeNull();
  });
});

describe("中止・失敗した依頼（#4639）", () => {
  const request = { id: 100, body: `依頼\n<!-- ${FIX_REQUEST_MARKER}:aaaa sha=${HEAD} -->`, html_url: "https://x/req", created_at: "t" };
  const result = (id: number, kind = "aborted") => ({
    id: 101,
    body: `中止\n<!-- issue-deck-dispatch-result:${kind} reason=check_user_added comment=${id} -->`,
    html_url: "https://x/res",
    created_at: "t2",
  });

  it("依頼コメントidを指す中止があれば、現在の依頼ではなく中断された依頼として返す", () => {
    expect(findCurrentFixRequest([request, result(100)], HEAD)).toBeNull();
    expect(findInterruptedFixRequest([request, result(100)], HEAD)).toEqual({
      kind: "aborted",
      reason: "check_user_added",
      requestUrl: "https://x/req",
      resultUrl: "https://x/res",
    });
  });

  it("別のコメントの中止は取り違えない", () => {
    expect(findCurrentFixRequest([request, result(999)], HEAD)).not.toBeNull();
    expect(findInterruptedFixRequest([request, result(999)], HEAD)).toBeNull();
  });

  it("失敗も中断として扱う", () => {
    expect(findInterruptedFixRequest([request, result(100, "failed")], HEAD)?.kind).toBe("failed");
  });
});

it("廃止したIssue実装へ投稿せず、ホスト実行を案内する", async () => {
  const result = await requestPullRequestFix(
    { id: "user", githubAccessToken: null, githubRefreshToken: null },
    { installation: { installationId: 1 } },
    { owner: "guchi-apps", repo: "issue-deck", number: 1, expectedHeadSha: HEAD, instruction: "直して" },
  );
  expect(result).toMatchObject({ ok: false, error: "local_session", message: expect.stringContaining("ホストセッション") });
});
