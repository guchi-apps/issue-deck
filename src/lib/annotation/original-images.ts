/**
 * 書き込み後の画像URL→書き込む前の元画像URLの対応表（#3851）。
 *
 * 書き込みエディタで保存すると添付は書き込み後の画像へ差し替わり、元画像は本文から消える。
 * 「画像から変更内容を抽出」で取り消し線の下にあった文字を読めるよう、元画像を覚えておく。
 * **ブラウザのメモリ上だけで持つ**（リロードで消える。消えたら書き込み後の1枚だけで読む）。
 */
const originalByAnnotated = new Map<string, string>();

/** 書き込み後の画像を登録する。書き込み済みの画像へ重ねて書き込んだときは、最初の元画像を保つ */
export function registerOriginalImage(annotatedUrl: string, originalUrl: string): void {
  if (annotatedUrl === originalUrl) return;
  originalByAnnotated.set(annotatedUrl, originalByAnnotated.get(originalUrl) ?? originalUrl);
}

/** 指定した画像のうち、元画像が分かるものだけを「書き込み後URL→元画像URL」で返す */
export function pickOriginalImages(urls: string[]): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const url of urls) {
    const original = originalByAnnotated.get(url);
    if (original) picked[url] = original;
  }
  return picked;
}
