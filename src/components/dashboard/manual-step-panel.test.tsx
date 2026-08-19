// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ManualStepPanel } from "@/components/dashboard/manual-step-panel";
import {
  summarizeManualStepPrerequisites,
  type ManualStepPrerequisite,
} from "@/lib/manual-step-prerequisites";

const REPO = "guchi-apps/issue-deck";

function prerequisite(overrides: Partial<ManualStepPrerequisite> = {}): ManualStepPrerequisite {
  return {
    repositoryFullName: REPO,
    number: 1690,
    origin: false,
    explicit: true,
    kind: "issue",
    title: "右パネルから進捗を変えられるようにする",
    htmlUrl: `https://github.com/${REPO}/issues/1690`,
    stage: "develop",
    label: "developへマージ済み・本番未反映",
    satisfied: false,
    stepIndex: 1,
    manualStep: false,
    ...overrides,
  };
}

function renderWithPrerequisites(prerequisites: ManualStepPrerequisite[]) {
  render(
    <ManualStepPanel
      isSubmitting={false}
      onComplete={vi.fn()}
      onSkip={vi.fn()}
      prerequisites={prerequisites}
      prerequisiteSummary={summarizeManualStepPrerequisites(prerequisites, REPO)}
      repositoryFullName={REPO}
    />,
  );
}

describe("ManualStepPanel", () => {
  afterEach(() => {
    cleanup();
  });

  // #2003: 自分が終わるまで何が止まっているのかは、後回しにしてよいかの判断に一番効く
  it("このIssueの完了を待っているIssueを、前提条件の下に出す", () => {
    render(
      <ManualStepPanel
        isSubmitting={false}
        onComplete={vi.fn()}
        onSkip={vi.fn()}
        dependents={[
          {
            id: "38",
            repositoryFullName: REPO,
            number: 38,
            title: "セルフホストランナーが落ちたまま復帰しない",
            htmlUrl: `https://github.com/${REPO}/issues/38`,
            stage: "in-progress",
            label: "実装中",
            stepIndex: 0,
            manualStep: false,
          },
        ]}
        repositoryFullName={REPO}
      />,
    );

    expect(screen.getByText("このIssueの完了を待っているIssue")).toBeTruthy();
    expect(screen.getByText("このIssueが終わるまで #38 は先へ進めません。")).toBeTruthy();
  });

  it("完了・実施せずのそれぞれのクローズを呼び分ける", () => {
    const onComplete = vi.fn();
    const onSkip = vi.fn();
    render(<ManualStepPanel isSubmitting={false} onComplete={onComplete} onSkip={onSkip} />);

    fireEvent.click(screen.getByRole("button", { name: "手作業を完了してクローズ" }));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onSkip).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "実施せずクローズ" }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  // 手順は本文テンプレートの見出しと重複していたので出さない（#1732）
  it("手順の説明は出さず、クローズのボタンだけを出す", () => {
    render(<ManualStepPanel isSubmitting={false} onComplete={vi.fn()} onSkip={vi.fn()} />);

    expect(screen.queryByText(/実装エージェントへは送りません/)).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByText(/進捗（Status）はReadyのまま/)).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("送信中はどちらのボタンも押せない", () => {
    const onComplete = vi.fn();
    const onSkip = vi.fn();
    render(<ManualStepPanel isSubmitting onComplete={onComplete} onSkip={onSkip} />);

    for (const button of screen.getAllByRole<HTMLButtonElement>("button")) {
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(onComplete).not.toHaveBeenCalled();
    expect(onSkip).not.toHaveBeenCalled();
  });

  it("前提条件が揃っていなければ、待っている相手と何を待っているかを出す", () => {
    renderWithPrerequisites([
      prerequisite({ origin: true }),
      prerequisite({
        number: 1704,
        kind: "pull-request",
        title: "デプロイ完了を通知する",
        stage: "open",
        label: "マージ待ち",
        stepIndex: null,
      }),
    ]);

    expect(screen.getByText("前提条件の状況")).toBeTruthy();
    expect(screen.getByText("2件中 0件 完了")).toBeTruthy();
    expect(
      screen.getByText("まだ実行できません。#1690 がmainへ反映されるのを待ってください（ほか1件）。"),
    ).toBeTruthy();
    expect(screen.getByText("起点")).toBeTruthy();
    expect(screen.getByText("PR #1704")).toBeTruthy();
  });

  // 判定は本文の記載からの推定なので、外したときに完了できなくなる方が損が大きい
  it("前提条件が揃っていなくてもクローズのボタンは押せる", () => {
    renderWithPrerequisites([prerequisite()]);

    for (const button of screen.getAllByRole<HTMLButtonElement>("button")) {
      expect(button.disabled).toBe(false);
    }
  });

  it("前提条件がすべて満たされていれば実行できる旨を出す", () => {
    renderWithPrerequisites([
      prerequisite({ stage: "done-main", label: "mainへ反映済み", satisfied: true, stepIndex: 2 }),
    ]);

    expect(screen.getByText("前提はすべて満たされています。いま実行できます。")).toBeTruthy();
    expect(screen.getByText("mainへ反映済み")).toBeTruthy();
  });

  it("参照が1件も無ければ前提条件のブロックごと出さない", () => {
    renderWithPrerequisites([]);

    expect(screen.queryByText("前提条件の状況")).toBeNull();
  });
});
