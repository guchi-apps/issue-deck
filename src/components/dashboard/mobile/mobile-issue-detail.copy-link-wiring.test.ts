import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #5097: スマホのIssue詳細は`issue-detail.tsx`と別の⋯メニューを持つ。#5092で「リンクをコピー」を
// PC側にだけ足して、スマホに出なかった。同じ項目が両方にあることを固定する
describe("mobile-issue-detail の「リンクをコピー」（#5097）", () => {
  const read = (file: string) => readFileSync(join(__dirname, file), "utf8");
  const urlCall = 'buildDashboardUrl(window.location.origin, "issue", String(issue.id))';

  it("操作メニューにIssue詳細へのリンクをコピーする項目がある", () => {
    const source = read("mobile-issue-detail.tsx");
    expect(source).toContain("リンクをコピー");
    expect(source).toContain(urlCall);
  });

  it("PC側と同じURLの作り方である", () => {
    expect(read("../issue-detail.tsx")).toContain(urlCall);
  });
});
