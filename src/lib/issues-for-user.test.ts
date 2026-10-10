import { beforeEach, describe, expect, it, vi } from "vitest";

const issueFindMany = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    issue: {
      get findMany() {
        return issueFindMany;
      },
    },
  },
}));

vi.mock("@/lib/dispatch/pending-dispatch", () => ({
  getPendingDispatchAtByIssue: async () => new Map(),
}));

vi.mock("@/lib/manual-step-verification-patrol", () => ({
  listManualStepVerifiedAtByIssue: async () => new Map(),
}));

import { getIssuesForUser } from "@/lib/issues-for-user";

function row(number: number, state: "OPEN" | "CLOSED") {
  const date = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: `id-${number}`,
    githubIssueId: BigInt(number),
    number,
    title: `Issue ${number}`,
    state,
    stateReason: null,
    authorLogin: "author",
    assigneeLogin: null,
    labels: [],
    milestoneTitle: null,
    milestoneOpen: null,
    milestoneClosed: null,
    commentCount: 0,
    githubCreatedAt: date,
    githubUpdatedAt: date,
    githubClosedAt: state === "CLOSED" ? date : null,
    checkUserLabeledAt: null,
    qaAnswerPendingAt: null,
    lastCommentAt: null,
    projectStatus: null,
    htmlUrl: `https://github.com/owner/repo/issues/${number}`,
    repository: { fullName: "owner/repo", private: false, archived: false },
    favoritedBy: [],
    commentReadBy: [],
  };
}

describe("getIssuesForUser の本文（#3390）", () => {
  beforeEach(() => {
    issueFindMany.mockReset().mockImplementation(async (args: { select?: unknown }) =>
      args.select ? [{ id: "id-1", body: "本文 1" }] : [row(1, "OPEN"), row(2, "CLOSED")],
    );
  });

  it("既定ではopenの本文だけを持たせ、closedは外して印を立てる", async () => {
    const [open, closed] = await getIssuesForUser("user-1");
    expect(open.body).toBe("本文 1");
    expect(open.bodyOmitted).toBeUndefined();
    expect(closed.body).toBe("");
    expect(closed.bodyOmitted).toBe(true);
  });

  it("一覧の本体クエリは本文を読まず、open分だけを別クエリで引く（#4255）", async () => {
    await getIssuesForUser("user-1");
    const [main, bodies] = issueFindMany.mock.calls.map(([args]) => args);
    expect(main.omit).toEqual({ body: true });
    expect(bodies.where.state).toBe("OPEN");
    expect(bodies.select).toEqual({ id: true, body: true });
  });

  it("`none`なら本文用のクエリを発行しない（#4255）", async () => {
    await getIssuesForUser("user-1", { bodies: "none" });
    expect(issueFindMany).toHaveBeenCalledTimes(1);
  });

  it("`none`なら全件の本文を外す", async () => {
    const issues = await getIssuesForUser("user-1", { bodies: "none" });
    expect(issues.map((issue) => [issue.body, issue.bodyOmitted])).toEqual([
      ["", true],
      ["", true],
    ]);
  });
});
