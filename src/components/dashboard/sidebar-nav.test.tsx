// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SidebarNav } from "@/components/dashboard/sidebar-nav";
import type { ManualStepAttention } from "@/lib/manual-step-attention";
import type { QuestionAttention } from "@/lib/question-attention";
import { navViews } from "@/lib/nav-views";
import type { PullRequestNavCounts } from "@/lib/pull-request-list";
import { getPullRequestView } from "@/lib/pull-request-views";
import type { NavViewId } from "@/types/issue";
import type { PullRequestViewId } from "@/types/pull-request";
import type { ConnectedRepository } from "@/types/repository";

const NAV_COUNTS = Object.fromEntries(navViews.map((view) => [view.id, 0])) as Record<
  NavViewId,
  number
>;

const NO_MANUAL_STEP: ManualStepAttention = { total: 0, actionable: 0, waitingForPrerequisites: 0 };

function renderSidebar(
  pullRequestNavCounts: PullRequestNavCounts,
  navCounts: Record<NavViewId, number> = NAV_COUNTS,
  {
    checkUserPullRequestCount = 0,
    manualStepAttention = NO_MANUAL_STEP,
    questionAttention = { total: navCounts.question, unconfirmed: 0 },
  }: {
    checkUserPullRequestCount?: number;
    manualStepAttention?: ManualStepAttention;
    questionAttention?: QuestionAttention;
  } = {},
) {
  render(
    <SidebarNav
      activeView="all"
      onSelectView={() => {}}
      activePane="issues"
      activePullRequestView="all"
      onSelectPullRequestView={() => {}}
      onSelectFlow={() => {}}
      navCounts={navCounts}
      checkUserPullRequestCount={checkUserPullRequestCount}
      manualStepAttention={manualStepAttention}
      questionAttention={questionAttention}
      pullRequestNavCounts={pullRequestNavCounts}
      repositories={[]}
      labelSummary={[]}
    />,
  );
}

function repository(name: string, overrides: Partial<ConnectedRepository> = {}): ConnectedRepository {
  return {
    id: name,
    name,
    fullName: `guchi-apps/${name}`,
    private: false,
    archived: false,
    hasClaudeWorkflow: true,
    hasLocalStartScript: true,
    dispatchRunnable: false,
    hidden: false,
    favorite: false,
    ...overrides,
  };
}

function renderSidebarWithRepositories(
  repositories: ConnectedRepository[],
  selectedRepoFullNames: string[] = [],
) {
  render(
    <SidebarNav
      activeView="all"
      onSelectView={() => {}}
      activePane="issues"
      activePullRequestView="all"
      onSelectPullRequestView={() => {}}
      onSelectFlow={() => {}}
      navCounts={NAV_COUNTS}
      checkUserPullRequestCount={0}
      manualStepAttention={NO_MANUAL_STEP}
      questionAttention={{ total: 0, unconfirmed: 0 }}
      pullRequestNavCounts={{ all: 0, "in-progress": 0, completed: 0 }}
      repositories={repositories}
      selectedRepoFullNames={selectedRepoFullNames}
      labelSummary={[]}
    />,
  );
}

/** リポジトリ一覧に並んでいる名前を、表示順のまま取り出す（区切り線の行は空なので除く） */
function repositoryNamesInOrder() {
  const list = screen.getByRole("heading", { name: "リポジトリ" }).closest("div")
    ?.parentElement?.querySelector("ul");
  if (!list) throw new Error("リポジトリ一覧が見つかりません");
  return Array.from(list.querySelectorAll("li"))
    .map((item) => item.textContent?.trim() ?? "")
    .filter((text) => text.length > 0);
}

/** PRビューのボタンは判定条件の補足をtitle属性に持つので、それを手掛かりに引く */
function pullRequestNavItem(view: PullRequestViewId) {
  return screen.getByTitle(getPullRequestView(view).description);
}

afterEach(() => cleanup());

