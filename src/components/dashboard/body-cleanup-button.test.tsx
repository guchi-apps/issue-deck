// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BodyCleanupButton } from "@/components/dashboard/body-cleanup-button";

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("BodyCleanupButton", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("stackedのときは「音声／整理」を縦に積むが、名前は「音声入力を整理」のまま（#3054）", () => {
    const { rerender } = render(<BodyCleanupButton value="本文" onCleaned={() => {}} />);
    expect(screen.getByRole("button", { name: "音声入力を整理" }).textContent).toBe("音声入力を整理");

    rerender(<BodyCleanupButton value="本文" onCleaned={() => {}} stacked />);
    const stacked = screen.getByRole("button", { name: "音声入力を整理" });
    expect(stacked.textContent).toBe("音声整理");
    expect(stacked.querySelector("br")).not.toBeNull();
  });

  it("入力が空のときはボタンを押せない", () => {
    render(<BodyCleanupButton value="   " onCleaned={() => {}} />);
    const button = screen.getByRole("button", { name: /音声入力を整理/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("押すと整形APIを呼び、整形後のテキストをonCleanedへ渡す", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { text: "整形後の本文" }));
    vi.stubGlobal("fetch", fetchMock);
    const onCleaned = vi.fn();

    render(<BodyCleanupButton value="えーと あの 整形してほしい" onCleaned={onCleaned} />);
    fireEvent.click(screen.getByRole("button", { name: /音声入力を整理/ }));

    await waitFor(() => expect(onCleaned).toHaveBeenCalledWith("整形後の本文"));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/issues/body-cleanup");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      body: "えーと あの 整形してほしい",
    });
  });

  it("トークン未設定（501）のときは案内を表示し、onCleanedを呼ばない", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(501, { error: "not_configured" })));
    const onCleaned = vi.fn();

    render(<BodyCleanupButton value="整形してほしい" onCleaned={onCleaned} />);
    fireEvent.click(screen.getByRole("button", { name: /音声入力を整理/ }));

    await waitFor(() =>
      expect(screen.getByText("選択したAIモデルの認証情報が設定されていません")).not.toBeNull(),
    );
    expect(onCleaned).not.toHaveBeenCalled();
  });

  it("失敗したときはエラーメッセージを表示する", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(502, { message: "整形に失敗しました" })),
    );

    render(<BodyCleanupButton value="整形してほしい" onCleaned={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /音声入力を整理/ }));

    await waitFor(() => expect(screen.getByText("整形に失敗しました")).not.toBeNull());
  });
});
