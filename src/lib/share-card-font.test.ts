import { describe, expect, it } from "vitest";

import { loadShareCardFonts, parseFontsourceCss, pickSubsetFiles, subsetFamilyName } from "./share-card-font";

const CSS = `
@font-face {
  font-family: 'Murecho';
  src: url(./files/m-1-700-normal.woff2) format('woff2'), url(./files/m-1-700-normal.woff) format('woff');
  unicode-range: U+3042,U+4e00-4e10;
}
@font-face {
  font-family: 'Murecho';
  src: url(./files/m-latin-700-normal.woff2) format('woff2'), url(./files/m-latin-700-normal.woff) format('woff');
  unicode-range: U+0000-00FF,U+2026;
}`;

describe("parseFontsourceCss / pickSubsetFiles", () => {
  it("woffとunicode-rangeを取り出し、文字を含む分割だけを選ぶ", () => {
    const subsets = parseFontsourceCss(CSS);
    expect(subsets).toEqual([
      { file: "m-1-700-normal.woff", ranges: [[0x3042, 0x3042], [0x4e00, 0x4e10]] },
      { file: "m-latin-700-normal.woff", ranges: [[0x0000, 0x00ff], [0x2026, 0x2026]] },
    ]);
    expect(pickSubsetFiles(subsets, "abc")).toEqual(["m-latin-700-normal.woff"]);
    expect(pickSubsetFiles(subsets, "あ")).toEqual(["m-1-700-normal.woff"]);
    expect(pickSubsetFiles(subsets, "😀")).toEqual([]);
    expect(subsetFamilyName("murecho-102-700-normal.woff")).toBe("murecho-102");
    expect(subsetFamilyName("murecho-latin-400-normal.woff")).toBe("murecho-latin");
  });
});

describe("loadShareCardFonts", () => {
  it("実際の@fontsource/murechoから、日本語を含む分割を400・700の両方で読む", async () => {
    const { fonts, fontFamily } = await loadShareCardFonts("Issueリンク");
    expect(fonts.some((f) => f.weight === 400)).toBe(true);
    expect(fonts.some((f) => f.weight === 700)).toBe(true);
    expect(fonts.every((f) => f.data.length > 0)).toBe(true);
    // 分割ごとの名前は400・700で共通で、fontFamilyにはその全部が並ぶ
    const names = [...new Set(fonts.map((f) => f.name))];
    expect(fonts).toHaveLength(names.length * 2);
    expect(fontFamily.split(", ")).toEqual(names);
  });
});
