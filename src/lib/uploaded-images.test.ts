import { describe, expect, it } from "vitest";

import {
  buildUploadedImageList,
  extractUploadedImageFilenames,
  formatUploadedImageSize,
  isSvgImageUrl,
  isUploadedImageFilename,
  looksLikeSvg,
  selectCleanupTargets,
  summarizeUploadedImages,
} from "@/lib/uploaded-images";
import type { UploadedImage } from "@/types/uploaded-image";

const UUID = "0f9c1a2b-3c4d-5e6f-7a8b-9c0d1e2f3a4b";
const UUID2 = "1f9c1a2b-3c4d-5e6f-7a8b-9c0d1e2f3a4b";

describe("isUploadedImageFilename", () => {
  it("アップロードAPIが作るUUID名だけを通す", () => {
    expect(isUploadedImageFilename(`${UUID}.png`)).toBe(true);
    expect(isUploadedImageFilename(`${UUID}.webp`)).toBe(true);
    expect(isUploadedImageFilename(`${UUID}.svg`)).toBe(true);
  });

  it("パストラバーサル・対象外の拡張子・大文字のUUIDは通さない", () => {
    expect(isUploadedImageFilename(`../../etc/passwd`)).toBe(false);
    expect(isUploadedImageFilename(`${UUID}.svgz`)).toBe(false);
    expect(isUploadedImageFilename(`${UUID}.html`)).toBe(false);
    expect(isUploadedImageFilename(`${UUID.toUpperCase()}.png`)).toBe(false);
    expect(isUploadedImageFilename("screenshot.png")).toBe(false);
  });
});

describe("isSvgImageUrl", () => {
  it("拡張子がsvgのURL（クエリ付きも）だけをSVGとみなす", () => {
    expect(isSvgImageUrl(`https://x.example/api/issues/images/${UUID}.svg`)).toBe(true);
    expect(isSvgImageUrl(`/api/issues/images/${UUID}.svg?v=1`)).toBe(true);
    expect(isSvgImageUrl(`/api/issues/images/${UUID}.png`)).toBe(false);
    expect(isSvgImageUrl("/api/issues/images/svg.png")).toBe(false);
  });
});

