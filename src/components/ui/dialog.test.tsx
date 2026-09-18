// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { ImageAnnotationDialog } from "@/components/dashboard/image-annotation-dialog";
import { Dialog, DialogContent, useDialogOverlayDisabled } from "@/components/ui/dialog";

afterEach(cleanup);

describe("DialogContent", () => {
  it("共有Contextの状態を切り替えられる", async () => {
    function Controls() {
      const setOverlayDisabled = useDialogOverlayDisabled();
      return (
        <>
          <button onClick={() => setOverlayDisabled(true)}>退避</button>
          <button onClick={() => setOverlayDisabled(false)}>復元</button>
        </>
      );
    }
    render(<Dialog open><DialogContent><Controls /></DialogContent></Dialog>);
    fireEvent.click(screen.getByRole("button", { name: "退避" }));
    await waitFor(() => expect(document.querySelector('[data-slot="dialog-overlay"]')?.className).toContain("pointer-events-none"));
    fireEvent.click(screen.getByRole("button", { name: "復元" }));
    await waitFor(() => expect(document.querySelector('[data-slot="dialog-overlay"]')?.className).not.toContain("pointer-events-none"));
  });

  it("入れ子の書き込み画面を開く間は親の暗幕を退避し、閉じると復元する", async () => {
    function Harness() {
      const [image, setImage] = useState<{ src: string; name: string } | null>({
        src: "/img.png",
        name: "img.png",
      });
      return (
        <Dialog open>
          <DialogContent>
            <ImageAnnotationDialog image={image} onClose={() => setImage(null)} onSave={async () => {}} />
          </DialogContent>
        </Dialog>
      );
    }

    render(<Harness />);
    const getOverlay = () => document.querySelector('[data-slot="dialog-overlay"]');
    await waitFor(() => expect(getOverlay()?.className).toContain("pointer-events-none"));
    expect(getOverlay()?.className).toContain("bg-transparent");
    expect(getOverlay()?.className).not.toContain("bg-black/10");
    expect(getOverlay()?.className).not.toContain("backdrop-blur-xs");

    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "キャンセル" })).toBeNull());
    await waitFor(() => expect(getOverlay()?.className).not.toContain("pointer-events-none"));
    expect(getOverlay()?.className).toContain("bg-black/10");
    expect(getOverlay()?.className).toContain("backdrop-blur-xs");
  });

  it("書き込み画面が無いときは通常の暗幕を描画する", () => {
    render(
      <Dialog open>
        <DialogContent>内容</DialogContent>
      </Dialog>,
    );

    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    expect(overlay?.className).toContain("bg-black/10");
    expect(overlay?.className).toContain("backdrop-blur-xs");
  });
});
