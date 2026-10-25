import { describe, expect, it } from "vitest";

import {
  groupRepositoriesByWorkflowStatus,
  mergeSuggestedLabels,
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
    dispatchRunnable: false,
    hidden: false,
    favorite: false,
    excludedFromIssueCreation: false,
    releaseCheckSince: null,
    ...overrides,
  };
}

describe("mergeSuggestedLabels", () => {
  it("自動付与の対象（30〜89番台）に選択済みのラベルは、生成結果のラベルへ置き換える", () => {
    const prev = ["30.bug", "80.Priority: High"];
    const suggested = ["60.chore"];

    expect(mergeSuggestedLabels(prev, suggested)).toEqual(["60.chore"]);
  });

  it("実装オプション用ラベル（「実装を開始」ダイアログで選ぶ分）はリセットせず維持する", () => {
    const prev = ["30.bug", PLAN_REQUIRED_LABEL];
    const suggested = ["60.chore"];

    expect(mergeSuggestedLabels(prev, suggested)).toEqual([PLAN_REQUIRED_LABEL, "60.chore"]);
  });

  it("進捗管理用ラベルはリセットせず維持する", () => {
    const prev = ["30.bug", "02.wip"];
    const suggested = ["60.chore"];

    expect(mergeSuggestedLabels(prev, suggested)).toEqual(["02.wip", "60.chore"]);
  });

  /** #1662。生成結果に出てこないラベルまでリセットすると、自動生成のたびに黙って消える。 */
  it("自動付与の対象外のラベル（人が手で選んだ11.local・9x.Close: *）はリセットせず維持する", () => {
    const prev = ["11.local", "91.Close: duplicate", "30.bug"];
    const suggested = ["60.chore"];

    expect(mergeSuggestedLabels(prev, suggested)).toEqual([
      "11.local",
      "91.Close: duplicate",
      "60.chore",
    ]);
  });

  it("71.manual-stepは生成結果に混じっていても取り込まない（#1662）", () => {
    expect(mergeSuggestedLabels([], ["60.chore", "71.manual-step"])).toEqual(["60.chore"]);
  });

  it("生成結果に重複があっても1つにまとめる", () => {
    expect(mergeSuggestedLabels([], ["60.chore", "60.chore"])).toEqual(["60.chore"]);
  });
});

describe("groupRepositoriesByWorkflowStatus", () => {
  it("ホスト対応のリポジトリを先頭グループ、未導入を後続グループに分ける", () => {
    const notConfigured = makeRepo({ fullName: "owner/not-configured", dispatchRunnable: false });
    const configured = makeRepo({ fullName: "owner/configured", dispatchRunnable: true });

    expect(groupRepositoriesByWorkflowStatus([notConfigured, configured])).toEqual({
      registered: [configured],
      unregistered: [notConfigured],
    });
  });

  it("各グループ内では元の順序を維持する", () => {
    const first = makeRepo({ fullName: "owner/first", dispatchRunnable: true });
    const second = makeRepo({ fullName: "owner/second", dispatchRunnable: true });

    expect(groupRepositoriesByWorkflowStatus([second, first])).toEqual({
      registered: [second, first],
      unregistered: [],
    });
  });
});
