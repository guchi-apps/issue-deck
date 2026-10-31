import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 再検証の追加指摘から、同じ修正Issueの次世代へ戻す巡回（#4478）。
 * DB・GitHub・配車は差し替え、巡回の判断（継続・待機・停止・二重起案の抑止）だけを見る。
 */

type Row = Record<string, unknown> & { id: string };

const { state, seriesDb } = vi.hoisted(() => {
  const state = { rows: [] as Row[], jobCount: 0, decisions: [] as Record<string, unknown>[] };
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
        if ("startsWith" in c) return typeof value === "string" && value.startsWith(c.startsWith as string);
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
    releaseReviewDecision: { findMany: async () => state.decisions },
  },
}));
vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn(async () => "t") }));
const fetchPullRequest = vi.fn();
vi.mock("@/lib/github/actions-api", () => ({ fetchPullRequest: (...a: unknown[]) => fetchPullRequest(...a) }));
const createComment = vi.fn(async () => ({}));
const addIssueLabels = vi.fn(async () => [] as string[]);
const createIssue = vi.fn(async () => ({ number: 999 }));
const fetchIssueStateOrThrow = vi.fn();
vi.mock("@/lib/github/issues-api", () => ({
  fetchIssueStateOrThrow: (...a: unknown[]) => fetchIssueStateOrThrow(...a),
  addIssueLabels: (...a: unknown[]) => (addIssueLabels as (...x: unknown[]) => unknown)(...a),
  createComment: (...a: unknown[]) => (createComment as (...x: unknown[]) => unknown)(...a),
  createIssue: (...a: unknown[]) => (createIssue as (...x: unknown[]) => unknown)(...a),
  fetchIssueState: vi.fn(async () => "open"),
  updateIssue: vi.fn(async () => ({})),
}));
const fetchOpenPullRequestsForBase = vi.fn(async () => [] as unknown[]);
vi.mock("@/lib/github/release-api", () => ({
  fetchOpenPullRequestsForBase: (...a: unknown[]) => (fetchOpenPullRequestsForBase as (...x: unknown[]) => unknown)(...a),
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
const observeRcRevisionAfter = vi.fn(async () => null as unknown);
const reconcileRcCandidate = vi.fn(async () => undefined);
vi.mock("@/lib/release-rc-run", () => ({
  findCandidateIdByPullRequest: vi.fn(async () => "c1"),
  findReviewableRcForPullRequest: vi.fn(async () => null),
  observeRcRevisionAfter: (...a: unknown[]) => (observeRcRevisionAfter as (...x: unknown[]) => unknown)(...a),
  rcFixSeriesRequestKey: vi.fn(() => "key"),
  reconcileRcCandidate: (...a: unknown[]) => (reconcileRcCandidate as (...x: unknown[]) => unknown)(...a),
  requestRcImport: vi.fn(),
}));

import { buildReleaseFixSourceKey, rcImportFailureReason, REBUILD_FAILURE_REASONS, reviewFindingKey } from "@/lib/release-fix-series";
import { closeFixSeriesForCancelledCandidate, recoverRcFixSeries, runReleaseFixSweep } from "@/lib/release-fix-series-run";
import { summarizeReleaseReviewDecisions } from "@/lib/release-review-decision";
import { reviewFindingId } from "@/lib/release-review-result";

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
  state.decisions = [];
  vi.clearAllMocks();
  fetchPullRequest.mockResolvedValue({
    number: 11,
    state: "open",
    base: { sha: "b1", ref: "main" },
    head: { sha: "h1", ref: "release-main/v1.0.1" },
  });
  loadSummary.mockResolvedValue({ integration: section("passed"), aiReview: section("needs_check", { findings: [finding] }) });
  enqueueDispatchJob.mockResolvedValue({ ok: true, job: { id: "j1" } });
  fetchIssueStateOrThrow.mockResolvedValue("open");
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

  it("恒久的な起動拒否はDBも停止にし、鍵を解放して次の巡回で再通知・再起動しない", async () => {
    enqueueDispatchJob.mockResolvedValueOnce({ ok: false, rejection: "repository_not_found", message: "リポジトリが登録されていません" });
    await runReleaseFixSweep({ hostName: "subpc" });
    expect(state.rows[1]).toMatchObject({ status: "stopped", activeKey: null });
    expect(String(state.rows[1].stopReason)).toContain("リポジトリが登録されていません");
    const notified = createComment.mock.calls.length;

    await runReleaseFixSweep({ hostName: "subpc" });
    expect(enqueueDispatchJob).toHaveBeenCalledTimes(1);
    expect(createComment).toHaveBeenCalledTimes(notified);
    expect(state.rows).toHaveLength(2);
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

  describe("同じ指摘の再発は後継候補でも止める（#4766）", () => {
    const keyOf = (f: { title: string; file: string }) =>
      buildReleaseFixSourceKey({ repositoryFullName: "o/r", baseSha: "b1", sourceKind: "review_finding", itemKeys: [reviewFindingKey(f)] });

    it("新方式（同じPRのrevision）: 行がずれた同じ指摘が残れば、親自身を既存扱いにせず止める", async () => {
      const key = keyOf(finding);
      state.rows = [baseRow({ originBaseSha: "b1", sourceKey: key, activeKey: `o/r#10:${key}`, successorPrNumber: 10 })];
      fetchPullRequest.mockResolvedValue({ number: 10, state: "open", base: { sha: "b1", ref: "main" }, head: { sha: "h1", ref: "release-rc/1" } });
      loadSummary.mockResolvedValue({ integration: section("passed"), aiReview: section("needs_check", { findings: [{ ...finding, line: 40 }] }) });
      await runReleaseFixSweep({ hostName: "subpc" });
      expect(state.rows).toHaveLength(1);
      expect(state.rows[0].status).toBe("stopped");
      expect(String(state.rows[0].stopReason)).toContain("同じ指摘が再発しています");
      expect(enqueueDispatchJob).not.toHaveBeenCalled();
    });

    it("旧方式（後継は別のPR番号）でも、headと番号に依らず再発として止める", async () => {
      const key = keyOf(finding);
      state.rows = [baseRow({ originBaseSha: "b1", sourceKey: key, activeKey: `o/r#10:${key}` })];
      await runReleaseFixSweep({ hostName: "subpc" });
      expect(state.rows).toHaveLength(1);
      expect(state.rows[0].status).toBe("stopped");
      expect(String(state.rows[0].stopReason)).toContain("同じ指摘が再発しています");
    });
  });

  it("実行障害は起案せず、確認待ちにもしない", async () => {
    loadSummary.mockResolvedValue({ integration: section("passed"), aiReview: section("failed") });
    await runReleaseFixSweep({ hostName: "subpc" });
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].status).toBe("reverifying");
    expect(createIssue).not.toHaveBeenCalled();
  });

  it("世代が3を超えても止めず、同じ修正Issueの次世代へ進める（#4589）", async () => {
    state.rows[0].generation = 3;
    await runReleaseFixSweep({ hostName: "subpc" });
    expect(state.rows).toHaveLength(2);
    expect(state.rows[1]).toMatchObject({ generation: 4, issueNumber: 100 });
    expect(createIssue).not.toHaveBeenCalled();
  });

  it("3世代上限で止まっていた系列（後継なし）は、再評価して次世代へ戻す（#4589）", async () => {
    state.rows[0].status = "stopped";
    state.rows[0].activeKey = null;
    state.rows[0].generation = 3;
    state.rows[0].stopReason = "修正の反復が上限（3回）に達しました。原因を人が整理してから進めてください。リリース画面の修正系列から、原因を整理したうえで手動で修正Issueを起案できます";
    await runReleaseFixSweep({ hostName: "subpc" });
    expect(state.rows).toHaveLength(2);
    expect(state.rows[1]).toMatchObject({ generation: 4, issueNumber: 100 });
    // 巡回が重なっても二重に起案しない
    await runReleaseFixSweep({ hostName: "subpc" });
    expect(state.rows).toHaveLength(2);
  });

  it("親Issueの状態取得に失敗したら（403・429・5xx・不正な応答）新しいIssueを作らず、次の巡回で再試行する（#4488）", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchIssueStateOrThrow.mockRejectedValueOnce(new Error("GitHub API request failed: 503"));
    await runReleaseFixSweep({ hostName: "subpc" });
    expect(fetchIssueStateOrThrow).toHaveBeenCalledWith("o", "r", 100, "t");
    expect(createIssue).not.toHaveBeenCalled();
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].status).toBe("reverifying");

    await runReleaseFixSweep({ hostName: "subpc" });
    expect(createIssue).not.toHaveBeenCalled();
    expect(state.rows[1]).toMatchObject({ issueNumber: 100, generation: 2 });
  });

  it("親Issueが閉じている・存在しないときだけ新しいIssueを作る", async () => {
    fetchIssueStateOrThrow.mockResolvedValueOnce("closed");
    await runReleaseFixSweep({ hostName: "subpc" });
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(state.rows[1]).toMatchObject({ issueNumber: 999, generation: 2 });
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

describe("指摘ごとのユーザー判断（#4657）", () => {
  const findingB = { ...finding, title: "指摘B", file: "b.ts", line: 2 };
  const idA = reviewFindingId(finding);
  const idB = reviewFindingId(findingB);
  const deferA = {
    id: "d1",
    findingId: idA,
    sequence: 1,
    decision: "defer" as const,
    reason: "今回は見送る",
    impact: "影響",
    scope: "範囲",
    followUp: null,
    timing: null,
    prNumber: 11,
    headRef: "release-main/v1.0.1",
    baseSha: "b1",
    headSha: "h1",
    severity: "high" as const,
    blocking: true,
    findingTitle: "指摘A",
    decidedBy: "user",
    decidedAt: "2026-10-15T00:00:00.000Z",
  };
  const withDecisions = (findings: (typeof finding)[], records: (typeof deferA)[]) => ({
    ...section("needs_check", { findings: findings.map((f) => ({ ...f, id: reviewFindingId(f) })) }),
    decisions: summarizeReleaseReviewDecisions({
      records,
      findings: findings.map((f) => ({ id: reviewFindingId(f), title: f.title, severity: "high" as const, blocking: true })),
      suggestions: [],
      current: { baseSha: "b1" },
      state: "needs_check",
      unverifiedScope: null,
    }),
  });

  it("次世代は「見送り」と判断した指摘を再び起案しない", async () => {
    loadSummary.mockResolvedValue({ integration: section("passed"), aiReview: withDecisions([finding, findingB], [deferA]) });
    await runReleaseFixSweep({ hostName: "subpc" });
    expect(state.rows).toHaveLength(2);
    const items = state.rows[1].items as { title: string }[];
    expect(items.map((i) => i.title)).toEqual(["指摘B"]);
    expect(idB).not.toBe(idA);
  });

  it("残る止める指摘がすべて修正しない判断なら、次世代を作らず系列を終える", async () => {
    loadSummary.mockResolvedValue({ integration: section("passed"), aiReview: withDecisions([finding], [deferA]) });
    await runReleaseFixSweep({ hostName: "subpc" });
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({ status: "ready", activeKey: null });
    expect(enqueueDispatchJob).not.toHaveBeenCalled();
  });

  it("取り込み前の系列は、写した指摘がすべて修正しない判断になったら取り込み・候補更新を止める", async () => {
    state.rows = [
      baseRow({
        status: "issue_created",
        successorPrNumber: null,
        successorBaseSha: null,
        successorHeadSha: null,
        rebuildClaimedAt: null,
        fixPrNumber: null,
        fixPrMergedAt: null,
        originBaseSha: "b1",
        items: [{ title: "指摘A", file: "a.ts:1", detail: "d" }],
      }),
    ];
    state.decisions = [{ findingId: idA, decision: "defer", baseSha: "b1", sequence: 1 }];
    await runReleaseFixSweep({});
    expect(state.rows[0]).toMatchObject({ status: "stopped", activeKey: null });
    expect(String(state.rows[0].stopReason)).toContain("実行中のセッションは止まらず");
  });
});

describe("候補の取り消しで修正系列を畳む（#4800）", () => {
  const close = (prNumbers: number[]) => closeFixSeriesForCancelledCandidate({ repositoryFullName: "o/r", prNumbers, candidateLabel: "RC-9" });

  it("止まった系列を終端にし、確認待ちの札を外してコメントを残す。巡回しても復活しない", async () => {
    state.rows = [baseRow({ status: "stopped", activeKey: null, stopReason: "起案できる指摘が読み取れません", successorPrNumber: 11 })];
    expect(await close([11])).toBe(1);
    expect(state.rows[0]).toMatchObject({ status: "superseded", activeKey: null });
    expect(String(state.rows[0].stopReason)).toContain("RC-9");
    expect(removeLabels).toHaveBeenCalledWith("o", "r", 100, "t");
    expect(String((createComment.mock.calls.at(-1) as unknown[])[4] && ((createComment.mock.calls.at(-1) as unknown[])[4] as { body: string }).body)).toContain("取り消したため");
    await runReleaseFixSweep({ hostName: "subpc" });
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].status).toBe("superseded");
  });

  it("進行中の系列も畳むが、札は止まった系列だけ外す。別の候補の系列・終端の系列には触れない", async () => {
    state.rows = [
      baseRow({ id: "a", status: "reverifying" }),
      baseRow({ id: "b", releasePrNumber: 50, successorPrNumber: null, status: "stopped" }),
      baseRow({ id: "c", status: "ready" }),
    ];
    expect(await close([10])).toBe(1);
    expect(state.rows.map((r) => r.status)).toEqual(["superseded", "stopped", "ready"]);
    expect(removeLabels).not.toHaveBeenCalled();
  });
});

