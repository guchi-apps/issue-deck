import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserId = vi.fn();
const findRepository = vi.fn();
const fetchPullRequest = vi.fn();
const loadSummary = vi.fn();
const saveNote = vi.fn();

vi.mock("@/lib/auth-user", () => ({ requireUserId: (...a: unknown[]) => requireUserId(...a) }));
vi.mock("@/lib/db", () => ({ db: { repository: { findFirst: (...a: unknown[]) => findRepository(...a) } } }));
vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn(async () => "token") }));
vi.mock("@/lib/github/actions-api", () => ({ fetchPullRequest: (...a: unknown[]) => fetchPullRequest(...a) }));
vi.mock("@/lib/release-verification-load", () => ({ loadReleaseVerificationSummary: (...a: unknown[]) => loadSummary(...a) }));
vi.mock("@/lib/release-review-decision-store", () => ({
  resolveReleaseDecisionChain: vi.fn(async () => [11, 10]),
  releaseDecisionScopeKey: () => "o/r#10",
}));
vi.mock("@/lib/release-review-note-store", () => ({ saveReleaseReviewNote: (...a: unknown[]) => saveNote(...a) }));

import type { NextRequest } from "next/server";

import { POST } from "@/app/api/repositories/release/review-notes/route";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

function request(body: Record<string, unknown>) {
  return {
    json: async () => ({
      owner: "o",
      repo: "r",
      pullRequestNumber: 11,
      baseSha: BASE,
      headSha: HEAD,
      target: { kind: "check", checkId: "auth_boundary" },
      body: "連携先が未実装で影響なし",
      followUp: "guchi-apps/morrow#683",
      ...body,
    }),
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireUserId.mockResolvedValue("user-1");
  findRepository.mockResolvedValue({ installation: { installationId: 1 } });
  fetchPullRequest.mockResolvedValue({ state: "open", base: { ref: "main", sha: BASE }, head: { ref: "release-rc/3", sha: HEAD } });
  loadSummary.mockResolvedValue({
    aiReview: { state: "needs_check", findings: [], suggestions: [], review: { checks: [{ id: "auth_boundary", status: "unconfirmed" }, { id: "x", status: "confirmed" }] } },
  });
  saveNote.mockImplementation(async (input: Record<string, unknown>) => ({ id: "n1", ...input }));
});

describe("POST /api/repositories/release/review-notes", () => {
  it("未確認の項目へメモを保存し、今の対象で記録する", async () => {
    const res = await POST(request({}));
    expect(res.status).toBe(200);
    expect(saveNote).toHaveBeenCalledWith(
      expect.objectContaining({ scopeKey: "o/r#10", target: { kind: "check", checkId: "auth_boundary" }, body: "連携先が未実装で影響なし", followUp: "guchi-apps/morrow#683", baseSha: BASE, headSha: HEAD, userId: "user-1" }),
    );
  });

  it("候補全体へのメモは確認項目の状態に関係なく保存できる", async () => {
    expect((await POST(request({ target: { kind: "overall" } }))).status).toBe(200);
  });

  it("未確認でない項目へのメモは409で保存しない", async () => {
    const res = await POST(request({ target: { kind: "check", checkId: "x" } }));
    expect(res.status).toBe(409);
    expect(saveNote).not.toHaveBeenCalled();
  });

  it("理由が空・未ログイン・画面が古いときは保存しない", async () => {
    expect((await POST(request({ body: " " }))).status).toBe(400);
    requireUserId.mockResolvedValueOnce(null);
    expect((await POST(request({}))).status).toBe(401);
    fetchPullRequest.mockResolvedValueOnce({ state: "open", base: { ref: "main", sha: "c".repeat(40) }, head: { ref: "release-rc/3", sha: HEAD } });
    expect((await POST(request({}))).status).toBe(409);
    expect(saveNote).not.toHaveBeenCalled();
  });
});
