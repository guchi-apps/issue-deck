import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string };
const store = vi.hoisted(() => ({
  series: [] as Row[],
  rounds: [] as Row[],
  findings: [] as Row[],
  sessions: [] as Row[],
  sha: "a".repeat(40),
  nextId: 1,
  createComment: vi.fn(async () => undefined),
  addIssueLabels: vi.fn(async () => undefined),
  removeIssueLabel: vi.fn(async () => undefined),
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
    releaseFixInternalSession: table(() => store.sessions, {
      activeSeconds: 0,
      lastActivityAt: null,
      budgetMinutes: 120,
      pauseKind: null,
      pauseDetail: null,
      pausedAt: null,
      pausedSha: null,
      resumeBaseRound: 0,
      nextAction: null,
      assignee: null,
      assignmentEpoch: 0,
      leaseUntil: null,
      attempts: null,
    }),
    releaseFixInternalRound: table(() => store.rounds, { reviewVerdict: null, reviewTargetSha: null, testState: null, testTargetSha: null, openFindingCount: 0 }),
    releaseFixFinding: table(() => store.findings, { reopenCount: 0, regressionCount: 0, resolution: null }),
    repository: { findFirst: async () => ({ installation: { installationId: 1 } }) },
  },
}));
vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn(async () => "t") }));
vi.mock("@/lib/github/branches-api", () => ({ fetchBranchHeadSha: vi.fn(async () => store.sha) }));
vi.mock("@/lib/github/issues-api", () => ({ createComment: store.createComment, addIssueLabels: store.addIssueLabels, removeIssueLabel: store.removeIssueLabel }));

import type { ReviewReport } from "@/lib/release-fix-internal";
import {
  claimInternalSession,
  evaluateInternalGateForSweep,
  loadInternalViewForUi,
  pauseInternalByReport,
  readInternalStatus,
  recordInternalReview,
  recordInternalTest,
  releaseInternalSession,
  resumeInternal,
} from "@/lib/release-fix-internal-run";

const REPO = "o/r";
const ISSUE = 4410;

