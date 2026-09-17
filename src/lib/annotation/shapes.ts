/**
 * 添付画像への書き込み（#2972）で扱う図形と、その描画・当たり判定・履歴。
 *
 * 座標はすべて**元画像のピクセル座標**で持つ。画面上の表示倍率は描画する側
 * （`image-annotation-dialog.tsx`）だけが知っており、ここへは持ち込まない——保存時に
 * 元の解像度のまま描き出すため。
 *
 * 書いたものは保存するまで図形のまま持ち、「移動」で位置を直せるようにしている。
 * 保存した画像は1枚の絵になるので、開き直した後は以前の書き込みを動かせない。
 */

export type Point = { x: number; y: number };

/**
 * 色は背景に埋もれないものを選ぶためだけのもので、**意味は持たせない**（#2972で決めた）。
 * 何をしてほしいかは線の形（取り消し線・矢印・書き足した文字）と本文で伝える。
 */
export const ANNOTATION_COLORS = [
  { id: "red", label: "赤", value: "#ef4444" },
  { id: "blue", label: "青", value: "#3b82f6" },
  { id: "green", label: "緑", value: "#16a34a" },
  { id: "yellow", label: "黄", value: "#facc15" },
  { id: "white", label: "白", value: "#ffffff" },
] as const;

export type AnnotationColor = (typeof ANNOTATION_COLORS)[number]["id"];

/** 太さの3段階。画像の大きさに対する倍率で、実際の線幅は`strokeWidthFor`で決まる */
export const ANNOTATION_SIZES = [
  { id: "thin", label: "細い", ratio: 0.5 },
  { id: "medium", label: "普通", ratio: 1 },
  { id: "thick", label: "太い", ratio: 1.8 },
] as const;

export type AnnotationSize = (typeof ANNOTATION_SIZES)[number]["id"];

export type AnnotationTool = "move" | "pen" | "arrow" | "rect" | "text";

type ShapeBase = { id: string; color: AnnotationColor };

export type Shape =
  | (ShapeBase & { type: "pen"; width: number; points: Point[] })
  | (ShapeBase & { type: "arrow"; width: number; from: Point; to: Point })
  | (ShapeBase & { type: "rect"; width: number; from: Point; to: Point })
  | (ShapeBase & {
      type: "text";
      at: Point;
      text: string;
      fontSize: number;
      /** 描画時に測った文字の幅。当たり判定に使う（測れない環境では概算） */
      textWidth: number;
    });

export type Bounds = { left: number; top: number; right: number; bottom: number };

export function colorValue(color: AnnotationColor): string {
  return ANNOTATION_COLORS.find((c) => c.id === color)?.value ?? ANNOTATION_COLORS[0].value;
}

/**
 * 画像の長辺に比例した基準の大きさ。スクリーンショットはRetinaで2倍・3倍の解像度に
 * なるため、固定のピクセル数だと大きい画像ほど線が細く見えてしまう。
 */
function baseUnit(imageWidth: number, imageHeight: number): number {
  return Math.max(1, Math.max(imageWidth, imageHeight) / 1000);
}

function sizeRatio(size: AnnotationSize): number {
  return ANNOTATION_SIZES.find((s) => s.id === size)?.ratio ?? 1;
}

export function strokeWidthFor(size: AnnotationSize, imageWidth: number, imageHeight: number) {
  return Math.max(2, Math.round(6 * sizeRatio(size) * baseUnit(imageWidth, imageHeight)));
}

export function fontSizeFor(size: AnnotationSize, imageWidth: number, imageHeight: number) {
  // 文字は細い・太いの差を線ほど広げない（小さすぎると読めず、大きすぎると画面を隠す）
  const ratio = 0.75 + sizeRatio(size) * 0.3;
  return Math.max(14, Math.round(24 * ratio * baseUnit(imageWidth, imageHeight)));
}

/** 文字の背景の余白。描画と当たり判定で同じ値を使う */
export function textPadding(fontSize: number): number {
  return Math.round(fontSize * 0.25);
}

