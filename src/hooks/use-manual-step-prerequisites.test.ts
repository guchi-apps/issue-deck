// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useManualStepPrerequisites } from "@/hooks/use-manual-step-prerequisites";
import type { Issue } from "@/types/issue";

const REPO = "guchi-apps/issue-deck";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: String(overrides.number ?? 1),
    number: 1,
    title: "サンプルIssue",
    body: "",
    state: "open",
    stateReason: null,
    repositoryFullName: REPO,
    repositoryPrivate: false,
    repositoryArchived: false,
    author: { login: "author-user" },
    assignee: null,
    labels: [],
    milestone: null,
    commentCount: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    closedAt: null,
    checkUserLabeledAt: null,
    qaAnswerPendingAt: null,
    lastCommentAt: null,
    dispatchPendingAt: null,
    projectStatus: null,
    htmlUrl: `https://github.com/${REPO}/issues/${overrides.number ?? 1}`,
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: 0,
    ...overrides,
  };
}

function manualStep(body: string): Issue {
  return makeIssue({
    number: 1712,
    title: "[手作業] VPS: .envを更新する",
    labels: [{ name: "71.manual-step", color: "d876e3", description: null }],
    body,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useManualStepPrerequisites", () => {
  it("Issueキャッシュだけで解決できるならGitHub APIを呼ばない", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const origin = makeIssue({ number: 1690, projectStatus: "Develop" });
    const issue = manualStep("## 関連\n\n- 起点Issue: #1690\n");

    const { result } = renderHook(() => useManualStepPrerequisites(issue, [issue, origin]));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.prerequisites).toHaveLength(1);
    expect(result.current.summary?.message).toBe(
      "まだ実行できません。#1690 がmainへ反映されるのを待ってください。",
    );
  });

  it("Issueとして見つからない番号だけPRとして引く", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        pullRequests: [
          {
            number: 1704,
            htmlUrl: `https://github.com/${REPO}/pull/1704`,
            title: "デプロイ完了を通知する",
            state: "closed",
            draft: false,
            merged: true,
            ciStatus: null,
            linkedIssueNumber: null,
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const done = makeIssue({ number: 1690, projectStatus: "Done", state: "closed" });
    const issue = manualStep("## 前提条件\n\n- #1690 と #1704 の完了後\n");

    const { result } = renderHook(() => useManualStepPrerequisites(issue, [issue, done]));

    await waitFor(() => {
      expect(result.current.prerequisites[1]?.stage).toBe("merged");
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "/api/issues/pull-requests?owner=guchi-apps&repo=issue-deck&numbers=1704",
    );
    expect(result.current.summary?.message).toBe(
      "前提はすべて満たされています。いま実行できます。",
    );
  });

  it("手作業Issueでなければ何も出さない", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const issue = makeIssue({ number: 1712, body: "## 関連\n\n- 起点Issue: #1690\n" });

    const { result } = renderHook(() => useManualStepPrerequisites(issue, [issue]));

    expect(result.current.prerequisites).toEqual([]);
    expect(result.current.summary).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
