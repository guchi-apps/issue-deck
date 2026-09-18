/**
 * 円グラフ（AI使用量の「リポジトリ別」・#3060）の配置計算。描画（`repository-pie-chart.tsx`）から
 * 切り離した純粋関数で、扇形の形・円の内側に文字が入るか・円の外側のラベルと引き出し線の位置を返す。
 *
 * **円グラフ用のライブラリは使わない**（依存を増やさないため）。要るのは扇形の弧と、ラベルが
 * 重ならないようにする並べ替えだけで、どちらもここで済む。
 */

export type PieSliceInput = {
  /** 円の外側に出す名前 */
  name: string;
  /** 名前の下に添える補足（「その他」の「29リポジトリ」など） */
  note?: string;
  /** 全体に対する割合（0〜1） */
  fraction: number;
  percentText: string;
  amountText: string;
};

export type PieGeometry = {
  width: number;
  height: number;
  radius: number;
  fontSize: number;
};

export type PieLabelLine = { text: string; strong: boolean };

export type PieSliceLayout = {
  /** 扇形のSVGパス */
  path: string;
  /** 円の内側に「%」と「（金額）」を出すときの位置（文字列の中心）。入り切らないときはnull */
  inside: { x: number; y: number } | null;
  label: {
    lines: PieLabelLine[];
    /** 1行目の文字の基準位置。`anchor`が`end`のときは右端 */
    x: number;
    /** 各行の基準線のY（上から順） */
    lineYs: number[];
    anchor: "start" | "end";
    /** 円の縁から名前の手前までの引き出し線（`points`属性の値） */
    leader: string;
  };
};

/**
 * 文字幅の目安。全角は1em、半角は0.6em。**測るのではなく見積もる**（描画前に配置を決めるため）。
 * 見積もりを少し大きめに取ってあるので、入るかどうかの判定は安全側に倒れる。
 */
export function estimateTextWidth(text: string, size: number): number {
  let width = 0;
  for (const char of text) width += (char.codePointAt(0) ?? 0) > 255 ? size : size * 0.6;
  return width;
}

/** 幅から円の大きさを決める。ラベルを置く左右の余白と、名前が長い行の高さを見込む */
export function pieGeometryForWidth(width: number): PieGeometry {
  const safeWidth = Math.max(width, 240);
  const radius = Math.round(Math.min(Math.max(safeWidth * 0.23, 56), 140));
  const fontSize = safeWidth < 380 ? 10.5 : safeWidth < 480 ? 11.5 : 12;
  return { width: safeWidth, height: Math.round(radius * 2 + 110), radius, fontSize };
}

/** 名前が幅に収まらないときは末尾を省略記号にする（全文は`<title>`で出す） */
function ellipsize(text: string, size: number, maxWidth: number): string {
  if (estimateTextWidth(text, size) <= maxWidth) return text;
  const chars = [...text];
  while (chars.length > 1 && estimateTextWidth(`${chars.join("")}…`, size) > maxWidth) chars.pop();
  return `${chars.join("")}…`;
}

/** 円の内側に文字を置く中心の半径（円の半径に対する比） */
const INSIDE_RADIUS_RATIO = 0.66;
/** 内側に出す最小の角度（ラジアン）。これより細い扇形は弦が足りていても外へ出す */
const INSIDE_MIN_ANGLE = 0.5;
/** 引き出し線の縁からの余白と折れ点、名前までの水平距離 */
const LEADER_GAP = 3;
const LEADER_ELBOW = 12;
const LABEL_SIDE_OFFSET = 20;
const LABEL_TEXT_GAP = 4;
/** 外側ラベルの縦の最小間隔 */
const LABEL_GAP = 4;
/** 円をここまで小さくしても左右のラベルが収まらないときは、はみ出しを許す */
const MIN_RADIUS = 44;

type Sized = {
  sweep: number;
  middle: number;
  fitsInside: boolean;
  right: boolean;
  lines: PieLabelLine[];
  labelWidth: number;
};

/** 半径を決めたときの、各切れの扇形の角度・内側に入るか・外側に出す行 */
function sizeSlices(slices: PieSliceInput[], radius: number, fontSize: number, maxNameWidth: number): Sized[] {
  let start = 0;
  return slices.map((slice) => {
    const sweep = slice.fraction * Math.PI * 2;
    const middle = start + sweep / 2;
    start += sweep;
    const amountText = `(${slice.amountText})`;
    // 円の内側に入るのは、扇形の弦が「(金額)」の幅より広いときだけ
    const chord = 2 * radius * INSIDE_RADIUS_RATIO * Math.sin(sweep / 2);
    const fitsInside =
      sweep > INSIDE_MIN_ANGLE && chord >= estimateTextWidth(amountText, fontSize) + 6;
    const lines: PieLabelLine[] = [{ text: ellipsize(slice.name, fontSize, maxNameWidth), strong: true }];
    if (slice.note) lines.push({ text: slice.note, strong: false });
    if (!fitsInside) lines.push({ text: `${slice.percentText} ${amountText}`, strong: false });
    // 太字（名前）は同じ字数でも幅が広いので、1割増しで見積もる
    const labelWidth = Math.max(
      ...lines.map((line) =>
        line.strong ? estimateTextWidth(line.text, fontSize) * 1.1 : estimateTextWidth(line.text, fontSize - 1),
      ),
    );
    return { sweep, middle, fitsInside, right: Math.sin(middle) >= 0, lines, labelWidth };
  });
}

