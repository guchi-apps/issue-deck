// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ImageExtractButton } from "@/components/dashboard/image-extract-button";

const WITH_IMAGE = "保存ボタンを直したい\n\n![a.png](https://example.test/api/issues/images/x.png)";

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe("ImageExtractButton", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("添付画像が無いときは押せない", () => {
    render(<ImageExtractButton value="本文だけ" onChange={() => {}} />);
    expect((screen.getByRole("button", { name: /画像から変更内容を抽出/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("押すと添付画像のURLを送り、変更内容を本文の末尾（画像記法の上）へ足す", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { items: ["保存ボタンを右上へ移動する"], unreadable: false }));
    vi.stubGlobal("fetch", fetchMock);
    const onChange = vi.fn();

    render(<ImageExtractButton value={WITH_IMAGE} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /画像から変更内容を抽出/ }));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/issues/image-extract");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      images: ["https://example.test/api/issues/images/x.png"],
    });
    expect(onChange).toHaveBeenCalledWith(
      "保存ボタンを直したい\n\n## 画像から読み取った変更内容\n- 保存ボタンを右上へ移動する\n\n![a.png](https://example.test/api/issues/images/x.png)",
    );
    await waitFor(() => expect(screen.getByText(/1件の変更内容を本文へ追加しました/)).not.toBeNull());
  });

  it("失敗したときは理由を出し、本文を変えない", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(413, { message: "画像が大きすぎて読み取れません" })));
    const onChange = vi.fn();

    render(<ImageExtractButton value={WITH_IMAGE} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /画像から変更内容を抽出/ }));

    await waitFor(() => expect(screen.getByText("画像が大きすぎて読み取れません")).not.toBeNull());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("認証情報が未設定（501）なら案内を出す", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(501, { error: "not_configured" })));

    render(<ImageExtractButton value={WITH_IMAGE} onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /画像から変更内容を抽出/ }));

    await waitFor(() =>
      expect(screen.getByText("選択したAIモデルの認証情報が設定されていません")).not.toBeNull(),
    );
  });
});
