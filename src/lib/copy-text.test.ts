// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { copyText } from "@/lib/copy-text";

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", { value, configurable: true });
}

function setExecCommand(value: unknown) {
  Object.defineProperty(document, "execCommand", { value, configurable: true });
}

afterEach(() => {
  setClipboard(undefined);
  setExecCommand(undefined);
});

describe("copyText", () => {
  it("navigator.clipboardが使えるときはそれでコピーする", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });

    await expect(copyText("ssh vps")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("ssh vps");
  });

  // tailnet経由（http）で開発サーバーを見るときは`navigator.clipboard`自体が生えない
  it("navigator.clipboardが無いときはexecCommandへ落とす", async () => {
    setClipboard(undefined);
    const execCommand = vi.fn().mockReturnValue(true);
    setExecCommand(execCommand);

    await expect(copyText("ssh vps")).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
    // 一時的に作ったtextareaを画面に残さない
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  });

  it("clipboardが権限拒否で落ちてもexecCommandを試す", async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error("denied")) });
    setExecCommand(vi.fn().mockReturnValue(true));

    await expect(copyText("ssh vps")).resolves.toBe(true);
  });

  it("どちらも使えなければfalseを返す", async () => {
    setClipboard(undefined);
    setExecCommand(undefined);

    await expect(copyText("ssh vps")).resolves.toBe(false);
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  });
});
