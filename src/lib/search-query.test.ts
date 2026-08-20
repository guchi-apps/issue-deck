import { describe, expect, it } from "vitest";
import { extractSearchTokens, matchesSearchQuery, parseSearchQuery } from "@/lib/search-query";
import type { Issue } from "@/types/issue";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "1",
    number: 1,
    title: "サンプルIssue",
    body: "本文のテキスト",
    state: "open",
    stateReason: null,
    repositoryFullName: "owner/repo",
    repositoryPrivate: false,
    repositoryArchived: false,
    author: { login: "author-user" },
    assignee: null,
    labels: [],
    milestone: null,
    commentCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    closedAt: null,
    checkUserLabeledAt: null,
    qaAnswerPendingAt: null,
    lastCommentAt: null,
    dispatchPendingAt: null,
    manualStepVerifiedAt: null,
    projectStatus: null,
    htmlUrl: "https://github.com/owner/repo/issues/1",
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: 0,
    ...overrides,
  };
}

describe("parseSearchQuery", () => {
  it("label:トークンをincludeLabelsに集約する", () => {
    const parsed = parseSearchQuery("label:bug label:urgent");
    expect(parsed.includeLabels).toEqual(["bug", "urgent"]);
  });

  it("-label:トークンをexcludeLabelsに集約する", () => {
    const parsed = parseSearchQuery("-label:wontfix");
    expect(parsed.excludeLabels).toEqual(["wontfix"]);
  });

  it("ダブルクォートで囲まれた値を1つのトークンとして扱う", () => {
    const parsed = parseSearchQuery('label:"in progress"');
    expect(parsed.includeLabels).toEqual(["in progress"]);
  });

  it("is:トークンをstateとして解釈する（open/closed以外は無視）", () => {
    expect(parseSearchQuery("is:open").state).toBe("open");
    expect(parseSearchQuery("is:closed").state).toBe("closed");
    expect(parseSearchQuery("is:invalid").state).toBeNull();
  });

  it("assignee:noneを未担当として解釈する", () => {
    expect(parseSearchQuery("assignee:none").assignee).toBe("none");
  });

  it("assignee:ログイン名は大文字小文字を保持する（noneの判定のみ大文字小文字を無視する）", () => {
    expect(parseSearchQuery("assignee:Octocat").assignee).toBe("Octocat");
  });

  it("トークン以外の残り文字列をキーワードとして小文字化して返す", () => {
    const parsed = parseSearchQuery("label:bug Foo Bar");
    expect(parsed.keyword).toBe("foo bar");
  });

  it("複数種のトークンを同時に解析できる", () => {
    const parsed = parseSearchQuery('label:bug -label:wontfix is:open assignee:none keyword');
    expect(parsed).toEqual({
      includeLabels: ["bug"],
      excludeLabels: ["wontfix"],
      state: "open",
      assignee: "none",
      keyword: "keyword",
    });
  });
});

describe("matchesSearchQuery", () => {
  it("includeLabelsのすべてを持つ場合のみ一致する", () => {
    const issue = makeIssue({ labels: [{ name: "bug", color: "red", description: null }] });
    expect(matchesSearchQuery(issue, "label:bug")).toBe(true);
    expect(matchesSearchQuery(issue, "label:bug label:urgent")).toBe(false);
  });

  it("excludeLabelsを持つ場合は一致しない", () => {
    const issue = makeIssue({ labels: [{ name: "wontfix", color: "gray", description: null }] });
    expect(matchesSearchQuery(issue, "-label:wontfix")).toBe(false);
  });

  it("stateが異なる場合は一致しない", () => {
    const issue = makeIssue({ state: "closed" });
    expect(matchesSearchQuery(issue, "is:open")).toBe(false);
    expect(matchesSearchQuery(issue, "is:closed")).toBe(true);
  });

  it("assignee:noneは未担当のIssueにのみ一致する", () => {
    expect(matchesSearchQuery(makeIssue({ assignee: null }), "assignee:none")).toBe(true);
    expect(
      matchesSearchQuery(makeIssue({ assignee: { login: "octocat" } }), "assignee:none"),
    ).toBe(false);
  });

  it("assignee:ログイン名はloginが一致する場合のみ一致する", () => {
    const issue = makeIssue({ assignee: { login: "octocat" } });
    expect(matchesSearchQuery(issue, "assignee:octocat")).toBe(true);
    expect(matchesSearchQuery(issue, "assignee:someone-else")).toBe(false);
  });

  it("キーワードはtitle/bodyに部分一致すれば真になる", () => {
    const issue = makeIssue({ title: "Search Feature", body: "本文" });
    expect(matchesSearchQuery(issue, "feature")).toBe(true);
    expect(matchesSearchQuery(issue, "notfound")).toBe(false);
  });

  it("トークンとキーワードを組み合わせて絞り込める", () => {
    const issue = makeIssue({
      title: "Search Feature",
      labels: [{ name: "bug", color: "red", description: null }],
      state: "open",
    });
    expect(matchesSearchQuery(issue, "label:bug is:open feature")).toBe(true);
    expect(matchesSearchQuery(issue, "label:bug is:open notfound")).toBe(false);
  });
});

describe("matchesSearchQuery（AIあいまい検索・#1788）", () => {
  const aiMatchedIds = new Set(["ai-1"]);

  it("aiMatchedIdsがあるときは自由語の部分一致の代わりにid集合で判定する", () => {
    const matched = makeIssue({ id: "ai-1", title: "一覧の絞り込みが重い", body: "" });
    const unmatched = makeIssue({ id: "ai-2", title: "検索が遅い", body: "" });

    // 文字列としては一致しないIssueが残り、一致するIssueでもAIが選ばなければ落ちる
    expect(matchesSearchQuery(matched, "検索が遅い", { aiMatchedIds })).toBe(true);
    expect(matchesSearchQuery(unmatched, "検索が遅い", { aiMatchedIds })).toBe(false);
  });

  it("label:等のトークンはAI検索中もそのまま効く", () => {
    const issue = makeIssue({
      id: "ai-1",
      labels: [{ name: "bug", color: "red", description: null }],
      state: "open",
    });

    expect(matchesSearchQuery(issue, "label:bug 重い", { aiMatchedIds })).toBe(true);
    expect(matchesSearchQuery(issue, "label:other 重い", { aiMatchedIds })).toBe(false);
    expect(matchesSearchQuery(issue, "is:closed 重い", { aiMatchedIds })).toBe(false);
  });

  it("aiMatchedIdsを渡さなければ従来どおりの部分一致になる", () => {
    const issue = makeIssue({ id: "ai-2", title: "検索が遅い" });

    expect(matchesSearchQuery(issue, "検索", {})).toBe(true);
    expect(matchesSearchQuery(issue, "検索", { aiMatchedIds: null })).toBe(true);
  });
});

describe("extractSearchTokens（#1788）", () => {
  it("トークンだけを残し、自由語を落とす", () => {
    expect(extractSearchTokens('label:bug -label:wontfix is:open assignee:octocat 検索が遅い')).toBe(
      "label:bug -label:wontfix is:open assignee:octocat",
    );
  });

  it("トークンが無ければ空文字になる", () => {
    expect(extractSearchTokens("検索が遅い")).toBe("");
  });

  it("繰り返し呼んでも結果が変わらない（グローバル正規表現のlastIndexに引きずられない）", () => {
    expect(extractSearchTokens("label:bug 重い")).toBe("label:bug");
    expect(extractSearchTokens("label:bug 重い")).toBe("label:bug");
  });
});
