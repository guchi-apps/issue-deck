import { describe, expect, it } from "vitest";

import {
  buildUploadedImageList,
  formatUploadedImageSize,
  isUploadedImageFilename,
} from "@/lib/uploaded-images";

const UUID = "0f9c1a2b-3c4d-5e6f-7a8b-9c0d1e2f3a4b";
const UUID2 = "1f9c1a2b-3c4d-5e6f-7a8b-9c0d1e2f3a4b";

describe("isUploadedImageFilename", () => {
  it("アップロードAPIが作るUUID名だけを通す", () => {
    expect(isUploadedImageFilename(`${UUID}.png`)).toBe(true);
    expect(isUploadedImageFilename(`${UUID}.webp`)).toBe(true);
  });

  it("パストラバーサル・対象外の拡張子・大文字のUUIDは通さない", () => {
    expect(isUploadedImageFilename(`../../etc/passwd`)).toBe(false);
    expect(isUploadedImageFilename(`${UUID}.svg`)).toBe(false);
    expect(isUploadedImageFilename(`${UUID.toUpperCase()}.png`)).toBe(false);
    expect(isUploadedImageFilename("screenshot.png")).toBe(false);
  });
});

describe("buildUploadedImageList", () => {
  it("新しい順に並べ、配信URLとISO日時を添える", () => {
    const list = buildUploadedImageList([
      { filename: `${UUID}.png`, size: 2048, modifiedAtMs: 1_000 },
      { filename: `${UUID2}.jpg`, size: 4096, modifiedAtMs: 2_000 },
    ]);

    expect(list.map((image) => image.filename)).toEqual([`${UUID2}.jpg`, `${UUID}.png`]);
    expect(list[0].url).toBe(`/api/issues/images/${UUID2}.jpg`);
    expect(list[0].uploadedAt).toBe(new Date(2_000).toISOString());
  });

  it("UUID名でないファイルは一覧に出さない", () => {
    const list = buildUploadedImageList([
      { filename: "note.txt", size: 10, modifiedAtMs: 3_000 },
      { filename: `${UUID}.png`, size: 10, modifiedAtMs: 1_000 },
    ]);

    expect(list.map((image) => image.filename)).toEqual([`${UUID}.png`]);
  });

  it("更新時刻が同じものはファイル名順にして、取得のたびに入れ替わらないようにする", () => {
    const list = buildUploadedImageList([
      { filename: `${UUID2}.png`, size: 10, modifiedAtMs: 5_000 },
      { filename: `${UUID}.png`, size: 10, modifiedAtMs: 5_000 },
    ]);

    expect(list.map((image) => image.filename)).toEqual([`${UUID}.png`, `${UUID2}.png`]);
  });
});

describe("formatUploadedImageSize", () => {
  it("KB・MBで丸め、1KB未満でも0KBとは出さない", () => {
    expect(formatUploadedImageSize(200)).toBe("1KB");
    expect(formatUploadedImageSize(2048)).toBe("2KB");
    expect(formatUploadedImageSize(3 * 1024 * 1024)).toBe("3.0MB");
  });
});
