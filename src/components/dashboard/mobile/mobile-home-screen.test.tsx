// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DispatchHostView } from "@/lib/dispatch/dispatch-job";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";

// ホームは`useDispatchState`を自分で1回呼び、ヘッダーのボタンへ配る（#1690）。
// jsdomでは取得口を持たせたくないので、フックごと差し替える
let dispatchState: DispatchStateHandle;
vi.mock("@/hooks/use-dispatch-state", () => ({
  useDispatchState: () => dispatchState,
}));

import { MobileHomeScreen } from "@/components/dashboard/mobile/mobile-home-screen";
import type { ManualStepAttention } from "@/lib/manual-step-attention";
import type { PullRequestNavCounts } from "@/lib/pull-request-list";
import { NAV_VIEW_IDS } from "@/types/issue";
import type { NavViewId, OverviewStat } from "@/types/issue";

const NAV_COUNTS = Object.fromEntries(NAV_VIEW_IDS.map((id) => [id, 0])) as Record<
  NavViewId,
  number
>;

const PR_NAV_COUNTS: PullRequestNavCounts = { all: 0, "in-progress": 0, completed: null };

const NO_MANUAL_STEP: ManualStepAttention = { total: 0, actionable: 0, waitingForPrerequisites: 0 };

const OVERVIEW_STATS: OverviewStat[] = [
  { label: "要対応", value: "2", linkedView: "check-user" },
  { label: "実行中", value: "4", linkedView: "in-progress" },
  { label: "本番反映待ち", value: "3", linkedView: "release-pending" },
];

function makeDispatch(overrides: {
  hosts?: DispatchHostView[];
  sessions?: DispatchSessionView[];
}): DispatchStateHandle {
  return {
    hosts: overrides.hosts ?? [],
    jobs: [],
    sessions: overrides.sessions ?? [],
    concurrency: 2,
    isLoaded: true,
    error: null,
    setError: vi.fn(),
    isSubmitting: false,
    enqueue: vi.fn(),
    sendSessionControl: vi.fn(),
    cancel: vi.fn(),
    dismiss: vi.fn(),
    prioritize: vi.fn(),
  } as unknown as DispatchStateHandle;
}

function makeHost(overrides: Partial<DispatchHostView> = {}): DispatchHostView {
  return {
    name: "subpc",
    repositories: ["guchi-apps/issue-deck"],
    contractVersion: 2,
    online: true,
    lastSeenAt: "2026-08-16T00:00:00Z",
    screenshotCapable: true,
    sessionControlCapable: true,
    instructionCapable: true,
    crossRepoQuestionCapable: true,
    maxSessions: 12,
    liveSessions: 3,
    metrics: null,
    checkout: null,
    ...overrides,
  };
}

function renderHome(
  props: Partial<Parameters<typeof MobileHomeScreen>[0]> = {},
) {
  return render(
    <MobileHomeScreen
      overviewStats={OVERVIEW_STATS}
      navCounts={NAV_COUNTS}
      checkUserPullRequestCount={0}
      manualStepAttention={NO_MANUAL_STEP}
      pullRequestNavCounts={PR_NAV_COUNTS}
      onSelectQuickView={() => {}}
      onSelectPullRequests={() => {}}
      onSelectFlow={() => {}}
      favoriteRepositories={[]}
      onSelectRepository={() => {}}
      onOpenIssue={() => {}}
      onCreateIssue={() => {}}
      onAskCrossRepoQuestion={() => {}}
      onOpenSettings={() => {}}
      {...props}
    />,
  );
}

beforeEach(() => {
  dispatchState = makeDispatch({});
});

afterEach(() => {
  cleanup();
});

