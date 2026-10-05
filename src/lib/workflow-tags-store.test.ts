// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  invalidateWorkflowTags,
  loadWorkflowTags,
  peekWorkflowTags,
  WORKFLOW_TAGS_TTL_MS,
} from "@/lib/workflow-tags-store";

function stubFetch() {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ latest: "workflows/v1", repositories: [] }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  invalidateWorkflowTags();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("loadWorkflowTags", () => {
  it("同時の取得は1回にまとめ、期限内の再取得はキャッシュを返す", async () => {
    const fetchMock = stubFetch();

    await Promise.all([loadWorkflowTags(), loadWorkflowTags()]);
    await loadWorkflowTags();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("期限を過ぎたら取り直す。期限切れの値はpeekで返さない", async () => {
    const fetchMock = stubFetch();
    await loadWorkflowTags();

    vi.setSystemTime(Date.now() + WORKFLOW_TAGS_TTL_MS + 1);
    expect(peekWorkflowTags()).toBeNull();
    await loadWorkflowTags();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("invalidateのあとと強制取得は古い状態を再確認する", async () => {
    const fetchMock = stubFetch();
    await loadWorkflowTags();

    invalidateWorkflowTags();
    await loadWorkflowTags();
    await loadWorkflowTags(true);

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("取得中にinvalidateされたら、その古い結果をキャッシュへ戻さない", async () => {
    stubFetch();
    const pending = loadWorkflowTags();
    invalidateWorkflowTags();
    await pending;

    expect(peekWorkflowTags()).toBeNull();
  });
});