describe("新方式の候補への取り込みで止めた系列（#4895）", () => {
  const stoppedRc = (over: Partial<Row> = {}) =>
    baseRow({
      status: "stopped",
      stopReason: rcImportFailureReason({ kind: "failed", detail: "候補ブランチが更新されていません" }),
      activeKey: null,
      successorPrNumber: null,
      successorBaseSha: null,
      successorHeadSha: null,
      ...over,
    });
  const applied = { status: "applied", prNumber: 10, baseSha: "b2", headSha: "h2", failureReason: null };

  beforeEach(() => {
    observeRcRevisionAfter.mockResolvedValue(null);
    fetchOpenPullRequestsForBase.mockResolvedValue([]);
  });

  it("取り込みのrevisionが後から適用されていれば、巡回が再検証中へ戻して確認待ちを解く", async () => {
    state.rows = [stoppedRc()];
    observeRcRevisionAfter.mockResolvedValue(applied);
    await runReleaseFixSweep({ hostName: "subpc" });
    expect(state.rows[0]).toMatchObject({ status: "reverifying", stopReason: null, successorPrNumber: 10, successorHeadSha: "h2" });
    expect(removeLabels).toHaveBeenCalled();
  });

  it("従来の理由（段階なし）で止めた系列も同じく戻す", async () => {
    state.rows = [stoppedRc({ stopReason: REBUILD_FAILURE_REASONS.rc })];
    observeRcRevisionAfter.mockResolvedValue(applied);
    await runReleaseFixSweep({ hostName: "subpc" });
    expect(state.rows[0]).toMatchObject({ status: "reverifying" });
  });

  it("適用されていなければ止めたままにする", async () => {
    state.rows = [stoppedRc()];
    observeRcRevisionAfter.mockResolvedValue({ ...applied, status: "failed", failureReason: "競合" });
    await runReleaseFixSweep({ hostName: "subpc" });
    expect(state.rows[0]).toMatchObject({ status: "stopped" });
    expect(removeLabels).not.toHaveBeenCalled();
  });

  describe("recoverRcFixSeries（画面の「再取り込み・再確認」）", () => {
    const ctx = { owner: "o", repo: "r", token: "t" };
    const rcPr = (sha: string) => ({ number: 10, head: { ref: "release-rc/2", sha }, base: { sha: "b0" } });

    it("記録を照合し直し、取り込みが適用されていれば再検証へ戻す", async () => {
      state.rows = [stoppedRc()];
      observeRcRevisionAfter.mockResolvedValue(applied);
      const result = await recoverRcFixSeries({ repositoryFullName: "o/r", prNumber: 10, ctx });
      expect(reconcileRcCandidate).toHaveBeenCalledWith("o/r", "c1");
      expect(result).toEqual({ resumed: [100], requeued: [], blocked: [] });
    });

    it("候補ブランチが系列の起点のままなら、取り込みを依頼し直せる状態へ戻す", async () => {
      state.rows = [stoppedRc()];
      fetchOpenPullRequestsForBase.mockResolvedValue([rcPr("h0")]);
      const result = await recoverRcFixSeries({ repositoryFullName: "o/r", prNumber: 10, ctx });
      expect(result).toEqual({ resumed: [], requeued: [100], blocked: [] });
      expect(state.rows[0]).toMatchObject({ status: "fix_merged", stopReason: null, rebuildClaimedAt: null });
    });

    it("候補ブランチが記録に無い変更で進んでいれば、推測で取り込まず理由を返す", async () => {
      state.rows = [stoppedRc()];
      fetchOpenPullRequestsForBase.mockResolvedValue([rcPr("zz")]);
      const result = await recoverRcFixSeries({ repositoryFullName: "o/r", prNumber: 10, ctx });
      expect(result.blocked).toHaveLength(1);
      expect(result.blocked[0].reason).toContain("記録に無い変更で進んでいます");
      expect(state.rows[0]).toMatchObject({ status: "stopped" });
    });
  });
});


