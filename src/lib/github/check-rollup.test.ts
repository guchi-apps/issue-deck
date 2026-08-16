import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchCheckRollup, fetchPullRequestRollup } from "@/lib/github/check-rollup";

function stubGraphql(body: unknown, status = 200) {
  const calls: { url: string; body: string }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body ?? "" });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

function rollupResponse(rollup: unknown) {
  return { data: { repository: { object: { statusCheckRollup: rollup } } } };
}

/** GitHub Actions発のcheck-runノード。`workflowFile`はcallerのファイル名（#1799） */
function checkRun(status: string, conclusion: string | null, workflowFile: string) {
  return {
    __typename: "CheckRun",
    status,
    conclusion,
    checkSuite: {
      workflowRun: {
        workflow: { resourcePath: `/owner/repo/actions/workflows/${workflowFile}` },
      },
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchCheckRollup", () => {
  it("refを`expression`として渡し、GraphQLへ1回だけ問い合わせる", async () => {
    const calls = stubGraphql(
      rollupResponse({ state: "SUCCESS", contexts: { totalCount: 0, nodes: [] } }),
    );

    await fetchCheckRollup("owner", "repo", "5dd3448", "token");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.github.com/graphql");
    expect(JSON.parse(calls[0]?.body ?? "{}").variables).toEqual({
      owner: "owner",
      name: "repo",
      expression: "5dd3448",
    });
  });

  it("GraphQLの大文字の列挙をcheck-runと同じ小文字へ正規化する", async () => {
    stubGraphql(
      rollupResponse({
        state: "PENDING",
        contexts: {
          totalCount: 2,
          nodes: [
            { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null },
            { __typename: "CheckRun", status: "COMPLETED", conclusion: "CANCELLED" },
          ],
        },
      }),
    );

    await expect(fetchCheckRollup("owner", "repo", "develop", "token")).resolves.toEqual({
      state: "pending",
      checks: [
        { status: "in_progress", conclusion: null },
        { status: "completed", conclusion: "cancelled" },
      ],
    });
  });

  it("commit status（StatusContext）はcheck-runの形へ寄せる", async () => {
    stubGraphql(
      rollupResponse({
        state: "PENDING",
        contexts: {
          totalCount: 3,
          nodes: [
            { __typename: "StatusContext", state: "SUCCESS" },
            { __typename: "StatusContext", state: "ERROR" },
            { __typename: "StatusContext", state: "PENDING" },
          ],
        },
      }),
    );

    await expect(fetchCheckRollup("owner", "repo", "develop", "token")).resolves.toEqual({
      state: "pending",
      checks: [
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "failure" },
        { status: "pending", conclusion: null },
      ],
    });
  });

  it("運用自動化（レビュー・自動マージ等）のcheck-runは集約から外す（#1799）", async () => {
    stubGraphql(
      rollupResponse({
        state: "PENDING",
        contexts: {
          totalCount: 3,
          nodes: [
            checkRun("COMPLETED", "SUCCESS", "ci.yml"),
            // CIの完了を待って動くジョブ。数えるとPRが開いている間ずっと「CI実行中」になる。
            checkRun("IN_PROGRESS", null, "claude-review-develop.yml"),
            checkRun("QUEUED", null, "issue-labels.yml"),
          ],
        },
      }),
    );

    await expect(fetchCheckRollup("owner", "repo", "develop", "token")).resolves.toEqual({
      state: "pending",
      checks: [{ status: "completed", conclusion: "success" }],
    });
  });

  it("ワークフローが分からないチェック（外部CI・他のアプリ）は数える", async () => {
    stubGraphql(
      rollupResponse({
        state: "PENDING",
        contexts: {
          totalCount: 3,
          nodes: [
            checkRun("COMPLETED", "SUCCESS", "ci.yml"),
            checkRun("IN_PROGRESS", null, "claude-review-develop.yml"),
            { __typename: "StatusContext", state: "PENDING" },
          ],
        },
      }),
    );

    await expect(fetchCheckRollup("owner", "repo", "develop", "token")).resolves.toEqual({
      state: "pending",
      checks: [
        { status: "completed", conclusion: "success" },
        { status: "pending", conclusion: null },
      ],
    });
  });

  it("運用自動化しか無いリポジトリでは、除く前のチェックをそのまま返す", async () => {
    stubGraphql(
      rollupResponse({
        state: "SUCCESS",
        contexts: {
          totalCount: 2,
          nodes: [
            checkRun("COMPLETED", "SUCCESS", "issue-labels.yml"),
            checkRun("COMPLETED", "SKIPPED", "claude-review-develop.yml"),
          ],
        },
      }),
    );

    await expect(fetchCheckRollup("owner", "repo", "develop", "token")).resolves.toEqual({
      state: "success",
      checks: [
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "skipped" },
      ],
    });
  });

  it("チェックが100件を超える場合は1件ずつ返さず、`state`だけを返す", async () => {
    stubGraphql(
      rollupResponse({
        state: "SUCCESS",
        contexts: {
          totalCount: 218,
          nodes: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
        },
      }),
    );

    await expect(fetchCheckRollup("owner", "repo", "develop", "token")).resolves.toEqual({
      state: "success",
      checks: null,
    });
  });

  it("チェックが1件も無いrefでは空の一覧を返す", async () => {
    stubGraphql(rollupResponse(null));

    await expect(fetchCheckRollup("owner", "repo", "develop", "token")).resolves.toEqual({
      state: null,
      checks: [],
    });
  });

  it("GraphQLがエラーを返した場合はnullを返す（例外にしない）", async () => {
    stubGraphql({ errors: [{ message: "Resource not accessible by integration" }] });

    await expect(fetchCheckRollup("owner", "repo", "develop", "token")).resolves.toBeNull();
  });

  it("HTTPが失敗した場合もnullを返す", async () => {
    stubGraphql({}, 502);

    await expect(fetchCheckRollup("owner", "repo", "develop", "token")).resolves.toBeNull();
  });
});

