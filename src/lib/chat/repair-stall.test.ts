import { describe, expect, it } from "vitest";

import { detectRepairStall } from "@/lib/chat/repair-stall";

const report = (n: number, text = "途中PRか最終PRかの方針をご回答ください") => ({
  body: `${text}\n<!-- issue-deck-agent:implementer -->`,
  created_at: `2026-10-08T0${n}:00:00Z`,
});

describe("detectRepairStall", () => {
  it("方針待ちの停止が3回続くと停止扱い（4回目を起動しない）", () => {
    expect(detectRepairStall([report(1), report(2), report(3)])).toMatchObject({ stalled: true, consecutive: 3 });
  });
  it("2回ではまだ停止扱いにしない", () => {
    expect(detectRepairStall([report(1), report(2)]).stalled).toBe(false);
  });
  it("利用者が承認した修正依頼より後の停止だけを数える", () => {
    const request = { body: "<!-- issue-deck-chat-fix-request:abc sha=1 -->", created_at: "2026-10-08T04:00:00Z" };
    expect(detectRepairStall([report(1), report(2), report(3), request]).stalled).toBe(false);
  });
  it("判断待ちでない報告で連続が切れる", () => {
    expect(detectRepairStall([report(1), report(2, "実装を完了しました"), report(3)]).consecutive).toBe(1);
  });
});
