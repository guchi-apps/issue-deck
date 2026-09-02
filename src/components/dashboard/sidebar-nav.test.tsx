// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SidebarNav, SidebarNavView } from "@/components/dashboard/sidebar-nav";
import type { ManualStepAttention } from "@/lib/manual-step-attention";
import type { MergePendingAttention } from "@/lib/merge-pending-attention";
import { navViews } from "@/lib/nav-views";
import type { PullRequestNavCounts } from "@/lib/pull-request-list";
import type { ReleaseActivityCounts } from "@/lib/release-activity";
import { getPullRequestView } from "@/lib/pull-request-views";
import type { NavViewId } from "@/types/issue";
import type { PullRequestViewId } from "@/types/pull-request";
import type { ConnectedRepository } from "@/types/repository";

const NAV_COUNTS = Object.fromEntries(navViews.map((view) => [view.id, 0])) as Record<
  NavViewId,
  number
>;

const NO_MANUAL_STEP: ManualStepAttention = { total: 0, actionable: 0, waitingForPrerequisites: 0 };

/** 「マージ待ち」の内訳。件数を渡さないテストでは0件（丸は点かない）にしておく */
const NO_MERGE_PENDING: MergePendingAttention = {
  total: 0,
  autoMerging: 0,
  repairing: 0,
  actionRequired: 0,
};

