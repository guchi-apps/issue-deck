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
    // ブランチは#1638でタブになった（旧「設定」の枠）
    expect(resolveBottomNavTab({ kind: "flow" })).toBe("flow");
  });

  // 設定はフッターから外し、ホームのヘッダーの歯車から開く画面になった（#1638）。
  // 確認環境（#2444）も同じくタブを持たない
  it("設定・確認環境ではどのタブも点灯させない", () => {
    expect(resolveBottomNavTab({ kind: "settings" })).toBeNull();
    expect(resolveBottomNavTab({ kind: "preview" })).toBeNull();
  });

  // AI使用量は#2504ではドリルダウンだったが、#2631でフッターの5枠目になった
  it("AI使用量では「AI使用量」タブを点灯させる", () => {
    expect(resolveBottomNavTab({ kind: "usage" })).toBe("usage");
  });

  // #2724でフッターの「Issue」（リポジトリ一覧）・「PR」タブを外したため、Issue・PRに関わる
  // 画面はどれもホームからのドリルダウンになった（遷移元がどこでも「ホーム」を点灯させる）
  it("リポジトリ一覧・リポジトリ別Issue一覧・PR一覧ではホームタブを返す", () => {
    expect(resolveBottomNavTab({ kind: "repos" })).toBe("home");
    expect(resolveBottomNavTab(repoDetail)).toBe("home");
    expect(resolveBottomNavTab({ kind: "pull-requests", origin: "tab" })).toBe("home");
    expect(resolveBottomNavTab({ kind: "pull-requests", origin: "home" })).toBe("home");
  });

  // 全リポジトリ横断のIssue一覧はフッターから外し、ホームからのドリルダウンにした（#1436）
  it("全リポジトリ横断のIssue一覧では、遷移元によらずホームタブを返す", () => {
    expect(resolveBottomNavTab(issuesScreen)).toBe("home");
    expect(resolveBottomNavTab({ ...issuesScreen, origin: "home" })).toBe("home");
    expect(resolveBottomNavTab({ ...issuesScreen, origin: "repos" })).toBe("home");
  });

  it("Issue詳細では戻り先の画面に応じたタブを返す", () => {
    expect(resolveBottomNavTab({ kind: "issue-detail", issue, back: issuesScreen })).toBe("home");
    expect(resolveBottomNavTab({ kind: "issue-detail", issue, back: repoDetail })).toBe("home");
    expect(resolveBottomNavTab({ kind: "issue-detail", issue, back: { kind: "flow" } })).toBe(
      "flow",
    );
  });
});
