import { describe, expect, it, vi } from "vitest";

import {
  crossRepoKeyMarker,
  fileCrossRepoIssues,
  parseCrossRepoIssueRequests,
  renderChildBody,
  renderOriginComment,
  type CrossRepoDeps,
  type CrossRepoIssueRef,
  type CrossRepoIssueRequest,
} from "@/lib/dispatch/cross-repo-filing";

const origin = { repository: "guchi-apps/issue-deck", issueNumber: 100 };

function request(overrides: Partial<CrossRepoIssueRequest> = {}): CrossRepoIssueRequest {
  return {
    key: "fix-token",
    targetRepository: "guchi-apps/car-care",
    title: "トークンの復号を直す",
    body: "## 目的\n\n直す\n\n## 完了条件\n\n- 動く",
    waitForOrigin: false,
    launch: true,
    ...overrides,
  };
}

function fakeDeps(overrides: Partial<CrossRepoDeps> = {}) {
  const issues: (CrossRepoIssueRef & { repository: string; body: string })[] = [];
  const subIssueIds: number[] = [];
  const comments: string[] = [];
  const deps: CrossRepoDeps = {
    isRegistered: vi.fn(async () => true),
    findIssueByMarker: vi.fn(async (repository: string, marker: string) => {
      return issues.find((i) => i.repository === repository && i.body.includes(marker)) ?? null;
    }),
    createIssue: vi.fn(async (repository: string, input: { title: string; body: string }) => {
      const issue = { repository, body: input.body, number: issues.length + 1, id: 1000 + issues.length, url: `https://github.com/${repository}/issues/${issues.length + 1}`, state: "open" as const };
      issues.push(issue);
      return issue;
    }),
    listSubIssueIds: vi.fn(async () => [...subIssueIds]),
    addSubIssue: vi.fn(async (_o, id: number) => {
      subIssueIds.push(id);
    }),
    findOriginLaunch: vi.fn(async () => ({ hostName: "subpc", agent: "claude" })),
    launch: vi.fn(async () => ({ ok: true as const })),
    comment: vi.fn(async (_o, body: string) => {
      comments.push(body);
    }),
    ...overrides,
  };
  return { deps, issues, subIssueIds, comments };
}

describe("parseCrossRepoIssueRequests", () => {
  it("既定値を補う（起動する・起点を待たない）", () => {
    const { requests, error } = parseCrossRepoIssueRequests([{ key: "abc", targetRepository: "o/r", title: " t ", body: "b" }], origin);
    expect(error).toBeUndefined();
    expect(requests[0]).toMatchObject({ title: "t", launch: true, waitForOrigin: false });
  });

  it.each([
    [[], "起票依頼が空です"],
    [Array.from({ length: 6 }, (_, i) => ({ ...request(), key: `key-${i}` })), "5件まで"],
    [[{ ...request(), key: "A" }], "keyは"],
    [[request(), request()], "重複"],
    [[{ ...request(), targetRepository: "guchi-apps/issue-deck" }], "起点と同じ"],
    [[{ ...request(), title: "" }], "タイトル"],
    [[{ ...request(), body: "  " }], "本文"],
    [[{ ...request(), body: "token=abcdefghijklmnopqrstu" }], "秘密値"],
    [[{ ...request(), launch: "yes" }], "launch"],
  ])("不正な依頼を拒否する %#", (input, message) => {
    const { requests, error } = parseCrossRepoIssueRequests(input, origin);
    expect(requests).toEqual([]);
    expect(error).toContain(message);
  });
});

describe("renderChildBody", () => {
  it("起点へのリンクとマーカーを足す", () => {
    const body = renderChildBody(request(), origin);
    expect(body).toContain("起点: guchi-apps/issue-deck#100");
    expect(body).toContain(crossRepoKeyMarker(origin, "fix-token"));
    expect(body).not.toContain("## 前提条件");
  });

  it("起点を待つときは前提条件に起点を書く", () => {
    expect(renderChildBody(request({ waitForOrigin: true }), origin)).toContain("先に完了している必要があるIssue・PR: guchi-apps/issue-deck#100");
  });
});