function renderSidebar(
  pullRequestNavCounts: PullRequestNavCounts,
  navCounts: Record<NavViewId, number> = NAV_COUNTS,
  {
    checkUserPullRequestCount = 0,
    manualStepAttention = NO_MANUAL_STEP,
    unconfirmedQuestionCount = 0,
    waitingQuestionCount = 0,
    releaseActivity = null,
    mergePendingAttention = NO_MERGE_PENDING,
  }: {
    checkUserPullRequestCount?: number;
    manualStepAttention?: ManualStepAttention;
    unconfirmedQuestionCount?: number;
    waitingQuestionCount?: number;
    releaseActivity?: ReleaseActivityCounts | null;
    mergePendingAttention?: MergePendingAttention | null;
  } = {},
) {
  render(
    <SidebarNavView
      activeView="all"
      onSelectView={() => {}}
      activePane="issues"
      activePullRequestView="all"
      onSelectPullRequestView={() => {}}
      onSelectFlow={() => {}}
      onSelectPreview={() => {}}
      onSelectUsage={() => {}}
      onSelectReleaseHistory={() => {}}
      onLaunchNewApp={() => {}}
      navCounts={navCounts}
      checkUserPullRequestCount={checkUserPullRequestCount}
      manualStepAttention={manualStepAttention}
      unconfirmedQuestionCount={unconfirmedQuestionCount}
      waitingQuestionCount={waitingQuestionCount}
      releaseActivity={releaseActivity}
      pullRequestNavCounts={pullRequestNavCounts}
      mergePendingAttention={mergePendingAttention}
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
      onSelectPreview={() => {}}
      onSelectUsage={() => {}}
      onSelectReleaseHistory={() => {}}
      onLaunchNewApp={() => {}}
      navCounts={NAV_COUNTS}
      checkUserPullRequestCount={0}
      manualStepAttention={NO_MANUAL_STEP}
      unconfirmedQuestionCount={0}
      waitingQuestionCount={0}
      pullRequestNavCounts={{ all: 0, "in-progress": 0, completed: 0 }}
      mergePendingAttention={NO_MERGE_PENDING}
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

/**
 * PRビューのボタンは判定条件の補足をtitle属性に持つので、それを手掛かりに引く。
 * 「マージ待ち」だけは内訳が後ろに付く（#2334）ため、前方一致で引く。
 */
function pullRequestNavItem(view: PullRequestViewId) {
  const description = getPullRequestView(view).description;
  return screen.getByTitle((_content, element) =>
    (element?.getAttribute("title") ?? "").startsWith(description),
  );
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

  // #1613で左メニューから外していたが、「マージ待ち」と改名して戻した（#2120）。
  it("マージ待ちにも件数を出す", () => {
    renderSidebar({ all: 4, "in-progress": 3, completed: 1 });

    expect(pullRequestNavItem("completed").textContent).toContain("マージ待ち");
    expect(pullRequestNavItem("completed").textContent).toContain("1");
  });

  // マージ待ちのうち、人がマージするかCI失敗を直すかしかないPRが残っているときだけ（#2334）
  it("要操作のマージ待ちPRがあれば件数をオレンジの丸で出す", () => {
    renderSidebar({ all: 4, "in-progress": 2, completed: 2 }, NAV_COUNTS, {
      mergePendingAttention: { total: 2, autoMerging: 1, repairing: 0, actionRequired: 1 },
    });

    expect(pullRequestNavItem("completed").querySelector("span:last-child")?.className).toContain(
      "bg-amber-500",
    );
  });

  // Auto-merge有効でCI成功のPR・自動修復中のPRは放っておけば片付く（ベルと同じ除外）
  it("マージ待ちが自動で進むものだけなら丸にしない", () => {
    renderSidebar({ all: 4, "in-progress": 2, completed: 2 }, NAV_COUNTS, {
      mergePendingAttention: { total: 2, autoMerging: 1, repairing: 1, actionRequired: 0 },
    });

    expect(
      pullRequestNavItem("completed").querySelector("span:last-child")?.className,
    ).not.toContain("bg-amber-500");
  });

  it("マージ待ちが0件なら丸にしない（手を動かせるものが無い）", () => {
    renderSidebar({ all: 2, "in-progress": 2, completed: 0 });

    expect(
      pullRequestNavItem("completed").querySelector("span:last-child")?.className,
    ).not.toContain("bg-amber-500");
  });

  // 「すべてのPR」は実行中を含む在庫の数、「実行中」は人が何もしなくても進むもの（#2334）
  it("すべてのPR・実行中は件数があっても丸にしない", () => {
    renderSidebar({ all: 4, "in-progress": 2, completed: 2 }, NAV_COUNTS, {
      mergePendingAttention: { total: 2, autoMerging: 0, repairing: 0, actionRequired: 2 },
    });

    for (const view of ["all", "in-progress"] as const) {
      expect(pullRequestNavItem(view).querySelector("span:last-child")?.className).not.toContain(
        "bg-amber-500",
      );
    }
  });

  // 数字（一覧に並ぶ総数）と丸（要操作）で意味が違うため、内訳を吹き出しで補う（#2334）
  it("マージ待ちの行の吹き出しに内訳を添える", () => {
    renderSidebar({ all: 4, "in-progress": 2, completed: 2 }, NAV_COUNTS, {
      mergePendingAttention: { total: 2, autoMerging: 1, repairing: 0, actionRequired: 1 },
    });

    const title = screen.getByText("マージ待ち").closest("button")?.getAttribute("title") ?? "";
    expect(title).toContain("2件: 要操作1件・自動マージ待ち1件");
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
      { unconfirmedQuestionCount: 1 },
    );

    const button = screen.getByRole("button", { name: /質問/ });
    expect(button.textContent).toContain("3");
    expect(button.querySelector("span:last-child")?.className).toContain("bg-amber-500");
    // 数字（総数）と丸（未確認）で意味が違うため、内訳は吹き出しで補う
    expect(button.getAttribute("title")).toContain("3件");
    expect(button.getAttribute("title")).toContain("1件");
  });

  // 回答待ちのあいだは回るアイコンを出す（#2309）。丸（未確認）とは別の合図で、併存する
  it("回答待ちの質問があれば回るアイコンを出し、内訳を吹き出しへ添える", () => {
    renderSidebar(
      { all: 0, "in-progress": 0, completed: 0 },
      { ...NAV_COUNTS, question: 3 },
      { unconfirmedQuestionCount: 1, waitingQuestionCount: 2 },
    );

    const button = screen.getByRole("button", { name: /質問/ });
    expect(button.querySelector(".animate-spin")).not.toBeNull();
    expect(button.getAttribute("title")).toContain("回答待ちが2件");
    expect(button.getAttribute("title")).toContain("まだ開いていないものが1件");
  });

  it("回答待ちの質問が無ければ回るアイコンを出さない", () => {
    renderSidebar(
      { all: 0, "in-progress": 0, completed: 0 },
      { ...NAV_COUNTS, question: 3 },
      { unconfirmedQuestionCount: 1, waitingQuestionCount: 0 },
    );

    expect(
      screen.getByRole("button", { name: /質問/ }).querySelector(".animate-spin"),
    ).toBeNull();
  });

  // 質問の合図をコードレビューの行へ持ち込まない（#2325）。同じ枠に並んでいるだけで、
  // 回っているのは質問の回答待ち——押した先にレビューは1件も走っていない
  it("回答待ちの質問があってもコードレビューの行は回さない", () => {
    renderSidebar(
      { all: 0, "in-progress": 0, completed: 0 },
      { ...NAV_COUNTS, question: 3 },
      { unconfirmedQuestionCount: 1, waitingQuestionCount: 2 },
    );

    const button = screen.getByRole("button", { name: /コードレビュー/ });
    expect(button.querySelector(".animate-spin")).toBeNull();
    // 質問の未確認でオレンジの丸を点けたり、質問の内訳を吹き出しに出したりもしない
    expect(button.querySelector("span:last-child")?.className).not.toContain("amber");
    expect(button.getAttribute("title")).toBeNull();
  });

  it("未確認の質問が無ければ強調しないが、件数は出す", () => {
    renderSidebar(
      { all: 0, "in-progress": 0, completed: 0 },
      { ...NAV_COUNTS, question: 3 },
      { unconfirmedQuestionCount: 0 },
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

  // 「まず人が動くもの」を上から順に並べる（#1613）。「コードレビュー」「確認環境」は
  // Pull Requestの枠の下・リポジトリの枠の上に置く（#2674）
  it("要対応・質問・ブランチ・AI使用量・リリース履歴・Issue・PR・コードレビュー・確認環境の順に並べる", () => {
    renderSidebar({ all: 0, "in-progress": 0, completed: 0 });

    const labels = Array.from(document.querySelectorAll("nav > div button")).map((button) =>
      button.textContent?.replace(/\d+$/, "").trim(),
    );
    expect(labels.slice(0, 16)).toEqual([
      "ユーザーの確認待ち",
      "ユーザーの作業待ち",
      "質問",
      "ブランチ",
      "AI使用量",
      "リリース履歴",
      "すべてのIssue",
      "お気に入り",
      "未着手",
      "実行中",
      "本番反映待ち",
      "すべてのPR",
      "実行中",
      "マージ待ち",
      "コードレビュー",
      "確認環境",
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

describe("SidebarNavの「ブランチ」行（#2167）", () => {
  const NO_PR_COUNTS: PullRequestNavCounts = { all: 0, "in-progress": 0, completed: 0 };

  /** 内訳のうち指定したものだけを立てた件数（`total`・`actionRequired`は合計で埋める） */
  function activity({
    progressing = 0,
    mergePending = 0,
    failed = 0,
  }: {
    progressing?: number;
    mergePending?: number;
    failed?: number;
  }): ReleaseActivityCounts {
    return {
      total: progressing + mergePending + failed,
      progressing,
      mergePending,
      failed,
      actionRequired: mergePending + failed,
    };
  }

  /** 「ブランチ」行はラベルが1語なので、ボタンのテキストで引く */
  function branchNavItem() {
    return screen.getByRole("button", { name: /ブランチ/ });
  }

  it("未取得のうちは件数を出さない（0件と区別する）", () => {
    renderSidebar(NO_PR_COUNTS, NAV_COUNTS, { releaseActivity: null });

    expect(branchNavItem().textContent).toBe("ブランチ");
  });

  it("リリース・デプロイが動いているプロジェクト数を出す", () => {
    renderSidebar(NO_PR_COUNTS, NAV_COUNTS, {
      releaseActivity: activity({ progressing: 3 }),
    });

    expect(branchNavItem().textContent).toContain("3");
  });

  it("操作待ちが無ければ強調しない（待てば進むもので橙を点けない）", () => {
    renderSidebar(NO_PR_COUNTS, NAV_COUNTS, {
      releaseActivity: activity({ progressing: 3 }),
    });

    expect(branchNavItem().querySelector("span:last-child")?.className).not.toContain(
      "bg-amber-500",
    );
  });

  it("バンプPRのマージ待ちなど操作待ちがあればオレンジの丸にする", () => {
    renderSidebar(NO_PR_COUNTS, NAV_COUNTS, {
      releaseActivity: activity({ progressing: 2, mergePending: 1 }),
    });

    // 出す数字は動いているプロジェクト数のままで、丸だけが操作待ちの合図（質問の行と同じ）
    expect(branchNavItem().textContent).toContain("3");
    expect(branchNavItem().querySelector("span:last-child")?.className).toContain("bg-amber-500");
  });

  it("数字と丸で意味が違うので、内訳を吹き出しで補う", () => {
    renderSidebar(NO_PR_COUNTS, NAV_COUNTS, {
      releaseActivity: activity({ progressing: 2, mergePending: 1 }),
    });

    expect(branchNavItem().getAttribute("title")).toContain(
      "リリース・デプロイが未完了のプロジェクト3件: 実行中2件・マージ待ち1件",
    );
  });

  // 失敗は人が直すまで進まないので、マージ待ちと同じく丸を点ける。ただし「実行中」とは
  // 書き分ける（#2167のレビュー指摘）。
  it("リリース・デプロイの失敗も操作待ちとして丸を点け、内訳では実行中と分ける", () => {
    renderSidebar(NO_PR_COUNTS, NAV_COUNTS, {
      releaseActivity: activity({ progressing: 1, failed: 1 }),
    });

    expect(branchNavItem().querySelector("span:last-child")?.className).toContain("bg-amber-500");
    expect(branchNavItem().getAttribute("title")).toContain("実行中1件・失敗1件");
  });

  // 手作業は上の「ユーザーの作業待ち」が持つ別の項目（#2167）。
  it("手作業が残っていてもブランチの件数・強調には影響しない", () => {
    renderSidebar(
      NO_PR_COUNTS,
      { ...NAV_COUNTS, "manual-step": 3 },
      {
        manualStepAttention: { total: 3, actionable: 3, waitingForPrerequisites: 0 },
        releaseActivity: activity({}),
      },
    );

    expect(branchNavItem().textContent).toContain("0");
    expect(branchNavItem().querySelector("span:last-child")?.className).not.toContain(
      "bg-amber-500",
    );
  });

  it("Providerの外では件数を出さない（未取得と同じ扱い）", () => {
    renderSidebarWithRepositories([]);

    expect(branchNavItem().textContent).toBe("ブランチ");
  });
});
