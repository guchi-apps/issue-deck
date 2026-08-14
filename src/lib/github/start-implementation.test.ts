import { describe, expect, it } from "vitest";

import { CHECK_USER_LABEL, MANUAL_STEP_LABEL, PLAN_REQUIRED_LABEL } from "@/lib/github/approval-labels";
import {
  canStartImplementation,
  isSelectableLabelName,
  planRequiredDefaultForLabels,
  START_IMPLEMENTATION_DEFAULT_OPTIONS,
  startImplementationCommentBody,
  startImplementationDisabledReason,
  startImplementationLabelsToAdd,
  startImplementationOptionsFromLabels,
  visibleStartImplementationOptions,
} from "@/lib/github/start-implementation";

describe("startImplementationCommentBody", () => {
  it("計画が必要でない場合、実装開始の定型文を返す", () => {
    expect(startImplementationCommentBody(false)).toBe("@claude 実装を開始してください");
  });

  it("計画が必要な場合、計画立案の定型文を返す", () => {
    expect(startImplementationCommentBody(true)).toBe("@claude 計画を立案してください");
  });
});

describe("startImplementationLabelsToAdd", () => {
  // 進捗（Planning/Implementation）はProject Statusで表すため、ここが返すのは
  // 実装オプション用ラベルだけ（#991 Phase 5・#1010）
  it("オプションが1つも選ばれていなければ空配列を返す", () => {
    expect(
      startImplementationLabelsToAdd({
        planRequired: false,
        previewRequired: false,
        screenshotRequired: false,
        mergeConfirmRequired: false,
      }),
    ).toEqual([]);
  });

  it("選択したオプションに対応するラベルだけを返す（進捗ラベルは含めない）", () => {
    expect(
      startImplementationLabelsToAdd({
        planRequired: true,
        previewRequired: false,
        screenshotRequired: false,
        mergeConfirmRequired: false,
      }),
    ).toEqual([PLAN_REQUIRED_LABEL]);
  });
});

describe("planRequiredDefaultForLabels", () => {
  it("新機能・改善・デザインの種別では計画を既定でONにする（#1317）", () => {
    expect(planRequiredDefaultForLabels(["50.feature"])).toBe(true);
    expect(planRequiredDefaultForLabels(["51.improvement"])).toBe(true);
    expect(planRequiredDefaultForLabels(["62.design"])).toBe(true);
  });

  it("バグ修正・軽微な修正・文書整理の種別では計画を既定でOFFにする（#1317）", () => {
    expect(planRequiredDefaultForLabels(["30.bug"])).toBe(false);
    expect(planRequiredDefaultForLabels(["60.chore"])).toBe(false);
    expect(planRequiredDefaultForLabels(["65.docs"])).toBe(false);
  });

  it("種別ラベルが無ければ従来どおりOFFにする", () => {
    expect(planRequiredDefaultForLabels([])).toBe(false);
    expect(planRequiredDefaultForLabels(["80.Priority: High"])).toBe(false);
  });

  // 種別を選び直したときに付け外しの両方向へ追従させるため、21.plan-required自体は見ない
  it("21.plan-requiredが付いているだけでは既定をONにしない", () => {
    expect(planRequiredDefaultForLabels([PLAN_REQUIRED_LABEL])).toBe(false);
  });
});

describe("startImplementationOptionsFromLabels", () => {
  function makeLabels(names: string[]) {
    return names.map((name) => ({ name, color: "000000", description: null }));
  }

  it("付与済みのオプションラベルをそのまま初期選択にする", () => {
    expect(startImplementationOptionsFromLabels(makeLabels(["24.screenshot-required"]))).toEqual({
      ...START_IMPLEMENTATION_DEFAULT_OPTIONS,
      screenshotRequired: true,
    });
  });

  it("21.plan-requiredが未付与でも、新機能のIssueなら計画にチェックを入れて開く（#1317）", () => {
    expect(startImplementationOptionsFromLabels(makeLabels(["50.feature"]))).toEqual({
      ...START_IMPLEMENTATION_DEFAULT_OPTIONS,
      planRequired: true,
    });
  });

  it("バグ修正のIssueでも、既に21.plan-requiredが付いていれば尊重する", () => {
    expect(startImplementationOptionsFromLabels(makeLabels(["30.bug", PLAN_REQUIRED_LABEL]))).toEqual(
      { ...START_IMPLEMENTATION_DEFAULT_OPTIONS, planRequired: true },
    );
  });

  it("バグ修正のIssueでは計画にチェックを入れない", () => {
    expect(startImplementationOptionsFromLabels(makeLabels(["30.bug"]))).toEqual(
      START_IMPLEMENTATION_DEFAULT_OPTIONS,
    );
  });
});

describe("visibleStartImplementationOptions", () => {
  function keysFor(isActionsTarget: boolean, screenshotRequired: boolean) {
    return visibleStartImplementationOptions({
      isActionsTarget,
      options: { ...START_IMPLEMENTATION_DEFAULT_OPTIONS, screenshotRequired },
    }).map((option) => option.key);
  }

  // サブPC・ローカル実行はtailscale serveで実物の画面を見られるため撮影は不要（#1265・#1317）
  it("GitHub Actions以外を選んでいる場合、スクリーンショットのオプションを出さない", () => {
    expect(keysFor(false, false)).not.toContain("screenshotRequired");
    expect(keysFor(false, false)).toContain("previewRequired");
  });

  it("GitHub Actionsを選んでいる場合はスクリーンショットのオプションを出す", () => {
    expect(keysFor(true, false)).toContain("screenshotRequired");
  });

  // 隠すと、既に付いてしまったラベルをこのダイアログから外せなくなる
  it("既にチェックが入っている場合は実行先によらず出す", () => {
    expect(keysFor(false, true)).toContain("screenshotRequired");
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

describe("canStartImplementation", () => {
  function makeIssue(labelNames: string[]): Parameters<typeof canStartImplementation>[0] {
    return {
      state: "open",
      labels: labelNames.map((name) => ({ name, color: "000000", description: null })),
      projectStatus: null,
    };
  }

  it("未着手のopenなIssueでは表示する", () => {
    expect(canStartImplementation(makeIssue([]))).toBe(true);
  });

  it("承認待ち（00.check-user）のIssueでは表示しない", () => {
    expect(canStartImplementation(makeIssue([CHECK_USER_LABEL]))).toBe(false);
  });

  // 手作業Issueは進捗が`Ready`のまま留まるため、この判定を入れないと
  // 実装エージェントへ送る主ボタンが出続ける（#1280）
  it("手作業Issue（71.manual-step）では表示しない", () => {
    expect(canStartImplementation(makeIssue([MANUAL_STEP_LABEL]))).toBe(false);
  });

  it("closedなIssueでは表示しない", () => {
    expect(canStartImplementation({ ...makeIssue([]), state: "closed" })).toBe(false);
  });
});
