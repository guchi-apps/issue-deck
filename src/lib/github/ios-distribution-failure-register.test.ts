import { beforeEach, describe, expect, it, vi } from "vitest";

import { registerManualIosFailureIssue } from "@/lib/github/ios-distribution-failure-register";

type Row = { repositoryFullName: string; runId: bigint; issueNumber: number; state: string; detectedAt: Date };
let rows: Row[] = [];

vi.mock("@/lib/db", () => ({
  db: {
    iosDistributionFailureIssue: {
      findFirst: vi.fn(async ({ where }: { where: { repositoryFullName: string; state: string } }) =>
        rows.find((r) => r.repositoryFullName === where.repositoryFullName && r.state === where.state) ?? null,
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { repositoryFullName_runId: { repositoryFullName: string; runId: bigint } };
          create: Row;
          update: Partial<Row>;
        }) => {
          const key = where.repositoryFullName_runId;
          const found = rows.find((r) => r.repositoryFullName === key.repositoryFullName && r.runId === key.runId);
          if (found) Object.assign(found, update);
          else rows.push(create);
        },
      ),
    },
  },
}));

const input = { repositoryFullName: "o/r", runId: 10, runUrl: "https://example/runs/10", failedStage: "署名", issueNumber: 7 };

beforeEach(() => {
  rows = [];
});

describe("registerManualIosFailureIssue", () => {
  it("openの行が無ければ新規に登録する", async () => {
    expect(await registerManualIosFailureIssue(input)).toEqual({ kind: "registered", issueNumber: 7 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ runId: BigInt(10), issueNumber: 7, state: "open" });
  });

  it("同じrunのclosed行は番号を差し替えて開き直す（一意制約に当たらない）", async () => {
    rows.push({ repositoryFullName: "o/r", runId: BigInt(10), issueNumber: 3, state: "closed", detectedAt: new Date(0) });
    expect(await registerManualIosFailureIssue(input)).toEqual({ kind: "registered", issueNumber: 7 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ issueNumber: 7, state: "open" });
  });

  it("openの行が既にあれば登録せず、その番号を返す（open行を2件にしない）", async () => {
    rows.push({ repositoryFullName: "o/r", runId: BigInt(9), issueNumber: 3, state: "open", detectedAt: new Date(0) });
    expect(await registerManualIosFailureIssue(input)).toEqual({ kind: "already_tracked", issueNumber: 3 });
    expect(rows).toHaveLength(1);
  });
});
