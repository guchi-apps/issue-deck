import { beforeEach, describe, expect, it, vi } from "vitest";

const fileCrossRepoIssues = vi.fn();
const isRegistered = vi.fn();

vi.mock("@/lib/preview-mode", () => ({ previewModeGuard: () => null }));
vi.mock("@/lib/dispatch/cross-repo-filing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dispatch/cross-repo-filing")>();
  return { ...actual, fileCrossRepoIssues: (...args: unknown[]) => fileCrossRepoIssues(...args) };
});
vi.mock("@/lib/dispatch/cross-repo-filing-deps", () => ({
  defaultCrossRepoDeps: { isRegistered: (...args: unknown[]) => isRegistered(...args) },
}));

const { POST } = await import("./route");

function postRequest(body: unknown, authorization = "Bearer secret-value") {
  return new Request("http://localhost/api/dispatch/cross-repo-issues", {
    method: "POST",
    headers: { authorization },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

const valid = {
  repository: "guchi-apps/issue-deck",
  issue: 100,
  requests: [{ key: "fix-token", targetRepository: "guchi-apps/car-care", title: "t", body: "b" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DISPATCH_SECRET = "secret-value";
  isRegistered.mockResolvedValue(true);
  fileCrossRepoIssues.mockResolvedValue([{ key: "fix-token", number: 1 }]);
});

describe("POST /api/dispatch/cross-repo-issues", () => {
  it("共有シークレットが違えば401", async () => {
    const res = await POST(postRequest(valid, "Bearer wrong"));
    expect(res.status).toBe(401);
    expect(fileCrossRepoIssues).not.toHaveBeenCalled();
  });

  it("依頼が不正なら400で理由を返す", async () => {
    const res = await POST(postRequest({ ...valid, requests: [{ ...valid.requests[0], targetRepository: valid.repository }] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("起点と同じ");
  });

  it("起点が未登録なら400", async () => {
    isRegistered.mockResolvedValue(false);
    const res = await POST(postRequest(valid));
    expect(res.status).toBe(400);
  });

  it("起票して結果を返す", async () => {
    const res = await POST(postRequest(valid));
    expect(res.status).toBe(200);
    expect(fileCrossRepoIssues).toHaveBeenCalledWith(
      [expect.objectContaining({ key: "fix-token", launch: true, waitForOrigin: false })],
      { repository: "guchi-apps/issue-deck", issueNumber: 100 },
      expect.anything(),
    );
  });

  it("起票・紐付けの失敗は500で理由を返す", async () => {
    fileCrossRepoIssues.mockRejectedValue(new Error("紐付けできません"));
    const res = await POST(postRequest(valid));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("紐付けできません");
  });
});