describe("SidebarNav", () => {
  it("実行中のPRは件数を出す", () => {
    renderSidebar({ all: 4, "in-progress": 3, completed: 1 });

    expect(pullRequestNavItem("in-progress").textContent).toContain("3");
  });

  it("0件でも件数を出す（Issue側の項目と揃える）", () => {
    renderSidebar({ all: 0, "in-progress": 0, completed: 0 });

    expect(pullRequestNavItem("in-progress").textContent).toContain("0");
  });

  // openなPRだけを出すビューになり、母集団がscopeに依存しなくなったため（#1613）。
  it("すべてのPRにも件数を出す", () => {
    renderSidebar({ all: 4, "in-progress": 3, completed: 1 });

    expect(pullRequestNavItem("all").textContent).toContain("4");
  });

  // 「完了したPR」は左メニューから外した（#1613）。prview=completedのURLは今までどおり開ける。
  it("完了したPRは出さない", () => {
    renderSidebar({ all: 4, "in-progress": 3, completed: 1 });

    expect(screen.queryByTitle(getPullRequestView("completed").description)).toBeNull();
  });

  // 行全体をamberで塗ると選択中の行と紛らわしく、ラベル文字の色も他のビューと揃わない（#1443）。
  it("確認待ちが残っていても強調するのは件数バッジだけにする", () => {
    renderSidebar({ all: 0, "in-progress": 0, completed: 0 }, { ...NAV_COUNTS, "check-user": 2 });

    const button = screen.getByRole("button", { name: /ユーザーの確認待ち/ });
    expect(button.className).not.toContain("amber");
    const badge = screen.getByText("2");
    expect(badge.className).toContain("bg-amber-500");
  });

  // 対応Issueを持たないリリースPRもユーザーがマージするしかないため（#1613）。
  it("ユーザーのマージ待ちPRを確認待ちの件数に足す", () => {
    renderSidebar(
      { all: 1, "in-progress": 0, completed: 1 },
      { ...NAV_COUNTS, "check-user": 2 },
      { checkUserPullRequestCount: 1 },
    );

    expect(screen.getByRole("button", { name: /ユーザーの確認待ち/ }).textContent).toContain("3");
  });

  it("Issueが0件でもマージ待ちPRがあれば確認待ちを強調する", () => {
    renderSidebar({ all: 1, "in-progress": 0, completed: 1 }, NAV_COUNTS, {
      checkUserPullRequestCount: 1,
    });

    const button = screen.getByRole("button", { name: /ユーザーの確認待ち/ });
    expect(button.querySelector("span:last-child")?.className).toContain("bg-amber-500");
  });

  // 数週間先まで実行できない手作業で橙色が点きっぱなしになると、合図として読めなくなる（#1613）。
  it("手作業はいま実行できるものがあるときだけ強調する", () => {
    renderSidebar(
      { all: 0, "in-progress": 0, completed: 0 },
      { ...NAV_COUNTS, "manual-step": 3 },
      { manualStepAttention: { total: 3, actionable: 0, waitingForPrerequisites: 3 } },
    );

    expect(screen.getByText("3").className).not.toContain("bg-amber-500");
  });

  it("実行できる手作業が1件でもあれば強調する", () => {
    renderSidebar(
      { all: 0, "in-progress": 0, completed: 0 },
      { ...NAV_COUNTS, "manual-step": 3 },
      { manualStepAttention: { total: 3, actionable: 1, waitingForPrerequisites: 2 } },
    );

    expect(screen.getByText("3").className).toContain("bg-amber-500");
  });

  // 件数（computeNavCounts）が「いま実行できる数」になったため、内訳の吹き出しは
  // 同じことを言い直すだけになる（#1763）。前提待ちの件数は一覧のヘッダーで読む
  it("手作業の行に内訳の吹き出しを付けない", () => {
    renderSidebar(
      { all: 0, "in-progress": 0, completed: 0 },
      { ...NAV_COUNTS, "manual-step": 1 },
      { manualStepAttention: { total: 3, actionable: 1, waitingForPrerequisites: 2 } },
    );

    expect(
      screen.getByRole("button", { name: /ユーザーの作業待ち/ }).getAttribute("title"),
    ).toBeNull();
  });

  // 数字は一覧に並ぶ件数で、オレンジの丸は未確認があるときだけ（#2070）。#1910のように
  // 未確認の数を数字に出すと、読み終えた質問しか無いときに「質問は無い」と読めてしまう
  it("未確認の質問があれば一覧の件数をオレンジの丸で出す", () => {
    renderSidebar(
      { all: 0, "in-progress": 0, completed: 0 },
      { ...NAV_COUNTS, question: 3 },
      { questionAttention: { total: 3, unconfirmed: 1 } },
    );

    const button = screen.getByRole("button", { name: /質問/ });
    expect(button.textContent).toContain("3");
    expect(button.querySelector("span:last-child")?.className).toContain("bg-amber-500");
    // 数字（総数）と丸（未確認）で意味が違うため、内訳は吹き出しで補う
    expect(button.getAttribute("title")).toContain("3件");
    expect(button.getAttribute("title")).toContain("1件");
  });

  it("未確認の質問が無ければ強調しないが、件数は出す", () => {
    renderSidebar(
      { all: 0, "in-progress": 0, completed: 0 },
      { ...NAV_COUNTS, question: 3 },
      { questionAttention: { total: 3, unconfirmed: 0 } },
    );

    const button = screen.getByRole("button", { name: /質問/ });
    expect(button.textContent).toContain("3");
    expect(button.querySelector("span:last-child")?.className).not.toContain("amber");
    expect(button.getAttribute("title")).toContain("3件");
  });

  // 取得前に0を出すと「PRが無い」と読めてしまうため。
  it("未取得のときはどのPRビューにも件数を出さない", () => {
    renderSidebar({ all: null, "in-progress": null, completed: null });

    for (const view of ["all", "in-progress"] as const) {
      expect(pullRequestNavItem(view).textContent).toBe(getPullRequestView(view).label);
    }
  });

  // 「まず人が動くもの」を上から順に並べる（#1613）
  it("要対応・質問・ブランチ・Issue・PRの順に並べる", () => {
    renderSidebar({ all: 0, "in-progress": 0, completed: 0 });

    const labels = Array.from(document.querySelectorAll("nav > div button")).map((button) =>
      button.textContent?.replace(/\d+$/, "").trim(),
    );
    expect(labels.slice(0, 9)).toEqual([
      "ユーザーの確認待ち",
      "ユーザーの作業待ち",
      "質問",
      "ブランチ",
      "すべてのIssue",
      "お気に入り",
      "未着手",
      "実行中",
      "本番反映待ち",
    ]);
  });

  // 連携数が増えると選択中の行がスクロール範囲の外へ出てしまうため（#1480）。
  it("選択中のリポジトリを一覧の先頭に並べる", () => {
    renderSidebarWithRepositories(
      [repository("alpha"), repository("beta"), repository("gamma")],
      ["guchi-apps/gamma"],
    );

    expect(repositoryNamesInOrder()).toEqual(["gamma", "alpha", "beta"]);
  });

  it("選択が無いときは渡された並び順のまま出す", () => {
    renderSidebarWithRepositories([repository("alpha"), repository("beta"), repository("gamma")]);

    expect(repositoryNamesInOrder()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("複数選択でもグループ内の並び順は変えない", () => {
    renderSidebarWithRepositories(
      [repository("alpha"), repository("beta"), repository("gamma"), repository("delta")],
      ["guchi-apps/gamma", "guchi-apps/alpha"],
    );

    expect(repositoryNamesInOrder()).toEqual(["alpha", "gamma", "beta", "delta"]);
  });

  // 行が消えると選択だけが残り、その行から解除できなくなるため（#1480）。
  it("非表示のリポジトリでも選択中なら一覧に出す", () => {
    renderSidebarWithRepositories(
      [repository("alpha"), repository("beta", { hidden: true })],
      ["guchi-apps/beta"],
    );

    expect(repositoryNamesInOrder()).toEqual(["beta", "alpha"]);
    // 表示済みの1件を数に含めると、押しても増えない件数を出してしまう
    expect(screen.queryByText(/すべて表示する/)).toBeNull();
  });
});
