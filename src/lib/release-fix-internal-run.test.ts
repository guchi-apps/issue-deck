import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string };
const store = vi.hoisted(() => ({
  series: [] as Row[],
  rounds: [] as Row[],
  findings: [] as Row[],
  sha: "a".repeat(40),
  nextId: 1,
  createComment: vi.fn(async () => undefined),
  addIssueLabels: vi.fn(async () => undefined),
}));

function match(row: Row, where: Record<string, unknown> = {}) {
  return Object.entries(where).every(([k, v]) => (typeof v === "object" && v !== null ? true : row[k] === v));
}
function apply(row: Row, data: Record<string, unknown>) {
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === "object" && v !== null && "increment" in v) row[k] = (row[k] as number) + (v as { increment: number }).increment;
    else row[k] = v;
  }
}
function table(rows: () => Row[], defaults: Record<string, unknown> = {}) {
  return {
  findMany: async ({ where }: { where?: Record<string, unknown> } = {}) => rows().filter((r) => match(r, where)).map((r) => ({ ...r })),
  findFirst: async ({ where }: { where?: Record<string, unknown> } = {}) => {
    const hit = rows().find((r) => match(r, where));
    return hit ? { ...hit } : null;
  },
  create: async ({ data }: { data: Record<string, unknown> }) => {
    const row = { id: `id${store.nextId++}`, ...defaults, ...data } as Row;
    rows().push(row);
    return { ...row };
  },
  update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
    const hit = rows().find((r) => r.id === where.id)!;
    apply(hit, data);
    return { ...hit };
  },
  updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    const hits = rows().filter((r) => match(r, where));
    hits.forEach((r) => apply(r, data));
    return { count: hits.length };
  },
  };
}

vi.mock("@/lib/db", () => ({
  db: {
    releaseFixSeries: table(() => store.series),
    releaseFixInternalRound: table(() => store.rounds, { reviewVerdict: null, reviewTargetSha: null, testState: null, testTargetSha: null, openFindingCount: 0 }),
    releaseFixFinding: table(() => store.findings, { reopenCount: 0, resolution: null }),
    repository: { findFirst: async () => ({ installation: { installationId: 1 } }) },
  },
}));
vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn(async () => "t") }));
vi.mock("@/lib/github/branches-api", () => ({ fetchBranchHeadSha: vi.fn(async () => store.sha) }));
vi.mock("@/lib/github/issues-api", () => ({ createComment: store.createComment, addIssueLabels: store.addIssueLabels }));

import { evaluateInternalGateForSweep, readInternalStatus, recordInternalReview, recordInternalTest } from "@/lib/release-fix-internal-run";

const REPO = "o/r";
const ISSUE = 4410;

beforeEach(() => {
  vi.clearAllMocks();
  store.series = [{ id: "s1", repositoryFullName: REPO, issueNumber: ISSUE, internalReview: true, internalStopReason: null, status: "fix_in_progress", createdAt: new Date() }];
  store.rounds = [];
  store.findings = [];
  store.sha = "a".repeat(40);
});