beforeEach(() => {
  vi.clearAllMocks();
  store.series = [{ id: "s1", repositoryFullName: REPO, issueNumber: ISSUE, internalReview: true, internalStopReason: null, status: "fix_in_progress", fixPrMergedAt: null, createdAt: new Date() }];
  store.rounds = [];
  store.findings = [];
  store.sessions = [];
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
    expect(after).toMatchObject({ ok: false, error: "paused" });
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

const pass: ReviewReport = { verdict: "pass", newFindings: [], stillOpen: [], resolved: [] };
const sess = (over: Record<string, unknown> = {}) => {
  store.sessions.push({ id: "ss1", repositoryFullName: REPO, issueNumber: ISSUE, activeSeconds: 0, lastActivityAt: null, budgetMinutes: 120, pauseKind: null, pauseDetail: null, pausedAt: null, pausedSha: null, resumeBaseRound: 0, nextAction: null, assignee: null, assignmentEpoch: 0, leaseUntil: null, attempts: null, ...over } as never);
};

describe("再開可能な一時停止（#4587）", () => {
  it("5往復を超えても、指摘が減り続ける修正は回数だけでは止まらない", async () => {
    await recordInternalReview({ repositoryFullName: REPO, issueNumber: ISSUE, report: { verdict: "findings", newFindings: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ title: `指摘${n}` })), stillOpen: [], resolved: [] }, summary: null });
    for (let i = 1; i <= 6; i += 1) {
      store.sha = String(i).repeat(40);
      const r = await recordInternalReview({
        repositoryFullName: REPO,
        issueNumber: ISSUE,
        report: { verdict: "findings", newFindings: [], stillOpen: [`F-00${i + 1}`], resolved: [{ key: `F-00${i}`, resolution: "確認" }] },
        summary: null,
      });
      expect(r.ok && r.status.pause).toBeNull();
    }
    expect(store.series[0].internalStopReason).toBeNull();
  });

  it("稼働時間が予算に達すると一時停止し、待機・中断の時間は消費しない", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-13T00:00:00Z"));
      await recordInternalTest({ repositoryFullName: REPO, issueNumber: ISSUE, state: "failed", summary: null });
      // 5時間の待機のあと報告しても、算入されるのは間隔の上限（10分）まで
      vi.setSystemTime(new Date("2026-10-13T05:00:00Z"));
      await recordInternalTest({ repositoryFullName: REPO, issueNumber: ISSUE, state: "failed", summary: null });
      expect(store.sessions[0].activeSeconds).toBe(600);
      // 予算ぎりぎりまで消費した状態から報告すると、予算に達して一時停止する
      store.sessions[0].activeSeconds = 7190;
      vi.setSystemTime(new Date("2026-10-13T05:05:00Z"));
      const r = await recordInternalTest({ repositoryFullName: REPO, issueNumber: ISSUE, state: "passed", summary: null });
      expect(r).toMatchObject({ ok: false, error: "paused" });
      expect(store.sessions[0].pauseKind).toBe("budget_reached");
      expect(store.sessions[0].lastActivityAt).toBeNull();
      expect(store.addIssueLabels).toHaveBeenCalledTimes(1);
      // 停止中の報告は記録せず、稼働時間も増えない
      const before = store.sessions[0].activeSeconds;
      vi.setSystemTime(new Date("2026-10-13T05:08:00Z"));
      expect(await recordInternalReview({ repositoryFullName: REPO, issueNumber: ISSUE, report: pass, summary: null })).toMatchObject({ ok: false, error: "paused" });
      expect(store.sessions[0].activeSeconds).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("状態の取得は読み取り専用: 予算超過でも停止・コメント・ラベル・セッション行の作成をしない", async () => {
    sess({ activeSeconds: 99999 });
    await recordInternalReviewSeed();
    const snapshot = JSON.stringify([store.sessions, store.series, store.rounds]);
    const status = await readInternalStatus(REPO, ISSUE);
    expect(status.ok && status.status.pendingPause).toMatchObject({ kind: "budget_reached" });
    expect(status.ok && status.status.pause).toBeNull();
    await loadInternalViewForUi(REPO, ISSUE, true, null);
    expect(JSON.stringify([store.sessions, store.series, store.rounds])).toBe(snapshot);
    expect(store.createComment).not.toHaveBeenCalled();
    expect(store.addIssueLabels).not.toHaveBeenCalled();
  });

  it("記録の無い修正でも、取得だけではセッション行を作らない", async () => {
    await readInternalStatus(REPO, ISSUE);
    expect(store.sessions).toHaveLength(0);
  });

  it("予算の追加で再開でき、累積の稼働時間・指摘・往復は保持される。二重の再開は一方だけが成功する", async () => {
    await recordInternalReview({ repositoryFullName: REPO, issueNumber: ISSUE, report: { verdict: "findings", newFindings: [{ title: "A" }], stillOpen: [], resolved: [] }, summary: null });
    Object.assign(store.sessions[0], { pauseKind: "budget_reached", pauseDetail: "予算", activeSeconds: 7300 });
    store.series[0].internalStopReason = "予算";
    expect(await resumeInternal({ repositoryFullName: REPO, issueNumber: ISSUE })).toMatchObject({ ok: false, error: "input_required" });
    const [a, b] = await Promise.all([
      resumeInternal({ repositoryFullName: REPO, issueNumber: ISSUE, addMinutes: 60, by: "u" }),
      resumeInternal({ repositoryFullName: REPO, issueNumber: ISSUE, addMinutes: 60, by: "u" }),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(store.sessions[0]).toMatchObject({ pauseKind: null, budgetMinutes: 180, activeSeconds: 7300, resumeBaseRound: 1 });
    expect(store.series[0].internalStopReason).toBeNull();
    expect(store.findings).toHaveLength(1);
    // 再開後は報告できる
    expect(await recordInternalTest({ repositoryFullName: REPO, issueNumber: ISSUE, state: "failed", summary: null })).toMatchObject({ ok: true });
  });

  it("停滞による停止は方針の入力が要り、再開直後に同じ停滞で即再停止しない", async () => {
    await recordInternalReview({ repositoryFullName: REPO, issueNumber: ISSUE, report: { verdict: "findings", newFindings: [{ title: "同じ" }], stillOpen: [], resolved: [] }, summary: null });
    for (let i = 1; i <= 2; i += 1) {
      store.sha = String(i).repeat(40);
      await recordInternalReview({ repositoryFullName: REPO, issueNumber: ISSUE, report: { verdict: "findings", newFindings: [], stillOpen: ["F-001"], resolved: [] }, summary: null });
    }
    expect(store.sessions[0].pauseKind).toBe("recurring_finding");
    expect(await resumeInternal({ repositoryFullName: REPO, issueNumber: ISSUE, addMinutes: 30 })).toMatchObject({ ok: false, error: "input_required" });
    expect(await resumeInternal({ repositoryFullName: REPO, issueNumber: ISSUE, direction: "別の方式で直す" })).toMatchObject({ ok: true });
    store.sha = "9".repeat(40);
    const next = await recordInternalReview({ repositoryFullName: REPO, issueNumber: ISSUE, report: { verdict: "findings", newFindings: [], stillOpen: ["F-001"], resolved: [] }, summary: null });
    expect(next.ok && next.status.pause).toBeNull();
  });

  it("完了・置換・マージ済みの系列は再開しない", async () => {
    sess({ pauseKind: "no_progress", pauseDetail: "x" });
    store.series[0].status = "superseded";
    expect(await resumeInternal({ repositoryFullName: REPO, issueNumber: ISSUE, direction: "d" })).toMatchObject({ ok: false, error: "not_resumable" });
    store.series[0].status = "fix_in_progress";
    store.series[0].fixPrMergedAt = new Date();
    expect(await resumeInternal({ repositoryFullName: REPO, issueNumber: ISSUE, direction: "d" })).toMatchObject({ ok: false, error: "not_resumable" });
    expect(store.sessions[0].pauseKind).toBe("no_progress");
  });

  it("実行環境の障害は本人確認待ちにせず、エージェントが入力なしで再開できる。予算・方針の停止は再開できない", async () => {
    const paused = await pauseInternalByReport({ repositoryFullName: REPO, issueNumber: ISSUE, kind: "environment", detail: "Claude API 529" });
    expect(paused.ok && paused.status.pause).toMatchObject({ kind: "environment", autoResumable: true });
    expect(store.addIssueLabels).not.toHaveBeenCalled();
    expect(await resumeInternal({ repositoryFullName: REPO, issueNumber: ISSUE, autoOnly: true })).toMatchObject({ ok: true });
    await pauseInternalByReport({ repositoryFullName: REPO, issueNumber: ISSUE, kind: "needs_decision", detail: "権限不足" });
    expect(store.addIssueLabels).toHaveBeenCalledTimes(1);
    expect(await resumeInternal({ repositoryFullName: REPO, issueNumber: ISSUE, autoOnly: true })).toMatchObject({ ok: false, error: "input_required" });
  });

  it("旧方式で止まった系列は理由を保持して読み替えられ、新しい予算で再評価して再開できる", async () => {
    store.series[0].internalStopReason = "独立レビューの往復が上限（5回）に達しました。残っている指摘と進め方を人が判断してください";
    const status = await readInternalStatus(REPO, ISSUE);
    expect(status.ok && status.status.pause).toMatchObject({ kind: "budget_reached" });
    expect(status.ok && status.status.pause?.message).toContain("往復が上限");
    expect(store.sessions).toHaveLength(0);
    expect(await resumeInternal({ repositoryFullName: REPO, issueNumber: ISSUE })).toMatchObject({ ok: true });
    expect(store.series[0].internalStopReason).toBeNull();
  });
});

async function recordInternalReviewSeed() {
  await recordInternalReview({ repositoryFullName: REPO, issueNumber: ISSUE, report: { verdict: "findings", newFindings: [{ title: "A" }], stillOpen: [], resolved: [] }, summary: null });
  store.sessions[0].pauseKind = null;
  store.sessions[0].activeSeconds = 99999;
  store.createComment.mockClear();
  store.addIssueLabels.mockClear();
  store.series[0].internalStopReason = null;
}

describe("担当の取得・引き継ぎ・解放（#4587）", () => {
  it("担当Aから引き継いだBが続け、旧担当Aの遅延報告は弾かれる。累積の記録はゼロにならない", async () => {
    const a = await claimInternalSession({ repositoryFullName: REPO, issueNumber: ISSUE, assignee: "agent-a" });
    expect(a).toMatchObject({ ok: true, epoch: 1, handover: false });
    const actorA = { assignee: "agent-a", epoch: 1 };
    await recordInternalReview({ repositoryFullName: REPO, issueNumber: ISSUE, report: { verdict: "findings", newFindings: [{ title: "A" }], stillOpen: [], resolved: [] }, summary: null, actor: actorA });
    const seconds = store.sessions[0].activeSeconds;

    // 持ち時間の内は、明示の引き継ぎが無ければ取れない
    expect(await claimInternalSession({ repositoryFullName: REPO, issueNumber: ISSUE, assignee: "agent-b" })).toMatchObject({ ok: false, error: "lease_held" });
    const b = await claimInternalSession({ repositoryFullName: REPO, issueNumber: ISSUE, assignee: "agent-b", takeover: true });
    expect(b).toMatchObject({ ok: true, epoch: 2, handover: true });
    expect(store.sessions[0].activeSeconds).toBe(seconds);

    // 旧担当の遅延報告
    expect(await recordInternalTest({ repositoryFullName: REPO, issueNumber: ISSUE, state: "passed", summary: null, actor: actorA })).toMatchObject({ ok: false, error: "stale_assignee" });
    expect(store.rounds[0].testState ?? null).toBeNull();
    // 新担当は既存の指摘から続けられる
    store.sha = "b".repeat(40);
    const r = await recordInternalReview({
      repositoryFullName: REPO,
      issueNumber: ISSUE,
      report: { verdict: "pass", newFindings: [], stillOpen: [], resolved: [{ key: "F-001", resolution: "確認" }] },
      summary: null,
      actor: { assignee: "agent-b", epoch: 2 },
    });
    expect(r).toMatchObject({ ok: true, round: 2 });
    expect(store.sessions[0].attempts).toHaveLength(2);
  });

  it("担当がいるのに担当を名乗らない報告は弾く。解放後の旧担当の報告も弾く", async () => {
    await claimInternalSession({ repositoryFullName: REPO, issueNumber: ISSUE, assignee: "agent-a" });
    expect(await recordInternalTest({ repositoryFullName: REPO, issueNumber: ISSUE, state: "passed", summary: null })).toMatchObject({ ok: false, error: "stale_assignee" });
    expect(await releaseInternalSession({ repositoryFullName: REPO, issueNumber: ISSUE, actor: { assignee: "agent-a", epoch: 1 } })).toMatchObject({ ok: true });
    expect(store.sessions[0]).toMatchObject({ assignee: null, assignmentEpoch: 2 });
    expect(await recordInternalTest({ repositoryFullName: REPO, issueNumber: ISSUE, state: "passed", summary: null, actor: { assignee: "agent-a", epoch: 1 } })).toMatchObject({ ok: false, error: "stale_assignee" });
  });

  it("持ち時間が切れた担当は、引き継ぎの指定なしで別の担当が取得できる", async () => {
    sess({ assignee: "agent-a", assignmentEpoch: 1, leaseUntil: new Date(Date.now() - 1000) });
    expect(await claimInternalSession({ repositoryFullName: REPO, issueNumber: ISSUE, assignee: "agent-b" })).toMatchObject({ ok: true, epoch: 2, handover: true });
  });

  it("同時の取得は一方だけが成功する", async () => {
    sess();
    const [x, y] = await Promise.all([
      claimInternalSession({ repositoryFullName: REPO, issueNumber: ISSUE, assignee: "agent-x" }),
      claimInternalSession({ repositoryFullName: REPO, issueNumber: ISSUE, assignee: "agent-y" }),
    ]);
    expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1);
    expect(store.sessions).toHaveLength(1);
    expect(["agent-x", "agent-y"]).toContain(store.sessions[0].assignee);
  });
});

describe("外部エージェントの報告の結び付け（#4588）", () => {
  const sha = "a".repeat(40);
  it("検証したと申告するSHAがブランチのHEADと違えば記録せず、現在のHEADを返す（最新HEADへ付け替えない）", async () => {
    const result = await recordInternalTest({ repositoryFullName: REPO, issueNumber: ISSUE, state: "passed", summary: null, expectedSha: "f".repeat(40) });
    expect(result).toMatchObject({ ok: false, error: "stale_sha", currentSha: sha });
    expect(store.rounds).toHaveLength(0);
    const review = await recordInternalReview({ repositoryFullName: REPO, issueNumber: ISSUE, report: pass, summary: null, expectedSha: "f".repeat(40) });
    expect(review).toMatchObject({ ok: false, error: "stale_sha" });
    expect(store.rounds).toHaveLength(0);
  });
  it("SHAが一致すれば記録する。申告しない旧実行ホストの報告は従来どおり", async () => {
    expect(await recordInternalTest({ repositoryFullName: REPO, issueNumber: ISSUE, state: "passed", summary: null, expectedSha: sha })).toMatchObject({ ok: true });
    expect(await recordInternalReview({ repositoryFullName: REPO, issueNumber: ISSUE, report: pass, summary: null })).toMatchObject({ ok: true });
  });
  it("実装担当と同じ主体のレビューは独立レビューとして記録しない。別の主体は担当でなくても世代が合えば記録し、主体を残す", async () => {
    const claimed = await claimInternalSession({ repositoryFullName: REPO, issueNumber: ISSUE, assignee: "ext:tokA:agentA" });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const self = await recordInternalReview({
      repositoryFullName: REPO,
      issueNumber: ISSUE,
      report: pass,
      summary: null,
      expectedSha: sha,
      actor: { assignee: "ext:tokA:agentA", epoch: claimed.epoch, reviewer: true },
      reviewer: { kind: "external", ref: "ext:tokA:other", isSelf: (n) => n.startsWith("ext:tokA:") },
    });
    expect(self).toMatchObject({ ok: false, error: "self_review_not_independent" });
    expect(store.rounds).toHaveLength(0);
    const independent = await recordInternalReview({
      repositoryFullName: REPO,
      issueNumber: ISSUE,
      report: pass,
      summary: null,
      expectedSha: sha,
      actor: { epoch: claimed.epoch, reviewer: true },
      reviewer: { kind: "external", ref: "ext:tokB:agentB", isSelf: (n) => n.startsWith("ext:tokB:") },
    });
    expect(independent).toMatchObject({ ok: true });
    expect(store.rounds[0]).toMatchObject({ reviewerKind: "external", reviewerRef: "ext:tokB:agentB" });
  });
  it("独立レビューの報告も、担当の世代が変わった後の遅延報告は弾く", async () => {
    const a = await claimInternalSession({ repositoryFullName: REPO, issueNumber: ISSUE, assignee: "ext:tokA:agentA" });
    if (!a.ok) throw new Error("claim");
    await claimInternalSession({ repositoryFullName: REPO, issueNumber: ISSUE, assignee: "ext:tokC:agentC", takeover: true });
    const late = await recordInternalReview({
      repositoryFullName: REPO,
      issueNumber: ISSUE,
      report: pass,
      summary: null,
      expectedSha: sha,
      actor: { epoch: a.epoch, reviewer: true },
      reviewer: { kind: "external", ref: "ext:tokB:agentB", isSelf: () => false },
    });
    expect(late).toMatchObject({ ok: false, error: "stale_assignee" });
    expect(store.rounds).toHaveLength(0);
  });
});
