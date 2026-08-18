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
    expect(resolveBottomNavTab({ kind: "pull-requests", origin: "tab" })).toBe("pull-requests");
    // ブランチは#1638でタブになった（旧「設定」の枠）
    expect(resolveBottomNavTab({ kind: "flow" })).toBe("flow");
  });

  // 設定はフッターから外し、ホームのヘッダーの歯車から開く画面になった（#1638）
  it("設定画面ではどのタブも点灯させない", () => {
    expect(resolveBottomNavTab({ kind: "settings" })).toBeNull();
  });

  it("リポジトリ別Issue一覧では「Issue」タブ（repos）を返す", () => {
    expect(resolveBottomNavTab(repoDetail)).toBe("repos");
  });

  // 全リポジトリ横断のIssue一覧はフッターから外し、ホームからのドリルダウンにした（#1436）
  it("全リポジトリ横断のIssue一覧ではホームタブを返す", () => {
    expect(resolveBottomNavTab(issuesScreen)).toBe("home");
    expect(resolveBottomNavTab({ ...issuesScreen, origin: "home" })).toBe("home");
  });

  // 「Issue」タブのリポジトリ一覧から開いた場合だけ「Issue」タブを点灯させる（#1951）
  it("リポジトリ一覧から開いた横断のIssue一覧では「Issue」タブ（repos）を返す", () => {
    expect(resolveBottomNavTab({ ...issuesScreen, origin: "repos" })).toBe("repos");
    expect(
      resolveBottomNavTab({
        kind: "issue-detail",
        issue,
        back: { ...issuesScreen, origin: "repos" },
      }),
    ).toBe("repos");
  });

  it("ホームから開いたPR一覧でもPRタブを返す", () => {
    expect(resolveBottomNavTab({ kind: "pull-requests", origin: "home" })).toBe("pull-requests");
  });

  it("Issue詳細では戻り先の画面に応じたタブを返す", () => {
    expect(resolveBottomNavTab({ kind: "issue-detail", issue, back: issuesScreen })).toBe("home");
    expect(resolveBottomNavTab({ kind: "issue-detail", issue, back: repoDetail })).toBe("repos");
  });
});
