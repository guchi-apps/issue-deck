// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImagesSection } from "@/components/dashboard/settings/images-section";
import { resetHistoryStack } from "@/lib/history-stack";
import { summarizeUploadedImages } from "@/lib/uploaded-images";
import type { UploadedImage, UploadedImageListResponse } from "@/types/uploaded-image";

const FILENAME = "0f9c1a2b-3c4d-5e6f-7a8b-9c0d1e2f3a4b.png";

/** 容量サマリーの凡例（枚数とバイト数）を1行ずつの文字列にする */
function legendText(within: typeof screen): string[] {
  return within
    .getAllByRole("listitem")
    .map((item) => item.textContent?.replace(/\s+/g, " ").trim() ?? "")
    .filter((text) => /枚 \//.test(text));
}

function image(overrides: Partial<UploadedImage> = {}): UploadedImage {
  return {
    filename: FILENAME,
    url: `/api/issues/images/${FILENAME}`,
    size: 2048,
    uploadedAt: "2026-08-29T01:00:00.000Z",
    usage: "used",
    references: [
      { repositoryFullName: "guchi-apps/issue-deck", issueNumber: 2475, isPullRequest: false },
    ],
    ...overrides,
  };
}

function listResponse(
  images: UploadedImage[],
  overrides: Partial<UploadedImageListResponse> = {},
): UploadedImageListResponse {
  return {
    images,
    summary: summarizeUploadedImages(images, []),
    scan: {
      completedAt: "2026-08-29T02:00:00.000Z",
      repositoryCount: 3,
      scannedRepositoryCount: 3,
    },
    cleanup: { enabled: false, retentionDays: 30, trashDays: 30 },
    ...overrides,
  };
}

function stubFetch(response: UploadedImageListResponse) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }
    if (init?.method === "PATCH") {
      return { ok: true, json: async () => response.cleanup } as Response;
    }
    if (init?.method === "POST") {
      return { ok: true, json: async () => ({ ok: true, count: 1, size: 2048 }) } as Response;
    }
    void input;
    return { ok: true, json: async () => response } as Response;
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
    stubFetch(listResponse([image()]));
    render(<ImagesSection />);

    expect(await screen.findByLabelText(`${FILENAME} を削除する`)).toBeTruthy();
    expect(screen.getByLabelText(`${FILENAME} を拡大する`)).toBeTruthy();
    expect(screen.getByText(/2KB/)).toBeTruthy();
  });

  it("1枚も無ければその旨を出す", async () => {
    stubFetch(listResponse([]));
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
    stubFetch(listResponse(many));
    render(<ImagesSection />);

    await screen.findByLabelText(`${many[0].filename} を拡大する`);
    expect(screen.queryByLabelText(`${many[24].filename} を拡大する`)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /さらに表示（残り6枚）/ }));

    expect(screen.getByLabelText(`${many[24].filename} を拡大する`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /さらに表示/ })).toBeNull();
  });

  it("削除ボタンだけでは消さず、確認して初めてDELETEを投げる", async () => {
    const fetchMock = stubFetch(listResponse([image()]));
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
    const fetchMock = stubFetch(listResponse([image()]));
    render(<ImagesSection />);

    fireEvent.click(await screen.findByLabelText(`${FILENAME} を削除する`));
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));

    await waitFor(() => {
      expect(screen.queryByText("この画像を削除しますか？")).toBeNull();
    });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });

  it("容量の内訳を使用中・未使用に分けて出す（#2475）", async () => {
    stubFetch(
      listResponse([
        image({ size: 3 * 1024 * 1024 }),
        image({
          filename: "1f9c1a2b-3c4d-5e6f-7a8b-9c0d1e2f3a4b.png",
          size: 1024 * 1024,
          usage: "unused",
          references: [],
        }),
      ]),
    );
    render(<ImagesSection />);

    expect(await screen.findByText("4.0MB")).toBeTruthy();
    // 内訳（使用中3.0MB / 未使用1.0MB）が凡例に出る
    expect(legendText(screen)).toEqual(["使用中 1枚 / 3.0MB", "未使用 1枚 / 1.0MB"]);
    expect(screen.getByRole("button", { name: "使用中 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "未使用 1" })).toBeTruthy();
  });

  it("参照の確認が一巡していない間は「確認中」と出し、未使用として扱わない（#2475）", async () => {
    stubFetch(
      listResponse([image({ usage: "unknown", references: [] })], {
        scan: { completedAt: null, repositoryCount: 3, scannedRepositoryCount: 1 },
      }),
    );
    render(<ImagesSection />);

    expect(await screen.findByText("確認中")).toBeTruthy();
    expect(screen.getByText(/すべてのIssueとコメントを一度確認し終えるまで/)).toBeTruthy();
    // 未使用が0枚なので一括操作のボタンは出ない
    expect(screen.queryByRole("button", { name: /ゴミ箱へ/ })).toBeNull();
  });

  it("未使用をまとめてゴミ箱へ移すのは、確認してから（#2475）", async () => {
    const fetchMock = stubFetch(
      listResponse([
        image({ usage: "unused", references: [], uploadedAt: "2020-01-01T00:00:00.000Z" }),
      ]),
    );
    render(<ImagesSection />);

    fireEvent.click(await screen.findByRole("button", { name: /未使用1枚をゴミ箱へ/ }));
    expect(screen.getByText("未使用の1枚をゴミ箱へ移しますか？")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "ゴミ箱へ移す" }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => init?.method === "POST" && url === "/api/issues/images/cleanup",
        ),
      ).toBe(true);
    });
  });

  it("自動削除の切り替えは保存ボタンを介さずその場で保存する（#2475）", async () => {
    const fetchMock = stubFetch(listResponse([image()]));
    render(<ImagesSection />);

    fireEvent.click(await screen.findByRole("checkbox", { name: /未使用の画像を自動で/ }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => init?.method === "PATCH" && url === "/api/settings/image-cleanup",
        ),
      ).toBe(true);
    });
  });
});
