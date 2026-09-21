/**
 * 画像から読み取った変更内容の、**画面とAPIが共有する形**と本文への整形（#3243）。
 *
 * 画像の読み込み・AI呼び出しは`lib/claude/image-extract.ts`（`node:fs`を使うサーバー専用）が持つ。
 * クライアントコンポーネントが読むものはこちらに分ける（`lib/markdown-attachments.ts`と同じ理由）。
 */

/** 本文へ足すときの見出し。見出しの文言はここ1か所が正 */
export const EXTRACTED_CHANGES_HEADING = "## 画像から読み取った変更内容";

/** 判読できない書き込みがあったときに、箇条書きの末尾へ足す1行 */
export const UNREADABLE_MARK_LINE = "判読できない書き込みがあります（画像を確認してください）";

export type ImageExtractResult = {
  /** 変更内容1件ぶん。1件1行 */
  items: string[];
  /** 読み取れない書き込みが残っていたか */
  unreadable: boolean;
};

/** 1件が長すぎても本文を荒らさないよう、行の長さを抑える */
const MAX_ITEM_LENGTH = 300;

function normalizeItem(item: string): string {
  return item.replace(/\s+/g, " ").trim().replace(/^[-*・]\s*/, "").slice(0, MAX_ITEM_LENGTH);
}

/** 本文へ足す文（見出し＋箇条書き）。足すものが無ければ空文字 */
export function formatExtractedChanges(result: ImageExtractResult): string {
  const lines = result.items.map(normalizeItem).filter((item) => item !== "");
  if (result.unreadable) lines.push(UNREADABLE_MARK_LINE);
  if (lines.length === 0) return "";
  return `${EXTRACTED_CHANGES_HEADING}\n${lines.map((line) => `- ${line}`).join("\n")}`;
}
