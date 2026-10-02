import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  resetIosDistributionFailureSweepIntervalForTest,
  runIosDistributionFailureSweep,
} from "@/lib/github/ios-distribution-failure-sweep-run";

/**
 * 巡回IOの確認。判定（`ios-distribution-failure.test.ts`）ではなく、判定の結果として
 * 実際にIssueを起票したか・DBの一意制約(repositoryFullName, runId)に当たらないかを見る。
 */

type Row = {
  id: string;
  repositoryFullName: string;
  runId: bigint;
  issueNumber: number;
  state: string;
  failedStage: string | null;
  runUrl: string;
  detectedAt: Date;
  resolvedAt: Date | null;
};

let rows: Row[] = [];
let latestRun: Record<string, unknown> | null = null;
let issueState = "open";
const createIssue = vi.fn();
const createComment = vi.fn();

const FULL_NAME = "guchi-apps/kurashio";

vi.mock("@/lib/db", () => ({
  db: {
    repository: {
      findMany: vi.fn(async () => [
        { fullName: FULL_NAME, ownerLogin: "guchi-apps", name: "kurashio", installation: { installationId: 1 } },
      ]),
    },
    iosDistributionFailureIssue: {
      findFirst: vi.fn(async ({ where }: { where: Partial<Row> }) =>
        rows.find((r) => Object.entries(where).every(([k, v]) => (r as Record<string, unknown>)[k] === v)) ?? null,
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        Object.assign(rows.find((r) => r.id === where.id)!, data);
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Partial<Row>; data: Partial<Row> }) => {
        for (const r of rows) {
          if (!Object.entries(where).every(([k, v]) => (r as Record<string, unknown>)[k] === v)) continue;
          if (data.runId !== undefined && rows.some((o) => o !== r && o.runId === data.runId)) {
            throw new Error("Unique constraint failed");
          }
          Object.assign(r, data);
        }
      }),
      create: vi.fn(async ({ data }: { data: Omit<Row, "id" | "resolvedAt"> }) => {
        if (rows.some((r) => r.repositoryFullName === data.repositoryFullName && r.runId === data.runId)) {
          throw new Error("Unique constraint failed");
        }
        rows.push({ ...data, id: `row${rows.length}`, resolvedAt: null });
      }),
    },
  },
}));
vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn(async () => "token") }));
vi.mock("@/lib/github/actions-api", () => ({ fetchWorkflowRunJobs: vi.fn(async () => []) }));
vi.mock("@/lib/github/release-api", () => ({
  fetchLatestWorkflowRun: vi.fn(async () => latestRun),
  fetchFailedJobNames: vi.fn(async () => []),
}));
vi.mock("@/lib/github/issues-api", () => ({
  createComment: (...args: unknown[]) => createComment(...args),
  createIssue: (...args: unknown[]) => createIssue(...args),
  fetchIssueState: vi.fn(async () => issueState),
  fetchRepositoryLabelNames: vi.fn(async () => new Set<string>()),
  updateIssue: vi.fn(),
}));

const now = new Date("2026-10-02T12:00:00Z");

function failedRun(id: number) {
  return {
    id,
    status: "completed",
    conclusion: "failure",
    htmlUrl: `https://github.com/run/${id}`,
    createdAt: "2026-10-02T10:00:00Z",
    updatedAt: "2026-10-02T10:00:00Z",
    event: "workflow_dispatch",
    runAttempt: 1,
  };
}

function row(overrides: Partial<Row>): Row {
  return {
    id: "r0",
    repositoryFullName: FULL_NAME,
    runId: BigInt(100),
    issueNumber: 5,
    state: "open",
    failedStage: null,
    runUrl: "https://github.com/run/100",
    detectedAt: new Date("2026-10-02T10:30:00Z"),
    resolvedAt: null,
    ...overrides,
  };
}

describe("runIosDistributionFailureSweep", () => {
  beforeEach(() => {
    rows = [];
    latestRun = null;
    issueState = "open";
    createIssue.mockReset().mockResolvedValue({ number: 11 });
    createComment.mockReset();
    resetIosDistributionFailureSweepIntervalForTest();
  });

  it("失敗したrunで追跡行が無ければ起票して行を作る", async () => {
    latestRun = failedRun(100);
    const result = await runIosDistributionFailureSweep({ force: true, now });
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(result.actions).toEqual([{ repositoryFullName: FULL_NAME, kind: "created", issueNumber: 11 }]);
    expect(rows).toHaveLength(1);
  });

  it("人が追跡Issueを先に閉じていても、同じrunでは再起票しない", async () => {
    latestRun = failedRun(100);
    rows = [row({})];
    issueState = "closed";
    const result = await runIosDistributionFailureSweep({ force: true, now });
    expect(createIssue).not.toHaveBeenCalled();
    expect(result.actions).toEqual([]);
    expect(rows[0].state).toBe("closed");
  });

  it("過去に追跡したrunが再び最新になっても、一意制約に当たらず他の項目だけ更新する", async () => {
    latestRun = failedRun(100);
    rows = [
      row({ id: "old", runId: BigInt(100), state: "closed", issueNumber: 5 }),
      row({ id: "cur", runId: BigInt(200), state: "open", issueNumber: 6, runUrl: "https://github.com/run/200" }),
    ];
    const result = await runIosDistributionFailureSweep({ force: true, now });
    expect(result.actions).toEqual([{ repositoryFullName: FULL_NAME, kind: "updated", issueNumber: 6 }]);
    const cur = rows.find((r) => r.id === "cur")!;
    expect(cur.runId).toBe(BigInt(200));
    expect(cur.runUrl).toBe("https://github.com/run/100");
  });
});
