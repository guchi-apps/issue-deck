import { describe, expect, it } from "vitest";

import {
  EMPTY_HISTORY,
  commitShapes,
  eraseShapesAlong,
  eraseShapesAt,
  eraserRadiusFor,
  findShapeAt,
  fontSizeFor,
  isNegligibleShape,
  moveShape,
  redoShapes,
  strokeWidthFor,
  undoShapes,
  type Shape,
} from "@/lib/annotation/shapes";

const arrow: Shape = {
  id: "a",
  type: "arrow",
  color: "red",
  width: 4,
  from: { x: 0, y: 0 },
  to: { x: 100, y: 100 },
};
const rect: Shape = {
  id: "r",
  type: "rect",
  color: "blue",
  width: 4,
  from: { x: 200, y: 200 },
  to: { x: 300, y: 260 },
};
const text: Shape = {
  id: "t",
  type: "text",
  color: "green",
  at: { x: 50, y: 300 },
  text: "反映待ち",
  fontSize: 20,
  textWidth: 80,
};

describe("findShapeAt", () => {
  it("斜めの矢印は線の近くだけで当たり、外接矩形の隅では当たらない", () => {
    expect(findShapeAt([arrow], { x: 52, y: 50 }, 4)?.id).toBe("a");
    expect(findShapeAt([arrow], { x: 90, y: 10 }, 4)).toBeNull();
  });

  it("四角は枠線で当たり、内側では当たらない（下の図形を掴めるように）", () => {
    expect(findShapeAt([rect], { x: 250, y: 201 }, 4)?.id).toBe("r");
    expect(findShapeAt([rect], { x: 250, y: 230 }, 4)).toBeNull();
  });

  it("文字は背景の箱の内側ならどこでも当たる", () => {
    expect(findShapeAt([text], { x: 90, y: 310 }, 0)?.id).toBe("t");
    expect(findShapeAt([text], { x: 200, y: 310 }, 0)).toBeNull();
  });

  it("重なっていれば後から描いた方を返す", () => {
    const later: Shape = { ...arrow, id: "later" };
    expect(findShapeAt([arrow, later], { x: 50, y: 50 }, 4)?.id).toBe("later");
  });

  it("ペンは折れ線のどの区間でも当たる", () => {
    const pen: Shape = {
      id: "p",
      type: "pen",
      color: "red",
      width: 6,
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
    };
    expect(findShapeAt([pen], { x: 11, y: 6 }, 0)?.id).toBe("p");
    expect(findShapeAt([pen], { x: 0, y: 10 }, 0)).toBeNull();
  });
});

describe("moveShape", () => {
  it("図形の種類ごとに座標をずらし、元の図形は変えない", () => {
    expect(moveShape(arrow, 5, -5)).toMatchObject({ from: { x: 5, y: -5 }, to: { x: 105, y: 95 } });
    expect(moveShape(text, 10, 10)).toMatchObject({ at: { x: 60, y: 310 } });
    expect(arrow).toMatchObject({ from: { x: 0, y: 0 } });
  });
});

describe("isNegligibleShape", () => {
  it("押しただけの矢印と空の文字は描いたことにしない", () => {
    expect(isNegligibleShape({ ...arrow, to: { x: 1, y: 1 } })).toBe(true);
    expect(isNegligibleShape({ ...text, text: "  " })).toBe(true);
    expect(isNegligibleShape(arrow)).toBe(false);
  });
});

describe("大きさ", () => {
  it("高解像度の画像ほど線と文字を太く・大きくする", () => {
    expect(strokeWidthFor("medium", 3000, 2000)).toBeGreaterThan(strokeWidthFor("medium", 800, 600));
    expect(fontSizeFor("medium", 3000, 2000)).toBeGreaterThan(fontSizeFor("medium", 800, 600));
    expect(strokeWidthFor("thin", 800, 600)).toBeLessThan(strokeWidthFor("thick", 800, 600));
  });
});

