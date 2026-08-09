import { describe, expect, it } from "vitest";

import { PLAN_REQUIRED_LABEL } from "@/lib/github/approval-labels";
import {
  isSelectableLabelName,
  startImplementationCommentBody,
  startImplementationDisabledReason,
  startImplementationLabelsForCreate,
} from "@/lib/github/start-implementation";
import { PLANNING_LABEL_NAME, WIP_LABEL_NAME } from "@/lib/github/workflow-status";

describe("startImplementationCommentBody", () => {
  it("計画が必要でない場合、実装開始の定型文を返す", () => {
    expect(startImplementationCommentBody(false)).toBe("@claude 実装を開始してください");
  });

  it("計画が必要な場合、計画立案の定型文を返す", () => {
    expect(startImplementationCommentBody(true)).toBe("@claude 計画を立案してください");
  });
});

describe("startImplementationLabelsForCreate", () => {
  it("計画が必要が選択されていない場合、02.wipを付与する", () => {
    expect(startImplementationLabelsForCreate(["bug"])).toEqual(["bug", WIP_LABEL_NAME]);
  });

  it("計画が必要が選択されている場合、02.wipではなく01.planningを付与する", () => {
    expect(startImplementationLabelsForCreate(["bug", PLAN_REQUIRED_LABEL])).toEqual([
      "bug",
      PLAN_REQUIRED_LABEL,
      PLANNING_LABEL_NAME,
    ]);
  });

  it("選択済みラベルに重複があっても1つにまとめる", () => {
    expect(startImplementationLabelsForCreate([WIP_LABEL_NAME, "bug"])).toEqual([
      WIP_LABEL_NAME,
      "bug",
    ]);
  });
});

describe("startImplementationDisabledReason", () => {
  it("hasClaudeWorkflowがfalseの場合、無効化理由を返す（#976）", () => {
    expect(startImplementationDisabledReason(false)).not.toBeNull();
  });

  it("hasClaudeWorkflowがtrueの場合、nullを返す", () => {
    expect(startImplementationDisabledReason(true)).toBeNull();
  });

  it("hasClaudeWorkflowがundefined（リポジトリ情報が見つからない等）の場合、誤って無効化しないようnullを返す", () => {
    expect(startImplementationDisabledReason(undefined)).toBeNull();
  });
});

describe("isSelectableLabelName", () => {
  it("通常のラベルは選択可能と判定する", () => {
    expect(isSelectableLabelName("bug")).toBe(true);
  });

  it("実装フロー制御ラベル（21.plan-required等）は選択不可と判定する（#887: 質問Issue作成時に選べてしまう不具合の直接原因）", () => {
    expect(isSelectableLabelName("21.plan-required")).toBe(false);
    expect(isSelectableLabelName("22.merge-confirm-required")).toBe(false);
    expect(isSelectableLabelName("23.preview-required")).toBe(false);
    expect(isSelectableLabelName("24.screenshot-required")).toBe(false);
  });

  it("進捗管理用ラベル（00〜09番台）は選択不可と判定する", () => {
    expect(isSelectableLabelName("00.check-user")).toBe(false);
    expect(isSelectableLabelName("00.qa-answered")).toBe(false);
    expect(isSelectableLabelName("02.wip")).toBe(false);
  });
});
