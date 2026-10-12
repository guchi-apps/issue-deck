import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 再検証の追加指摘から、同じ修正Issueの次世代へ戻す巡回（#4478）。
 * DB・GitHub・配車は差し替え、巡回の判断（継続・待機・停止・二重起案の抑止）だけを見る。
 */

type Row = Record<string, unknown> & { id: string };

const { state, seriesDb } = vi.hoisted(() => {
  const state = { rows: [] as Row[], jobCount: 0 };
  const matches = (row: Row, where: Record<string, unknown> | undefined): boolean => {
    if (!where) return true;
    return Object.entries(where).every(([key, cond]) => {
      if (key === "OR") return (cond as Record<string, unknown>[]).some((w) => matches(row, w));
      const value = row[key];
      if (cond && typeof cond === "object" && !(cond instanceof Date)) {
        const c = cond as Record<string, unknown>;
        if ("in" in c) return (c.in as unknown[]).includes(value);
        if ("not" in c) return value !== c.not;
        if ("contains" in c) return typeof value === "string" && value.includes(c.contains as string);
        return true;
      }
      return value === cond;
    });
  };
  const seriesDb = {
    findMany: async (args?: { where?: Record<string, unknown> }) => state.rows.filter((r) => matches(r, args?.where)).map((r) => ({ ...r })),
    findFirst: async (args?: { where?: Record<string, unknown> }) => {
      const r = state.rows.find((r) => matches(r, args?.where));
      return r ? { ...r } : null;
    },
    findUnique: async (args: { where: Record<string, unknown> }) => {
      const r = state.rows.find((r) => matches(r, args.where));
      return r ? { ...r } : null;
    },
    update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = state.rows.find((r) => r.id === args.where.id)!;
      Object.assign(row, args.data);
      return { ...row };
    },
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hit = state.rows.filter((r) => matches(r, args.where));
      hit.forEach((r) => Object.assign(r, args.data));
      return { count: hit.length };
    },
    create: async (args: { data: Record<string, unknown> }) => {
      const row = { id: `s${state.rows.length + 1}`, createdAt: new Date(), stopReason: null, fixPrNumber: null, fixPrMergedAt: null, acceptedExtraPrs: null, rebuildClaimedAt: null, ...args.data } as Row;
      state.rows.push(row);
      return row;
    },
  };
  return { state, seriesDb };
});

vi.mock("@/lib/db", () => ({
  db: {
    releaseFixSeries: seriesDb,
    repository: { findFirst: async () => ({ installation: { installationId: 1 } }) },
    dispatchJob: { findUnique: async () => null, count: async () => state.jobCount },
    issue: { findFirst: async () => null },
    appSetting: { findUnique: async () => null },
  },
}));
vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn(async () => "t") }));
const fetchPullRequest = vi.fn();
vi.mock("@/lib/github/actions-api", () => ({ fetchPullRequest: (...a: unknown[]) => fetchPullRequest(...a) }));
const createComment = vi.fn(async () => ({}));
const createIssue = vi.fn(async () => ({ number: 999 }));
vi.mock("@/lib/github/issues-api", () => ({
  addIssueLabels: vi.fn(async () => []),
  createComment: (...a: unknown[]) => (createComment as (...x: unknown[]) => unknown)(...a),
  createIssue: (...a: unknown[]) => (createIssue as (...x: unknown[]) => unknown)(...a),
  fetchIssueState: vi.fn(async () => "open"),
  fetchIssueStateOrThrow: vi.fn(async () => "open"),
  updateIssue: vi.fn(async () => ({})),
}));
vi.mock("@/lib/github/release-api", () => ({
  fetchOpenPullRequestsForBase: vi.fn(async () => []),
  fetchPullRequestForRebuild: vi.fn(),
  isAncestorCommit: vi.fn(),
  fetchPullRequestsByHead: vi.fn(async () => []),
  fetchReleaseRebuildCandidate: vi.fn(),
  releaseCallerSupportsSelection: vi.fn(),
}));
vi.mock("@/lib/github/release-workflow-cache", () => ({ releaseWorkflowExists: vi.fn() }));
vi.mock("@/lib/release-fix-internal-run", () => ({ evaluateInternalGateForSweep: vi.fn(), loadInternalViewForUi: vi.fn() }));
vi.mock("@/lib/release-rebuild-history-run", () => ({ findLatestApprovalEventId: vi.fn(), recordRebuildEvent: vi.fn(async () => undefined) }));
vi.mock("@/lib/release-rebuild-run", () => ({ rebuildReleaseCandidate: vi.fn() }));
vi.mock("@/lib/release-rebuild-selection-run", () => ({ requestSelectiveRebuild: vi.fn() }));
const loadSummary = vi.fn();
vi.mock("@/lib/release-verification-load", () => ({ loadReleaseVerificationSummary: (...a: unknown[]) => loadSummary(...a) }));
const removeLabels = vi.fn(async () => undefined);
vi.mock("@/lib/dispatch/check-user-labels", () => ({ removeCheckUserWithReason: (...a: unknown[]) => (removeLabels as (...x: unknown[]) => unknown)(...a) }));
const enqueueDispatchJob = vi.fn();
vi.mock("@/lib/dispatch/jobs", () => ({ enqueueDispatchJob: (...a: unknown[]) => enqueueDispatchJob(...a) }));