describe("指摘0件の全体レビュー未確認は、修正Issueの確認待ちにしない（#5130）", () => {
  const unverifiedSummary = () => ({
    integration: section("passed"),
    aiReview: { ...section("needs_check"), stage: { kind: "needs_check", items: [] }, unverifiedScope: "本番環境の設定と疎通" },
  });
  const commentTargets = () => createComment.mock.calls.map((call) => (call as unknown[])[2]);

  beforeEach(() => {
    loadSummary.mockResolvedValue(unverifiedSummary());
  });

  it("系列は止めるが、修正Issueに札を付けず、理由と次の操作をリリース候補のPRへ残す", async () => {
    await runReleaseFixSweep({ hostName: "subpc" });
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({ status: "stopped", activeKey: null });
    expect(String(state.rows[0].stopReason)).toContain("本番環境の設定と疎通");
    expect(String(state.rows[0].stopReason)).toContain("リリース候補の画面");
    expect(addIssueLabels).not.toHaveBeenCalled();
    expect(commentTargets()).toEqual([11]);
    // 合格扱いにしない（readyへ進めない）
    expect(state.rows[0].status).not.toBe("ready");
    // 止まる前は札を付けていないので、外しにも行かない
    expect(removeLabels).not.toHaveBeenCalled();
  });

  it("2回目の巡回では何もしない（コメント・札・ラベル解除を重ねない）", async () => {
    await runReleaseFixSweep({ hostName: "subpc" });
    vi.clearAllMocks();
    loadSummary.mockResolvedValue(unverifiedSummary());
    await runReleaseFixSweep({ hostName: "subpc" });
    expect(createComment).not.toHaveBeenCalled();
    expect(addIssueLabels).not.toHaveBeenCalled();
    expect(removeLabels).not.toHaveBeenCalled();
    expect(state.rows[0].status).toBe("stopped");
  });

  it("旧い巡回が確認待ちを付けて止めていた系列は、候補側の停止へ移すときに札を外す（1回だけ）", async () => {
    state.rows[0].status = "stopped";
    state.rows[0].activeKey = null;
    state.rows[0].stopReason =
      "全体レビューに未確認範囲が残っています（指摘は0件）：本番環境の設定と疎通。統合検証の結果でも解消しませんでした。範囲を確認し、問題なければ判断を記録し、直すものがあれば画面から修正Issueを起案してください";
    await runReleaseFixSweep({ hostName: "subpc" });
    expect(removeLabels).toHaveBeenCalledTimes(1);
    expect(removeLabels).toHaveBeenCalledWith("o", "r", 100, "t");
    expect(addIssueLabels).not.toHaveBeenCalled();
    await runReleaseFixSweep({ hostName: "subpc" });
    expect(removeLabels).toHaveBeenCalledTimes(1);
  });

  it("判別できない統合検証の失敗など、修正Issueで判断が要る停止は従来どおり札を付ける", async () => {
    loadSummary.mockResolvedValue({ integration: section("failed"), aiReview: section("passed") });
    await runReleaseFixSweep({ hostName: "subpc" });
    expect(state.rows[0].status).toBe("stopped");
    expect(addIssueLabels).toHaveBeenCalledWith("o", "r", 100, "t", ["00.check-user", "01.check-blocked"]);
    expect(commentTargets()).toEqual([100]);
  });
});

