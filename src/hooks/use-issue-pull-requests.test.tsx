// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useIssuePullRequests } from "@/hooks/use-issue-pull-requests";
import { AI_REVIEW_NONE } from "@/lib/github/check-rollup";
import type { PullRequestLink } from "@/lib/github/pull-request-link";
import type { IssuePullRequest } from "@/types/pull-request";

/**
 * #2352。マージボタンを取得の前後で出し分けるために、フックが「まだ一度も取得が終わって
 * いない」を持つようになったぶんの取り決め。
 *
 * 要点は**取得に失敗してもfalseになる**こと。取得中のまま据え置くと、取れなかっただけの
 * PRでマージボタンが永久に押せなくなる（#1339の「取得失敗でマージ不能にしない」を壊す）。
 */
function link(number: number): PullRequestLink {
  return { number, url: `https://github.com/guchi-apps/issue-deck/pull/${number}` };
}

function pullRequest(number: number): IssuePullRequest {
  return {
    number,
    htmlUrl: `https://github.com/guchi-apps/issue-deck/pull/${number}`,
    title: "対応PRのタイトル",
    state: "open",
    draft: false,
    merged: false,
    ciStatus: "success",
    mergeJudgement: { state: "settled", step: null, runUrl: null, aiReview: AI_REVIEW_NONE },
    mergeable: true,
    repairRun: null,
    linkedIssueNumber: 2352,
  };
}

/** 応答を保留したまま返す。取得中の状態を観測するため */
function deferredFetch() {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetchMock = vi.fn(async () => {
    await gate;
    return { ok: true, json: async () => ({ pullRequests: [pullRequest(2360)] }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return { release: () => release?.() };
}

beforeEach(() => {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useIssuePullRequests", () => {
  it("取得が終わるまではisLoadingDetailsがtrueで、終わるとfalseになる（#2352）", async () => {
    const { release } = deferredFetch();
    const { result } = renderHook(() =>
      useIssuePullRequests("guchi-apps/issue-deck", 2352, [link(2360)], false),
    );

    expect(result.current.isLoadingDetails).toBe(true);
    expect(result.current.pullRequests).toEqual([]);

    await act(async () => {
      release();
    });

    await waitFor(() => {
      expect(result.current.isLoadingDetails).toBe(false);
    });
    expect(result.current.pullRequests).toHaveLength(1);
  });

  it("取得に失敗してもisLoadingDetailsはfalseになる（取得失敗でマージ不能にしない）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
    const { result } = renderHook(() =>
      useIssuePullRequests("guchi-apps/issue-deck", 2352, [link(2360)], false),
    );

    await waitFor(() => {
      expect(result.current.isLoadingDetails).toBe(false);
    });
    expect(result.current.pullRequests).toEqual([]);
  });

  it("対応PRが1件も無いIssueでは取得中にしない", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ pullRequests: [] }) })),
    );
    const { result } = renderHook(() =>
      useIssuePullRequests("guchi-apps/issue-deck", 2352, [], false),
    );

    expect(result.current.isLoadingDetails).toBe(false);
  });

  it("別のIssueへ切り替えたら、そのIssueぶんの取得が終わるまで取得中に戻る（#2352）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ pullRequests: [] }) })),
    );
    const { result, rerender } = renderHook(
      ({ issueNumber, links }: { issueNumber: number; links: PullRequestLink[] }) =>
        useIssuePullRequests("guchi-apps/issue-deck", issueNumber, links, false),
      { initialProps: { issueNumber: 2352, links: [link(2360)] } },
    );

    await waitFor(() => {
      expect(result.current.isLoadingDetails).toBe(false);
    });

    rerender({ issueNumber: 2340, links: [link(2341)] });
    expect(result.current.isLoadingDetails).toBe(true);
  });
});