describe("内部確認の往復（指摘A→修正後に指摘B→合格）", () => {
  it("同じ修正Issueの中で往復し、合格したときだけPR作成可になる。新しいPR・Issueの操作はしない", async () => {
    const r1 = await recordInternalReview({ repositoryFullName: REPO, issueNumber: ISSUE, report: { verdict: "findings", newFindings: [{ title: "認可の漏れ" }], stillOpen: [], resolved: [] }, summary: null });
    expect(r1).toMatchObject({ ok: true, round: 1 });
    if (!r1.ok) return;
    expect(r1.status.findings[0]).toMatchObject({ key: "F-001", status: "open" });
    expect(r1.status.gate.complete).toBe(false);

    // 修正をpushした（SHAが変わる）。指摘Aを解消、レビューで指摘Bを発見
    store.sha = "b".repeat(40);
    const r2 = await recordInternalReview({
      repositoryFullName: REPO,
      issueNumber: ISSUE,
      report: { verdict: "findings", newFindings: [{ title: "旧pollerの互換" }], stillOpen: [], resolved: [{ key: "F-001", resolution: "route.tsで確認" }] },
      summary: null,
    });
    expect(r2).toMatchObject({ ok: true, round: 2 });
    if (!r2.ok) return;
    expect(r2.status.findings.map((f) => [f.key, f.status])).toEqual([["F-001", "resolved"], ["F-002", "open"]]);

    // Bを直して再レビュー合格、テスト合格
    store.sha = "c".repeat(40);
    const r3 = await recordInternalReview({ repositoryFullName: REPO, issueNumber: ISSUE, report: { verdict: "pass", newFindings: [], stillOpen: [], resolved: [{ key: "F-002", resolution: "互換分岐を確認" }] }, summary: null });
    expect(r3).toMatchObject({ ok: true, round: 3 });
    const t = await recordInternalTest({ repositoryFullName: REPO, issueNumber: ISSUE, state: "passed", summary: "vitest" });
    expect(t.ok && t.status.gate.complete).toBe(true);
    expect(store.rounds).toHaveLength(3);
  });

  it("合格後に内容が変わると古い合格は流用されない", async () => {
    await recordInternalReview({ repositoryFullName: REPO, issueNumber: ISSUE, report: { verdict: "pass", newFindings: [], stillOpen: [], resolved: [] }, summary: null });
    await recordInternalTest({ repositoryFullName: REPO, issueNumber: ISSUE, state: "passed", summary: null });
    store.sha = "d".repeat(40);
    const status = await readInternalStatus(REPO, ISSUE);
    expect(status.ok && status.status.gate).toMatchObject({ complete: false, blocker: "review_target_changed" });
    const gate = await evaluateInternalGateForSweep({ repositoryFullName: REPO, issueNumber: ISSUE, internalStopReason: null }, "a".repeat(40));
    expect(gate.complete).toBe(true);
    const stale = await evaluateInternalGateForSweep({ repositoryFullName: REPO, issueNumber: ISSUE, internalStopReason: null }, "d".repeat(40));
    expect(stale.complete).toBe(false);
  });

  it("同じ指摘が2回続けて解消しなければ止まり、Issueへ理由と札を一度だけ残す", async () => {
    await recordInternalReview({ repositoryFullName: REPO, issueNumber: ISSUE, report: { verdict: "findings", newFindings: [{ title: "同じ指摘" }], stillOpen: [], resolved: [] }, summary: null });
    for (let i = 0; i < 2; i += 1) {
      store.sha = String(i + 1).repeat(40);
      await recordInternalReview({ repositoryFullName: REPO, issueNumber: ISSUE, report: { verdict: "findings", newFindings: [], stillOpen: ["F-001"], resolved: [] }, summary: null });
    }
    expect(store.series[0].internalStopReason).toContain("F-001");
    expect(store.createComment).toHaveBeenCalledTimes(1);
    expect(store.addIssueLabels).toHaveBeenCalledTimes(1);
    const after = await recordInternalReview({ repositoryFullName: REPO, issueNumber: ISSUE, report: { verdict: "pass", newFindings: [], stillOpen: [], resolved: [] }, summary: null });
    expect(after).toMatchObject({ ok: false, error: "stopped" });
  });
});

describe("報告の結び付け", () => {
  it("進行中の内部確認つき系列が無い修正Issueへは記録しない", async () => {
    const result = await recordInternalReview({ repositoryFullName: REPO, issueNumber: 999, report: { verdict: "pass", newFindings: [], stillOpen: [], resolved: [] }, summary: null });
    expect(result).toMatchObject({ ok: false, error: "series_not_found" });
    expect(store.rounds).toHaveLength(0);
  });
  it("終わった系列・内部確認を求めない旧い系列には書かせない", async () => {
    store.series[0].status = "ready";
    expect(await recordInternalTest({ repositoryFullName: REPO, issueNumber: ISSUE, state: "passed", summary: null })).toMatchObject({ ok: false, error: "series_not_found" });
    store.series[0].status = "fix_in_progress";
    store.series[0].internalReview = false;
    expect(await readInternalStatus(REPO, ISSUE)).toMatchObject({ ok: false, error: "series_not_found" });
  });
  it("整合しないレビュー報告は記録しない", async () => {
    const result = await recordInternalReview({ repositoryFullName: REPO, issueNumber: ISSUE, report: { verdict: "pass", newFindings: [{ title: "x" }], stillOpen: [], resolved: [] }, summary: null });
    expect(result).toMatchObject({ ok: false, error: "invalid_report" });
    expect(store.rounds).toHaveLength(0);
  });
});
