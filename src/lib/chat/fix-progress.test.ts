import { describe, expect, it } from "vitest";

import { computeFixProgress, type FixProgressInput } from "@/lib/chat/fix-progress";

const base: FixProgressInput = {
  repo: "a/b",
  number: 1,
  requestedHeadSha: "aaaaaaa1111",
  pr: { state: "open", merged: false, headSha: "aaaaaaa1111", htmlUrl: "https://github.com/a/b/pull/1" },
  ciState: "success",
  activeRepair: false,
  agentReported: false,
  verdict: { reviewKind: "ok", reviewedSha: "aaaaaaa" },
  fetchedAt: "2026-10-05T00:00:00Z",
};

describe("computeFixProgress", () => {
  it("HEADが進んでいなければ、古いCI・レビューが良好でも完了にしない", () => {
    expect(computeFixProgress(base).phase).toBe("requested");
    expect(computeFixProgress({ ...base, activeRepair: true }).phase).toBe("working");
    expect(computeFixProgress({ ...base, agentReported: true }).phase).toBe("working");
  });
  it("pushされたがCI実行中ならCI待ち（完了ではない）", () => {
    const card = computeFixProgress({ ...base, pr: { ...base.pr, headSha: "bbbbbbb2222" }, ciState: "pending", verdict: null });
    expect(card.phase).toBe("waiting_ci");
    expect(card.steps[1].done).toBe(true);
    expect(card.steps[2].done).toBe(false);
  });
  it("CI成功でも新HEADへのレビュー判定が無ければレビュー待ち", () => {
    const card = computeFixProgress({ ...base, pr: { ...base.pr, headSha: "bbbbbbb2222" } });
    expect(card.phase).toBe("waiting_review"); // 判定は古いHEAD(aaaaaaa)のもの
  });
  it("新HEADのCI成功＋そのHEADへの自動レビュー通過で検証済み", () => {
    const card = computeFixProgress({
      ...base,
      pr: { ...base.pr, headSha: "bbbbbbb2222" },
      verdict: { reviewKind: "ok", reviewedSha: "bbbbbbb" },
    });
    expect(card.phase).toBe("verified");
  });
  it("CI失敗・未解消の指摘・クローズは失敗として区別する", () => {
    const moved = { ...base.pr, headSha: "bbbbbbb2222" };
    expect(computeFixProgress({ ...base, pr: moved, ciState: "failure" }).phase).toBe("failed");
    expect(
      computeFixProgress({ ...base, pr: moved, verdict: { reviewKind: "changes-requested", reviewedSha: "bbbbbbb" } }).phase,
    ).toBe("failed");
    expect(computeFixProgress({ ...base, pr: { ...moved, state: "closed" } }).phase).toBe("failed");
  });
});
