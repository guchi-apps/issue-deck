import { describe, expect, it } from "vitest";

import { parseSessionTimelineEvents } from "@/lib/dispatch/session-timeline";

describe("parseSessionTimelineEvents", () => {
  it("表示を許可した小さなイベントだけを受け取る", () => {
    expect(parseSessionTimelineEvents([{ occurredAt: "2026-10-03T15:00:00.000Z", kind: "assistant", title: "Codex", body: "確認します。" }])).toEqual([{ occurredAt: "2026-10-03T15:00:00.000Z", kind: "assistant", title: "Codex", body: "確認します。" }]);
  });

  it("未知の種別と長すぎる本文を拒否する", () => {
    expect(parseSessionTimelineEvents([{ occurredAt: "2026-10-03T15:00:00.000Z", kind: "tool", title: "Bash" }])).toBeNull();
    expect(parseSessionTimelineEvents([{ occurredAt: "2026-10-03T15:00:00.000Z", kind: "assistant", title: "Codex", body: "x".repeat(1_201) }])).toBeNull();
  });
});
