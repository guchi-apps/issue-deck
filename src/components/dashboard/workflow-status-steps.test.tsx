// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { WorkflowStatusSteps } from "@/components/dashboard/workflow-status-steps";
import type { IssueLabel } from "@/types/issue";

function labels(...names: string[]): IssueLabel[] {
  return names.map((name) => ({ name, color: "64748b", description: null }));
}

describe("WorkflowStatusSteps", () => {
  afterEach(() => {
    cleanup();
  });

  it("Project Statusが無い場合は何も表示しない", () => {
    const { container } = render(<WorkflowStatusSteps labels={labels("bug")} />);
    expect(container.firstChild).toBeNull();
  });

  it("現在ステップの名称と番号をスマホ向けキャプションに表示する", () => {
    render(<WorkflowStatusSteps labels={labels()} projectStatus="Implementation" />);
    expect(screen.getByText("実装中（2/6）")).not.toBeNull();
  });

  it("ユーザー確認待ちの場合はキャプション付近にも確認待ち表示を出す", () => {
    render(<WorkflowStatusSteps labels={labels("00.check-user")} projectStatus="Implementation" />);
    expect(screen.getAllByText("ユーザー確認待ち").length).toBeGreaterThan(0);
  });

  it("理由ラベルが付いていれば、何を求められているかを添える（#1490）", () => {
    render(
      <WorkflowStatusSteps
        labels={labels("00.check-user", "01.check-plan")}
        projectStatus="Planning"
      />,
    );
    expect(screen.getAllByText("ユーザー確認待ち・計画の承認").length).toBeGreaterThan(0);
    // 理由が付いた場合は従来の文言だけの表示に戻さない
    expect(screen.queryByText("ユーザー確認待ち")).toBeNull();
  });

  /**
   * #2057。バッジの真下に案内パネル（`CheckUserReasonNotice`）が出ているときは、その見出しが
   * 同じ用件を書いている。**状態そのものは残す**ので、現在ステップの琥珀色は消えない。
   */
  it("showApprovalBadge=falseなら確認待ちのバッジを出さない（#2057）", () => {
    render(
      <WorkflowStatusSteps
        labels={labels("00.check-user", "01.check-merge")}
        projectStatus="Develop PR"
        showApprovalBadge={false}
      />,
    );
    expect(screen.queryByText(/ユーザー確認待ち/)).toBeNull();
    // 段階のキャプションは残り、確認待ちであることは色（amber）で読める
    expect(screen.getByText("developへマージ（3/6）").className).toContain("amber");
  });

  it("showExecutionTarget=falseなら「サブPCで実行中」を出さない（#2057）", () => {
    render(
      <WorkflowStatusSteps
        labels={labels()}
        projectStatus="Implementation"
        executionTarget={{ host: "subpc", expectsActionsRun: false }}
        showExecutionTarget={false}
      />,
    );
    expect(screen.queryByText(/で実行中/)).toBeNull();
    expect(screen.getByText("実装中（2/6）")).not.toBeNull();
  });

  it("既定では従来どおりバッジも実行先も出す", () => {
    render(
      <WorkflowStatusSteps
        labels={labels("00.check-user")}
        projectStatus="Implementation"
        executionTarget={{ host: "subpc", expectsActionsRun: false }}
      />,
    );
    expect(screen.getAllByText("ユーザー確認待ち").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/で実行中/).length).toBeGreaterThan(0);
  });

  it("各ステップの円にaria-currentが付き、完了済みステップと現在ステップが判別できる", () => {
    render(<WorkflowStatusSteps labels={labels()} projectStatus="Develop PR" />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(6);
    expect(items[2].getAttribute("aria-current")).toBe("step");
    expect(items[0].getAttribute("aria-current")).toBeNull();
    expect(items[0].title).toBe("Planning");
  });

  /**
   * #2069。計画フェーズを通らずに実装へ入ったIssueで、1段目に済みのチェックを出すと、
   * 計画を立てて承認まで通したIssueと見分けが付かない。
   */
  it("planningSkipped=trueなら1段目をスキップとして描く（#2069）", () => {
    render(
      <WorkflowStatusSteps labels={labels()} projectStatus="Implementation" planningSkipped />,
    );
    const items = screen.getAllByRole("listitem");
    // 塗りつぶし（済み）にせず、破線の輪郭にする
    expect(items[0].className).toContain("border-dashed");
    expect(items[0].className).not.toContain("bg-primary");
    expect(items[0].getAttribute("aria-label")).toBe("計画スキップ");
    expect(items[0].title).toContain("計画フェーズを通らずに実装へ入りました");
    // PCの段のラベルと、段のラベルが出ないスマホ向けのキャプションの両方で言う
    expect(screen.getAllByText("計画スキップ")).toHaveLength(2);
    expect(screen.getByText("実装中（2/6）")).not.toBeNull();
  });

  it("planningSkippedを渡さなければ従来どおり済みのチェックを出す（#2069）", () => {
    render(<WorkflowStatusSteps labels={labels()} projectStatus="Implementation" />);
    const items = screen.getAllByRole("listitem");
    expect(items[0].className).toContain("bg-primary");
    expect(items[0].className).not.toContain("border-dashed");
    expect(screen.queryByText("計画スキップ")).toBeNull();
  });

  it("まだ計画中（Planning）のIssueはスキップ表示にしない（#2069）", () => {
    render(<WorkflowStatusSteps labels={labels()} projectStatus="Planning" planningSkipped />);
    const items = screen.getAllByRole("listitem");
    expect(items[0].className).not.toContain("border-dashed");
    expect(screen.queryByText("計画スキップ")).toBeNull();
    expect(screen.getByText("計画検討中（1/6）")).not.toBeNull();
  });

  it("スキップと実行先はキャプションで並べて出す（#2069）", () => {
    render(
      <WorkflowStatusSteps
        labels={labels()}
        projectStatus="Implementation"
        executionTarget={{ host: "subpc", expectsActionsRun: false }}
        planningSkipped
      />,
    );
    expect(screen.getByText("計画スキップ・サブPCで実行中")).not.toBeNull();
  });
});
