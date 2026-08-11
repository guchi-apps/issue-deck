// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalSessionSetupDialog } from "@/components/dashboard/local-session-setup-dialog";
import { LOCAL_SESSION_REGISTER_COMMAND, LOCAL_SESSION_TEST_URL } from "@/lib/local-session";

import packageJson from "../../../package.json";

const writeText = vi.fn();

Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: { writeText },
});

const LOCAL_SESSION_COMMAND = "~/.local/share/issue-deck/start-local-session.sh guchi-apps issue-deck 1088";

function renderDialog() {
  return render(
    <LocalSessionSetupDialog
      open
      onOpenChange={vi.fn()}
      localSessionCommand={LOCAL_SESSION_COMMAND}
    />,
  );
}

describe("LocalSessionSetupDialog", () => {
  afterEach(() => {
    cleanup();
    writeText.mockReset();
    window.localStorage.clear();
  });

  it("登録コマンド・動作確認URL・フォールバックコマンドをすべて表示する", () => {
    renderDialog();

    expect(screen.getByText(LOCAL_SESSION_REGISTER_COMMAND)).not.toBeNull();
    expect(screen.getByText(LOCAL_SESSION_TEST_URL)).not.toBeNull();
    expect(screen.getByText(LOCAL_SESSION_COMMAND)).not.toBeNull();
  });

  it("動作確認は実体を作らないよう、実在しない番号のURLへのリンクにする", () => {
    renderDialog();

    const link = screen.getByRole("link", { name: /動作確認する/ });
    expect(link.getAttribute("href")).toBe(LOCAL_SESSION_TEST_URL);
  });

  // 登録できたかは検知できないため、コピーした時点の版を控えて人が照合できるようにする（#1088）
  it("登録コマンドをコピーすると、そのときのバージョンを控える", () => {
    renderDialog();

    expect(screen.getByText(/登録コマンドをコピーした記録はありません/)).not.toBeNull();

    const [registerCopyButton] = screen.getAllByRole("button", { name: /コピー/ });
    fireEvent.click(registerCopyButton);

    expect(writeText).toHaveBeenCalledWith(LOCAL_SESSION_REGISTER_COMMAND);
    expect(window.localStorage.getItem("issue-deck:local-session-registered-version")).toBe(
      packageJson.version,
    );
    expect(screen.getByText(/この版の登録コマンドをコピー済み/)).not.toBeNull();
  });

  it("控えた版が現在の版と異なれば、登録し直しを促す", () => {
    window.localStorage.setItem("issue-deck:local-session-registered-version", "0.0.1");

    renderDialog();

    expect(screen.getByText(/登録し直すことをおすすめします/)).not.toBeNull();
    expect(screen.getByText("v0.0.1")).not.toBeNull();
  });

  it("フォールバックのコピーではバージョンを控えない（登録とは無関係のため）", () => {
    renderDialog();

    const copyButtons = screen.getAllByRole("button", { name: /コピー/ });
    fireEvent.click(copyButtons[copyButtons.length - 1]);

    expect(writeText).toHaveBeenCalledWith(LOCAL_SESSION_COMMAND);
    expect(window.localStorage.getItem("issue-deck:local-session-registered-version")).toBeNull();
  });
});
