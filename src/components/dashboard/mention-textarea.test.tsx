// @vitest-environment jsdom
import { render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MentionTextarea } from "@/components/dashboard/mention-textarea";

function Harness() {
  const [value, setValue] = useState("");
  return <MentionTextarea value={value} onChange={setValue} />;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeFile(name: string, type = "image/png") {
  return new File(["dummy"], name, { type });
}

function setInputFiles(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, "files", { value: files, configurable: true });
}

describe("MentionTextarea 複数画像アップロード", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("2枚を同時添付し、完了順が逆でも両方の画像参照が本文に残る", async () => {
    const first = deferred<{ ok: boolean; json: () => Promise<{ url: string }> }>();
    const second = deferred<{ ok: boolean; json: () => Promise<{ url: string }> }>();
    let callCount = 0;
    const fetchMock = vi.fn(() => {
      callCount += 1;
      return callCount === 1 ? first.promise : second.promise;
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<Harness />);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const [fileA, fileB] = [makeFile("a.png"), makeFile("b.png")];
    setInputFiles(fileInput, [fileA, fileB]);
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // 後に開始した2枚目のアップロードが先に完了するケース（完了順の逆転）。
    second.resolve({ ok: true, json: () => Promise.resolve({ url: "/api/issues/images/b.png" }) });
    await waitFor(() => {
      const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
      expect(textarea.value).toContain("b.png");
    });
    first.resolve({ ok: true, json: () => Promise.resolve({ url: "/api/issues/images/a.png" }) });

    await waitFor(() => {
      const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
      expect(textarea.value).toContain("a.png");
      expect(textarea.value).toContain("b.png");
    });
  });

  it("アップロード中は onUploadingChange(true) 、全件完了後に false を通知する", async () => {
    const first = deferred<{ ok: boolean; json: () => Promise<{ url: string }> }>();
    const second = deferred<{ ok: boolean; json: () => Promise<{ url: string }> }>();
    let callCount = 0;
    const fetchMock = vi.fn(() => {
      callCount += 1;
      return callCount === 1 ? first.promise : second.promise;
    });
    vi.stubGlobal("fetch", fetchMock);

    const onUploadingChange = vi.fn();
    function Wrapped() {
      const [value, setValue] = useState("");
      return <MentionTextarea value={value} onChange={setValue} onUploadingChange={onUploadingChange} />;
    }
    const { container } = render(<Wrapped />);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    setInputFiles(fileInput, [makeFile("a.png"), makeFile("b.png")]);
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    await waitFor(() => expect(onUploadingChange).toHaveBeenCalledWith(true));

    first.resolve({ ok: true, json: () => Promise.resolve({ url: "/api/issues/images/a.png" }) });
    await waitFor(() => {
      const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
      expect(textarea.value).toContain("a.png");
    });
    // 1枚目だけ完了した時点ではまだ2枚目がアップロード中のはず。
    expect(onUploadingChange).not.toHaveBeenLastCalledWith(false);

    second.resolve({ ok: true, json: () => Promise.resolve({ url: "/api/issues/images/b.png" }) });
    await waitFor(() => expect(onUploadingChange).toHaveBeenLastCalledWith(false));
  });
});