import { runReleaseFixSweep } from "@/lib/release-fix-series-run";

const section = (state: string, extra: Partial<{ reason: string | null; findings: unknown[] }> = {}) => ({
  state,
  reason: extra.reason ?? null,
  summary: null,
  evidenceUrl: null,
  findings: extra.findings ?? [],
  affectedPullRequests: [],
  progress: null,
});
const finding = { severity: "high", title: "指摘A", detail: "d", file: "a.ts", line: 1, recommendation: null, pullRequests: [] };

function baseRow(over: Partial<Row> = {}): Row {
  return {
    id: "s1",
    repositoryFullName: "o/r",
    releasePrNumber: 10,
    releaseVersion: "1.0.0",
    originBaseSha: "b0",
    originHeadSha: "h0",
    sourceKind: "review_finding",
    causeClass: "code",
    sourceKey: "key0",
    items: [],
    issueNumber: 100,
    fixPrNumber: 101,
    fixPrMergedAt: new Date(),
    status: "reverifying",
    stopReason: null,
    activeKey: "o/r#10:key0",
    parentId: null,
    generation: 1,
    rebuildClaimedAt: new Date(),
    successorPrNumber: 11,
    successorBaseSha: "b1",
    successorHeadSha: "h1",
    createdByUserId: "u1",
    internalReview: true,
    createdAt: new Date("2026-10-12T00:00:00Z"),
    ...over,
  };
}

beforeEach(() => {
  state.rows = [baseRow()];
  state.jobCount = 0;
  vi.clearAllMocks();
  fetchPullRequest.mockResolvedValue({
    number: 11,
    state: "open",
    base: { sha: "b1", ref: "main" },
    head: { sha: "h1", ref: "release-main/v1.0.1" },
  });
  loadSummary.mockResolvedValue({ integration: section("passed"), aiReview: section("needs_check", { findings: [finding] }) });
  enqueueDispatchJob.mockResolvedValue({ ok: true, job: { id: "j1" } });
});

