import { describe, expect, it, vi } from "vitest";

import { settlePullRequestMergeable } from "@/lib/github/pull-requests-api";

type Pr = { state: string; merged?: boolean; mergeable: boolean | null };
const sleep = vi.fn(async () => {});

describe("settlePullRequestMergeable（#5178）", () => {
  it("判定済みなら取り直さない", async () => {
    const refetch = vi.fn<() => Promise<Pr>>();
    const result = await settlePullRequestMergeable<Pr>({ state: "open", mergeable: true }, refetch, { sleep });
    expect(result.mergeable).toBe(true);
    expect(refetch).not.toHaveBeenCalled();
  });

  it("closed・マージ済みは未判定でも取り直さない", async () => {
    const refetch = vi.fn<() => Promise<Pr>>();
    await settlePullRequestMergeable<Pr>({ state: "closed", mergeable: null }, refetch, { sleep });
    await settlePullRequestMergeable<Pr>({ state: "open", merged: true, mergeable: null }, refetch, { sleep });
    expect(refetch).not.toHaveBeenCalled();
  });

  it("未判定なら判定が出た時点で止める", async () => {
    const refetch = vi.fn<() => Promise<Pr>>().mockResolvedValueOnce({ state: "open", mergeable: false });
    const result = await settlePullRequestMergeable<Pr>({ state: "open", mergeable: null }, refetch, { sleep });
    expect(result.mergeable).toBe(false);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("上限まで取り直しても未判定ならnullのまま返す", async () => {
    const refetch = vi.fn<() => Promise<Pr>>().mockResolvedValue({ state: "open", mergeable: null });
    const result = await settlePullRequestMergeable<Pr>({ state: "open", mergeable: null }, refetch, { sleep, attempts: 2 });
    expect(result.mergeable).toBeNull();
    expect(refetch).toHaveBeenCalledTimes(2);
  });
});