/** 矢じりの長さ。線幅に比例させ、短い矢印では矢じりが本体より長くならないようにする */
export function arrowHeadLength(shape: { width: number; from: Point; to: Point }): number {
  const length = Math.hypot(shape.to.x - shape.from.x, shape.to.y - shape.from.y);
  return Math.min(shape.width * 4 + 8, length * 0.6);
}

export function shapeBounds(shape: Shape): Bounds {
  switch (shape.type) {
    case "pen": {
      const xs = shape.points.map((p) => p.x);
      const ys = shape.points.map((p) => p.y);
      return {
        left: Math.min(...xs),
        top: Math.min(...ys),
        right: Math.max(...xs),
        bottom: Math.max(...ys),
      };
    }
    case "arrow":
    case "rect":
      return {
        left: Math.min(shape.from.x, shape.to.x),
        top: Math.min(shape.from.y, shape.to.y),
        right: Math.max(shape.from.x, shape.to.x),
        bottom: Math.max(shape.from.y, shape.to.y),
      };
    case "text": {
      const pad = textPadding(shape.fontSize);
      return {
        left: shape.at.x - pad,
        top: shape.at.y - pad,
        right: shape.at.x + shape.textWidth + pad,
        bottom: shape.at.y + shape.fontSize * 1.2 + pad,
      };
    }
  }
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * `point`がその図形に当たっているか。線は線そのものからの距離で見る——外接矩形で
 * 見ると、斜めの矢印や大きな四角の内側を押しただけで下の図形が掴めなくなるため。
 * `tolerance`は指で押す場合を見込んだ余白（画像ピクセル）。
 */
export function hitsShape(shape: Shape, point: Point, tolerance: number): boolean {
  switch (shape.type) {
    case "text": {
      const b = shapeBounds(shape);
      return (
        point.x >= b.left - tolerance &&
        point.x <= b.right + tolerance &&
        point.y >= b.top - tolerance &&
        point.y <= b.bottom + tolerance
      );
    }
    case "pen": {
      const reach = tolerance + shape.width / 2;
      if (shape.points.length === 1) {
        return Math.hypot(point.x - shape.points[0].x, point.y - shape.points[0].y) <= reach;
      }
      return shape.points
        .slice(1)
        .some((p, i) => distanceToSegment(point, shape.points[i], p) <= reach);
    }
    case "arrow":
      return distanceToSegment(point, shape.from, shape.to) <= tolerance + shape.width / 2;
    case "rect": {
      const reach = tolerance + shape.width / 2;
      const { left, top, right, bottom } = shapeBounds(shape);
      const corners: Point[] = [
        { x: left, y: top },
        { x: right, y: top },
        { x: right, y: bottom },
        { x: left, y: bottom },
      ];
      return corners.some((c, i) => distanceToSegment(point, c, corners[(i + 1) % 4]) <= reach);
    }
  }
}

/** 一番手前（後から描いたもの）から当たる図形を探す */
export function findShapeAt(shapes: Shape[], point: Point, tolerance: number): Shape | null {
  for (let i = shapes.length - 1; i >= 0; i--) {
    if (hitsShape(shapes[i], point, tolerance)) return shapes[i];
  }
  return null;
}

export function moveShape(shape: Shape, dx: number, dy: number): Shape {
  const shift = (p: Point): Point => ({ x: p.x + dx, y: p.y + dy });
  switch (shape.type) {
    case "pen":
      return { ...shape, points: shape.points.map(shift) };
    case "arrow":
    case "rect":
      return { ...shape, from: shift(shape.from), to: shift(shape.to) };
    case "text":
      return { ...shape, at: shift(shape.at) };
  }
}

/** 押しただけで離した矢印・四角のように、描いたことにならない大きさの図形か */
export function isNegligibleShape(shape: Shape): boolean {
  if (shape.type === "text") return shape.text.trim() === "";
  if (shape.type === "pen") return false; // 点を打っただけでも印として残す
  const b = shapeBounds(shape);
  return b.right - b.left < 3 && b.bottom - b.top < 3;
}

type Ctx = Pick<
  CanvasRenderingContext2D,
  | "save"
  | "restore"
  | "beginPath"
  | "moveTo"
  | "lineTo"
  | "stroke"
  | "strokeRect"
  | "fillRect"
  | "fillText"
  | "arc"
  | "fill"
  | "measureText"
  | "strokeStyle"
  | "fillStyle"
  | "lineWidth"
  | "lineCap"
  | "lineJoin"
  | "font"
  | "textBaseline"
>;

export function textFont(fontSize: number): string {
  return `bold ${fontSize}px "Murecho", "BIZ UDPGothic", system-ui, sans-serif`;
}

export function drawShape(ctx: Ctx, shape: Shape): void {
  const color = colorValue(shape.color);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  switch (shape.type) {
    case "pen": {
      ctx.lineWidth = shape.width;
      const [first, ...rest] = shape.points;
      if (rest.length === 0) {
        ctx.beginPath();
        ctx.arc(first.x, first.y, shape.width / 2, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      for (const p of rest) ctx.lineTo(p.x, p.y);
      ctx.stroke();
      break;
    }
    case "arrow": {
      ctx.lineWidth = shape.width;
      const { from, to } = shape;
      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      const head = arrowHeadLength(shape);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      for (const spread of [-0.45, 0.45]) {
        ctx.moveTo(to.x, to.y);
        ctx.lineTo(to.x - head * Math.cos(angle + spread), to.y - head * Math.sin(angle + spread));
      }
      ctx.stroke();
      break;
    }
    case "rect":
      ctx.lineWidth = shape.width;
      ctx.strokeRect(shape.from.x, shape.from.y, shape.to.x - shape.from.x, shape.to.y - shape.from.y);
      break;
    case "text": {
      const b = shapeBounds(shape);
      // 文字の裏に地を敷く。スクリーンショットの上では色だけだと背景の文字に紛れるため。
      // 白い文字だけは暗い地にする
      ctx.fillStyle = shape.color === "white" ? "rgba(17,17,17,0.85)" : "rgba(255,255,255,0.9)";
      ctx.fillRect(b.left, b.top, b.right - b.left, b.bottom - b.top);
      ctx.fillStyle = color;
      ctx.font = textFont(shape.fontSize);
      ctx.textBaseline = "top";
      ctx.fillText(shape.text, shape.at.x, shape.at.y + shape.fontSize * 0.1);
      break;
    }
  }
  ctx.restore();
}

/** 文字の幅を測る。`measureText`が使えない環境（jsdom）では文字数からの概算にする */
export function measureTextWidth(
  ctx: Pick<CanvasRenderingContext2D, "font" | "measureText"> | null,
  text: string,
  fontSize: number,
): number {
  if (ctx) {
    ctx.font = textFont(fontSize);
    const width = ctx.measureText(text).width;
    if (width > 0) return width;
  }
  return Array.from(text).length * fontSize;
}

// ---- 履歴 ----

export type ShapeHistory = { past: Shape[][]; present: Shape[]; future: Shape[][] };

export const EMPTY_HISTORY: ShapeHistory = { past: [], present: [], future: [] };

export function commitShapes(history: ShapeHistory, next: Shape[]): ShapeHistory {
  if (next === history.present) return history;
  return { past: [...history.past, history.present], present: next, future: [] };
}

export function undoShapes(history: ShapeHistory): ShapeHistory {
  if (history.past.length === 0) return history;
  return {
    past: history.past.slice(0, -1),
    present: history.past[history.past.length - 1],
    future: [history.present, ...history.future],
  };
}

export function redoShapes(history: ShapeHistory): ShapeHistory {
  if (history.future.length === 0) return history;
  return {
    past: [...history.past, history.present],
    present: history.future[0],
    future: history.future.slice(1),
  };
}