describe("再検証の追加指摘", () => {
  it("確認待ちにせず、同じ修正Issueの次世代を起案して起動する", async () => {
    await runReleaseFixSweep({ hostName: "subpc" });
    expect(state.rows).toHaveLength(2);
    expect(state.rows[1]).toMatchObject({ issueNumber: 100, generation: 2, parentId: "s1", status: "issue_created" });
    expect(state.rows[0]).toMatchObject({ status: "superseded", activeKey: null });
    expect(createIssue).not.toHaveBeenCalled();
    expect(enqueueDispatchJob).toHaveBeenCalledWith(expect.objectContaining({ issueNumber: 100, hostName: "subpc" }));
  });

  it("2回巡回しても次世代・起動ジョブを重ねない", async () => {
    await runReleaseFixSweep({ hostName: "subpc" });
    state.jobCount = 1; // 1回目の起動ジョブが積まれた
    await runReleaseFixSweep({ hostName: "subpc" });
    expect(state.rows).toHaveLength(2);
    expect(enqueueDispatchJob).toHaveBeenCalledTimes(1);
  });

  it("起動が一時的に断られたら、次の巡回で起動し直す", async () => {
    enqueueDispatchJob.mockResolvedValueOnce({ ok: false, rejection: "host_offline", message: "オフライン" });
    await runReleaseFixSweep({ hostName: "subpc" });
    expect(state.rows.every((r) => r.status !== "stopped")).toBe(true);
    await runReleaseFixSweep({ hostName: "subpc" });
    expect(enqueueDispatchJob).toHaveBeenCalledTimes(2);
  });

  it("後継が既にある旧世代は、起案も起動もせず引き継ぎ済みに畳む", async () => {
    state.rows[0].status = "stopped";
    state.rows[0].stopReason = "後継候補 #11 の再検証で指摘・失敗が残りました（世代 1）。後継候補から修正Issueを起案すると、同じ系列として続きます";
    state.rows.push(baseRow({ id: "s2", parentId: "s1", generation: 2, status: "fix_in_progress", activeKey: "o/r#10:key1", sourceKey: "key1", createdAt: new Date("2026-10-12T01:00:00Z") }));
    await runReleaseFixSweep({ hostName: "subpc" });
    expect(state.rows).toHaveLength(2);
    expect(state.rows[0]).toMatchObject({ status: "superseded" });
    expect(removeLabels).toHaveBeenCalledWith("o", "r", 100, "t");
    expect(enqueueDispatchJob).not.toHaveBeenCalled();
  });

  it("旧い巡回が止めた系列を再評価して次世代へ戻し、確認待ちを解く", async () => {
    state.rows[0].status = "stopped";
    state.rows[0].activeKey = null;
    state.rows[0].stopReason = "後継候補 #11 の再検証で指摘・失敗が残りました（世代 1）。後継候補から修正Issueを起案すると、同じ系列として続きます";
    await runReleaseFixSweep({ hostName: "subpc" });
    expect(state.rows[1]).toMatchObject({ issueNumber: 100, generation: 2 });
    expect(state.rows[0].status).toBe("superseded");
    expect(removeLabels).toHaveBeenCalledTimes(1);
  });

  it("実行障害は起案せず、確認待ちにもしない", async () => {
    loadSummary.mockResolvedValue({ integration: section("passed"), aiReview: section("failed") });
    await runReleaseFixSweep({ hostName: "subpc" });
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].status).toBe("reverifying");
    expect(createIssue).not.toHaveBeenCalled();
  });

  it("世代の上限に達したら、理由つきで止めて確認待ちにする", async () => {
    state.rows[0].generation = 3;
    await runReleaseFixSweep({ hostName: "subpc" });
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({ status: "stopped" });
    expect(String(state.rows[0].stopReason)).toContain("上限");
  });

  it("ラベルの解消に失敗しても継続は止めない", async () => {
    removeLabels.mockRejectedValueOnce(new Error("boom"));
    state.rows[0].status = "stopped";
    state.rows[0].activeKey = null;
    state.rows[0].stopReason = "後継候補 #11 の再検証で指摘・失敗が残りました（世代 1）。後継候補から修正Issueを起案すると、同じ系列として続きます";
    await runReleaseFixSweep({ hostName: "subpc" });
    expect(state.rows).toHaveLength(2);
  });
});
