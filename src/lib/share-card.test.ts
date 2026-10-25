import { describe, expect, it } from "vitest";

import {
  buildDashboardPath,
  buildShareMeta,
  formatShareLabel,
  isLinkPreviewBot,
  resolveSharePath,
} from "./share-card";

const q = (s: string) => new URLSearchParams(s);

describe("isLinkPreviewBot", () => {
  it("Discordbotを判定し、通常のブラウザは対象にしない", () => {
    expect(isLinkPreviewBot("Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)")).toBe(true);
    expect(isLinkPreviewBot("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) AppleWebKit Safari/605")).toBe(false);
    expect(isLinkPreviewBot(null)).toBe(false);
  });
});

describe("resolveSharePath", () => {
  it("issue=からIssue用のパスを返す", () => {
    expect(resolveSharePath(q("issue=6022306920&mscreen=issue-detail&missue=6022306920"))).toBe("/share/issue/6022306920");
  });
  it("pr=からPR用のパスを返す", () => {
    expect(resolveSharePath(q("pane=pull-requests&pr=guchi-apps%2Fissue-deck%235036"))).toBe(
      "/share/pr/guchi-apps/issue-deck/5036",
    );
  });
  it("指定が無い・不正な値はnull（rewriteしない）", () => {
    expect(resolveSharePath(q(""))).toBeNull();
    expect(resolveSharePath(q("issue=abc"))).toBeNull();
    expect(resolveSharePath(q("issue=1%2F..%2F2"))).toBeNull();
    expect(resolveSharePath(q("issue=99999999999999999999"))).toBeNull();
    expect(resolveSharePath(q("pr=a%2Fb%230"))).toBeNull();
    expect(resolveSharePath(q("pr=..%2F..%2Fx%231"))).toBeNull();
  });
});

describe("メタ情報", () => {
  it("リポジトリ名と種別・番号だけで組み立てる", () => {
    const meta = buildShareMeta({ kind: "issue", repositoryFullName: "guchi-apps/yoteiflow", number: 1366 }, "issue");
    expect(meta.title).toBe("guchi-apps/yoteiflow Issue #1366");
    expect(Object.keys(meta).sort()).toEqual(["description", "title"]);
  });
  it("未存在は存在を示さない汎用の文言", () => {
    expect(buildShareMeta(null, "pr")).toEqual({ title: "IssueDeck", description: "IssueDeck の PR" });
  });
  it("種別の表示", () => {
    expect(formatShareLabel("pr", 5036)).toBe("PR #5036");
  });
});

describe("buildDashboardPath", () => {
  it("従来の/dashboardのURLを返す", () => {
    expect(buildDashboardPath("issue", "6022306920")).toBe(
      "/dashboard?issue=6022306920&mscreen=issue-detail&missue=6022306920",
    );
    expect(buildDashboardPath("pr", "a/b#3")).toBe("/dashboard?pane=pull-requests&pr=a%2Fb%233&mscreen=pull-requests");
  });
});