describe("候補更新で系列が置き換わるとき、系列が付けた確認待ちを外す（#5130）", () => {
  it("止まっていた系列が候補の更新で`superseded`になったら、札を外す", async () => {
    state.rows[0].status = "stopped";
    state.rows[0].activeKey = null;
    state.rows[0].stopReason = "全体レビューに未確認範囲が残っています（指摘は0件）。統合検証の結果でも解消しませんでした";
    fetchPullRequest.mockResolvedValue({ number: 11, state: "open", base: { sha: "b1", ref: "main" }, head: { sha: "h2", ref: "release-main/v1.0.1" } });
    await runReleaseFixSweep({ hostName: "subpc" });
    expect(state.rows[0].status).toBe("superseded");
    expect(removeLabels).toHaveBeenCalledTimes(1);
    expect(removeLabels).toHaveBeenCalledWith("o", "r", 100, "t");
    expect(addIssueLabels).not.toHaveBeenCalled();
    // 終端なので次の巡回では触れない
    await runReleaseFixSweep({ hostName: "subpc" });
    expect(removeLabels).toHaveBeenCalledTimes(1);
  });

  it("札を付けていない（再検証中の）系列が置き換わっても、ラベルは外しに行かない", async () => {
    fetchPullRequest.mockResolvedValue({ number: 11, state: "open", base: { sha: "b1", ref: "main" }, head: { sha: "h2", ref: "release-main/v1.0.1" } });
    await runReleaseFixSweep({ hostName: "subpc" });
    expect(state.rows[0].status).toBe("superseded");
    expect(removeLabels).not.toHaveBeenCalled();
  });
});
