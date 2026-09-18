import { describe, expect, it } from "vitest";

import {
  estimateTextWidth,
  layoutPie,
  pieGeometryForWidth,
  type PieSliceInput,
} from "@/lib/pie-chart-layout";

/**
 * リポジトリ別の円グラフ（#3060）の配置。ここで効くのは、
 * 「円の内側に入るか外へ出すか」の判定と、外側ラベルが重ならないこと。
 */

function slices(costs: number[], names = costs.map((_c, i) => `repo-${i}`)): PieSliceInput[] {
  const total = costs.reduce((sum, cost) => sum + cost, 0);
  return costs.map((cost, index) => ({
    name: names[index],
    fraction: cost / total,
    percentText: `${((cost / total) * 100).toFixed(1)}%`,
    amountText: `$${cost}`,
  }));
}

/** Issueの画像にある上位5件と、仮の「その他」 */
const SAMPLE = slices([5219, 1378, 861.3, 791.7, 705.9, 1180]);

describe("pieGeometryForWidth", () => {
  it("幅に比例して円を大きくし、上限と下限で抑える", () => {
    expect(pieGeometryForWidth(337).radius).toBe(78);
    expect(pieGeometryForWidth(558).radius).toBe(128);
    expect(pieGeometryForWidth(2000).radius).toBe(140);
    expect(pieGeometryForWidth(100).width).toBe(240);
  });

  it("狭い幅では文字を小さくする", () => {
    expect(pieGeometryForWidth(337).fontSize).toBeLessThan(pieGeometryForWidth(558).fontSize);
  });
});

describe("layoutPie", () => {
  it("切れごとに扇形を1つ返し、最大の切れは円の内側に出す", () => {
    const layouts = layoutPie(SAMPLE, pieGeometryForWidth(558));
    expect(layouts).toHaveLength(6);
    expect(layouts[0].inside).not.toBeNull();
    expect(layouts[0].label.lines.map((line) => line.text)).toEqual(["repo-0"]);
  });

  it("金額が入り切らない狭い扇形は、割合と金額を円の外の名前の下へ移す", () => {
    const layouts = layoutPie(SAMPLE, pieGeometryForWidth(337));
    // スマホ幅では最大の切れ以外は入り切らない
    expect(layouts[0].inside).not.toBeNull();
    expect(layouts[4].inside).toBeNull();
    expect(layouts[4].label.lines.map((line) => line.text)).toEqual(["repo-4", "7.0% ($705.9)"]);
  });

  it("補足（noteがある切れ）は名前の下の行へ出す", () => {
    const input = SAMPLE.map((slice, index) => (index === 5 ? { ...slice, note: "29リポジトリ" } : slice));
    const layouts = layoutPie(input, pieGeometryForWidth(337));
    expect(layouts[5].label.lines[1].text).toBe("29リポジトリ");
  });

  it("外側のラベルは左右とも縦に重ならず、円の高さの中に収まる", () => {
    for (const width of [337, 430, 558]) {
      const geometry = pieGeometryForWidth(width);
      const lineHeight = geometry.fontSize + 3;
      const layouts = layoutPie(SAMPLE, geometry);
      for (const anchor of ["start", "end"] as const) {
        const blocks = layouts
          .filter((layout) => layout.label.anchor === anchor)
          .map((layout) => {
            const top = layout.label.lineYs[0] - geometry.fontSize;
            return { top, bottom: top + layout.label.lines.length * lineHeight };
          })
          .sort((a, b) => a.top - b.top);
        blocks.forEach((block, index) => {
          if (index > 0) expect(block.top).toBeGreaterThanOrEqual(blocks[index - 1].bottom);
          expect(block.bottom).toBeLessThanOrEqual(geometry.height);
        });
      }
    }
  });

  it("12時から時計回りに並べ、右半分に着く切れは右側へ、左半分は左側へラベルを置く", () => {
    const layouts = layoutPie(SAMPLE, pieGeometryForWidth(558));
    // 最大の切れは0〜約185度（右側が中心）、残りは左半分に並ぶ
    expect(layouts[0].label.anchor).toBe("start");
    for (const layout of layouts.slice(1)) expect(layout.label.anchor).toBe("end");
  });

  it("1つの切れが全体のときは扇形ではなく円で描く", () => {
    const [layout] = layoutPie(slices([100]), pieGeometryForWidth(337));
    expect(layout.path).not.toContain("L");
    expect(layout.path.match(/A/g)).toHaveLength(2);
  });

  it("長い名前は幅に収まるよう省略記号にする", () => {
    const geometry = pieGeometryForWidth(337);
    const [, second] = layoutPie(
      slices([5, 5], ["short", "a-very-long-repository-name-that-cannot-fit"]),
      geometry,
    );
    const text = second.label.lines[0].text;
    expect(text.endsWith("…")).toBe(true);
    expect(text.length).toBeLessThan("a-very-long-repository-name-that-cannot-fit".length);
  });
});

describe("estimateTextWidth", () => {
  it("全角は1em、半角は0.6emで見積もる", () => {
    expect(estimateTextWidth("その他", 10)).toBe(30);
    expect(estimateTextWidth("abcd", 10)).toBeCloseTo(24);
  });
});
