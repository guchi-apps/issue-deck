import { describe, expect, it } from "vitest";

import { classifyReleaseContents, importedRevisionByPr } from "@/lib/release-contents";
import type { ReleaseChangePullRequest } from "@/types/pull-request";

const pr = (number: number, isVersionBump = false): ReleaseChangePullRequest => ({
  number,
  title: `PR${number}`,
  issueNumber: null,
  isVersionBump,
  review: null,
  prHeadSha: null,
  reviewUnavailable: false,
});
const base = { isLoading: false, error: null, addedPrNumbers: [], excludedPrNumbers: [] };

describe("classifyReleaseContents", () => {
  it("元の変更＋修正A＋未選択の無関係B: Bを含めず、Aは追加として区別する", () => {
    const r = classifyReleaseContents({
      ...base,
      changes: { pullRequests: [pr(1), pr(2), pr(100, true)], unknownCommits: [], truncated: false },
      addedPrNumbers: [2],
      excludedPrNumbers: [3],
    });
    expect(r.kind).toBe("ready");
    if (r.kind !== "ready") return;
    expect(r.original.map((p) => p.number)).toEqual([1]);
    expect(r.added.map((p) => p.number)).toEqual([2]);
    expect(r.excluded).toEqual([3]);
  });

  it("差分に載っているPRは、記録で含めないとあっても含める側が正", () => {
    const r = classifyReleaseContents({
      ...base,
      changes: { pullRequests: [pr(3)], unknownCommits: [], truncated: false },
      excludedPrNumbers: [3],
    });
    if (r.kind !== "ready") throw new Error("ready");
    expect(r.excluded).toEqual([]);
  });

  it("取得中・失敗は変更なしにしない。PR不明・打ち切りは保持する", () => {
    expect(classifyReleaseContents({ ...base, changes: null }).kind).toBe("loading");
    expect(classifyReleaseContents({ ...base, changes: null, error: "x" }).kind).toBe("error");
    const r = classifyReleaseContents({
      ...base,
      changes: { pullRequests: [], unknownCommits: [{ sha: "a", title: "t" }], truncated: true },
    });
    if (r.kind !== "ready") throw new Error("ready");
    expect(r.unknownCommits).toHaveLength(1);
    expect(r.truncated).toBe(true);
  });
});

describe("新方式の候補の取り込み（#5469）", () => {
  it("適用済みrevisionで取り込んだPRは「元から含む」でなく取り込みの区分にrevision付きで分ける", () => {
    const r = classifyReleaseContents({
      ...base,
      changes: { pullRequests: [pr(1019), pr(1024), pr(1031)], unknownCommits: [], truncated: false },
      importedPrs: [{ number: 1031, revision: 2 }],
    });
    if (r.kind !== "ready") throw new Error("ready");
    expect(r.original.map((p) => p.number)).toEqual([1019, 1024]);
    expect(r.added).toEqual([expect.objectContaining({ number: 1031, importedRevision: 2 })]);
  });

  it("前のリリースで取り込み済みとして外したPRを通す（差分に載っているものは除く）", () => {
    const r = classifyReleaseContents({
      ...base,
      changes: { pullRequests: [pr(1016)], unknownCommits: [], truncated: false, releasedByPick: [1012, 1016, 1012] },
    });
    if (r.kind !== "ready") throw new Error("ready");
    expect(r.releasedByPick).toEqual([1012]);
  });

  it("importedRevisionByPr: 適用済みのrevisionだけを古い順に見て、最初に取り込んだrevisionを返す", () => {
    const map = importedRevisionByPr([
      { revision: 3, status: "requested", importedPrs: [{ number: 7 }] },
      { revision: 2, status: "applied", importedPrs: [{ number: 5 }] },
      { revision: 4, status: "applied", importedPrs: [{ number: 5 }, { number: 6 }] },
      { revision: 1, status: "applied", importedPrs: null },
    ]);
    expect([...map]).toEqual([[5, 2], [6, 4]]);
  });
});