function pullRequestResponse(pullRequest: unknown) {
  return { data: { repository: { pullRequest } } };
}

function pullRequestWithRollup(mergeable: string | null, rollup: unknown) {
  return pullRequestResponse({
    mergeable,
    commits: { nodes: [{ commit: { statusCheckRollup: rollup } }] },
  });
}

describe("fetchPullRequestRollup", () => {
  it("CI状態とコンフリクト有無をGraphQL 1回でまとめて取る（#1742）", async () => {
    const calls = stubGraphql(
      pullRequestWithRollup("CONFLICTING", {
        state: "SUCCESS",
        contexts: {
          totalCount: 1,
          nodes: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
        },
      }),
    );

    await expect(fetchPullRequestRollup("owner", "repo", 42, "token")).resolves.toEqual({
      rollup: { state: "success", checks: [{ status: "completed", conclusion: "success" }] },
      mergeable: false,
    });
    // ref経由（`fetchCheckRollup`）と足して2回にならないこと自体がこの関数の目的。
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]?.body ?? "{}").variables).toEqual({
      owner: "owner",
      name: "repo",
      number: 42,
    });
  });

  it("`MERGEABLE`はtrue、`UNKNOWN`（判定中）はnullにする", async () => {
    stubGraphql(pullRequestWithRollup("MERGEABLE", null));
    await expect(fetchPullRequestRollup("owner", "repo", 1, "token")).resolves.toEqual({
      rollup: { state: null, checks: [] },
      mergeable: true,
    });

    stubGraphql(pullRequestWithRollup("UNKNOWN", null));
    await expect(fetchPullRequestRollup("owner", "repo", 1, "token")).resolves.toEqual({
      rollup: { state: null, checks: [] },
      mergeable: null,
    });
  });

  it("コミットが取れない場合もチェック無しとして扱う", async () => {
    stubGraphql(pullRequestResponse({ mergeable: "MERGEABLE", commits: { nodes: [] } }));

    await expect(fetchPullRequestRollup("owner", "repo", 1, "token")).resolves.toEqual({
      rollup: { state: null, checks: [] },
      mergeable: true,
    });
  });

  it("取得に失敗した場合は例外にせず未取得として返す", async () => {
    stubGraphql({ errors: [{ message: "Resource not accessible by integration" }] });

    await expect(fetchPullRequestRollup("owner", "repo", 1, "token")).resolves.toEqual({
      rollup: null,
      mergeable: null,
    });
  });

  it("PRが見つからない場合も未取得として返す", async () => {
    stubGraphql(pullRequestResponse(null));

    await expect(fetchPullRequestRollup("owner", "repo", 1, "token")).resolves.toEqual({
      rollup: null,
      mergeable: null,
    });
  });
});
