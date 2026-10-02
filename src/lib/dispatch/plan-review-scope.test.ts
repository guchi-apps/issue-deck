import { describe, expect, it } from "vitest";

import { judgePlanReviewScope } from "@/lib/dispatch/plan-review-scope";

const plan = (summary: string, files: string[]) =>
  `## 要約\n${summary}\n\n## 変更するファイル\n${files.map((f) => `- \`${f}\`: 直す`).join("\n")}\n`;

describe("judgePlanReviewScope", () => {
  it("表示・文言だけで、変更ファイルが画面の範囲なら省略する", () => {
    const result = judgePlanReviewScope(plan("**ボタンの文言を修正する**", ["src/components/dashboard/a.tsx"]));
    expect(result.review).toBe(false);
    expect(result.reason).toContain("省略");
  });

  it.each([
    ["認証", "認証の判定を直す"],
    ["DB・データ", "既存データを移行する"],
    ["配布経路", "共有スクリプトの配布先を変える"],
    ["本番手順", "本番のデプロイ手順を変える"],
  ])("小さな変更でも%sに関わるなら実施する", (_label, text) => {
    const result = judgePlanReviewScope(plan(`文言の修正。${text}`, ["src/components/dashboard/a.tsx"]));
    expect(result.review).toBe(true);
  });

  it("変更ファイルに画面以外が混ざれば、判定不能として理由付きで実施する", () => {
    const result = judgePlanReviewScope(plan("文言を修正する", ["src/lib/foo.ts", "src/components/a.tsx"]));
    expect(result.review).toBe(true);
    expect(result.reason).toContain("判断できない");
  });

  it("ファイルが読めない計画は判定不能として実施する", () => {
    expect(judgePlanReviewScope("## 要約\n文言を修正する").review).toBe(true);
  });
});
