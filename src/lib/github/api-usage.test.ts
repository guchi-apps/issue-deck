import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getGithubApiUsageSummary,
  loadPersistedBuckets,
  onBucketClosed,
  recordGithubApiCall,
  resetGithubApiUsage,
  toEndpointLabel,
  USAGE_WINDOW_MS,
  withGithubApiFeature,
} from "@/lib/github/api-usage";

const NOW = new Date(2026, 7, 4, 12, 0, 0).getTime();
const COMMENTS_URL = "https://api.github.com/repos/m-guchi/issue-deck/issues/123/comments?per_page=100";
const RUN_URL = "https://api.github.com/repos/m-guchi/issue-deck/actions/runs/456";

describe("toEndpointLabel", () => {
  it("owner/repoと数値IDをプレースホルダに置き換える", () => {
    expect(toEndpointLabel(COMMENTS_URL)).toBe("/repos/{owner}/{repo}/issues/{n}/comments");
    expect(toEndpointLabel(RUN_URL)).toBe("/repos/{owner}/{repo}/actions/runs/{n}");
  });

  it("コミットSHAもプレースホルダに置き換える", () => {
    expect(
      toEndpointLabel(
        "https://api.github.com/repos/m-guchi/issue-deck/commits/0123456789abcdef0123456789abcdef01234567/check-runs",
      ),
    ).toBe("/repos/{owner}/{repo}/commits/{sha}/check-runs");
  });

  it("workflowのファイル名は識別に役立つためそのまま残す", () => {
    expect(
      toEndpointLabel(
        "https://api.github.com/repos/m-guchi/issue-deck/actions/workflows/deploy.yml/runs?per_page=1",
      ),
    ).toBe("/repos/{owner}/{repo}/actions/workflows/deploy.yml/runs");
  });

  it("repos配下でないパスはそのまま扱う", () => {
    expect(toEndpointLabel("https://api.github.com/rate_limit")).toBe("/rate_limit");
    expect(toEndpointLabel("https://api.github.com/installation/repositories?per_page=100&page=1")).toBe(
      "/installation/repositories",
    );
  });
});

describe("githubApiUsage", () => {
  beforeEach(() => {
    resetGithubApiUsage();
  });

  it("用途別・エンドポイント別に呼び出し回数を集計する", () => {
    recordGithubApiCall(COMMENTS_URL, { feature: "issue_list_workflow_running", now: NOW });
    recordGithubApiCall(RUN_URL, { feature: "issue_list_workflow_running", now: NOW });
    recordGithubApiCall(RUN_URL, { feature: "issue_list_workflow_running", now: NOW });
    recordGithubApiCall(COMMENTS_URL, { feature: "issue_comments", now: NOW });

    const summary = getGithubApiUsageSummary(NOW);

    expect(summary.totalCurrentHour).toBe(4);
    expect(summary.totalLast24h).toBe(4);
    // 呼び出しが多い用途が先頭に来る
    expect(summary.features.map((feature) => feature.key)).toEqual([
      "issue_list_workflow_running",
      "issue_comments",
    ]);
    expect(summary.features[0].label).toBe("一覧の実行状況ポーリング");
    expect(summary.features[0].endpoints).toEqual([
      { endpoint: "/repos/{owner}/{repo}/actions/runs/{n}", currentHour: 2, last24h: 2 },
      { endpoint: "/repos/{owner}/{repo}/issues/{n}/comments", currentHour: 1, last24h: 1 },
    ]);
  });

  it("現在の正時より前の呼び出しは直近1時間（正時起点）に含めず、24時間には含める", () => {
    recordGithubApiCall(RUN_URL, { feature: "sync", now: NOW - 3 * 60 * 60_000 });
    recordGithubApiCall(RUN_URL, { feature: "sync", now: NOW });

    const summary = getGithubApiUsageSummary(NOW);

    expect(summary.totalCurrentHour).toBe(1);
    expect(summary.totalLast24h).toBe(2);
    expect(summary.currentHourStartedAt).toBe(NOW);
  });

  it("直近1時間はローリング60分ではなく正時起点の固定ウィンドウで数える（正時をまたぐとリセットされる）", () => {
    // NOWちょうどの5分前（前の正時からの経過分。ローリング60分では含まれるが、正時起点では含まれない）
    recordGithubApiCall(RUN_URL, { feature: "sync", now: NOW - 5 * 60_000 });
    // NOWちょうど（現在の正時の開始時刻そのもの。ウィンドウに含む）
    recordGithubApiCall(RUN_URL, { feature: "sync", now: NOW });

    const summary = getGithubApiUsageSummary(NOW);

    expect(summary.totalCurrentHour).toBe(1);
    expect(summary.totalLast24h).toBe(2);
  });

  it("同じ正時の中の呼び出しはすべて直近1時間として数える", () => {
    const midHour = NOW + 30 * 60_000;
    recordGithubApiCall(RUN_URL, { feature: "sync", now: NOW });
    recordGithubApiCall(RUN_URL, { feature: "sync", now: midHour });

    const summary = getGithubApiUsageSummary(midHour);

    expect(summary.totalCurrentHour).toBe(2);
    expect(summary.currentHourStartedAt).toBe(NOW);
  });

  it("24時間より前の呼び出しは集計から外れる", () => {
    recordGithubApiCall(RUN_URL, { feature: "sync", now: NOW - USAGE_WINDOW_MS - 60_000 });
    recordGithubApiCall(RUN_URL, { feature: "sync", now: NOW });

    expect(getGithubApiUsageSummary(NOW).totalLast24h).toBe(1);
  });

  it("記録が無ければ空の集計を返す", () => {
    const summary = getGithubApiUsageSummary(NOW);

    expect(summary.features).toEqual([]);
    expect(summary.totalCurrentHour).toBe(0);
    expect(summary.totalLast24h).toBe(0);
    expect(summary.measuringSince).toBe(NOW);
  });

  it("withGithubApiFeatureの文脈で呼び出した場合はその用途に計上する", async () => {
    await withGithubApiFeature("release_status", async () => {
      recordGithubApiCall(RUN_URL, { now: NOW });
    });

    expect(getGithubApiUsageSummary(NOW).features[0].key).toBe("release_status");
  });

  it("用途の文脈が無い場合はotherに計上する", () => {
    recordGithubApiCall(RUN_URL, { now: NOW });

    expect(getGithubApiUsageSummary(NOW).features[0].key).toBe("other");
  });
});

