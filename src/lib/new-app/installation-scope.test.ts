import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();
const fetchRepositorySelection = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    githubInstallation: {
      get findFirst() {
        return findFirst;
      },
    },
  },
}));

vi.mock("@/lib/github/installations-api", () => ({
  get fetchRepositorySelection() {
    return fetchRepositorySelection;
  },
}));

import { resolveNewAppInstallationScope } from "@/lib/new-app/installation-scope";

describe("resolveNewAppInstallationScope", () => {
  beforeEach(() => {
    findFirst.mockReset().mockResolvedValue({ installationId: 42 });
    fetchRepositorySelection.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("allなら手作業の追加は要らない", async () => {
    fetchRepositorySelection.mockResolvedValue("all");
    await expect(resolveNewAppInstallationScope("user-1")).resolves.toEqual({
      repositorySelection: "all",
      needsRepositoryAdd: false,
    });
    expect(fetchRepositorySelection).toHaveBeenCalledWith(42);
  });

  it("selectedへ戻されていたら手順を出す", async () => {
    fetchRepositorySelection.mockResolvedValue("selected");
    await expect(resolveNewAppInstallationScope("user-1")).resolves.toEqual({
      repositorySelection: "selected",
      needsRepositoryAdd: true,
    });
  });

  // 落とすと立ち上げが黙って壊れるので、読めないときは手順を出す側に倒す
  it("選び方を読めなかったら手順を出す", async () => {
    fetchRepositorySelection.mockRejectedValue(new Error("boom"));
    await expect(resolveNewAppInstallationScope("user-1")).resolves.toEqual({
      repositorySelection: null,
      needsRepositoryAdd: true,
    });
  });

  it("インストールが見つからないときも手順を出す", async () => {
    findFirst.mockResolvedValue(null);
    await expect(resolveNewAppInstallationScope("user-1")).resolves.toEqual({
      repositorySelection: null,
      needsRepositoryAdd: true,
    });
    expect(fetchRepositorySelection).not.toHaveBeenCalled();
  });
});
