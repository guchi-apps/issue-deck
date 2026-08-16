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
    kind: "issue",
    title: "右パネルから進捗を変えられるようにする",
    htmlUrl: `https://github.com/${REPO}/issues/1690`,
    stage: "develop",
    label: "developへマージ済み・本番未反映",
    satisfied: false,
    stepIndex: 1,
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

  // 本文テンプレート（docs/multi-agent/labels.md「本文」）の見出しと同じ順に並べる（#1730）。
  // ずれると、実行する人が本文を上から読みながら手順を追えなくなる。
  it("手順を本文の見出しと同じ順で出す", () => {
    render(<ManualStepPanel isSubmitting={false} onComplete={vi.fn()} onSkip={vi.fn()} />);

    const steps = screen.getAllByRole("listitem").map((item) => item.textContent ?? "");
    expect(steps.slice(0, 4)).toEqual([
      "「この作業でできるようになること」でやる意味と急ぎ具合を確かめる",
      "「前提条件」（デバイス・ディレクトリ・ブランチ・先に必要なIssue／PR）を満たしているか確かめる",
      "「やること」の手順を実行する",
      "「完了の確認方法」で効いたことを確かめる",
    ]);
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