describe("履歴", () => {
  it("元に戻す・やり直すで状態を行き来し、新しく描くとやり直しは消える", () => {
    let h = commitShapes(EMPTY_HISTORY, [arrow]);
    h = commitShapes(h, [arrow, rect]);
    h = undoShapes(h);
    expect(h.present).toEqual([arrow]);
    h = redoShapes(h);
    expect(h.present).toEqual([arrow, rect]);
    h = undoShapes(undoShapes(h));
    expect(h.present).toEqual([]);
    expect(undoShapes(h)).toBe(h);
    h = commitShapes(h, [text]);
    expect(h.future).toEqual([]);
    expect(redoShapes(h)).toBe(h);
  });
});

describe("消しゴム（#3055）", () => {
  const pen: Shape = {
    id: "p",
    type: "pen",
    color: "red",
    width: 4,
    points: [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 100, y: 0 },
      { x: 150, y: 0 },
    ],
  };
  const ids = () => {
    let n = 0;
    return () => `new-${++n}`;
  };

  it("何にも当たらなければ同じ配列をそのまま返す", () => {
    const shapes = [pen, arrow, rect, text];
    expect(eraseShapesAt(shapes, { x: 500, y: 500 }, 6, ids())).toBe(shapes);
  });

  it("ペンの線は当てた部分だけが削れ、残りは2本の線として残る", () => {
    const result = eraseShapesAt([pen], { x: 75, y: 0 }, 6, ids());
    // 50〜100の線分だけが消え、0〜50と100〜150が残る
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: "p", type: "pen" });
    expect(result[0].type === "pen" && result[0].points).toEqual([
      { x: 0, y: 0 },
      { x: 50, y: 0 },
    ]);
    expect(result[1]).toMatchObject({ id: "new-1", type: "pen", color: "red", width: 4 });
    expect(result[1].type === "pen" && result[1].points).toEqual([
      { x: 100, y: 0 },
      { x: 150, y: 0 },
    ]);
  });

  it("線の端を消すと1本のまま短くなり、全部に当たれば線ごと消える", () => {
    const shortened = eraseShapesAt([pen], { x: 25, y: 0 }, 6, ids());
    expect(shortened).toHaveLength(1);
    expect(shortened[0].type === "pen" && shortened[0].points).toEqual([
      { x: 50, y: 0 },
      { x: 100, y: 0 },
      { x: 150, y: 0 },
    ]);
    const dot: Shape = { id: "d", type: "pen", color: "red", width: 4, points: [{ x: 10, y: 10 }] };
    expect(eraseShapesAt([dot], { x: 12, y: 10 }, 6, ids())).toEqual([]);
  });

  it("矢印・四角・文字は当たった1つだけが丸ごと消える", () => {
    expect(eraseShapesAt([arrow, rect, text], { x: 50, y: 50 }, 6, ids())).toEqual([rect, text]);
    expect(eraseShapesAt([arrow, rect, text], { x: 250, y: 200 }, 6, ids())).toEqual([arrow, text]);
    expect(eraseShapesAt([arrow, rect, text], { x: 60, y: 305 }, 6, ids())).toEqual([arrow, rect]);
  });

  it("なぞった経路の途中にある線も取りこぼさない", () => {
    // 到着点は線から遠いが、経路が線を横切る
    const result = eraseShapesAlong([arrow], { x: 0, y: 100 }, { x: 100, y: 0 }, 6, ids());
    expect(result).toEqual([]);
  });

  it("消しゴムの半径は太さの段階に応じて大きくなる", () => {
    const thin = eraserRadiusFor("thin", 1000, 1000);
    const medium = eraserRadiusFor("medium", 1000, 1000);
    const thick = eraserRadiusFor("thick", 1000, 1000);
    expect(thin).toBeLessThan(medium);
    expect(medium).toBeLessThan(thick);
  });
});