describe("MobileHomeScreen（#1690）", () => {
  it("メニューにPCの左メニューと同じ項目を同じ順で並べる", () => {
    renderHome();

    const labels = screen
      .getAllByRole("listitem")
      .map((item) => item.textContent?.replace(/\d+$/, "") ?? "");

    expect(labels).toEqual([
      "ユーザーの確認待ち",
      "ユーザーの作業待ち",
      "質問",
      "ブランチ",
      "すべてのIssue",
      "お気に入り",
      "未着手",
      "実行中",
      "本番反映待ち",
      "すべてのPR",
      "実行中",
    ]);
  });

  it("「保存したフィルター」を出さない", () => {
    renderHome();

    expect(screen.queryByText("保存したフィルター")).toBeNull();
    expect(screen.queryByText("よくつかうフィルター")).toBeNull();
  });

  it("「ユーザーの確認待ち」の件数にはユーザーのマージ待ちPRを足す（PCと同じ数え方）", () => {
    renderHome({
      navCounts: { ...NAV_COUNTS, "check-user": 2 },
      checkUserPullRequestCount: 3,
    });

    const row = screen.getByRole("button", { name: /ユーザーの確認待ち/ });
    expect(row.textContent).toBe("ユーザーの確認待ち5");
  });

  it("「ユーザーの作業待ち」を強調するのは、いま実行できる手作業があるときだけ", () => {
    const { rerender } = renderHome({
      navCounts: { ...NAV_COUNTS, "manual-step": 2 },
      manualStepAttention: { total: 2, actionable: 0, waitingForPrerequisites: 2 },
    });

    function badgeClassName() {
      const row = screen.getByRole("button", { name: /ユーザーの作業待ち/ });
      return row.querySelector("span:last-child")?.className ?? "";
    }

    expect(badgeClassName()).not.toContain("bg-amber-500");

    rerender(
      <MobileHomeScreen
        overviewStats={OVERVIEW_STATS}
        navCounts={{ ...NAV_COUNTS, "manual-step": 2 }}
        checkUserPullRequestCount={0}
        manualStepAttention={{ total: 2, actionable: 1, waitingForPrerequisites: 1 }}
        pullRequestNavCounts={PR_NAV_COUNTS}
        onSelectQuickView={() => {}}
        onSelectPullRequests={() => {}}
        onSelectFlow={() => {}}
        favoriteRepositories={[]}
        onSelectRepository={() => {}}
        onOpenIssue={() => {}}
        onCreateIssue={() => {}}
        onAskCrossRepoQuestion={() => {}}
        onOpenSettings={() => {}}
      />,
    );

    expect(badgeClassName()).toContain("bg-amber-500");
  });

  it("先頭のカードを押すと、そのカードのビューへ遷移する", () => {
    const onSelectQuickView = vi.fn();
    renderHome({ onSelectQuickView });

    // メニューにも同名の行が並ぶため（#1743）、件数でカード側を指名する
    fireEvent.click(screen.getByRole("button", { name: /本番反映待ち\s*3/ }));

    expect(onSelectQuickView).toHaveBeenCalledWith("release-pending");
  });

  it("申告しているホストが無ければサブPCの様子を出さない", () => {
    renderHome();

    expect(screen.queryByText("サブPC")).toBeNull();
  });

  it("申告しているホストがあれば、セッション本数つきでサブPCの様子を出す", () => {
    dispatchState = makeDispatch({ hosts: [makeHost()] });
    renderHome();

    expect(screen.getByText("サブPC")).toBeTruthy();
    expect(screen.getByText("セッション 3/12")).toBeTruthy();
  });

  // 通知ベル（#1772）。PCのトップバー（実行キュー → ベル → アバター）と同じ順序にする
  it("ヘッダーの通知ベルは実行状況の右隣・設定の左に置く", () => {
    dispatchState = makeDispatch({ hosts: [makeHost()] });
    const { container } = renderHome();

    const labels = Array.from(container.querySelectorAll("header button")).map((button) =>
      button.getAttribute("aria-label"),
    );

    expect(labels).toContain("対応が必要なもの");
    expect(labels.indexOf("対応が必要なもの")).toBe(labels.indexOf("実行状況") + 1);
    expect(labels.indexOf("設定")).toBe(labels.indexOf("対応が必要なもの") + 1);
  });

  it("右下の丸ボタンからIssueの作成と質問ができる", () => {
    const onCreateIssue = vi.fn();
    const onAskCrossRepoQuestion = vi.fn();
    renderHome({ onCreateIssue, onAskCrossRepoQuestion });

    fireEvent.click(screen.getByRole("button", { name: "新しいIssueを作成" }));
    fireEvent.click(screen.getByRole("button", { name: "複数リポジトリに質問する" }));

    expect(onCreateIssue).toHaveBeenCalledTimes(1);
    expect(onAskCrossRepoQuestion).toHaveBeenCalledTimes(1);
  });
});