describe("onBucketClosed", () => {
  beforeEach(() => {
    resetGithubApiUsage();
  });

  it("バケットが繰り上がるとき、直前に閉じたバケットの内容を通知する", () => {
    const listener = vi.fn();
    onBucketClosed(listener);

    recordGithubApiCall(RUN_URL, { feature: "sync", now: NOW });
    recordGithubApiCall(COMMENTS_URL, { feature: "sync", now: NOW });
    expect(listener).not.toHaveBeenCalled();

    // 次の5分バケットへ進むタイミングで、直前のバケットが閉じたとして通知される
    const nextBucket = NOW + 5 * 60_000;
    recordGithubApiCall(RUN_URL, { feature: "issue_comments", now: nextBucket });

    expect(listener).toHaveBeenCalledTimes(1);
    const closed = listener.mock.calls[0][0];
    expect(closed.startedAt).toBe(NOW);
    expect(closed.entries).toEqual(
      expect.arrayContaining([
        { feature: "sync", endpoint: "/repos/{owner}/{repo}/actions/runs/{n}", count: 1 },
        { feature: "sync", endpoint: "/repos/{owner}/{repo}/issues/{n}/comments", count: 1 },
      ]),
    );
  });

  it("時刻が巻き戻ったバックデート挿入では、既存の最新バケットを閉じたとみなさない", () => {
    const listener = vi.fn();
    onBucketClosed(listener);

    recordGithubApiCall(RUN_URL, { feature: "sync", now: NOW });
    recordGithubApiCall(RUN_URL, { feature: "sync", now: NOW - 5 * 60_000 });

    expect(listener).not.toHaveBeenCalled();
  });

  // #2360。Next.jsは`instrumentation.ts`とRoute Handlerを別バンドルへ入れるため、このモジュールの
  // 実体が2つできる。集計とリスナーを`globalThis`へ載せていないと、起動時に登録した永続化の
  // リスナーが記録側から見えず、`GithubApiUsageBucket`へ1行も書かれない。
  // `vi.resetModules()`での読み直しが、その「実体が2つ」を同じ形で再現する。
  it("モジュールが別インスタンスとして読み直されても、登録済みのリスナーへ通知が届く", async () => {
    const listener = vi.fn();
    onBucketClosed(listener);

    vi.resetModules();
    const reimported = await import("@/lib/github/api-usage");
    expect(reimported.recordGithubApiCall).not.toBe(recordGithubApiCall);

    reimported.recordGithubApiCall(RUN_URL, { feature: "sync", now: NOW });
    reimported.recordGithubApiCall(RUN_URL, { feature: "sync", now: NOW + 5 * 60_000 });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].startedAt).toBe(NOW);

    // 読み直した側で記録した内容が、元のインスタンスの集計からも見える
    expect(getGithubApiUsageSummary(NOW + 5 * 60_000).totalLast24h).toBe(2);
  });
});

describe("loadPersistedBuckets", () => {
  beforeEach(() => {
    resetGithubApiUsage();
  });

  it("DBから読み込んだバケットをメモリの集計へ反映する", () => {
    loadPersistedBuckets(
      [
        {
          startedAt: NOW - 60 * 60_000,
          entries: [{ feature: "sync", endpoint: "/repos/{owner}/{repo}/actions/runs/{n}", count: 3 }],
        },
      ],
      NOW,
    );

    const summary = getGithubApiUsageSummary(NOW);
    expect(summary.totalLast24h).toBe(3);
    expect(summary.measuringSince).toBe(NOW - 60 * 60_000);
  });

  it("既にメモリ上にある集計とマージする（加算する）", () => {
    recordGithubApiCall(RUN_URL, { feature: "sync", now: NOW });
    loadPersistedBuckets(
      [{ startedAt: NOW, entries: [{ feature: "sync", endpoint: "/repos/{owner}/{repo}/actions/runs/{n}", count: 2 }] }],
      NOW,
    );

    expect(getGithubApiUsageSummary(NOW).totalLast24h).toBe(3);
  });

  it("24時間より古いバケットは読み込み後すぐに刈り取られる", () => {
    loadPersistedBuckets(
      [
        {
          startedAt: NOW - USAGE_WINDOW_MS - 60_000,
          entries: [{ feature: "sync", endpoint: "/repos/{owner}/{repo}/actions/runs/{n}", count: 5 }],
        },
      ],
      NOW,
    );

    expect(getGithubApiUsageSummary(NOW).totalLast24h).toBe(0);
  });
});
