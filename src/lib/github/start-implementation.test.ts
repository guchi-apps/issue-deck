import { describe, expect, it } from "vitest";

import { CHECK_USER_LABEL, MANUAL_STEP_LABEL, PLAN_REQUIRED_LABEL } from "@/lib/github/approval-labels";
import {
  ARTIFACT_REQUIRED_LABEL,
  artifactRequiredDefaultForLabels,
  canStartImplementation,
  commonStartImplementationOptions,
  isSelectableLabelName,
  isStartImplementationOptionLabel,
  planRequiredDefaultForLabels,
  START_IMPLEMENTATION_DEFAULT_OPTIONS,
  START_IMPLEMENTATION_OPTIONS,
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
        artifactRequired: false,
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
        artifactRequired: false,
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

describe("artifactRequiredDefaultForLabels", () => {
  /** リポジトリ側に25.artifact-requiredが配られている状態 */
  const distributed = [ARTIFACT_REQUIRED_LABEL, "62.design", "50.feature", "30.bug"];

  it("デザインの種別ではアーティファクトを既定でONにする（#1956）", () => {
    expect(
      artifactRequiredDefaultForLabels({
        issueLabelNames: ["62.design"],
        repositoryLabelNames: distributed,
      }),
    ).toBe(true);
  });

  it("デザイン以外の種別ではOFFのままにする（#1956）", () => {
    for (const issueLabelNames of [["50.feature"], ["51.improvement"], ["30.bug"], []]) {
      expect(
        artifactRequiredDefaultForLabels({ issueLabelNames, repositoryLabelNames: distributed }),
      ).toBe(false);
    }
  });

  // 種別を選び直したときに付け外しの両方向へ追従させるため、25.artifact-required自体は見ない
  it("25.artifact-requiredが付いているだけでは既定をONにしない", () => {
    expect(
      artifactRequiredDefaultForLabels({
        issueLabelNames: [ARTIFACT_REQUIRED_LABEL],
        repositoryLabelNames: distributed,
      }),
    ).toBe(false);
  });

  // 存在しないラベル名を付与すると、色も説明も無いラベルがその場で作られる（#1490・#1956）
  it("リポジトリに25.artifact-requiredが定義されていなければ既定をONにしない（#1956）", () => {
    expect(
      artifactRequiredDefaultForLabels({
        issueLabelNames: ["62.design"],
        repositoryLabelNames: ["62.design", "21.plan-required"],
      }),
    ).toBe(false);
  });

  it("リポジトリのラベル一覧が未取得のうちは既定をONにしない（#1956）", () => {
    expect(
      artifactRequiredDefaultForLabels({ issueLabelNames: ["62.design"], repositoryLabelNames: [] }),
    ).toBe(false);
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

  // デザインは計画の既定（#1317）にも含まれるため、2つ同時にチェックが入った状態で開く
  it("25.artifact-requiredが未付与でも、デザインのIssueならアーティファクトにチェックを入れて開く（#1956）", () => {
    expect(
      startImplementationOptionsFromLabels(makeLabels(["62.design"]), [ARTIFACT_REQUIRED_LABEL]),
    ).toEqual({
      ...START_IMPLEMENTATION_DEFAULT_OPTIONS,
      planRequired: true,
      artifactRequired: true,
    });
  });

  it("デザイン以外の種別ではアーティファクトにチェックを入れない（#1956）", () => {
    expect(
      startImplementationOptionsFromLabels(makeLabels(["51.improvement"]), [ARTIFACT_REQUIRED_LABEL]),
    ).toEqual({
      ...START_IMPLEMENTATION_DEFAULT_OPTIONS,
      planRequired: true,
    });
  });

  // 25.artifact-requiredを配っていないリポジトリで、押した覚えのないラベルを作らせない（#1956）
  it("リポジトリに25.artifact-requiredが無ければデザインのIssueでもチェックを入れない（#1956）", () => {
    expect(startImplementationOptionsFromLabels(makeLabels(["62.design"]), ["62.design"])).toEqual({
      ...START_IMPLEMENTATION_DEFAULT_OPTIONS,
      planRequired: true,
    });
  });

  it("既に25.artifact-requiredが付いていれば、リポジトリのラベル一覧によらず尊重する", () => {
    expect(startImplementationOptionsFromLabels(makeLabels([ARTIFACT_REQUIRED_LABEL]))).toEqual({
      ...START_IMPLEMENTATION_DEFAULT_OPTIONS,
      artifactRequired: true,
    });
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

  // アーティファクトの公開はローカルセッションのツールで、無人実行からは作れない（#1473）
  describe("アーティファクト（撮影とは逆向きの出し分け）", () => {
    function artifactKeysFor(isActionsTarget: boolean, artifactRequired: boolean) {
      return visibleStartImplementationOptions({
        isActionsTarget,
        options: { ...START_IMPLEMENTATION_DEFAULT_OPTIONS, artifactRequired },
      }).map((option) => option.key);
    }

    it("GitHub Actionsを選んでいる場合、アーティファクトのオプションを出さない", () => {
      expect(artifactKeysFor(true, false)).not.toContain("artifactRequired");
    });

    it("GitHub Actions以外を選んでいる場合はアーティファクトのオプションを出す", () => {
      expect(artifactKeysFor(false, false)).toContain("artifactRequired");
    });

    it("既にチェックが入っている場合は実行先によらず出す", () => {
      expect(artifactKeysFor(true, true)).toContain("artifactRequired");
    });
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

// #1915: Issue一覧のカードはこの判定でラベルを間引く（判定の正はSTART_IMPLEMENTATION_OPTIONS）
describe("isStartImplementationOptionLabel", () => {
  it("実装オプションが付けるラベルを判定する", () => {
    expect(isStartImplementationOptionLabel("21.plan-required")).toBe(true);
    expect(isStartImplementationOptionLabel("22.merge-confirm-required")).toBe(true);
    expect(isStartImplementationOptionLabel("23.preview-required")).toBe(true);
    expect(isStartImplementationOptionLabel("24.screenshot-required")).toBe(true);
    expect(isStartImplementationOptionLabel("25.artifact-required")).toBe(true);
  });

  it("それ以外のラベルは対象にしない", () => {
    expect(isStartImplementationOptionLabel("11.local")).toBe(false);
    expect(isStartImplementationOptionLabel("50.feature")).toBe(false);
    expect(isStartImplementationOptionLabel("71.manual-step")).toBe(false);
    expect(isStartImplementationOptionLabel("bug")).toBe(false);
  });

  // オプションを増やしたときに一覧側の判定だけ古くならないよう、定義から作る
  it("START_IMPLEMENTATION_OPTIONSのラベルをすべて対象にする", () => {
    for (const option of START_IMPLEMENTATION_OPTIONS) {
      expect(isStartImplementationOptionLabel(option.githubLabel)).toBe(true);
    }
  });
});

describe("commonStartImplementationOptions（#1993）", () => {
  const ALL_LABELS = START_IMPLEMENTATION_OPTIONS.map((option) => option.githubLabel);

  it("撮影は出さない（サブPCへ積むため）", () => {
    const keys = commonStartImplementationOptions(
      new Map([["guchi-apps/issue-deck", ALL_LABELS]]),
    ).map((option) => option.key);

    expect(keys).toContain("planRequired");
    expect(keys).toContain("artifactRequired");
    expect(keys).not.toContain("screenshotRequired");
  });

  // 片方にしか定義が無いラベルを一括で配ると、無い側では**その場で作られてしまう**（#1490）
  it("選んだIssueのリポジトリすべてに定義があるものだけ出す", () => {
    const keys = commonStartImplementationOptions(
      new Map([
        ["guchi-apps/issue-deck", ALL_LABELS],
        ["guchi-apps/dayspan", [PLAN_REQUIRED_LABEL]],
      ]),
    ).map((option) => option.key);

    expect(keys).toEqual(["planRequired"]);
  });

  it("ラベル一覧が分からないリポジトリでは絞り込まない", () => {
    const keys = commonStartImplementationOptions(new Map()).map((option) => option.key);

    expect(keys).toContain("planRequired");
    expect(keys).toContain("artifactRequired");
    expect(keys).toContain("mergeConfirmRequired");
    expect(keys).toContain("previewRequired");
  });
});
