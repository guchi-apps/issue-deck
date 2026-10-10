// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReleaseRebuildHistoryPanel } from "@/components/dashboard/release-rebuild-history-panel";
import { buildRebuildEpisodes, type RebuildEventView } from "@/lib/release-rebuild-history";

type Ev = RebuildEventView & { originPrNumber: number; originHeadSha: string };
const base = { actorName: null, reason: null, seriesId: null, originPrNumber: 4345, originHeadSha: "a".repeat(40) } as const;

function mockEpisodes(events: Ev[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ episodes: buildRebuildEpisodes(events) }), { status: 200 })),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ReleaseRebuildHistoryPanel", () => {
  it("後継候補が無い間も、元候補・承認者・承認範囲・含める／含めないPRを出す", async () => {
    mockEpisodes([
      { ...base, id: "1", kind: "approval", actorKind: "user", actorName: "guchi", trigger: "manual", payload: { approvedPrs: [{ number: 4339, title: "追加A" }] }, createdAt: "2026-10-11T02:05:00.000Z" },
      {
        ...base,
        id: "2",
        kind: "rebuild_started",
        actorKind: "system",
        trigger: "fix_series_after_approval",
        payload: { selectedPrs: [{ number: 4353, title: "修正A", mergeSha: "b".repeat(40) }], excludedPrs: [4400], approvalEventId: "1" },
        createdAt: "2026-10-11T02:06:00.000Z",
      },
    ]);
    render(<ReleaseRebuildHistoryPanel repositoryFullName="o/r" />);
    await waitFor(() => expect(screen.getByTestId("release-rebuild-history")).toBeTruthy());
    const text = screen.getByTestId("release-rebuild-history").textContent ?? "";
    expect(text).toContain("元候補 #4345");
    expect(text).toContain("後継候補を準備中");
    expect(text).toContain("guchi（ユーザー）");
    expect(text).toContain("手動承認を契機にした自動作り直し");
    expect(text).toContain("今回は含めない");
    expect(text).toContain("#4400");
    expect(text).not.toContain("操作経路不明: この作り直し");
  });

  it("操作記録が無い履歴は経路不明と出し、承認の記録を作らない", async () => {
    mockEpisodes([
      { ...base, id: "legacy-1", kind: "legacy_unknown", actorKind: "unknown", trigger: "unknown", payload: { successor: { number: 4360, headSha: null, baseSha: null } }, createdAt: "2026-10-11T02:06:00.000Z" },
    ]);
    render(<ReleaseRebuildHistoryPanel repositoryFullName="o/r" />);
    await waitFor(() => expect(screen.getByTestId("release-rebuild-history")).toBeTruthy());
    const text = screen.getByTestId("release-rebuild-history").textContent ?? "";
    expect(text).toContain("操作経路不明");
    expect(text).not.toContain("承認した範囲");
  });

  it("履歴が無ければ何も出さない", async () => {
    mockEpisodes([]);
    const { container } = render(<ReleaseRebuildHistoryPanel repositoryFullName="o/r" />);
    await new Promise((r) => setTimeout(r, 10));
    expect(container.innerHTML).toBe("");
  });
});
