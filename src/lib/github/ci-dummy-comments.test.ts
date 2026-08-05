import { describe, expect, it } from "vitest";

import { getCiDummyComments } from "@/lib/github/ci-dummy-comments";

describe("getCiDummyComments", () => {
  it("AI要約ボタンの表示条件（本文400文字超）を満たすコメントを1件以上含む", () => {
    const comments = getCiDummyComments();
    expect(comments.some((comment) => (comment.body ?? "").length > 400)).toBe(true);
  });

  it("コメントIDが重複しない", () => {
    const comments = getCiDummyComments();
    const ids = comments.map((comment) => comment.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
