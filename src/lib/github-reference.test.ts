import { describe, expect, it } from "vitest";

import {
  buildPullRequestId,
  parseGithubReferenceUrl,
  parsePullRequestId,
} from "@/lib/github-reference";

describe("parseGithubReferenceUrl", () => {
  it("IssueのURLをIssue参照として読む", () => {
    expect(parseGithubReferenceUrl("https://github.com/guchi-apps/issue-deck/issues/1260")).toEqual({
      repositoryFullName: "guchi-apps/issue-deck",
      number: 1260,
      kind: "issue",
    });
  });

  it("PRのURLをPR参照として読む", () => {
    expect(parseGithubReferenceUrl("https://github.com/guchi-apps/issue-deck/pull/42")).toEqual({
      repositoryFullName: "guchi-apps/issue-deck",
      number: 42,
      kind: "pull",
    });
  });

  it("番号の後ろにサブパス・フラグメント・クエリが続いても読む", () => {
    const urls = [
      "https://github.com/o/r/pull/7/files",
      "https://github.com/o/r/issues/7#issuecomment-1",
      "https://github.com/o/r/issues/7?foo=bar",
    ];
    for (const url of urls) {
      expect(parseGithubReferenceUrl(url)?.number).toBe(7);
    }
  });

  it("www付き・http・前後の空白を許容する", () => {
    expect(parseGithubReferenceUrl("  http://www.github.com/o/r/issues/3 ")).toEqual({
      repositoryFullName: "o/r",
      number: 3,
      kind: "issue",
    });
  });

  it("Issue・PR以外のGitHub URLは対象外", () => {
    const urls = [
      "https://github.com/o/r",
      "https://github.com/o/r/actions/runs/123",
      "https://github.com/o/r/blob/main/README.md",
      "https://github.com/apps/issue-deck",
      // 別ホストの紛らわしいURL（`github.com`を含むだけ）を拾わない
      "https://example.com/github.com/o/r/issues/1",
      "https://notgithub.com/o/r/issues/1",
    ];
    for (const url of urls) {
      expect(parseGithubReferenceUrl(url), url).toBeNull();
    }
  });

  it("番号が無い・数字でない場合は対象外", () => {
    expect(parseGithubReferenceUrl("https://github.com/o/r/issues")).toBeNull();
    expect(parseGithubReferenceUrl("https://github.com/o/r/pull/new")).toBeNull();
  });
});

describe("buildPullRequestId / parsePullRequestId", () => {
  it("組み立てた識別子を元に戻せる", () => {
    const id = buildPullRequestId("guchi-apps/issue-deck", 1260);
    expect(id).toBe("guchi-apps/issue-deck#1260");
    expect(parsePullRequestId(id)).toEqual({
      repositoryFullName: "guchi-apps/issue-deck",
      number: 1260,
    });
  });

  it("形式に合わない文字列はnull", () => {
    for (const id of ["", "guchi-apps/issue-deck", "#12", "guchi-apps#12", "o/r#abc"]) {
      expect(parsePullRequestId(id), id).toBeNull();
    }
  });
});
