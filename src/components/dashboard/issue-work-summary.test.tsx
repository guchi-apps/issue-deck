// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { IssueWorkSummary } from "@/components/dashboard/issue-work-summary";

afterEach(cleanup);

describe("IssueWorkSummary", () => {
  it("目的と完了条件の達成数を出す", () => {
    render(<IssueWorkSummary body={"## 目的\n通知を直す\n## 完了条件\n- [x] A\n- [ ] B\n"} status="idle" idPrefix="t" />);
    // 閉じている間の抜粋と、開いたときの本文の2か所に出る
    expect(screen.getAllByText("通知を直す").length).toBe(2);
    expect(screen.getByText("完了条件（1/2）")).toBeTruthy();
  });

  it("目的・完了条件は既定で折りたたまれ、見出しに達成数を出す", () => {
    render(<IssueWorkSummary body={"## 目的\n通知を直す\n## 完了条件\n- [x] A\n- [ ] B\n"} status="idle" idPrefix="t" />);
    const details = screen.getByTestId("work-summary-accordion") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(screen.getByText("（1/2）")).toBeTruthy();
  });

  it("依存待ちは本人操作待ちとは別の表示で、理由を出す", () => {
    render(
      <IssueWorkSummary
        body={"## 目的\nX\n"}
        status="dependency_wait"
        blockingMessage="#10の完了を待っています。"
        idPrefix="t"
      />,
    );
    expect(screen.getByText("依存先を待っています・操作不要")).toBeTruthy();
    expect(screen.getByText("#10の完了を待っています。")).toBeTruthy();
    expect(screen.queryByText("あなたの操作を待っています")).toBeNull();
  });

  it("目的も完了条件も無く待ちも無ければ何も描かない", () => {
    const { container } = render(<IssueWorkSummary body="説明だけ" status="idle" idPrefix="t" />);
    expect(container.textContent).toBe("");
  });
});
