import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #4304: モバイルの詳細が計画レビュー待ちの判定を、概要カードと進捗カードの両方へ渡していること。
// prop渡し忘れ（#4300で確認待ちと起動待ちが同時に出た原因）を検出する
describe("mobile-issue-detail の計画レビュー待ちの配線（#4304）", () => {
  const source = readFileSync(join(__dirname, "mobile-issue-detail.tsx"), "utf8");

  it("共通の判定を使い、概要カードと進捗カードの両方へ渡す", () => {
    expect(source).toContain("isPlanReviewAttentionHeld(");
    const passed = source.match(/planReviewCreating=\{planReviewCreating\}/g) ?? [];
    expect(passed.length).toBeGreaterThanOrEqual(2);
    expect(source).toMatch(/<MobileIssueSummaryCard[\s\S]*?planReviewCreating=/);
    expect(source).toMatch(/<IssueStatusCard[\s\S]*?planReviewCreating=/);
  });
});
