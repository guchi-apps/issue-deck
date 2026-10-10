import { beforeEach, describe, expect, it, vi } from "vitest";

const githubGraphql = vi.fn();
const githubFetch = vi.fn();
vi.mock("@/lib/github/graphql", () => ({
  get githubGraphql() {
    return githubGraphql;
  },
}));
vi.mock("@/lib/github/request", () => ({
  GITHUB_API: "https://api.github.com",
  get githubFetch() {
    return githubFetch;
  },
}));

import { checkPromotionCandidates, hasUnjudgedMemo, type CandidateIssue } from "@/lib/github/knowledge-promotion-candidates";

const memo = (createdAt: string, association = "OWNER") => ({
  body: "<!-- knowledge-candidate -->\n### x",
  createdAt,
  authorAssociation: association,
});
const judged = (createdAt: string) => ({
  body: "結果\n<!-- knowledge-promotion:judged -->",
  createdAt,
  authorAssociation: "OWNER",
});
const node = (over: Record<string, unknown>) => ({
  number: 1,
  state: "OPEN",
  stateReason: null,
  repository: { nameWithOwner: "guchi-apps/app" },
  comments: { nodes: [] },
  ...over,
});
const respond = (unjudged: unknown[], rechecked: unknown[] = []) =>
  githubGraphql.mockResolvedValue({ unjudged: { nodes: unjudged }, rechecked: { nodes: rechecked } });

describe("hasUnjudgedMemo", () => {
  const base = { repoFullName: "a/b", number: 1, state: "OPEN", stateReason: null };
  it("判定より後に付いたメモは対象に戻る", () => {
    const issue: CandidateIssue = { ...base, comments: [memo("2026-01-01"), judged("2026-01-02"), memo("2026-01-03")] };
    expect(hasUnjudgedMemo(issue)).toEqual({ hasMemo: true, hasJudged: true });
  });
  it("判定前のメモだけなら対象外", () => {
    const issue: CandidateIssue = { ...base, comments: [memo("2026-01-01"), judged("2026-01-02")] };
    expect(hasUnjudgedMemo(issue).hasMemo).toBe(false);
  });
  it("第三者のコメントは入力にしない", () => {
    const issue: CandidateIssue = { ...base, comments: [memo("2026-01-01", "NONE")] };
    expect(hasUnjudgedMemo(issue).hasMemo).toBe(false);
  });
});

describe("checkPromotionCandidates", () => {
  beforeEach(() => {
    githubGraphql.mockReset();
    githubFetch.mockReset();
  });

  it("closeしたIssueの未判定メモは候補", async () => {
    respond([node({ state: "CLOSED", stateReason: "COMPLETED", comments: { nodes: [memo("2026-01-01")] } })]);
    expect(await checkPromotionCandidates("t")).toEqual({
      kind: "candidates",
      count: 1,
      issues: ["guchi-apps/app#1"],
    });
    expect(githubFetch).not.toHaveBeenCalled();
  });

  it("判定済みのIssueに付いた新しいメモも拾い、検索の重複は1件にする", async () => {
    const issue = node({
      state: "CLOSED",
      stateReason: "COMPLETED",
      comments: { nodes: [memo("2026-01-01"), judged("2026-01-02"), memo("2026-01-03")] },
    });
    respond([], [issue, issue]);
    expect((await checkPromotionCandidates("t")).kind).toBe("candidates");
  });

  it("openでもissueブランチのPRがマージ済みなら候補", async () => {
    respond([node({ comments: { nodes: [memo("2026-01-01")] } })]);
    githubFetch.mockResolvedValue({ ok: true, json: async () => [{ merged_at: "2026-01-02" }] });
    expect((await checkPromotionCandidates("t")).kind).toBe("candidates");
  });

  it("未マージなら候補なし（unmerged）", async () => {
    respond([node({ comments: { nodes: [memo("2026-01-01")] } })]);
    githubFetch.mockResolvedValue({ ok: true, json: async () => [{ merged_at: null }] });
    expect(await checkPromotionCandidates("t")).toMatchObject({ kind: "none", reason: "unmerged" });
  });

  it("判定済みのみ・メモなしを区別する", async () => {
    respond([], [node({ comments: { nodes: [memo("2026-01-01"), judged("2026-01-02")] } })]);
    expect(await checkPromotionCandidates("t")).toMatchObject({ kind: "none", reason: "judged_only" });
    respond([node({ comments: { nodes: [] } })]);
    expect(await checkPromotionCandidates("t")).toMatchObject({ kind: "none", reason: "no_memo" });
  });

  it("API失敗は候補なしではなくfailed", async () => {
    githubGraphql.mockRejectedValue(new Error("502"));
    expect(await checkPromotionCandidates("t")).toEqual({ kind: "failed", message: "502" });
  });

  it("PR確認の失敗もfailed", async () => {
    respond([node({ comments: { nodes: [memo("2026-01-01")] } })]);
    githubFetch.mockResolvedValue({ ok: false, status: 403 });
    expect((await checkPromotionCandidates("t")).kind).toBe("failed");
  });
});
