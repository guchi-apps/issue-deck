import { beforeEach, describe, expect, it, vi } from "vitest";

const parentRunFindMany = vi.fn();
const repositoryFindMany = vi.fn();
vi.mock("@/lib/db", () => ({
  db: {
    parentRun: { findMany: (...args: unknown[]) => parentRunFindMany(...args) },
    repository: { findMany: (...args: unknown[]) => repositoryFindMany(...args) },
  },
}));

import { getParentRunChildMarksByIssue } from "@/lib/parent-run/child-state-query";

const LAUNCHED_AT = new Date("2026-10-24T01:00:00.000Z");

function run(parentRepository: string, parentIssue: number, childRepository: string, childNumber: number) {
  return {
    parentRepository,
    parentIssue,
    children: [
      {
        repository: childRepository,
        number: childNumber,
        display: { phase: "waiting", reason: `${parentRepository}の順番待ち` },
        launchedAt: null,
        updatedAt: LAUNCHED_AT,
      },
    ],
  };
}

describe("getParentRunChildMarksByIssue（#4969）", () => {
  beforeEach(() => {
    parentRunFindMany.mockReset();
    repositoryFindMany.mockReset();
  });

  it("閲覧者に見えない親リポジトリの実行は、子が共有されていても印にしない", async () => {
    // Aの非公開の親 → Bも見える共有の子
    parentRunFindMany.mockResolvedValue([
      run("alice/private-parent", 10, "shared/child", 1),
      run("shared/parent", 20, "shared/child", 2),
    ]);
    repositoryFindMany.mockResolvedValue([{ fullName: "shared/parent" }]);

    const marks = await getParentRunChildMarksByIssue("user-b");

    expect(marks.has("shared/child#1")).toBe(false);
    expect(marks.get("shared/child#2")).toMatchObject({ parentRepository: "shared/parent", parentNumber: 20 });
  });

  it("可視性は閲覧者のインストールで判定する", async () => {
    parentRunFindMany.mockResolvedValue([run("alice/private-parent", 10, "shared/child", 1)]);
    repositoryFindMany.mockResolvedValue([{ fullName: "alice/private-parent" }]);

    const marks = await getParentRunChildMarksByIssue("user-a");

    expect(repositoryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          fullName: { in: ["alice/private-parent"] },
          installation: { userInstallations: { some: { userId: "user-a" } } },
        }),
      }),
    );
    expect(marks.get("shared/child#1")).toMatchObject({ parentRepository: "alice/private-parent", parentNumber: 10 });
  });

  it("可視な実行と不可視な実行が同じ子に載るとき、不可視な方の情報は使わない", async () => {
    parentRunFindMany.mockResolvedValue([
      run("alice/private-parent", 10, "shared/child", 1),
      run("shared/parent", 20, "shared/child", 1),
    ]);
    repositoryFindMany.mockResolvedValue([{ fullName: "shared/parent" }]);

    const marks = await getParentRunChildMarksByIssue("user-b");

    expect(marks.get("shared/child#1")).toMatchObject({ parentRepository: "shared/parent", parentNumber: 20 });
  });

  it("稼働中の実行が無ければリポジトリは引かない", async () => {
    parentRunFindMany.mockResolvedValue([]);
    expect((await getParentRunChildMarksByIssue("user-b")).size).toBe(0);
    expect(repositoryFindMany).not.toHaveBeenCalled();
  });
});
