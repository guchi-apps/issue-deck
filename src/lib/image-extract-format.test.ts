import { describe, expect, it } from "vitest";

import {
  EXTRACTED_CHANGES_HEADING,
  formatExtractedChanges,
  UNREADABLE_MARK_LINE,
} from "@/lib/image-extract-format";

describe("formatExtractedChanges", () => {
  it("見出し付きの箇条書きにする", () => {
    expect(formatExtractedChanges({ items: ["保存ボタンを右上へ移動する", "「詳細」を削除する"], unreadable: false })).toBe(
      `${EXTRACTED_CHANGES_HEADING}\n- 保存ボタンを右上へ移動する\n- 「詳細」を削除する`,
    );
  });

  it("行頭の記号・余分な空白・改行を整える", () => {
    expect(formatExtractedChanges({ items: ["- 見出しを\n変更する  "], unreadable: false })).toBe(
      `${EXTRACTED_CHANGES_HEADING}\n- 見出しを 変更する`,
    );
  });

  it("判読できない書き込みがあれば末尾に1行足す", () => {
    expect(formatExtractedChanges({ items: ["A"], unreadable: true })).toBe(
      `${EXTRACTED_CHANGES_HEADING}\n- A\n- ${UNREADABLE_MARK_LINE}`,
    );
  });

  it("足すものが無ければ空文字", () => {
    expect(formatExtractedChanges({ items: ["  "], unreadable: false })).toBe("");
  });
});
