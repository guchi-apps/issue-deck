// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImagesSection } from "@/components/dashboard/settings/images-section";
import { resetHistoryStack } from "@/lib/history-stack";
import type { UploadedImage } from "@/types/uploaded-image";

const FILENAME = "0f9c1a2b-3c4d-5e6f-7a8b-9c0d1e2f3a4b.png";

function image(overrides: Partial<UploadedImage> = {}): UploadedImage {
  return {
    filename: FILENAME,
    url: `/api/issues/images/${FILENAME}`,
    size: 2048,
    uploadedAt: "2026-08-29T01:00:00.000Z",
    ...overrides,
  };
}

function stubFetch(images: UploadedImage[]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }
    void input;
    return { ok: true, json: async () => ({ images }) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ImagesSection", () => {
  beforeEach(() => {
    resetHistoryStack();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    resetHistoryStack();
  });

  it("アップロード済み画像をサムネイルで並べ、1枚ずつに削除ボタンを付ける", async () => {
    stubFetch([image()]);
    render(<ImagesSection />);

    expect(await screen.findByLabelText(`${FILENAME} を削除する`)).toBeTruthy();
    expect(screen.getByLabelText(`${FILENAME} を拡大する`)).toBeTruthy();
    expect(screen.getByText(/2KB/)).toBeTruthy();
  });

  it("1枚も無ければその旨を出す", async () => {
    stubFetch([]);
    render(<ImagesSection />);

    expect(await screen.findByText("アップロードされた画像はありません")).toBeTruthy();
  });

  it("24枚を超えるぶんは「さらに表示」を押すまで並べない（原本をそのまま読むため）", async () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      image({
        filename: `${index.toString(16).padStart(8, "0")}-3c4d-5e6f-7a8b-9c0d1e2f3a4b.png`,
        url: `/api/issues/images/${index}.png`,
      }),
    );
    stubFetch(many);
    render(<ImagesSection />);

    await screen.findByLabelText(`${many[0].filename} を拡大する`);
    expect(screen.queryByLabelText(`${many[24].filename} を拡大する`)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /さらに表示（残り6枚）/ }));

    expect(screen.getByLabelText(`${many[24].filename} を拡大する`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /さらに表示/ })).toBeNull();
  });

  it("削除ボタンだけでは消さず、確認して初めてDELETEを投げる", async () => {
    const fetchMock = stubFetch([image()]);
    render(<ImagesSection />);

    fireEvent.click(await screen.findByLabelText(`${FILENAME} を削除する`));
    expect(screen.getByText("この画像を削除しますか？")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "削除する" }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => init?.method === "DELETE" && url === `/api/issues/images/${FILENAME}`,
        ),
      ).toBe(true);
    });
  });

  it("確認をキャンセルすると削除しない", async () => {
    const fetchMock = stubFetch([image()]);
    render(<ImagesSection />);

    fireEvent.click(await screen.findByLabelText(`${FILENAME} を削除する`));
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));

    await waitFor(() => {
      expect(screen.queryByText("この画像を削除しますか？")).toBeNull();
    });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });
});
