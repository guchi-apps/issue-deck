import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * カード画像（satori）で日本語を描くためのフォント（#5090）。
 *
 * satoriの既定フォントは日本語の字形を持たず、タイトルが豆腐になる。新しい依存を足さず、
 * 画面用に既に入っている`@fontsource/murecho`のwoff（unicode-range別に約120個へ分割済み）から、
 * **描く文字を含む分割ファイルだけ**を読んで渡す（satoriはwoff2を読めないのでwoffを使う）。
 * 本番は`next start`でnode_modulesがそのまま残るため、ファイルを直接読める。
 */
export type ShareCardFont = { name: string; data: Buffer; weight: 400 | 700; style: "normal" };

/**
 * satoriはフォント名ごとに太さの合う1つだけを優先し、残りは登録順の代替に回す。分割を同じ名前で
 * 登録すると大半の文字が400の分割で描かれ太字が効かないため、**分割ごとに別名**（400と700で共通）を
 * 付け、`fontFamily`にその全部を並べる。
 */
export type ShareCardFontSet = { fonts: ShareCardFont[]; fontFamily: string };

type Subset = { file: string; ranges: [number, number][] };

const FONT_DIR = path.join(process.cwd(), "node_modules", "@fontsource", "murecho");

/** `@font-face`のCSSから、woffのファイル名とunicode-rangeの組を取り出す */
export function parseFontsourceCss(css: string): Subset[] {
  const subsets: Subset[] = [];
  for (const block of css.split("@font-face").slice(1)) {
    const file = block.match(/url\(\.\/files\/([^)]+\.woff)\)/)?.[1];
    const range = block.match(/unicode-range:\s*([^;]+);/)?.[1];
    if (!file || !range) continue;
    const ranges = range.split(",").map((part): [number, number] => {
      const [lo, hi] = part.trim().replace(/^U\+/i, "").split("-");
      return [parseInt(lo, 16), parseInt(hi ?? lo, 16)];
    });
    subsets.push({ file, ranges });
  }
  return subsets;
}

/** 分割の名前。`murecho-102-700-normal.woff`→`murecho-102`（400・700で同じ名前にする） */
export function subsetFamilyName(file: string): string {
  return file.replace(/-(?:400|700)-normal\.woff$/, "");
}

/** `text`の文字を1つでも含む分割ファイル名（出現順） */
export function pickSubsetFiles(subsets: Subset[], text: string): string[] {
  const codePoints = new Set(Array.from(text, (ch) => ch.codePointAt(0)!));
  return subsets
    .filter((s) => s.ranges.some(([lo, hi]) => [...codePoints].some((cp) => cp >= lo && cp <= hi)))
    .map((s) => s.file);
}

const subsetCache = new Map<number, Promise<Subset[]>>();
const fileCache = new Map<string, Promise<Buffer>>();

function loadSubsets(weight: 400 | 700): Promise<Subset[]> {
  let cached = subsetCache.get(weight);
  if (!cached) {
    // 失敗は覚えず、次の要求で読み直す
    cached = readFile(path.join(FONT_DIR, `${weight}.css`), "utf8")
      .then(parseFontsourceCss)
      .catch((error) => {
        subsetCache.delete(weight);
        throw error;
      });
    subsetCache.set(weight, cached);
  }
  return cached;
}

function loadFile(file: string): Promise<Buffer> {
  let cached = fileCache.get(file);
  if (!cached) {
    cached = readFile(path.join(FONT_DIR, "files", file)).catch((error) => {
      fileCache.delete(file);
      throw error;
    });
    fileCache.set(file, cached);
  }
  return cached;
}

/**
 * `text`を描くのに要るMurechoの分割を、400・700の両方について読み込む。
 * 読めなかった場合はフォント無し（satoriの既定フォントで描く。日本語は欠けるが画像自体は返す）。
 */
export async function loadShareCardFonts(text: string): Promise<ShareCardFontSet> {
  try {
    const perWeight = await Promise.all(
      ([400, 700] as const).map(async (weight) => {
        const files = pickSubsetFiles(await loadSubsets(weight), text);
        const data = await Promise.all(files.map(loadFile));
        return data.map(
          (d, i): ShareCardFont => ({ name: subsetFamilyName(files[i]), data: d, weight, style: "normal" }),
        );
      }),
    );
    const fonts = perWeight.flat();
    return { fonts, fontFamily: [...new Set(fonts.map((f) => f.name))].join(", ") };
  } catch {
    return { fonts: [], fontFamily: "sans-serif" };
  }
}