describe("fileCrossRepoIssues", () => {
  it("起票・紐付け・起動・起点へのコメントまで行う", async () => {
    const { deps, subIssueIds, comments } = fakeDeps();
    const [result] = await fileCrossRepoIssues([request()], origin, deps);
    expect(result).toMatchObject({ repository: "guchi-apps/car-care", number: 1, outcome: "created", launch: { status: "launched", hostName: "subpc", agent: "claude" } });
    expect(subIssueIds).toEqual([1000]);
    expect(deps.launch).toHaveBeenCalledWith({ repository: "guchi-apps/car-care", issueNumber: 1, hostName: "subpc", agent: "claude" });
    expect(comments[0]).toContain("guchi-apps/car-care#1（新規起票）");
    expect(comments[0]).toContain("<!-- issue-deck-agent:implementer -->");
  });

  it("同じkeyの再送は起票済みを再利用し、紐付けも重ねない", async () => {
    const { deps, issues } = fakeDeps();
    await fileCrossRepoIssues([request()], origin, deps);
    const [again] = await fileCrossRepoIssues([request()], origin, deps);
    expect(again.outcome).toBe("reused");
    expect(issues).toHaveLength(1);
    expect(deps.addSubIssue).toHaveBeenCalledTimes(1);
  });

  it("起動を頼まれていなければ起動しない", async () => {
    const { deps } = fakeDeps();
    const [result] = await fileCrossRepoIssues([request({ launch: false })], origin, deps);
    expect(result.launch).toEqual({ status: "not_requested" });
    expect(deps.launch).not.toHaveBeenCalled();
  });

  it("起点の起動記録が無ければ起動を見送り、画面からの起動を案内する", async () => {
    const { deps, comments } = fakeDeps({ findOriginLaunch: vi.fn(async () => null) });
    const [result] = await fileCrossRepoIssues([request()], origin, deps);
    expect(result.launch.status).toBe("skipped");
    expect(comments[0]).toContain("「実装を開始」");
  });

  it("起動の拒否・例外は起票の失敗にしない", async () => {
    const { deps } = fakeDeps({ launch: vi.fn(async () => ({ ok: false as const, message: "ホストがオフラインです" })) });
    const [rejected] = await fileCrossRepoIssues([request()], origin, deps);
    expect(rejected.launch).toEqual({ status: "failed", reason: "ホストがオフラインです" });

    const thrown = fakeDeps({ launch: vi.fn(async () => Promise.reject(new Error("boom"))) });
    const [failed] = await fileCrossRepoIssues([request()], origin, thrown.deps);
    expect(failed.launch).toEqual({ status: "failed", reason: "boom" });
  });

  it("クローズ済みの子は起動しない", async () => {
    const { deps } = fakeDeps({
      findIssueByMarker: vi.fn(async () => ({ number: 7, id: 7, url: "u", state: "closed" as const })),
    });
    const [result] = await fileCrossRepoIssues([request()], origin, deps);
    expect(result.launch.status).toBe("skipped");
    expect(deps.launch).not.toHaveBeenCalled();
  });

  it("未登録のリポジトリ・紐付けの失敗は例外にする", async () => {
    const unregistered = fakeDeps({ isRegistered: vi.fn(async () => false) });
    await expect(fileCrossRepoIssues([request()], origin, unregistered.deps)).rejects.toThrow("登録されていない");

    const linkFails = fakeDeps({ addSubIssue: vi.fn(async () => Promise.reject(new Error("403"))) });
    await expect(fileCrossRepoIssues([request()], origin, linkFails.deps)).rejects.toThrow("サブIssueへ紐付けできません");
    expect(linkFails.deps.launch).not.toHaveBeenCalled();
  });
});

describe("renderOriginComment", () => {
  it("すべて起動できたときは画面からの起動を案内しない", () => {
    const body = renderOriginComment(origin, [
      { key: "k", repository: "o/r", number: 1, url: "u", outcome: "reused", launch: { status: "launched", hostName: "h", agent: "codex" } },
    ]);
    expect(body).toContain("起票済みを再利用");
    expect(body).not.toContain("「実装を開始」");
  });
});
