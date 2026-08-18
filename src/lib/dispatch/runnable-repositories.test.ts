import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatchHostFindMany = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    dispatchHost: {
      get findMany() {
        return dispatchHostFindMany;
      },
    },
  },
}));

const { listDispatchRunnableRepositories } = await import("@/lib/dispatch/runnable-repositories");

describe("listDispatchRunnableRepositories", () => {
  beforeEach(() => {
    dispatchHostFindMany.mockReset();
  });

  it("申告のあるホストすべての和を返す", async () => {
    dispatchHostFindMany.mockResolvedValue([
      { repositories: JSON.stringify(["guchi-apps/vps", "guchi-apps/issue-deck"]) },
      { repositories: JSON.stringify(["guchi-apps/issue-deck", "guchi-apps/subpc"]) },
    ]);

    const runnable = await listDispatchRunnableRepositories();

    expect([...runnable].sort()).toEqual([
      "guchi-apps/issue-deck",
      "guchi-apps/subpc",
      "guchi-apps/vps",
    ]);
  });

  it("申告が壊れているホストは何も実行できない扱いにし、他のホストの申告は残す", async () => {
    dispatchHostFindMany.mockResolvedValue([
      { repositories: "{壊れたJSON" },
      { repositories: JSON.stringify(["guchi-apps/vps"]) },
    ]);

    const runnable = await listDispatchRunnableRepositories();

    expect([...runnable]).toEqual(["guchi-apps/vps"]);
  });

  it("申告しているホストが1台も無ければ空集合を返す", async () => {
    dispatchHostFindMany.mockResolvedValue([]);

    expect((await listDispatchRunnableRepositories()).size).toBe(0);
  });
});
