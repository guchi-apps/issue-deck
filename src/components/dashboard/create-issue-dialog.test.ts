import { describe, expect, it } from "vitest";

import {
  groupRepositoriesByWorkflowStatus,
  mergeSuggestedLabels,
  resolveKindRepository,
} from "@/components/dashboard/create-issue-dialog";
import { PLAN_REQUIRED_LABEL } from "@/lib/github/approval-labels";
import type { ConnectedRepository } from "@/types/repository";

function makeRepo(overrides: Partial<ConnectedRepository>): ConnectedRepository {
  return {
    id: overrides.fullName ?? "owner/repo",
    name: "repo",
    fullName: "owner/repo",
    private: false,
    archived: false,
    hasClaudeWorkflow: false,
    hasLocalStartScript: true,
    hidden: false,
    favorite: false,
    ...overrides,
  };
}

describe("mergeSuggestedLabels", () => {
  it("これまでに選択済みのラベルを一度リセットしてから、生成結果のラベルへ置き換える", () => {
    const prev = ["bug", "enhancement"];
    const suggested = ["60.chore"];

    expect(mergeSuggestedLabels(prev, suggested)).toEqual(["60.chore"]);
  });

  it("実装オプション用ラベル（「実装を開始」ダイアログで選ぶ分）はリセットせず維持する", () => {
    const prev = ["bug", PLAN_REQUIRED_LABEL];
    const suggested = ["60.chore"];

    expect(mergeSuggestedLabels(prev, suggested)).toEqual([PLAN_REQUIRED_LABEL, "60.chore"]);
  });

  it("進捗管理用ラベルはリセットせず維持する", () => {
    const prev = ["bug", "02.wip"];
    const suggested = ["60.chore"];

    expect(mergeSuggestedLabels(prev, suggested)).toEqual(["02.wip", "60.chore"]);
  });

  it("生成結果に重複があっても1つにまとめる", () => {
    expect(mergeSuggestedLabels([], ["60.chore", "60.chore"])).toEqual(["60.chore"]);
  });
});

describe("groupRepositoriesByWorkflowStatus", () => {
  it("claude-issue-dispatch.yml導入済みのリポジトリを先頭グループ、未導入を後続グループに分ける", () => {
    const notConfigured = makeRepo({ fullName: "owner/not-configured", hasClaudeWorkflow: false });
    const configured = makeRepo({ fullName: "owner/configured", hasClaudeWorkflow: true });

    expect(groupRepositoriesByWorkflowStatus([notConfigured, configured])).toEqual({
      registered: [configured],
      unregistered: [notConfigured],
    });
  });

  it("各グループ内では元の順序を維持する", () => {
    const first = makeRepo({ fullName: "owner/first", hasClaudeWorkflow: true });
    const second = makeRepo({ fullName: "owner/second", hasClaudeWorkflow: true });

    expect(groupRepositoriesByWorkflowStatus([second, first])).toEqual({
      registered: [second, first],
      unregistered: [],
    });
  });
});

/**
 * #1641。質問はGitHub Actions（mode=ask）が答えるため、`claude-issue-dispatch.yml`が
 * 導入済みのリポジトリでしか成立しない。
 */
describe("resolveKindRepository", () => {
  const configured = makeRepo({ fullName: "owner/configured", hasClaudeWorkflow: true });
  const notConfigured = makeRepo({ fullName: "owner/not-configured", hasClaudeWorkflow: false });

  it("Issueでは選択中のリポジトリをそのまま残す", () => {
    expect(
      resolveKindRepository("issue", [configured, notConfigured], "owner/not-configured"),
    ).toBe("owner/not-configured");
  });

  it("質問へ切り替えたとき、ワークフロー未導入のリポジトリを選んでいたら導入済みの先頭へ寄せる", () => {
    expect(
      resolveKindRepository("question", [notConfigured, configured], "owner/not-configured"),
    ).toBe("owner/configured");
  });

  it("質問で選べるリポジトリを既に選んでいる場合は変えない", () => {
    expect(resolveKindRepository("question", [configured, notConfigured], "owner/configured")).toBe(
      "owner/configured",
    );
  });

  it("質問で選べるリポジトリが1つも無ければ未選択にする", () => {
    expect(resolveKindRepository("question", [notConfigured], "owner/not-configured")).toBe("");
  });
});
