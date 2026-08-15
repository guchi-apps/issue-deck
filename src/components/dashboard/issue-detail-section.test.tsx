// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IssueDetailSection } from "@/components/dashboard/issue-detail-section";

describe("IssueDetailSection", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("既定では畳んでおり、見出し・件数・要約だけを見せる（#1577）", () => {
    render(
      <IssueDetailSection id="pull-requests" title="対応PR" count={6} summary={<span>マージ済み 5</span>}>
        <p>対応PRの一覧</p>
      </IssueDetailSection>,
    );

    expect(screen.getByText("対応PR")).not.toBeNull();
    expect(screen.getByText("6")).not.toBeNull();
    expect(screen.getByText("マージ済み 5")).not.toBeNull();
    expect(screen.queryByText("対応PRの一覧")).toBeNull();
  });

  it("見出しを押すと開く", () => {
    render(
      <IssueDetailSection id="pull-requests" title="対応PR">
        <p>対応PRの一覧</p>
      </IssueDetailSection>,
    );

    fireEvent.click(screen.getByRole("button", { name: /対応PR/ }));
    expect(screen.getByText("対応PRの一覧")).not.toBeNull();
  });

  it("開閉状態をlocalStorageに覚える（Issueごとではなくセクションごとに1つ）", () => {
    const { unmount } = render(
      <IssueDetailSection id="pull-requests" title="対応PR">
        <p>対応PRの一覧</p>
      </IssueDetailSection>,
    );
    fireEvent.click(screen.getByRole("button", { name: /対応PR/ }));
    expect(window.localStorage.getItem("issue-detail.section.pull-requests")).toBe("true");
    unmount();

    render(
      <IssueDetailSection id="pull-requests" title="対応PR">
        <p>対応PRの一覧</p>
      </IssueDetailSection>,
    );
    expect(screen.getByText("対応PRの一覧")).not.toBeNull();
  });

  it("forceOpenの間は開いたまま畳めない（マージ待ちで押すべきものを隠さない）", () => {
    render(
      <IssueDetailSection id="pull-requests" title="対応PR" forceOpen>
        <p>対応PRの一覧</p>
      </IssueDetailSection>,
    );

    const trigger = screen.getByRole("button", { name: /対応PR/ }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(screen.getByText("対応PRの一覧")).not.toBeNull();

    fireEvent.click(trigger);
    expect(screen.getByText("対応PRの一覧")).not.toBeNull();
    // 強制的に開いている間の状態は保存へ反映しない（マージ待ちが終わったら元の畳んだ状態に戻る）
    expect(window.localStorage.getItem("issue-detail.section.pull-requests")).not.toBe("true");
  });
});