describe("looksLikeSvg", () => {
  it("素のsvg要素・XML宣言・コメント・DOCTYPE・BOMの後ろのsvg要素を通す", () => {
    expect(looksLikeSvg('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toBe(true);
    expect(looksLikeSvg('\n  <svg\n xmlns="http://www.w3.org/2000/svg">')).toBe(true);
    expect(looksLikeSvg('<?xml version="1.0" encoding="UTF-8"?>\n<!-- 生成 -->\n<svg>')).toBe(true);
    expect(
      looksLikeSvg(
        '<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg>',
      ),
    ).toBe(true);
    expect(looksLikeSvg('<!DOCTYPE svg [<!ENTITY a "b">]><svg>')).toBe(true);
    expect(looksLikeSvg("\uFEFF<svg>")).toBe(true);
  });

  it("HTMLなどSVG以外・閉じていない前置き・空は通さない", () => {
    expect(looksLikeSvg("<html><body><svg></svg></body></html>")).toBe(false);
    expect(looksLikeSvg("<script>alert(1)</script>")).toBe(false);
    expect(looksLikeSvg("<svgfoo>")).toBe(false);
    expect(looksLikeSvg("<!-- 閉じていない<svg>")).toBe(false);
    expect(looksLikeSvg('<?xml version="1.0"')).toBe(false);
    expect(looksLikeSvg("")).toBe(false);
  });

  it("空白だらけの入力でも一瞬で判定する", () => {
    const started = Date.now();
    expect(looksLikeSvg(`${" ".repeat(60_000)}x`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
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

describe("extractUploadedImageFilenames", () => {
  it("画像記法・HTMLの<img>・クエリ付きのURLから、ホストを問わず拾う", () => {
    const body = [
      `![スクリーンショット](https://issue-deck.example.com/api/issues/images/${UUID}.png)`,
      `<img src="http://192.168.1.10:6475/api/issues/images/${UUID2}.jpg?v=2">`,
    ].join("\n");

    expect(extractUploadedImageFilenames(body).sort()).toEqual(
      [`${UUID}.png`, `${UUID2}.jpg`].sort(),
    );
  });

  it("同じ画像を2回貼っても1件にまとめる", () => {
    const body = `/api/issues/images/${UUID}.png と /api/issues/images/${UUID}.png`;
    expect(extractUploadedImageFilenames(body)).toEqual([`${UUID}.png`]);
  });

  it("空・null・画像を含まない本文では何も返さない", () => {
    expect(extractUploadedImageFilenames(null)).toEqual([]);
    expect(extractUploadedImageFilenames("")).toEqual([]);
    expect(extractUploadedImageFilenames("ただの本文です")).toEqual([]);
  });

  // SVGを拾えないと、貼られているSVGを「未使用」と判定して自動削除してしまう（#3286）
  it("SVGも本文中の使用画像として拾う", () => {
    expect(extractUploadedImageFilenames(`![icon](/api/issues/images/${UUID}.svg)`)).toEqual([
      `${UUID}.svg`,
    ]);
  });

  it("対象外の拡張子・大文字のUUIDは拾わない（消してよい判定に使うため緩めない）", () => {
    expect(extractUploadedImageFilenames(`/api/issues/images/${UUID}.html`)).toEqual([]);
    expect(extractUploadedImageFilenames(`/api/issues/images/${UUID.toUpperCase()}.png`)).toEqual(
      [],
    );
  });
});

describe("buildUploadedImageList の使用状況（#2475）", () => {
  const files = [{ filename: `${UUID}.png`, size: 10, modifiedAtMs: 1_000 }];

  it("参照があれば使用中にする", () => {
    const list = buildUploadedImageList(files, {
      referencesByFilename: new Map([
        [
          `${UUID}.png`,
          [{ repositoryFullName: "guchi-apps/issue-deck", issueNumber: 1, isPullRequest: false }],
        ],
      ]),
      scanCompleted: true,
    });

    expect(list[0].usage).toBe("used");
    expect(list[0].references).toHaveLength(1);
  });

  it("参照が無くても、索引が一巡していなければ未使用とは言わない", () => {
    expect(buildUploadedImageList(files, { scanCompleted: false })[0].usage).toBe("unknown");
    expect(buildUploadedImageList(files, { scanCompleted: true })[0].usage).toBe("unused");
  });
});

describe("selectCleanupTargets", () => {
  const now = new Date("2026-08-29T00:00:00.000Z");
  const scanCompletedAt = "2026-08-28T00:00:00.000Z";

  function image(overrides: Partial<UploadedImage> = {}): UploadedImage {
    return {
      filename: `${UUID}.png`,
      url: `/api/issues/images/${UUID}.png`,
      size: 10,
      uploadedAt: "2026-01-01T00:00:00.000Z",
      usage: "unused",
      references: [],
      ...overrides,
    };
  }

  it("未使用で保持期間を過ぎたものだけを数える", () => {
    const targets = selectCleanupTargets(
      [
        image(),
        image({ filename: `${UUID2}.png`, usage: "used" }),
        image({ filename: `${UUID2}.jpg`, uploadedAt: "2026-08-28T12:00:00.000Z" }),
      ],
      { retentionDays: 30, scanCompletedAt, now },
    );

    expect(targets.map((image) => image.filename)).toEqual([`${UUID}.png`]);
  });

  it("索引が一巡する前にアップロードされたものだけを対象にする", () => {
    const targets = selectCleanupTargets([image({ uploadedAt: "2026-08-28T12:00:00.000Z" })], {
      retentionDays: 0,
      scanCompletedAt,
      now,
    });

    expect(targets).toEqual([]);
  });

  it("索引が一巡していなければ1枚も対象にしない", () => {
    expect(
      selectCleanupTargets([image()], { retentionDays: 0, scanCompletedAt: null, now }),
    ).toEqual([]);
  });
});

describe("summarizeUploadedImages", () => {
  it("使用中・未使用・確認中・ゴミ箱に分け、合計にはゴミ箱も数える", () => {
    const base = {
      url: "",
      size: 1024,
      uploadedAt: "2026-08-29T00:00:00.000Z",
      references: [],
    };
    const summary = summarizeUploadedImages(
      [
        { ...base, filename: "a", usage: "used" },
        { ...base, filename: "b", usage: "unused" },
        { ...base, filename: "c", usage: "unknown" },
      ],
      [{ filename: "d", size: 1024, modifiedAtMs: 0 }],
    );

    expect(summary.total).toEqual({ count: 4, size: 4096 });
    expect(summary.used.count).toBe(1);
    expect(summary.unused.count).toBe(1);
    expect(summary.unknown.count).toBe(1);
    expect(summary.trashed).toEqual({ count: 1, size: 1024 });
  });
});
