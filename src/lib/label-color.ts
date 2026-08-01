import type { CSSProperties } from "react";

function hexToRgb(hex: string) {
  const normalized = hex.startsWith("#") ? hex.slice(1) : hex;
  const value =
    normalized.length === 3
      ? normalized
          .split("")
          .map((c) => c + c)
          .join("")
      : normalized;
  const num = Number.parseInt(value, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

function perceivedBrightness({ r, g, b }: { r: number; g: number; b: number }) {
  return (r * 299 + g * 587 + b * 114) / 1000;
}

// 薄い色（白に近い色）はそのままだと文字色にしても背景の縁取りにしても視認しづらいため、
// 明度を落として濃さを補う。彩色の濃いラベルはこの補正をせずGitHub本来の色を保つ。
function darken(hex: string, amount: number) {
  const { r, g, b } = hexToRgb(hex);
  const mix = (channel: number) => Math.round(channel * (1 - amount));
  return `#${[mix(r), mix(g), mix(b)].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

const LIGHT_COLOR_THRESHOLD = 190;

/** ラベルバッジ（塗りつぶし文字色パターン）用のスタイルを返す */
export function getLabelBadgeStyle(hex: string): CSSProperties {
  const isLight = perceivedBrightness(hexToRgb(hex)) > LIGHT_COLOR_THRESHOLD;
  return {
    backgroundColor: `${hex}20`,
    color: isLight ? darken(hex, 0.5) : hex,
  };
}

/** ラベル一覧の丸ドット用のスタイルを返す */
export function getLabelDotStyle(hex: string): CSSProperties {
  return { backgroundColor: hex };
}
