// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  composeAttachments,
  MentionTextarea,
  splitAttachments,
} from "@/components/dashboard/mention-textarea";

/** 呼び出し元が保持する値（value）を画面に出して、テストから中身を確かめられるようにする */
function Harness({
  initialValue = "",
  ...props
}: { initialValue?: string } & Partial<ComponentProps<typeof MentionTextarea>>) {
  const [value, setValue] = useState(initialValue);
  return (
    <>
      <MentionTextarea value={value} onChange={setValue} {...props} />
      <output data-testid="value">{value}</output>
    </>
  );
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

function emittedValue(container: HTMLElement) {
  return container.querySelector('[data-testid="value"]')?.textContent ?? "";
}

function attachedNames(container: HTMLElement) {
  return Array.from(container.querySelectorAll('[data-slot="mention-attachments"] img')).map(
    (img) => img.getAttribute("alt"),
  );
}

describe("MentionTextarea 複数画像アップロード", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("2枚を同時添付し、完了順が逆でも両方がサムネイルと本文に残る", async () => {
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
    await waitFor(() => expect(attachedNames(container)).toEqual(["b.png"]));
    first.resolve({ ok: true, json: () => Promise.resolve({ url: "/api/issues/images/a.png" }) });

    await waitFor(() => expect(attachedNames(container)).toEqual(["b.png", "a.png"]));
    expect(emittedValue(container)).toBe(
      "![b.png](/api/issues/images/b.png)\n![a.png](/api/issues/images/a.png)",
    );
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
    await waitFor(() => expect(attachedNames(container)).toEqual(["a.png"]));
    // 1枚目だけ完了した時点ではまだ2枚目がアップロード中のはず。
    expect(onUploadingChange).not.toHaveBeenLastCalledWith(false);

    second.resolve({ ok: true, json: () => Promise.resolve({ url: "/api/issues/images/b.png" }) });
    await waitFor(() => expect(onUploadingChange).toHaveBeenLastCalledWith(false));
  });
});

