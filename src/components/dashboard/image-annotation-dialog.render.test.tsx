// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ImageAnnotationDialog,
  annotatedFileName,
} from "@/components/dashboard/image-annotation-dialog";
import { resetHistoryStack } from "@/lib/history-stack";

// jsdomは画像を読み込まずcanvasも描けないので、読み込み完了と描画先を差し替える
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 800;
  naturalHeight = 600;
  set src(_value: string) {
    queueMicrotask(() => this.onload?.());
  }
}

const noop = () => {};
const fakeContext = new Proxy(
  { measureText: () => ({ width: 40 }) },
  { get: (target, key) => (key in target ? target[key as keyof typeof target] : noop), set: () => true },
);

beforeEach(() => {
  vi.stubGlobal("Image", FakeImage);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    fakeContext as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (callback, type) {
    callback(new Blob(["x"], { type: type ?? "image/png" }));
  });
});

afterEach(() => {
  cleanup();
  resetHistoryStack();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderEditor(overrides: Partial<Parameters<typeof ImageAnnotationDialog>[0]> = {}) {
  const props = {
    image: { src: "/api/issues/images/abc", name: "shot.png" },
    onClose: vi.fn(),
    onSave: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  render(<ImageAnnotationDialog {...props} />);
  const canvas = await screen.findByLabelText("shot.png への書き込み");
  return { ...props, canvas };
}

function drawArrow(canvas: HTMLElement) {
  fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
  fireEvent.pointerMove(canvas, { clientX: 120, clientY: 90, pointerId: 1 });
  fireEvent.pointerUp(canvas, { clientX: 120, clientY: 90, pointerId: 1 });
}

/** 2本指で距離100→200へ広げる（中心は固定）。ズーム倍率が2倍になる操作 */
function pinchZoomIn(canvas: HTMLElement) {
  fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100, pointerId: 1 });
  fireEvent.pointerDown(canvas, { clientX: 200, clientY: 100, pointerId: 2 });
  fireEvent.pointerMove(canvas, { clientX: 50, clientY: 100, pointerId: 1 });
  fireEvent.pointerMove(canvas, { clientX: 250, clientY: 100, pointerId: 2 });
}

describe("ImageAnnotationDialog", () => {
  it("暗幕を別の要素で重ねず、中身だけが不透明な全画面の層になる（#3006）", async () => {
    await renderEditor();
    // 暗幕を置くとiOS Safariが中身より上に描き、画面全体を覆って入力を奪った
    expect(document.querySelector("[data-radix-dialog-overlay], [data-slot='dialog-overlay']")).toBeNull();
    const fixedLayers = [...document.body.querySelectorAll<HTMLElement>(".fixed.inset-0")];
    expect(fixedLayers).toHaveLength(1);
    expect(fixedLayers[0].dataset.slot).toBe("image-annotation");
    expect(fixedLayers[0].className).toContain("bg-neutral-950");
  });

  it("道具を切り替えると押された状態が移る", async () => {
    await renderEditor();
    expect(screen.getByRole("button", { name: /ペン/ }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /矢印/ }));
    expect(screen.getByRole("button", { name: /矢印/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /ペン/ }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "青" }));
    expect(screen.getByRole("button", { name: "青" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("何も書いていなければ保存できず、キャンセルでそのまま閉じる", async () => {
    const { onClose } = await renderEditor();
    const [save] = screen.getAllByRole("button", { name: "保存して差し替え" });
    expect(save).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("書いてから保存すると、書き込み済みのPNGを渡して閉じる", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { canvas, onClose } = await renderEditor({ onSave });
    fireEvent.click(screen.getByRole("button", { name: /矢印/ }));
    drawArrow(canvas);

    const [save] = screen.getAllByRole("button", { name: "保存して差し替え" });
    expect(save).toHaveProperty("disabled", false);
    await act(async () => {
      fireEvent.click(save);
    });

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const file = onSave.mock.calls[0][0] as File;
    expect(file.name).toBe("shot-annotated.png");
    expect(file.type).toBe("image/png");
  });

  it("保存に失敗したら閉じずにエラーを出す", async () => {
    const { canvas, onClose } = await renderEditor({
      onSave: vi.fn().mockRejectedValue(new Error("upload_failed")),
    });
    drawArrow(canvas);
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "保存して差し替え" })[0]);
    });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("書きかけで閉じようとすると確認を出し、元に戻すで書く前に戻せる", async () => {
    const { canvas, onClose } = await renderEditor();
    drawArrow(canvas);

    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "編集を続ける" }));

    fireEvent.click(screen.getAllByRole("button", { name: "元に戻す" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("2本指でつまむと拡大でき、全体表示に戻すボタンでリセットできる", async () => {
    const { canvas } = await renderEditor();
    const wrapper = canvas.parentElement as HTMLElement;
    expect(wrapper.style.transform).toBe("translate(0px, 0px) scale(1)");

    const resetButtons = () => screen.getAllByRole("button", { name: "全体表示に戻す" });
    expect(resetButtons()[0]).toHaveProperty("disabled", true);

    pinchZoomIn(canvas);
    expect(wrapper.style.transform).toBe("translate(0px, 0px) scale(2)");
    expect(resetButtons()[0]).toHaveProperty("disabled", false);

    fireEvent.click(resetButtons()[0]);
    expect(wrapper.style.transform).toBe("translate(0px, 0px) scale(1)");
    expect(resetButtons()[0]).toHaveProperty("disabled", true);
  });

  it("ピンチへ切り替わると進行中のペンの書き込みを破棄する", async () => {
    const { canvas } = await renderEditor();
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 50, clientY: 50, pointerId: 1 });
    // 2本目が触れた時点でピンチへ切り替わり、1本目の書きかけは失われる
    fireEvent.pointerDown(canvas, { clientX: 200, clientY: 10, pointerId: 2 });
    fireEvent.pointerUp(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 200, clientY: 10, pointerId: 2 });

    expect(screen.getAllByRole("button", { name: "保存して差し替え" })[0]).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("文字は押した場所に入力欄を出し、Enterで確定する", async () => {
    const { canvas } = await renderEditor();
    fireEvent.click(screen.getByRole("button", { name: /文字/ }));
    fireEvent.pointerDown(canvas, { clientX: 30, clientY: 40, pointerId: 1 });

    const input = screen.getByLabelText("書き込む文字");
    fireEvent.change(input, { target: { value: "反映待ち" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.queryByLabelText("書き込む文字")).toBeNull();
    expect(screen.getAllByRole("button", { name: "保存して差し替え" })[0]).toHaveProperty(
      "disabled",
      false,
    );
  });
});

describe("annotatedFileName", () => {
  it("拡張子を出力形式に合わせ、2回目以降は接尾辞を重ねない", () => {
    expect(annotatedFileName("shot.png", "image/png")).toBe("shot-annotated.png");
    expect(annotatedFileName("photo.jpeg", "image/jpeg")).toBe("photo-annotated.jpg");
    expect(annotatedFileName("shot-annotated.png", "image/png")).toBe("shot-annotated.png");
    expect(annotatedFileName("", "image/png")).toBe("image-annotated.png");
  });
});
