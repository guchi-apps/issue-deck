import { describe, expect, it } from "vitest";

import {
  groupRepositoriesByWorkflowStatus,
  mergeSuggestedLabels,
  syncPlanRequiredLabel,
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

  it("実装オプション用ラベル（チェックボックス選択分）はリセットせず維持する", () => {
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

describe("syncPlanRequiredLabel", () => {
  it("新機能の種別を選ぶと計画のラベルを足す（#1317）", () => {
    expect(syncPlanRequiredLabel(["50.feature"])).toEqual(["50.feature", PLAN_REQUIRED_LABEL]);
  });

  it("バグ修正へ選び直すと計画のラベルを外す（付け外しの両方向を扱う）", () => {
    expect(syncPlanRequiredLabel(["30.bug", PLAN_REQUIRED_LABEL])).toEqual(["30.bug"]);
  });

  it("既定と一致していればnullを返し、書き込み自体を止める", () => {
    expect(syncPlanRequiredLabel(["30.bug"])).toBeNull();
    expect(syncPlanRequiredLabel(["50.feature", PLAN_REQUIRED_LABEL])).toBeNull();
    expect(syncPlanRequiredLabel([])).toBeNull();
  });

  it("種別以外のラベルには反応しない", () => {
    expect(syncPlanRequiredLabel(["80.Priority: High"])).toBeNull();
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
