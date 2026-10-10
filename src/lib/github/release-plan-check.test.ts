import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolvePlanCheck } from "@/lib/github/release-plan-check";

const c = (body: string) => ({ body, author: { login: "u" }, authorTrusted: true }) as never;
const untrusted = (body: string) => ({ body, author: { login: "x" }, authorTrusted: false }) as never;
const PLAN = "<!-- issue-deck:session-plan -->";

describe("resolvePlanCheck", () => {
  it("計画コメントが無ければ計画なし（対象外）", () => {
    expect(resolvePlanCheck([c("着手します")]).state).toBe("no-plan");
    expect(resolvePlanCheck([]).state).toBe("no-plan");
  });

  it("計画だけでレビューが無ければ未実施", () => {
    expect(resolvePlanCheck([c(PLAN)]).state).toBe("unreviewed");
  });

  it("重大な指摘が未応答なら要修正（findings）", () => {
    const body = readFileSync(
      path.join(process.cwd(), "src/lib/github/__fixtures__/plan-review-three-findings.md"),
      "utf8",
    );
    expect(resolvePlanCheck([c(PLAN), c(body)]).state).toBe("findings");
  });

  it("応答済みなら reviewed", () => {
    const result = resolvePlanCheck([
      c(PLAN),
      c("<!-- supervisor:plan-review -->"),
      c("<!-- issue-deck-agent:plan-reviser -->"),
    ]);
    expect(result.state).toBe("reviewed");
  });

  it("レビュー省略の記録は省略", () => {
    expect(resolvePlanCheck([c(PLAN), c("<!-- issue-deck:plan-review-skipped -->\nレビュー省略: 小さな変更")]).state).toBe(
      "skipped",
    );
  });

  it("信頼できない投稿者のマーカーでは状態を偽装できない", () => {
    expect(resolvePlanCheck([c(PLAN), untrusted("<!-- issue-deck:plan-review-skipped -->")]).state).toBe("unreviewed");
    expect(resolvePlanCheck([untrusted(PLAN)]).state).toBe("no-plan");
  });
});
