import { describe, expect, it } from "vitest";

import {
  isSubIssueDone,
  resolveSubIssueProgress,
  summarizeSubIssueProgress,
} from "@/lib/sub-issue-progress";
import type { SubIssue } from "@/types/issue";

function child(overrides: Partial<SubIssue> = {}): SubIssue {
  return {
    number: 1,
    title: "子Issue",
    state: "open",
    htmlUrl: "https://github.com/guchi-apps/issue-deck/issues/1",
    projectStatus: null,
    ...overrides,
  };
}

describe("resolveSubIssueProgress", () => {
  it("Project Statusから進捗を解決する", () => {
    expect(resolveSubIssueProgress(child({ projectStatus: "Implementation" }))).toBe("implementation");
    expect(resolveSubIssueProgress(child({ projectStatus: "Develop PR" }))).toBe("develop-pr");
  });

  it("Statusが無い（Project未登録・DB未キャッシュ）子は未着手として扱う", () => {
    expect(resolveSubIssueProgress(child({ projectStatus: null }))).toBe("ready");
  });

  it("closeされた子は、Statusが途中でもdoneとして扱う", () => {
    // not plannedでのclose・分割元のcloseなど、Doneまで進まずに閉じる経路が実在する
    expect(resolveSubIssueProgress(child({ state: "closed", projectStatus: "Implementation" }))).toBe(
      "done",
    );
    expect(resolveSubIssueProgress(child({ state: "closed", projectStatus: null }))).toBe("done");
  });
});

describe("isSubIssueDone", () => {
  it("openでStatusがDoneなら終わり扱いにする", () => {
    expect(isSubIssueDone(child({ projectStatus: "Done" }))).toBe(true);
  });

  it("openで途中のStatusなら終わっていない", () => {
    expect(isSubIssueDone(child({ projectStatus: "Develop" }))).toBe(false);
  });
});

describe("summarizeSubIssueProgress", () => {
  it("子が0件なら総数も完了率も0になる", () => {
    expect(summarizeSubIssueProgress([])).toEqual({ total: 0, done: 0, percent: 0, buckets: [] });
  });

  it("内訳は進捗の遷移順に並び、件数0の状態は含まない", () => {
    const summary = summarizeSubIssueProgress([
      child({ number: 3, state: "closed" }),
      child({ number: 1, projectStatus: "Implementation" }),
      child({ number: 2, projectStatus: null }),
      child({ number: 4, projectStatus: "Implementation" }),
    ]);

    expect(summary.buckets).toEqual([
      { key: "ready", count: 1 },
      { key: "implementation", count: 2 },
      { key: "done", count: 1 },
    ]);
    expect(summary.total).toBe(4);
    expect(summary.done).toBe(1);
    expect(summary.percent).toBe(25);
  });

  it("完了率は四捨五入した整数にする", () => {
    const summary = summarizeSubIssueProgress([
      child({ number: 1, state: "closed" }),
      child({ number: 2 }),
      child({ number: 3 }),
    ]);
    expect(summary.percent).toBe(33);
  });
});
