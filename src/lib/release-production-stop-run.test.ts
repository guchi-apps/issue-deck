import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  githubFetch: vi.fn(),
  fetchFileTextAtRef: vi.fn(),
  isAncestorCommit: vi.fn(),
  hasVersionVerification: vi.fn(),
}));

vi.mock("@/lib/github/request", () => ({ GITHUB_API: "https://api.github.test", githubFetch: mocks.githubFetch }));
vi.mock("@/lib/github/release-api", () => ({ fetchFileTextAtRef: mocks.fetchFileTextAtRef, isAncestorCommit: mocks.isAncestorCommit }));
vi.mock("@/lib/deploy-recovery-series-run", () => ({ hasVersionVerification: mocks.hasVersionVerification }));

import { observeSuccessorProof } from "@/lib/release-production-stop-run";

const ctx = { owner: "o", repo: "r", token: "t" };
const COVERED = "a".repeat(40);
const NEXT = "b".repeat(40);
const GATE_DEPLOY = [
  "jobs:",
  "  deploy:",
  "    steps:",
  "      - env:",
  "          APP_COMMIT_SHA: ${{ github.sha }}",
  "        run: |",
  "          {",
  "            printf '%s\\n' \"APP_COMMIT_SHA=${APP_COMMIT_SHA}\"",
  "          } | ssh host env",
  "      - run: ssh host deploy",
].join("\n");

function latestRun(run: Partial<{ head_sha: string; status: string; conclusion: string | null }>) {
  mocks.githubFetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      workflow_runs: [{ id: 1, html_url: "https://github.test/run/1", created_at: "2026-11-24T13:00:00Z", head_sha: NEXT, status: "completed", conclusion: "success", ...run }],
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchFileTextAtRef.mockResolvedValue(GATE_DEPLOY);
  mocks.hasVersionVerification.mockResolvedValue(true);
  mocks.isAncestorCommit.mockResolvedValue(true);
});

describe("observeSuccessorProof の閉じられない理由（#5638）", () => {
  it("後続の版が照合付きで成功し、対象を含めば閉じる", async () => {
    latestRun({});
    expect(await observeSuccessorProof(ctx, COVERED)).toEqual({
      ok: true,
      evidence: { coveredSha: COVERED, successorSha: NEXT, deployRunUrl: "https://github.test/run/1" },
    });
  });

  it("最新のデプロイが実行中・失敗・対象自身なら、それぞれの理由を返す", async () => {
    latestRun({ status: "in_progress", conclusion: null });
    expect(await observeSuccessorProof(ctx, COVERED)).toEqual({ ok: false, waiting: "latest_running" });
    latestRun({ conclusion: "failure" });
    expect(await observeSuccessorProof(ctx, COVERED)).toEqual({ ok: false, waiting: "latest_not_success" });
    latestRun({ head_sha: COVERED, conclusion: "failure" });
    expect(await observeSuccessorProof(ctx, COVERED)).toEqual({ ok: false, waiting: "latest_is_candidate" });
  });

  it("履歴を読めない・照合が無い・対象を含まない・系列が追うコミットを区別する", async () => {
    mocks.githubFetch.mockResolvedValue({ ok: false });
    expect(await observeSuccessorProof(ctx, COVERED)).toEqual({ ok: false, waiting: "latest_unreadable" });
    latestRun({});
    mocks.fetchFileTextAtRef.mockResolvedValue("jobs:\n  deploy:\n    steps:\n      - run: ssh host deploy\n");
    expect(await observeSuccessorProof(ctx, COVERED)).toEqual({ ok: false, waiting: "no_version_check" });
    mocks.fetchFileTextAtRef.mockResolvedValue(GATE_DEPLOY);
    mocks.isAncestorCommit.mockResolvedValue(false);
    expect(await observeSuccessorProof(ctx, COVERED)).toEqual({ ok: false, waiting: "not_including" });
    expect(await observeSuccessorProof(ctx, COVERED, { excludeShas: [NEXT] })).toEqual({ ok: false, waiting: "latest_excluded" });
  });
});
