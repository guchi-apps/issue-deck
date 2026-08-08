import { describe, expect, it } from "vitest";

import { PLAN_REQUIRED_LABEL } from "@/lib/github/approval-labels";
import {
  startImplementationCommentBody,
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
