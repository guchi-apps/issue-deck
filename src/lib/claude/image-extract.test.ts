import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const callClaudeMessages = vi.fn();
vi.mock("@/lib/claude/request", () => ({
  get callClaudeMessages() {
    return callClaudeMessages;
  },
}));

import {
  generateImageExtract,
  ImageExtractError,
  MAX_EXTRACT_IMAGE_BYTES,
  parseImageExtractResponse,
  resolveImageFilenames,
} from "@/lib/claude/image-extract";
import { UPLOADED_IMAGE_DIR } from "@/lib/images/image-storage";

const NAME_A = "eeeeeeee-1111-2222-3333-444444444401.png";
const NAME_B = "eeeeeeee-1111-2222-3333-444444444402.jpg";
const url = (name: string) => `https://example.test/api/issues/images/${name}`;

function aiResponse(text: string) {
  return { response: { ok: true, status: 200 }, json: { content: [{ type: "text", text }] } };
}

describe("resolveImageFilenames", () => {
  it("UUIDファイル名の形式に合うものだけを、重複なく拾う", () => {
    expect(
      resolveImageFilenames([url(NAME_A), url(NAME_A), "https://evil.test/../../etc/passwd", url(NAME_B)]),
    ).toEqual([NAME_A, NAME_B]);
  });
});

describe("parseImageExtractResponse", () => {
  it("コードフェンス付きでも読み、文字列以外の要素は捨てる", () => {
    expect(parseImageExtractResponse('```json\n{"items":["A",1,"  ","B"],"unreadable":true}\n```')).toEqual({
      items: ["A", "B"],
      unreadable: true,
    });
  });

  it("itemsが配列でなければ例外", () => {
    expect(() => parseImageExtractResponse('{"items":"A"}')).toThrow();
  });
});

