// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ImagePreviewDialog } from "@/components/dashboard/image-preview-dialog";
import { resetHistoryStack } from "@/lib/history-stack";

describe("ImagePreviewDialog", () => {
  afterEach(() => {
    cleanup();
    resetHistoryStack();
  });

  it("開いている間は画像とファイル名を出し、別タブで開く導線も残す", () => {
    render(
      <ImagePreviewDialog
        image={{ src: "/api/issues/images/abc", name: "kanban.png" }}
        onClose={() => {}}
      />,
    );

    const image = screen.getByAltText("kanban.png");
    expect(image.getAttribute("src")).toBe("/api/issues/images/abc");
    expect(screen.getAllByText("kanban.png").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: /新しいタブで開く/ }).getAttribute("href")).toBe(
      "/api/issues/images/abc",
    );
  });

  it("バツボタンで閉じる", () => {
    const onClose = vi.fn();
    render(
      <ImagePreviewDialog image={{ src: "/img.png", name: "img.png" }} onClose={onClose} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "プレビューを閉じる" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("Escキーで閉じる", () => {
    const onClose = vi.fn();
    render(
      <ImagePreviewDialog image={{ src: "/img.png", name: "img.png" }} onClose={onClose} />,
    );

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("画像の外側を押すと閉じるが、画像そのものを押しても閉じない", () => {
    const onClose = vi.fn();
    render(
      <ImagePreviewDialog image={{ src: "/img.png", name: "img.png" }} onClose={onClose} />,
    );

    const image = screen.getByAltText("img.png");
    fireEvent.click(image);
    expect(onClose).not.toHaveBeenCalled();

    const backdrop = image.parentElement;
    if (!backdrop) throw new Error("画像の外側が無い");
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalled();
  });

  it("閉じているときは何も描画しない", () => {
    render(<ImagePreviewDialog image={null} onClose={() => {}} />);

    expect(screen.queryByRole("button", { name: "プレビューを閉じる" })).toBeNull();
  });

  it("戻る操作で閉じられるよう、開いている間は履歴を1つ積む", () => {
    const onClose = vi.fn();
    const pushState = vi.spyOn(window.history, "pushState");

    const view = render(
      <ImagePreviewDialog image={{ src: "/img.png", name: "img.png" }} onClose={onClose} />,
    );
    expect(pushState).toHaveBeenCalledTimes(1);

    // 積んだエントリが戻る操作で外れたら閉じる
    fireEvent.popState(window);
    expect(onClose).toHaveBeenCalled();

    // 閉じたあとに履歴を巻き戻すのは、自分が積んだエントリが残っているときだけ
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    view.rerender(<ImagePreviewDialog image={null} onClose={onClose} />);
    expect(back).not.toHaveBeenCalled();

    pushState.mockRestore();
    back.mockRestore();
  });

  it("バツボタンで閉じたときは、積んだ履歴エントリを自分で片付ける", () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});

    const view = render(
      <ImagePreviewDialog image={{ src: "/img.png", name: "img.png" }} onClose={() => {}} />,
    );
    view.rerender(<ImagePreviewDialog image={null} onClose={() => {}} />);

    expect(back).toHaveBeenCalledTimes(1);
    back.mockRestore();
  });
});