export function layoutPie(slices: PieSliceInput[], geometry: PieGeometry): PieSliceLayout[] {
  const { width, height, fontSize } = geometry;
  const cy = height / 2;
  const lineHeight = fontSize + 3;
  const round = (value: number) => Math.round(value * 100) / 100;
  const maxNameWidth = width * 0.38;
  // ラベルは円の左右にそれぞれ置くので、その幅の最大で円の大きさと横位置を決める。
  // 左に名前が集まる並びでも右の余白を無駄にせず、収まらないときは円を小さくする
  const sideNeed = (sized: Sized[], right: boolean) => {
    const widths = sized.filter((item) => item.right === right).map((item) => item.labelWidth);
    return widths.length > 0 ? Math.max(...widths) : 0;
  };
  const edge = LABEL_SIDE_OFFSET + LABEL_TEXT_GAP;

  let radius = geometry.radius;
  let sized = sizeSlices(slices, radius, fontSize, maxNameWidth);
  while (
    radius > MIN_RADIUS &&
    2 * radius + 2 * edge + sideNeed(sized, false) + sideNeed(sized, true) > width
  ) {
    radius -= 2;
    sized = sizeSlices(slices, radius, fontSize, maxNameWidth);
  }
  const leftNeed = radius + edge + sideNeed(sized, false);
  const rightNeed = radius + edge + sideNeed(sized, true);
  // 左右のラベルが収まる範囲の中央に円を置く
  const cx = round(leftNeed + (width - leftNeed - rightNeed) / 2);
  // 12時の位置を起点に時計回り
  const point = (angle: number, distance: number): [number, number] => [
    cx + distance * Math.sin(angle),
    cy - distance * Math.cos(angle),
  ];

  type Pending = {
    layout: PieSliceLayout;
    right: boolean;
    y: number;
    height: number;
    edge: [number, number];
    elbow: [number, number];
  };
  const pending: Pending[] = [];

  let start = 0;
  slices.forEach((slice, index) => {
    const item = sized[index];
    const end = start + item.sweep;

    let path: string;
    if (slice.fraction >= 0.9999) {
      path = `M${round(cx)} ${round(cy - radius)}A${radius} ${radius} 0 1 1 ${round(cx)} ${round(cy + radius)}A${radius} ${radius} 0 1 1 ${round(cx)} ${round(cy - radius)}Z`;
    } else {
      const [x0, y0] = point(start, radius);
      const [x1, y1] = point(end, radius);
      path = `M${round(cx)} ${round(cy)}L${round(x0)} ${round(y0)}A${radius} ${radius} 0 ${item.sweep > Math.PI ? 1 : 0} 1 ${round(x1)} ${round(y1)}Z`;
    }

    let inside: PieSliceLayout["inside"] = null;
    if (item.fitsInside) {
      const [ix, iy] = point(item.middle, radius * INSIDE_RADIUS_RATIO);
      inside = { x: round(ix), y: round(iy) };
    }

    pending.push({
      layout: {
        path,
        inside,
        label: { lines: item.lines, x: 0, lineYs: [], anchor: item.right ? "start" : "end", leader: "" },
      },
      right: item.right,
      y: cy - (radius + LABEL_SIDE_OFFSET + 2) * Math.cos(item.middle),
      height: item.lines.length * lineHeight,
      edge: point(item.middle, radius + LEADER_GAP),
      elbow: point(item.middle, radius + LEADER_ELBOW),
    });
    start = end;
  });

  // 外側のラベルは左右それぞれ、上から順に間隔を空けて詰める。下へはみ出すぶんは全体を上へ戻し、
  // 戻したぶんで重なった行は下から押し上げ直す
  for (const side of [true, false]) {
    const group = pending.filter((item) => item.right === side).sort((a, b) => a.y - b.y);
    let bottom = -Infinity;
    for (const item of group) {
      item.y = Math.max(item.y, bottom + LABEL_GAP + item.height / 2);
      bottom = item.y + item.height / 2;
    }
    const last = group[group.length - 1];
    if (last && last.y + last.height / 2 > height - 2) last.y = height - 2 - last.height / 2;
    for (let i = group.length - 2; i >= 0; i -= 1) {
      const limit = group[i + 1].y - group[i + 1].height / 2 - LABEL_GAP - group[i].height / 2;
      if (group[i].y > limit) group[i].y = limit;
    }
  }

  return pending.map((item) => {
    const sideX = item.right ? cx + radius + LABEL_SIDE_OFFSET : cx - radius - LABEL_SIDE_OFFSET;
    const top = item.y - item.height / 2;
    item.layout.label.x = round(sideX + (item.right ? LABEL_TEXT_GAP : -LABEL_TEXT_GAP));
    item.layout.label.lineYs = item.layout.label.lines.map((_line, index) =>
      round(top + lineHeight * index + fontSize),
    );
    item.layout.label.leader = [item.edge, item.elbow, [sideX, item.y]]
      .map(([px, py]) => `${round(px)},${round(py)}`)
      .join(" ");
    return item.layout;
  });
}
