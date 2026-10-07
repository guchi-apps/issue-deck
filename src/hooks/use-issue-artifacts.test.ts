// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useIssueArtifacts } from "@/hooks/use-issue-artifacts";
import type { Issue } from "@/types/issue";

/**
 * #4112。計画承認欄の「アーティファクトの作成を依頼」は「取得が成功して0件」のときだけ出す。
 * 取得に失敗した空配列を「未作成」と取り違えないよう、`isFailed`で区別できることを固定する。
 */
const issue = { repositoryFullName: "o/r", number: 1 } as Issue;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useIssueArtifacts", () => {
  it("取得が成功して0件なら、読み込み済みで失敗ではない", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ artifacts: [] }) })),
    );
    const { result } = renderHook(() => useIssueArtifacts(issue));
    await waitFor(() => expect(result.current.isLoaded).toBe(true));
    expect(result.current.isFailed).toBe(false);
    expect(result.current.artifacts).toEqual([]);
  });

  it("取得が失敗したら、読み込み済みでも失敗として区別できる", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false, status: 500 })));
    const { result } = renderHook(() => useIssueArtifacts(issue));
    await waitFor(() => expect(result.current.isLoaded).toBe(true));
    expect(result.current.isFailed).toBe(true);
  });
});
