import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const githubGraphql = vi.fn();
const findMany = vi.fn();

vi.mock("@/lib/github/graphql", () => ({
  get githubGraphql() {
    return githubGraphql;
  },
}));
vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: async () => "token" }));
vi.mock("@/lib/db", () => ({ db: { repository: { findMany: (...args: unknown[]) => findMany(...args) } } }));

import { collectReviewGates } from "@/lib/github/review-gates";

const CALLER = readFileSync(path.join(process.cwd(), ".github/workflows/claude-review-develop.yml"), "utf8");

function reviewContexts(conclusion: string) {
  const suite = { workflowRun: { workflow: { resourcePath: "/o/r/actions/workflows/claude-review-develop.yml" } } };
  return [{ __typename: "CheckRun", name: "review / claude-review", status: "COMPLETED", conclusion, checkSuite: suite }];
}

/** 番号の新しい順に`issue-<n>`のPRを並べる */
function pullRequests(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const number = 100 - i;
    return { number, url: `https://github.com/guchi-apps/app/pull/${number}`, headRefName: `issue-${number}` };
  });
}

describe("collectReviewGates", () => {
  beforeEach(() => {
    githubGraphql.mockReset();
    findMany.mockReset();
    findMany.mockResolvedValue([
      {
        fullName: "guchi-apps/app",
        ownerLogin: "guchi-apps",
        name: "app",
        defaultBranch: "main",
        installation: { installationId: 1 },
      },
    ]);
  });

  it("チェック集約はPR10件ずつに分けて読む（#2963。まとめると GitHub が打ち切る）", async () => {
    githubGraphql.mockImplementation(async (_token: string, query: string, variables: Record<string, unknown>, label: string) => {
      if (label === "Claudeレビューの雛形取得") return { repository: null };
      if (label === "Claudeレビューの実行条件の取得") {
        // PR一覧のクエリではチェックを読まない
        expect(query).not.toContain("statusCheckRollup");
        return {
          r0: {
            developCaller: { text: CALLER },
            defaultCaller: null,
            pullRequests: { nodes: [...pullRequests(25), { number: 1, url: "u", headRefName: "release/v1" }] },
          },
        };
      }
      const count = Object.keys(variables).filter((key) => key.startsWith("number")).length;
      expect(count).toBeLessThanOrEqual(10);
      return Object.fromEntries(
        Array.from({ length: count }, (_, i) => [
          `p${i}`,
          {
            pullRequest: {
              commits: {
                nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: reviewContexts("SUCCESS") } } } }],
              },
            },
          },
        ]),
      );
    });

    const overview = await collectReviewGates("user");

    const rollupCalls = githubGraphql.mock.calls.filter(([, , , label]) => label === "Claudeレビューの実行状況の取得");
    expect(rollupCalls).toHaveLength(3);
    const [repository] = overview.repositories;
    expect(repository.outcomesAvailable).toBe(true);
    expect(repository.outcomes).toHaveLength(20);
    // 古い順で、新しい20件を採る
    expect(repository.outcomes[0].number).toBe(81);
    expect(repository.outcomes.at(-1)?.number).toBe(100);
  });

  it("チェック集約の取得に2回失敗しても例外にせず、その行の実行状況を「取得できない」にする", async () => {
    githubGraphql.mockImplementation(async (_token: string, _query: string, _variables: unknown, label: string) => {
      if (label === "Claudeレビューの雛形取得") return { repository: null };
      if (label === "Claudeレビューの実行条件の取得") {
        return { r0: { developCaller: { text: CALLER }, defaultCaller: null, pullRequests: { nodes: pullRequests(3) } } };
      }
      throw new Error("GitHub GraphQL request failed: 502");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const overview = await collectReviewGates("user");

    const rollupCalls = githubGraphql.mock.calls.filter(([, , , label]) => label === "Claudeレビューの実行状況の取得");
    expect(rollupCalls).toHaveLength(2);
    expect(overview.repositories).toHaveLength(1);
    expect(overview.repositories[0].outcomesAvailable).toBe(false);
  });

  it("1回目だけ落ちたチェック集約は投げ直して数える", async () => {
    let rollupAttempts = 0;
    githubGraphql.mockImplementation(async (_token: string, _query: string, _variables: unknown, label: string) => {
      if (label === "Claudeレビューの雛形取得") return { repository: null };
      if (label === "Claudeレビューの実行条件の取得") {
        return { r0: { developCaller: { text: CALLER }, defaultCaller: null, pullRequests: { nodes: pullRequests(1) } } };
      }
      rollupAttempts += 1;
      if (rollupAttempts === 1) throw new Error("GitHub GraphQL request failed: 502");
      return {
        p0: {
          pullRequest: {
            commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: reviewContexts("SKIPPED") } } } }] },
          },
        },
      };
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const overview = await collectReviewGates("user");

    expect(overview.repositories[0].outcomesAvailable).toBe(true);
    expect(overview.repositories[0].outcomes).toEqual([
      { number: 100, url: "https://github.com/guchi-apps/app/pull/100", outcome: "skipped" },
    ]);
  });
});