describe("MentionTextarea 画像の添付", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubUpload(url: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ url }) })),
    );
  }

  async function attach(container: HTMLElement, file: File) {
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    setInputFiles(fileInput, [file]);
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => expect(attachedNames(container).length).toBeGreaterThan(0));
  }

  it("カーソルが文の途中にあっても、本文は変わらず画像は末尾に付く", async () => {
    stubUpload("/api/issues/images/shot.png");
    const { container } = render(<Harness />);
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "手順3の画面です。あとで補足します。" } });
    textarea.setSelectionRange(9, 9);

    await attach(container, makeFile("shot.png"));

    // 入力欄の文字は添付前のまま。URLの文字も出ない。
    expect(textarea.value).toBe("手順3の画面です。あとで補足します。");
    expect(textarea.value).not.toContain("/api/issues/images/");
    expect(emittedValue(container)).toBe(
      "手順3の画面です。あとで補足します。\n\n![shot.png](/api/issues/images/shot.png)",
    );
  });

  it("サムネイルの×で、その画像だけが本文から外れる", async () => {
    const { container } = render(
      <Harness initialValue={"再現手順です。\n\n![a.png](/img/a.png)\n![b.png](/img/b.png)"} />,
    );

    expect(attachedNames(container)).toEqual(["a.png", "b.png"]);
    fireEvent.click(container.querySelector('[aria-label="a.png の添付を取り消す"]') as HTMLElement);

    expect(attachedNames(container)).toEqual(["b.png"]);
    expect(emittedValue(container)).toBe("再現手順です。\n\n![b.png](/img/b.png)");
  });

  // #3286
  it("SVGを選べる（ファイル選択の候補に含まれ、アップロードされる）", async () => {
    stubUpload("/api/issues/images/icon.svg");
    const { container } = render(<Harness />);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput.accept).toContain("image/svg+xml");

    await attach(container, makeFile("icon.svg", "image/svg+xml"));

    expect(emittedValue(container)).toBe("![icon.svg](/api/issues/images/icon.svg)");
  });

  it("SVGのサムネイルには「SVG」の印が付き、書き込みボタンは出さない（PNGには出す）", () => {
    const { container } = render(
      <Harness initialValue={"![a.png](/img/a.png)\n![icon.svg](/api/issues/images/icon.svg)"} />,
    );

    expect(container.querySelector('[aria-label="a.png に書き込む"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="icon.svg に書き込む"]')).toBeNull();
    // 取り消しは従来どおり使える
    expect(container.querySelector('[aria-label="icon.svg の添付を取り消す"]')).not.toBeNull();
    const badges = Array.from(container.querySelectorAll('[data-slot="mention-attachments"] span')).filter(
      (el) => el.textContent === "SVG",
    );
    expect(badges).toHaveLength(1);
  });

  it("SVGのプレビューには「書き込む」を出さない", () => {
    const { container } = render(<Harness initialValue={"![icon.svg](/api/issues/images/icon.svg)"} />);

    fireEvent.click(container.querySelector('[title="icon.svg（拡大する）"]') as HTMLElement);

    expect(document.querySelector('[data-slot="image-preview"]')).not.toBeNull();
    expect(screen.queryByRole("button", { name: "書き込む" })).toBeNull();
    // 開いたままだと次のテストへ残る（この環境は自動でDOMを片付けない）
    fireEvent.click(document.querySelector('[aria-label="プレビューを閉じる"]') as HTMLElement);
  });

  it("SVGとして読み取れないと判定されたときは、その旨を出して添付しない", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({ ok: false, status: 415, json: () => Promise.resolve({ error: "invalid_svg" }) }),
      ),
    );
    const { container } = render(<Harness />);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    setInputFiles(fileInput, [makeFile("broken.svg", "image/svg+xml")]);
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    expect(await screen.findByText("SVGとして読み取れないファイルです")).toBeTruthy();
    expect(attachedNames(container)).toEqual([]);
  });

  // 別タブに開くとホーム画面から起動したアプリで戻れなくなるため、アプリ内で開く（#2065）
  it("サムネイルを押すとプレビューが開き、バツボタンで閉じる", () => {
    const { container } = render(<Harness initialValue={"![a.png](/img/a.png)"} />);

    expect(document.querySelector('[aria-label="プレビューを閉じる"]')).toBeNull();

    fireEvent.click(container.querySelector('[title="a.png（拡大する）"]') as HTMLElement);
    const close = document.querySelector('[aria-label="プレビューを閉じる"]') as HTMLElement;
    expect(close).not.toBeNull();

    fireEvent.click(close);
    expect(document.querySelector('[aria-label="プレビューを閉じる"]')).toBeNull();
  });

  // #2972。書き込みを保存すると、同じ位置の添付が新しい画像に置き換わる（名前はそのまま）
  it("サムネイルのペンから書き込んで保存すると、その添付だけが新しい画像に差し替わる", async () => {
    stubUpload("/api/issues/images/annotated.png");
    vi.stubGlobal(
      "Image",
      class {
        onload: (() => void) | null = null;
        naturalWidth = 400;
        naturalHeight = 300;
        set src(_value: string) {
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    const noop = () => {};
    const ctx = new Proxy({}, { get: () => noop, set: () => true });
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const toBlob = vi
      .spyOn(HTMLCanvasElement.prototype, "toBlob")
      .mockImplementation((callback) => callback(new Blob(["x"], { type: "image/png" })));

    const { container } = render(
      <Harness initialValue={"![a.png](/img/a.png)\n![b.png](/img/b.png)"} />,
    );
    fireEvent.click(container.querySelector('[aria-label="a.png に書き込む"]') as HTMLElement);

    const canvas = await screen.findByLabelText("a.png への書き込み");
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 80, clientY: 60, pointerId: 1 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    fireEvent.click(screen.getAllByRole("button", { name: "保存して差し替え" })[0]);

    await waitFor(() =>
      expect(emittedValue(container)).toBe(
        "![a.png](/api/issues/images/annotated.png)\n![b.png](/img/b.png)",
      ),
    );
    getContext.mockRestore();
    toBlob.mockRestore();
  });

  // #3424。プレビューから書き込んで保存すると、戻ったプレビューも書き込み後の画像を出す
  it("プレビューから書き込んで保存すると、開いたままのプレビューが新しい画像に切り替わる", async () => {
    stubUpload("/api/issues/images/annotated.png");
    vi.stubGlobal(
      "Image",
      class {
        onload: (() => void) | null = null;
        naturalWidth = 400;
        naturalHeight = 300;
        set src(_value: string) {
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    const noop = () => {};
    const ctx = new Proxy({}, { get: () => noop, set: () => true });
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const toBlob = vi
      .spyOn(HTMLCanvasElement.prototype, "toBlob")
      .mockImplementation((callback) => callback(new Blob(["x"], { type: "image/png" })));

    const { container } = render(<Harness initialValue={"![a.png](/img/a.png)"} />);
    fireEvent.click(container.querySelector('[title="a.png（拡大する）"]') as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "書き込む" }));

    const canvas = await screen.findByLabelText("a.png への書き込み");
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 80, clientY: 60, pointerId: 1 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    fireEvent.click(screen.getAllByRole("button", { name: "保存して差し替え" })[0]);

    await waitFor(() =>
      expect(document.querySelector('[data-slot="image-preview"] img')?.getAttribute("src")).toBe(
        "/api/issues/images/annotated.png",
      ),
    );
    getContext.mockRestore();
    toBlob.mockRestore();
    fireEvent.click(document.querySelector('[aria-label="プレビューを閉じる"]') as HTMLElement);
  });

  it("末尾に画像記法を含む本文を渡すと、入力欄にURLを出さずサムネイルとして表示する", () => {
    const { container } = render(
      <Harness initialValue={"再現手順です。\n\n![a.png](/img/a.png)"} />,
    );
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;

    expect(textarea.value).toBe("再現手順です。");
    expect(attachedNames(container)).toEqual(["a.png"]);
  });
});

/**
 * #1929。Issue作成フォームをスマホ一画面に収めるため、入力欄の下を1行にまとめた。
 */
describe("MentionTextarea 入力欄の下の行", () => {
  function buttonNames(container: HTMLElement) {
    // 「画像を添付」は文字を出さないアイコンだけのボタンなので、名前はaria-labelから読む（#3074）
    return Array.from(container.querySelectorAll('[data-slot="mention-toolbar"] button')).map(
      (button) => button.getAttribute("aria-label") ?? button.textContent,
    );
  }

  it("添付のサムネイルと「画像を添付」を同じ行に並べる", () => {
    const { container } = render(
      <Harness initialValue={"再現手順です。\n\n![a.png](/img/a.png)"} />,
    );
    const toolbar = container.querySelector('[data-slot="mention-toolbar"]') as HTMLElement;

    // サムネイルの列と操作が、別々の行ではなく同じ行の中に並ぶ
    expect(toolbar.querySelector('[data-slot="mention-attachments"] img')).not.toBeNull();
    expect(buttonNames(container)).toContain("画像を添付");
  });

  it("プレビューへの切り替えは既定で出し、showPreviewToggleで消せる", () => {
    const shown = render(<Harness initialValue="本文" />);
    expect(buttonNames(shown.container)).toContain("プレビュー");
    shown.unmount();

    const hidden = render(<Harness initialValue="本文" showPreviewToggle={false} />);
    expect(buttonNames(hidden.container)).not.toContain("プレビュー");
    expect(buttonNames(hidden.container)).toContain("画像を添付");
  });

  /**
   * #3068。「画像を添付」は最右のサムネイルのすぐ右に並ぶ。サムネイルの列が伸びて操作を
   * 右端へ押しやると、画像が1枚のときに間が大きく空く（列は縮むだけで、伸びない）
   */
  it("サムネイルの列の直後に「画像を添付」が並び、列は伸びない", () => {
    const { container } = render(
      <Harness initialValue={"再現手順です。\n\n![a.png](/img/a.png)"} />,
    );
    const strip = container.querySelector('[data-slot="mention-attachments"]') as HTMLElement;
    const attach = container.querySelector(
      '[data-slot="mention-toolbar"] button[aria-label="画像を添付"]',
    ) as HTMLElement;

    // 列の次の要素が操作の並び（画像を添付を含む）で、列は縮むだけ（flex-1で伸ばさない）
    expect(strip.nextElementSibling?.contains(attach)).toBe(true);
    expect(strip.className).toContain("min-w-0");
    expect(strip.className).not.toContain("flex-1");
    // 操作は行が詰まっても縮まない（はみ出したサムネイルの側が見切れる）
    expect(attach.parentElement?.className).toContain("shrink-0");
  });

  /**
   * #3074。「画像添付」の文字は出さず、アイコンだけを点線の四角で囲む。文字が無くても
   * 名前（読み上げ・ホバー）は残る。
   */
  it("「画像を添付」は文字を出さないアイコンだけの点線枠で、名前はaria-labelに残る", () => {
    const { container } = render(<Harness initialValue="本文" />);
    const attach = container.querySelector(
      '[data-slot="mention-toolbar"] button[aria-label="画像を添付"]',
    ) as HTMLElement;

    expect(attach.textContent).toBe("");
    expect(attach.querySelector("svg")).not.toBeNull();
    expect(attach.getAttribute("title")).toBe("画像を添付");
    expect(attach.className).toContain("border-dashed");
  });

  it("アップロード中も文字は出さず、押せない薄いアイコンのまま名前が「アップロード中」になる", async () => {
    const pending = deferred<{ ok: boolean; json: () => Promise<{ url: string }> }>();
    vi.stubGlobal("fetch", vi.fn(() => pending.promise));

    const { container } = render(<Harness initialValue="本文" />);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    setInputFiles(fileInput, [makeFile("a.png")]);
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    const busy = await waitFor(() => {
      const button = container.querySelector(
        '[data-slot="mention-toolbar"] button[aria-label="アップロード中"]',
      ) as HTMLButtonElement | null;
      expect(button).not.toBeNull();
      return button as HTMLButtonElement;
    });
    expect(busy.textContent).toBe("");
    expect(busy.disabled).toBe(true);
    // 回るスピナーはサムネイル列の点線枠が持つ。ボタンには出さず、点線＋スピナーを2種類並べない
    expect(busy.querySelector("svg.animate-spin")).toBeNull();
    expect(container.querySelector('[data-slot="mention-attachments"] svg.animate-spin')).not.toBeNull();

    pending.resolve({ ok: true, json: () => Promise.resolve({ url: "/api/issues/images/a.png" }) });
    await waitFor(() =>
      expect(container.querySelector('button[aria-label="画像を添付"]')).not.toBeNull(),
    );
    vi.unstubAllGlobals();
  });
});

describe("splitAttachments / composeAttachments", () => {
  it("末尾に並ぶ画像記法だけを添付として切り出す", () => {
    expect(splitAttachments("本文\n\n![a.png](/img/a.png)\n![b.png](/img/b.png)")).toEqual({
      body: "本文",
      attachments: [
        { name: "a.png", url: "/img/a.png" },
        { name: "b.png", url: "/img/b.png" },
      ],
    });
  });

  it("文章の途中に書かれた画像記法は本文の文字として残す", () => {
    const value = "前置き\n![a.png](/img/a.png)\nあとがき";
    expect(splitAttachments(value)).toEqual({ body: value, attachments: [] });
  });

  it("添付が無いときは本文の末尾の改行を削らない", () => {
    expect(composeAttachments("書きかけ\n\n", [])).toBe("書きかけ\n\n");
    expect(splitAttachments("書きかけ\n\n")).toEqual({ body: "書きかけ\n\n", attachments: [] });
  });

  it("分解と合成が往復する", () => {
    const value = "本文\n\n![a.png](/img/a.png)";
    const { body, attachments } = splitAttachments(value);
    expect(composeAttachments(body, attachments)).toBe(value);
    // 本文が空でも先頭に空行を作らない。
    expect(composeAttachments("", attachments)).toBe("![a.png](/img/a.png)");
  });
});

// iOS Safariはfont-sizeが16px未満の入力欄にフォーカスすると画面全体を自動拡大する（#1442）。
// jsdomでは実効のfont-sizeを測れないため、スマホ幅で効くクラスの方で担保する。
describe("MentionTextarea の文字サイズ", () => {
  it("スマホ幅では16px（text-base）で、小さくするクラスはmd以上にしか付かない", () => {
    const { container } = render(<Harness />);
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;

    expect(textarea.classList.contains("text-base")).toBe(true);
    expect(textarea.classList.contains("text-sm")).toBe(false);
    expect(textarea.classList.contains("md:text-sm")).toBe(true);
  });

  it("呼び出し側がclassNameを渡してもtext-baseが消えない", () => {
    function Wrapped() {
      const [value, setValue] = useState("");
      return <MentionTextarea value={value} onChange={setValue} className="min-h-20" />;
    }
    const { container } = render(<Wrapped />);
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;

    expect(textarea.classList.contains("text-base")).toBe(true);
    expect(textarea.classList.contains("text-sm")).toBe(false);
  });
});
