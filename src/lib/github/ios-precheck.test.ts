import { describe, expect, it } from "vitest";

import { toIosPrecheckSummary, type IosPrecheckCommitNode } from "@/lib/github/ios-precheck";

function commit(oid: string, state: string | null, description: string | null = null): IosPrecheckCommitNode {
  return {
    oid,
    status: state ? { context: { state, description, createdAt: "2026-10-07T00:00:00Z" } } : null,
  };
}

describe("toIosPrecheckSummary", () => {
  it("どのコミットにもstatusが無ければnull（対象外・未依頼）", () => {
    expect(toIosPrecheckSummary([commit("a", null), commit("b", null)])).toBeNull();
    expect(toIosPrecheckSummary([])).toBeNull();
  });

  it("headに結果があればそれを検証SHAとして出し、前回は持たない", () => {
    const summary = toIosPrecheckSummary([commit("a", "FAILURE", "ビルド失敗"), commit("b", "SUCCESS", "ok")]);
    expect(summary).toEqual({
      headSha: "b",
      head: { phase: "success", description: "ok", sha: "b", updatedAt: "2026-10-07T00:00:00Z" },
      previous: null,
    });
  });

  it("headに無ければ未実施とし、それより前で最後に付いた結果を前回として添える（古い成功を最新に見せない）", () => {
    const summary = toIosPrecheckSummary([
      commit("a", "FAILURE", "古い"),
      commit("b", "SUCCESS", "前回"),
      commit("c", null),
    ]);
    expect(summary?.head).toBeNull();
    expect(summary?.headSha).toBe("c");
    expect(summary?.previous).toMatchObject({ phase: "success", sha: "b", description: "前回" });
  });

  it("pendingは文言で検証中と検証待ちに分ける（scripts/ios-precheck.shのstatus_forに合わせる）", () => {
    const phaseOf = (description: string | null) =>
      toIosPrecheckSummary([commit("a", "PENDING", description)])?.head?.phase;
    expect(phaseOf("iOS検証: ビルド中")).toBe("running");
    expect(phaseOf("iOS検証待ち（Macのキュー待ち）")).toBe("running");
    expect(phaseOf("iOS検証待ち（unreachable）: Macへ接続できません")).toBe("waiting");
    expect(phaseOf(null)).toBe("waiting");
  });

  it("errorは検証失敗として扱う", () => {
    expect(toIosPrecheckSummary([commit("a", "ERROR")])?.head?.phase).toBe("failure");
  });
});
