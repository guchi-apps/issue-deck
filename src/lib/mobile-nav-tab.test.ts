import { describe, expect, it } from "vitest";

import { resolveBottomNavTab } from "@/lib/mobile-nav-tab";
import type { MobileScreen } from "@/hooks/use-mobile-screen";
import type { Issue } from "@/types/issue";
import type { ConnectedRepository } from "@/types/repository";

const repository = { fullName: "owner/repo", name: "repo" } as ConnectedRepository;
const issue = { id: "1" } as Issue;

const repoDetail: MobileScreen = {
  kind: "repo-detail",
  repository,
  view: "all",
  labels: [],
  state: "open",
  assignee: null,
  sort: "created",
  returnToIssueId: null,
  back: { kind: "repos" },
};

const issuesScreen: MobileScreen = {
  kind: "issues",
  view: "all",
  labels: [],
  state: "open",
  assignee: null,
  sort: "created",
  returnToIssueId: null,
  origin: "tab",
};

describe("resolveBottomNavTab", () => {
  it("タブ画面はそのままのタブを返す", () => {
    expect(resolveBottomNavTab({ kind: "home" })).toBe("home");
    expect(resolveBottomNavTab({ kind: "repos" })).toBe("repos");
    expect(resolveBottomNavTab({ kind: "settings" })).toBe("settings");
    expect(resolveBottomNavTab({ kind: "pull-requests", origin: "tab" })).toBe("pull-requests");
  });

  it("リポジトリ別Issue一覧では「Issue」タブ（repos）を返す", () => {
    expect(resolveBottomNavTab(repoDetail)).toBe("repos");
  });

  // 全リポジトリ横断のIssue一覧はフッターから外し、ホームからのドリルダウンにした（#1436）
  it("全リポジトリ横断のIssue一覧ではホームタブを返す", () => {
    expect(resolveBottomNavTab(issuesScreen)).toBe("home");
  });

  it("ホームから開いたPR一覧でもPRタブを返す", () => {
    expect(resolveBottomNavTab({ kind: "pull-requests", origin: "home" })).toBe("pull-requests");
  });

  it("Issue詳細では戻り先の画面に応じたタブを返す", () => {
    expect(resolveBottomNavTab({ kind: "issue-detail", issue, back: issuesScreen })).toBe("home");
    expect(resolveBottomNavTab({ kind: "issue-detail", issue, back: repoDetail })).toBe("repos");
  });
});
