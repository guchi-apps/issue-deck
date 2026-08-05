import { beforeEach, describe, expect, it } from "vitest";

import {
  getGithubApiUsageSummary,
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
    resetGithubApiUsage(NOW);
  });

  it("用途別・エンドポイント別に呼び出し回数を集計する", () => {
    recordGithubApiCall(COMMENTS_URL, { feature: "issue_list_workflow_running", now: NOW });
    recordGithubApiCall(RUN_URL, { feature: "issue_list_workflow_running", now: NOW });
    recordGithubApiCall(RUN_URL, { feature: "issue_list_workflow_running", now: NOW });
    recordGithubApiCall(COMMENTS_URL, { feature: "issue_comments", now: NOW });

    const summary = getGithubApiUsageSummary(NOW);

    expect(summary.totalLastHour).toBe(4);
    expect(summary.totalLast24h).toBe(4);
    // 呼び出しが多い用途が先頭に来る
    expect(summary.features.map((feature) => feature.key)).toEqual([
      "issue_list_workflow_running",
      "issue_comments",
    ]);
    expect(summary.features[0].label).toBe("一覧の実行状況ポーリング");
    expect(summary.features[0].endpoints).toEqual([
      { endpoint: "/repos/{owner}/{repo}/actions/runs/{n}", lastHour: 2, last24h: 2 },
      { endpoint: "/repos/{owner}/{repo}/issues/{n}/comments", lastHour: 1, last24h: 1 },
    ]);
  });

  it("1時間より前の呼び出しは直近1時間に含めず、24時間には含める", () => {
    recordGithubApiCall(RUN_URL, { feature: "sync", now: NOW - 3 * 60 * 60_000 });
    recordGithubApiCall(RUN_URL, { feature: "sync", now: NOW });

    const summary = getGithubApiUsageSummary(NOW);

    expect(summary.totalLastHour).toBe(1);
    expect(summary.totalLast24h).toBe(2);
  });

  it("24時間より前の呼び出しは集計から外れる", () => {
    recordGithubApiCall(RUN_URL, { feature: "sync", now: NOW - USAGE_WINDOW_MS - 60_000 });
    recordGithubApiCall(RUN_URL, { feature: "sync", now: NOW });

    expect(getGithubApiUsageSummary(NOW).totalLast24h).toBe(1);
  });

  it("記録が無ければ空の集計を返す", () => {
    const summary = getGithubApiUsageSummary(NOW);

    expect(summary.features).toEqual([]);
    expect(summary.totalLastHour).toBe(0);
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
