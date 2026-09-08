// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useIssuePullRequests } from "@/hooks/use-issue-pull-requests";
import { AI_REVIEW_NONE } from "@/lib/github/check-rollup";
import {
  ISSUE_PULL_REQUEST_CONFLICT_POLL_INTERVAL_MS,
  ISSUE_PULL_REQUEST_POLL_INTERVAL_MS,
} from "@/lib/issue-pull-requests";
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
    reviewVerdict: null,
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
  vi.useRealTimers();
});

/** 呼ばれた順に応答を返す。最後の応答は以降ずっと返し続ける */
function sequencedFetch(responses: IssuePullRequest[][]) {
  const queue = [...responses];
  let last = queue[queue.length - 1] ?? [];
  const fetchMock = vi.fn(async () => {
    if (queue.length > 0) last = queue.shift() as IssuePullRequest[];
    return { ok: true, json: async () => ({ pullRequests: last }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function conflicting(number: number): IssuePullRequest {
  return { ...pullRequest(number), mergeable: false };
}

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

  it("コンフリクトしている間は1分ごとに取り直し、解消された回で止まる（#2915）", async () => {
    vi.useFakeTimers();
    // 3回目の取得で解消される。以降は解消済みの応答を返し続ける
    const fetchMock = sequencedFetch([
      [conflicting(2360)],
      [conflicting(2360)],
      [pullRequest(2360)],
    ]);

    const { result } = renderHook(() =>
      // マージ待ちでもPR待ちでもないIssue（進捗が`Develop PR`以外に取り残された状態）
      useIssuePullRequests("guchi-apps/issue-deck", 2352, [link(2360)], false),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.pullRequests[0]?.mergeable).toBe(false);

    // コンフリクトだけが理由のときは20秒では飛ばない
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ISSUE_PULL_REQUEST_POLL_INTERVAL_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // `pollWhileCiRunning`が偽でも、コンフリクトを見つけたら1分間隔で取り直しが始まる
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        ISSUE_PULL_REQUEST_CONFLICT_POLL_INTERVAL_MS - ISSUE_PULL_REQUEST_POLL_INTERVAL_MS,
      );
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.pullRequests[0]?.mergeable).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ISSUE_PULL_REQUEST_CONFLICT_POLL_INTERVAL_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // 再読み込みなしに「コンフリクトあり」が消える
    expect(result.current.pullRequests[0]?.mergeable).toBe(true);

    // 動くものが無くなったので、以降はGitHub APIを叩かない
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ISSUE_PULL_REQUEST_CONFLICT_POLL_INTERVAL_MS * 3);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("CI実行中からコンフリクトだけが残る状態へ移ると、間隔が20秒から1分へ切り替わる（#2915）", async () => {
    vi.useFakeTimers();
    const fetchMock = sequencedFetch([
      [{ ...pullRequest(2360), ciStatus: "in_progress" as const }],
      [conflicting(2360)],
    ]);

    renderHook(() => useIssuePullRequests("guchi-apps/issue-deck", 2352, [link(2360)], true));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // CI実行中は20秒で飛ぶ
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ISSUE_PULL_REQUEST_POLL_INTERVAL_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // コンフリクトだけになったので、次はもう20秒では飛ばない
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ISSUE_PULL_REQUEST_POLL_INTERVAL_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        ISSUE_PULL_REQUEST_CONFLICT_POLL_INTERVAL_MS - ISSUE_PULL_REQUEST_POLL_INTERVAL_MS,
      );
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("コンフリクトも無く状態が確定していれば取り直さない", async () => {
    vi.useFakeTimers();
    const fetchMock = sequencedFetch([[pullRequest(2360)]]);

    renderHook(() => useIssuePullRequests("guchi-apps/issue-deck", 2352, [link(2360)], false));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ISSUE_PULL_REQUEST_CONFLICT_POLL_INTERVAL_MS * 3);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
