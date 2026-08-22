// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CheckUserReasonNotice } from "@/components/dashboard/check-user-reason-notice";
import { CHECK_USER_TARGET_ATTR } from "@/lib/check-user-focus";
import { resolveCheckUserGuidance } from "@/lib/github/check-user-guidance";

function guidanceFor(...args: Parameters<typeof resolveCheckUserGuidance>) {
  const guidance = resolveCheckUserGuidance(...args);
  if (!guidance) throw new Error("理由ラベルのある前提のテスト");
  return guidance;
}

describe("CheckUserReasonNotice", () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  it("見出し・説明・押すボタンの案内・エージェントの状態を出す", () => {
    render(
      <CheckUserReasonNotice
        guidance={guidanceFor({ reason: "plan", placement: "status" })}
      />,
    );
    expect(screen.getByText("計画の承認が必要です")).not.toBeNull();
    expect(screen.getByRole("button", { name: "承認欄へ移動" })).not.toBeNull();
    expect(screen.getByText("待機中")).not.toBeNull();
  });

  /**
   * #2057。以前はパネルの4行目に「待機中 承認するまで実装は始まりません」という段があり、
   * 補足文は説明文かボタンの案内の言い換えだった。タグは見出しと同じ行へ寄せる。
   */
  it("エージェントの状態は見出しと同じ行に置き、補足文は出さない（#2057）", () => {
    render(<CheckUserReasonNotice guidance={guidanceFor({ reason: "plan", placement: "status" })} />);

    const heading = screen.getByText("計画の承認が必要です");
    expect(heading.parentElement?.textContent).toContain("待機中");
    expect(screen.queryByText("承認するまで実装は始まりません")).toBeNull();
  });

  it("移動ボタンを押すと、その操作をする場所までスクロールする", () => {
    const target = document.createElement("div");
    target.setAttribute(CHECK_USER_TARGET_ATTR, "approval");
    target.scrollIntoView = vi.fn();
    document.body.append(target);

    render(
      <CheckUserReasonNotice guidance={guidanceFor({ reason: "blocked", placement: "status" })} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "承認欄へ移動" }));
    expect(target.scrollIntoView).toHaveBeenCalled();
  });

  it("セッションが入力待ちのときはRemote Controlを開くリンクを出す", () => {
    render(
      <CheckUserReasonNotice
        guidance={guidanceFor({
          reason: "input",
          placement: "status",
          sessionWaitingInput: true,
          remoteControlUrl: "https://claude.ai/code/session_abc",
        })}
      />,
    );
    const link = screen.getByRole("link", { name: /Remote Controlで開く/ });
    expect(link.getAttribute("href")).toBe("https://claude.ai/code/session_abc");
  });

  it("承認カードの中では移動ボタンを出さない（そこが目的地のため）", () => {
    render(
      <CheckUserReasonNotice guidance={guidanceFor({ reason: "plan", placement: "approval" })} />,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});
