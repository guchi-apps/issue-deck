import { describe, expect, it } from "vitest";

import { FALLBACK_NOTICE_MARKER, isFallbackNoticeComment } from "@/lib/github/fallback-notice";

describe("isFallbackNoticeComment", () => {
  it("ワークフローが実際に投稿する形式（本文末尾に空行区切りでマーカー）をtrueと判定する", () => {
    expect(
      isFallbackNoticeComment({
        body: `⚠️ 実装ステップが終了しましたが...\n\n実行ログ: https://example.com\n\n${FALLBACK_NOTICE_MARKER}`,
      }),
    ).toBe(true);
  });

  it("マーカーが無いコメントはfalseと判定する", () => {
    expect(isFallbackNoticeComment({ body: "通常の実装進捗コメント" })).toBe(false);
  });

  it("マーカー文字列を文中で引用しただけの通常コメントはfalseと判定する（#495）", () => {
    expect(
      isFallbackNoticeComment({
        body: `計画コメントの例です。フォールバック通知は末尾に${FALLBACK_NOTICE_MARKER}を付与します。ここではまだ計画の説明が続きます。`,
      }),
    ).toBe(false);
  });

  it("空行区切りなしで末尾にマーカーが付いているだけのコメントはfalseと判定する", () => {
    expect(isFallbackNoticeComment({ body: `通常のコメント${FALLBACK_NOTICE_MARKER}` })).toBe(
      false,
    );
  });
});
