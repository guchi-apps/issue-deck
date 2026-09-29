import { beforeEach, describe, expect, it, vi } from "vitest";

const upsert = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ db: { repositoryNameAlias: { upsert } } }));

import { buildRepositoryNameResolver, recordRepositoryRename } from "./repository-alias";

describe("buildRepositoryNameResolver", () => {
  it("旧名を現在名へ寄せる", () => {
    const resolve = buildRepositoryNameResolver([{ oldName: "myroom", newName: "kurashio" }], ["kurashio"]);
    expect(resolve("myroom")).toBe("kurashio");
    expect(resolve("kurashio")).toBe("kurashio");
    expect(resolve("other")).toBe("other");
  });

  it("A→B→Cの連鎖を辿る", () => {
    const resolve = buildRepositoryNameResolver(
      [
        { oldName: "a", newName: "b" },
        { oldName: "b", newName: "c" },
      ],
      ["c"],
    );
    expect(resolve("a")).toBe("c");
  });

  it("循環しても止まる", () => {
    const resolve = buildRepositoryNameResolver(
      [
        { oldName: "a", newName: "b" },
        { oldName: "b", newName: "a" },
      ],
      [],
    );
    expect(["a", "b"]).toContain(resolve("a"));
  });

  it("現存する名前は、旧名として記録されていても解決しない", () => {
    const resolve = buildRepositoryNameResolver([{ oldName: "a", newName: "b" }], ["a", "b"]);
    expect(resolve("a")).toBe("a");
  });
});

describe("recordRepositoryRename", () => {
  beforeEach(() => {
    upsert.mockReset();
  });

  it("oldNameでupsertする（同じ改名を二重に記録しても作り直すだけ）", async () => {
    upsert.mockResolvedValue({});
    const input = { githubRepositoryId: 1, oldName: "myroom", newName: "kurashio" };
    await recordRepositoryRename(input);
    await recordRepositoryRename(input);
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls[0][0].where).toEqual({ oldName: "myroom" });
  });

  it("名前が同じなら記録しない", async () => {
    await recordRepositoryRename({ githubRepositoryId: 1, oldName: "a", newName: "a" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("失敗しても投げない", async () => {
    upsert.mockImplementation(async () => {
      throw new Error("boom");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      recordRepositoryRename({ githubRepositoryId: 1, oldName: "a", newName: "b" }),
    ).resolves.toBeUndefined();
  });
});