describe("generateImageExtract", () => {
  beforeEach(async () => {
    callClaudeMessages.mockReset();
    await mkdir(UPLOADED_IMAGE_DIR, { recursive: true });
    await writeFile(path.join(UPLOADED_IMAGE_DIR, NAME_A), Buffer.from([137, 80, 78, 71]));
  });

  afterEach(async () => {
    await rm(path.join(UPLOADED_IMAGE_DIR, NAME_A), { force: true });
    await rm(path.join(UPLOADED_IMAGE_DIR, NAME_B), { force: true });
  });

  it("画像をbase64のimageブロックとして送り、変更内容を返す", async () => {
    callClaudeMessages.mockResolvedValue(aiResponse('{"items":["保存ボタンを右上へ移動する"],"unreadable":false}'));

    const result = await generateImageExtract("token", [url(NAME_A)]);

    expect(result).toEqual({ items: ["保存ボタンを右上へ移動する"], unreadable: false });
    const call = callClaudeMessages.mock.calls[0][0];
    expect(call.feature).toBe("issue_image_extract");
    const content = call.body.messages[0].content;
    expect(content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: Buffer.from([137, 80, 78, 71]).toString("base64") },
    });
    expect(content[1].type).toBe("text");
  });

  // #3851。取り消し線で隠れた元の文字を読めるよう、元画像を「元画像→書き込み後」の順で添える
  it("元画像が分かる画像は、元画像→書き込み後の順に送り、プロンプトに見比べる指示を足す", async () => {
    await writeFile(path.join(UPLOADED_IMAGE_DIR, NAME_B), Buffer.from([255, 216]));
    callClaudeMessages.mockResolvedValue(aiResponse('{"items":["A"],"unreadable":false}'));

    await generateImageExtract("token", [url(NAME_A)], { [url(NAME_A)]: url(NAME_B) });

    const content = callClaudeMessages.mock.calls[0][0].body.messages[0].content;
    expect(content.map((block: { type: string }) => block.type)).toEqual(["text", "image", "text", "image", "text"]);
    expect(content[1].source.media_type).toBe("image/jpeg");
    expect(content[3].source.media_type).toBe("image/png");
    expect(content[4].text).toContain("元画像と見比べる");
  });

  it("元画像が読めないときは失敗にせず、書き込み後だけで読む", async () => {
    callClaudeMessages.mockResolvedValue(aiResponse('{"items":["A"],"unreadable":false}'));

    await generateImageExtract("token", [url(NAME_A)], { [url(NAME_A)]: url(NAME_B) });

    const content = callClaudeMessages.mock.calls[0][0].body.messages[0].content;
    expect(content.map((block: { type: string }) => block.type)).toEqual(["image", "text"]);
    expect(content[1].text).not.toContain("元画像と見比べる");
  });

  it("元画像を足すと合計が上限を超えるときは、元画像を外して書き込み後だけで読む", async () => {
    await writeFile(path.join(UPLOADED_IMAGE_DIR, NAME_A), Buffer.alloc(MAX_EXTRACT_IMAGE_BYTES));
    await writeFile(path.join(UPLOADED_IMAGE_DIR, NAME_B), Buffer.alloc(MAX_EXTRACT_IMAGE_BYTES));
    const names = [1, 2, 3].map((i) => `eeeeeeee-1111-2222-3333-44444444441${i}.png`);
    try {
      for (const name of names) await writeFile(path.join(UPLOADED_IMAGE_DIR, name), Buffer.alloc(MAX_EXTRACT_IMAGE_BYTES));
      callClaudeMessages.mockResolvedValue(aiResponse('{"items":["A"],"unreadable":false}'));

      await generateImageExtract("token", [url(NAME_A), url(names[0])], {
        [url(NAME_A)]: url(NAME_B),
        [url(names[0])]: url(names[1]),
      });

      const content = callClaudeMessages.mock.calls[0][0].body.messages[0].content;
      // 書き込み後2枚＋元画像1枚（約3枚ぶんのbase64）までは収まり、2枚目の元画像は外れる
      expect(content.filter((block: { type: string }) => block.type === "image").length).toBeLessThan(4);
    } finally {
      for (const name of names) await rm(path.join(UPLOADED_IMAGE_DIR, name), { force: true });
    }
  });

  it("画像が無ければno_images", async () => {
    await expect(generateImageExtract("token", ["https://example.test/x.png"])).rejects.toMatchObject({
      code: "no_images",
    });
    expect(callClaudeMessages).not.toHaveBeenCalled();
  });

  // SVGはAnthropic APIの画像として送れず400になるため、送る前に外す（#3286）
  it("SVGだけならAIを呼ばずno_imagesで、SVGが読めない旨を伝える", async () => {
    const svg = "eeeeeeee-1111-2222-3333-444444444403.svg";

    await expect(generateImageExtract("token", [url(svg)])).rejects.toMatchObject({
      code: "no_images",
      message: expect.stringContaining("SVG"),
    });
    expect(callClaudeMessages).not.toHaveBeenCalled();
  });

  it("SVGが混ざっていても、SVGだけを外して残りの画像を読ませる", async () => {
    callClaudeMessages.mockResolvedValue(aiResponse('{"items":["A"],"unreadable":false}'));
    const svg = "eeeeeeee-1111-2222-3333-444444444403.svg";

    await generateImageExtract("token", [url(svg), url(NAME_A)]);

    const content = callClaudeMessages.mock.calls[0][0].body.messages[0].content;
    expect(content.filter((block: { type: string }) => block.type === "image")).toHaveLength(1);
  });

  it("上限を超える枚数はtoo_many_images", async () => {
    const urls = Array.from({ length: 5 }, (_, i) => url(`eeeeeeee-1111-2222-3333-44444444440${i}.png`));
    await expect(generateImageExtract("token", urls)).rejects.toMatchObject({ code: "too_many_images" });
  });

  it("ファイルが無ければimage_not_found", async () => {
    await expect(generateImageExtract("token", [url(NAME_B)])).rejects.toMatchObject({ code: "image_not_found" });
  });

  it("5MBを超える画像はimage_too_largeで、AIを呼ばない", async () => {
    await writeFile(path.join(UPLOADED_IMAGE_DIR, NAME_B), Buffer.alloc(MAX_EXTRACT_IMAGE_BYTES + 1));

    await expect(generateImageExtract("token", [url(NAME_B)])).rejects.toBeInstanceOf(ImageExtractError);
    expect(callClaudeMessages).not.toHaveBeenCalled();
  });

  it("何も読み取れなかったらnothing_extracted", async () => {
    callClaudeMessages.mockResolvedValue(aiResponse('{"items":[],"unreadable":false}'));
    await expect(generateImageExtract("token", [url(NAME_A)])).rejects.toMatchObject({ code: "nothing_extracted" });
  });

  it("判読できないだけの応答は結果として返す", async () => {
    callClaudeMessages.mockResolvedValue(aiResponse('{"items":[],"unreadable":true}'));
    await expect(generateImageExtract("token", [url(NAME_A)])).resolves.toEqual({ items: [], unreadable: true });
  });

  it("APIが失敗したら通常のErrorを投げる", async () => {
    callClaudeMessages.mockResolvedValue({ response: { ok: false, status: 529 }, json: null });
    await expect(generateImageExtract("token", [url(NAME_A)])).rejects.toThrow("529");
  });
});
