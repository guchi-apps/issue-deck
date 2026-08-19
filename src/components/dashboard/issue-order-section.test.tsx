// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { IssueOrderSection } from "@/components/dashboard/issue-order-section";
import type { IssueDependent } from "@/lib/issue-dependents";
import {
  summarizeManualStepPrerequisites,
  type ManualStepPrerequisite,
} from "@/lib/manual-step-prerequisites";

const REPO = "guchi-apps/subpc";

function prerequisite(overrides: Partial<ManualStepPrerequisite> = {}): ManualStepPrerequisite {
  return {
    repositoryFullName: REPO,
    number: 39,
    origin: false,
    explicit: true,
    kind: "issue",
    title: "[手作業] サブPC: 停止しているセルフホストランナーを起こす",
    htmlUrl: `https://github.com/${REPO}/issues/39`,
    stage: "manual-pending",
    label: "手作業・未実施",
    satisfied: false,
    stepIndex: null,
    manualStep: true,
    ...overrides,
  };
}

function dependent(overrides: Partial<IssueDependent> = {}): IssueDependent {
  return {
    id: "38",
    repositoryFullName: REPO,
    number: 38,
    title: "セルフホストランナーが落ちたまま復帰しない",
    htmlUrl: `https://github.com/${REPO}/issues/38`,
    stage: "in-progress",
    label: "実装中",
    stepIndex: 0,
    manualStep: false,
    ...overrides,
  };
}

function renderSection({
  prerequisites = [] as ManualStepPrerequisite[],
  dependents = [] as IssueDependent[],
} = {}) {
  render(
    <IssueOrderSection
      prerequisites={prerequisites}
      prerequisiteSummary={
        prerequisites.length > 0
          ? summarizeManualStepPrerequisites(prerequisites, REPO, { manualStep: false })
          : null
      }
      dependents={dependents}
      repositoryFullName={REPO}
      idPrefix="test"
    />,
  );
}

describe("IssueOrderSection（#2003）", () => {
  afterEach(() => {
    cleanup();
  });

  it("順序がどちら向きにも無ければ何も描かない", () => {
    const { container } = render(
      <IssueOrderSection
        prerequisites={[]}
        prerequisiteSummary={null}
        dependents={[]}
        repositoryFullName={REPO}
        idPrefix="test"
      />,
    );

    expect(container.firstChild).toBeNull();
  });

  // 畳まれていると、順序を書いた側は出したつもりでも読む側が開くまで気付かない
  it("前提が残っている間は開いたまま出す", () => {
    renderSection({ prerequisites: [prerequisite()] });

    expect(
      screen.getByText("前提が1件残っています。#39 の手作業が実施されるのを待ってください。"),
    ).toBeTruthy();
    expect(screen.getByText("前提1件待ち")).toBeTruthy();
  });

  it("待たれている側も同じセクションに出す", () => {
    renderSection({ prerequisites: [prerequisite()], dependents: [dependent()] });

    expect(screen.getByText("このIssueの完了を待っているIssue")).toBeTruthy();
    expect(screen.getByText("このIssueが終わるまで #38 は先へ進めません。")).toBeTruthy();
  });

  // 待たれているだけなら急ぐ理由にはなっても手が止まってはいない。畳んだままにして、
  // 見出しの要約だけで気付けるようにする
  it("前提が残っていなければ畳んだままにし、要約だけを見出しに残す", () => {
    renderSection({ dependents: [dependent()] });

    expect(screen.getByText("1件が完了を待っている")).toBeTruthy();
    expect(screen.queryByText("このIssueの完了を待っているIssue")).toBeNull();
  });

  // 手作業はdevelopもmainも通らないので、3段階のドットを出さない
  it("未実施の手作業の前提には3段階のドットを出さない", () => {
    renderSection({ prerequisites: [prerequisite()] });

    expect(screen.getByText("手作業・未実施")).toBeTruthy();
    expect(screen.queryByText("実装 → develop → main")).toBeNull();
  });
});
