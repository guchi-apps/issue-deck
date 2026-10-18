import { beforeEach, describe, expect, it, vi } from "vitest";

const requireUserId = vi.fn();
const findFirst = vi.fn();
const getInstallationToken = vi.fn();
const fetchPullRequest = vi.fn();
const mergePullRequest = vi.fn();
const loadFinalizationSnapshot = vi.fn();
const listReleaseVerificationRecords = vi.fn();

vi.mock("@/lib/auth-user", () => ({ requireUserId: (...a: unknown[]) => requireUserId(...a) }));
vi.mock("@/lib/db", () => ({ db: { repository: { findFirst: (...a: unknown[]) => findFirst(...a) } } }));
vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: (...a: unknown[]) => getInstallationToken(...a) }));
vi.mock("@/lib/github/actions-api", () => ({
  fetchPullRequest: (...a: unknown[]) => fetchPullRequest(...a),
  mergePullRequest: (...a: unknown[]) => mergePullRequest(...a),
}));
vi.mock("@/lib/github/api-usage", () => ({ withGithubApiFeature: (_f: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/github/deploy-launch-watch", () => ({ recordDeployLaunchWatch: vi.fn().mockResolvedValue(true) }));
vi.mock("@/lib/preview-mode", () => ({ previewModeGuard: () => null }));
vi.mock("@/lib/release-finalize-run", () => ({ loadFinalizationSnapshot: (...a: unknown[]) => loadFinalizationSnapshot(...a) }));
vi.mock("@/lib/release-verification", () => ({ listReleaseVerificationRecords: (...a: unknown[]) => listReleaseVerificationRecords(...a) }));
vi.mock("@/lib/release-prerequisites-run", () => ({ loadReleasePrerequisiteBlockers: async () => [] }));
vi.mock("@/lib/release-verification-config", () => ({ getReleaseVerificationConfig: () => ({ enforced: false }) }));

import { POST } from "./route";

function request() {
  return new Request("http://localhost/api/issues/pull-request-merge", {
    method: "POST",
    body: JSON.stringify({ owner: "o", repo: "r", number: 7 }),
  }) as never;
}

const rcPr = (over: Record<string, unknown> = {}) => ({
  head: { sha: "final", ref: "release-rc/2" },
  base: { sha: "b", ref: "main" },
  body: null,
  draft: false,
  ...over,
});

describe("POST /api/issues/pull-request-merge の新方式候補の工程検査（#4635）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUserId.mockResolvedValue("u1");
    findFirst.mockResolvedValue({ installation: { installationId: 1 } });
    getInstallationToken.mockResolvedValue("t");
    listReleaseVerificationRecords.mockResolvedValue([]);
    mergePullRequest.mockResolvedValue({ sha: "m" });
  });

  it("ドラフトのRCはGitHubのmerge APIを呼ばず409で次の操作を返す", async () => {
    fetchPullRequest.mockResolvedValue(rcPr({ draft: true }));
    loadFinalizationSnapshot.mockResolvedValue({ candidateId: "c", phase: "review", applied: null });
    const res = await POST(request());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "rc_not_prepared", next: "verify" });
    expect(mergePullRequest).not.toHaveBeenCalled();
  });

  it("承認待ちでもドラフトのままなら通さない", async () => {
    fetchPullRequest.mockResolvedValue(rcPr({ draft: true }));
    loadFinalizationSnapshot.mockResolvedValue({ candidateId: "c", phase: "awaiting_approval", applied: { preHeadSha: "p", finalHeadSha: "final", finalBaseSha: "b" } });
    const res = await POST(request());
    expect(await res.json()).toMatchObject({ error: "rc_draft" });
    expect(mergePullRequest).not.toHaveBeenCalled();
  });

  it("記録が引けなければ通さない", async () => {
    fetchPullRequest.mockResolvedValue(rcPr());
    loadFinalizationSnapshot.mockResolvedValue(null);
    const res = await POST(request());
    expect(await res.json()).toMatchObject({ error: "rc_record_missing" });
    expect(mergePullRequest).not.toHaveBeenCalled();
  });

  it("公開準備後に候補のheadが変わっていたら通さない", async () => {
    fetchPullRequest.mockResolvedValue(rcPr({ head: { sha: "moved", ref: "release-rc/2" } }));
    loadFinalizationSnapshot.mockResolvedValue({ candidateId: "c", phase: "awaiting_approval", applied: { preHeadSha: "p", finalHeadSha: "final", finalBaseSha: "b" } });
    const res = await POST(request());
    expect(await res.json()).toMatchObject({ error: "rc_head_mismatch" });
  });

  it("公開準備が済んだ候補は通り、headを固定してマージする", async () => {
    fetchPullRequest.mockResolvedValue(rcPr());
    loadFinalizationSnapshot.mockResolvedValue({ candidateId: "c", phase: "awaiting_approval", applied: { preHeadSha: "p", finalHeadSha: "final", finalBaseSha: "b" } });
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(mergePullRequest).toHaveBeenCalledWith("o", "r", 7, "t", "final");
  });

  it("旧方式（release-main/*）にはRC記録の検査を掛けない", async () => {
    fetchPullRequest.mockResolvedValue(rcPr({ head: { sha: "h", ref: "release-main/v1.2.3" } }));
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(loadFinalizationSnapshot).not.toHaveBeenCalled();
  });
});
