// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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

// 実行状況シートの中身はIssue詳細への遷移（`useReferenceNavigation` → `useRouter`）を要求する。
// ここで見たいのは「同じシートが開くか」だけなので、遷移そのものは差し替える
vi.mock("@/hooks/use-reference-navigation", () => ({
  useReferenceNavigation: () => ({ openIssue: () => {}, openPullRequest: () => {} }),
}));

import {
  MobileHomeScreen,
  MobileHomeScreenView,
} from "@/components/dashboard/mobile/mobile-home-screen";
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
  /** 最初の取得が終わったか（#2090）。偽の間はサブPCのカードの代わりにスケルトンが出る */
  isLoaded?: boolean;
}): DispatchStateHandle {
  return {
    hosts: overrides.hosts ?? [],
    jobs: [],
    sessions: overrides.sessions ?? [],
    concurrency: 2,
    isLoaded: overrides.isLoaded ?? true,
    error: null,
    setError: vi.fn(),
    isSubmitting: false,
    enqueue: vi.fn(),
    sendSessionControl: vi.fn(),
    cancel: vi.fn(),
    dismiss: vi.fn(),
    prioritize: vi.fn(),
    // 引っ張って更新（#2182）がサブPCのカードを取り直すのに呼ぶ
    refresh: vi.fn(),
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
    manualStepCapable: null,
    manualStepAbortCapable: null,
    planReviewCapable: null,
    codeReviewCapable: null,
    selfUpdateCapable: null,
    maxSessions: 12,
    liveSessions: 3,
    metrics: null,
    launchHold: null,
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
      unconfirmedQuestionCount={0}
      pullRequestNavCounts={PR_NAV_COUNTS}
      onSelectQuickView={() => {}}
      onSelectPullRequests={() => {}}
      onSelectFlow={() => {}}
      favoriteRepositories={[]}
      onSelectRepository={() => {}}
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
      "コードレビュー",
      "ブランチ",
      "すべてのIssue",
      "お気に入り",
      "未着手",
      "実行中",
      "本番反映待ち",
      "すべてのPR",
      "実行中",
      "マージ待ち",
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
        unconfirmedQuestionCount={0}
        pullRequestNavCounts={PR_NAV_COUNTS}
        onSelectQuickView={() => {}}
        onSelectPullRequests={() => {}}
        onSelectFlow={() => {}}
        favoriteRepositories={[]}
        onSelectRepository={() => {}}
        onCreateIssue={() => {}}
        onAskCrossRepoQuestion={() => {}}
        onOpenSettings={() => {}}
      />,
    );

    expect(badgeClassName()).toContain("bg-amber-500");
  });

  // 数字は一覧に並ぶ件数で、オレンジの丸は未確認があるときだけ（#2070・PCと同じ）。
  // #1910のように未確認の数を数字に出すと、読み終えた質問しか無いときに
  // 質問が何件も開いたままでも`0`と出て「質問は無い」と読めてしまう
  function questionRow(total: number) {
    // 横断質問のボタンも同じ画面にあるため、件数まで含めてメニューの行を指名する
    return screen.getByRole("button", { name: new RegExp(`^質問\\s*${total}$`) });
  }

  it("未確認の質問があれば、一覧の件数をオレンジの丸で出す", () => {
    renderHome({
      navCounts: { ...NAV_COUNTS, question: 3 },
      unconfirmedQuestionCount: 1,
    });

    const row = questionRow(3);
    expect(row.querySelector("span:last-child")?.className).toContain("bg-amber-500");
    // 数字（総数）と丸（未確認）で意味が違うため、内訳は吹き出しで補う
    expect(row.getAttribute("title")).toContain("3件");
    expect(row.getAttribute("title")).toContain("1件");
  });

  it("未確認の質問が無くても、開いている質問の件数は出す（強調はしない）", () => {
    renderHome({
      navCounts: { ...NAV_COUNTS, question: 3 },
      unconfirmedQuestionCount: 0,
    });

    const row = questionRow(3);
    expect(row.querySelector("span:last-child")?.className).not.toContain("amber");
    expect(row.getAttribute("title")).toContain("3件");
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

  /**
   * #2090。`hosts`は取得前も`[]`なので、これが無いと届くまでカードごと消え、その下の
   * メニューがカード1枚ぶん繰り上がる。届いた瞬間に全部が下へ落ちるため、開いてすぐ
   * 押した指が別の行に当たっていた。
   */
  it("最初の取得が終わるまではサブPCのカードの代わりにスケルトンを置く", () => {
    dispatchState = makeDispatch({ isLoaded: false });
    const { container } = renderHome();

    expect(container.querySelector('[data-testid="dispatch-host-skeleton"]')).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("サブPCの状態を読み込み中");
  });

  it("取得が終わればスケルトンを消す（ホストが1台も無くても残さない）", () => {
    dispatchState = makeDispatch({ isLoaded: true });
    const { container } = renderHome();

    expect(container.querySelector('[data-testid="dispatch-host-skeleton"]')).toBeNull();
  });

  it("取得が終わればスケルトンと同じ場所へカードが入る", () => {
    dispatchState = makeDispatch({ isLoaded: true, hosts: [makeHost()] });
    const { container } = renderHome();

    expect(container.querySelector('[data-testid="dispatch-host-skeleton"]')).toBeNull();
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

  // #1933。ホームは使用率だけのサマリで、セッションの一覧はヘッダーの実行状況シートが持つ
  it("動いているセッションはホームに出さず、カードから実行状況を開ける", () => {
    dispatchState = makeDispatch({
      hosts: [makeHost({ metrics: null })],
      sessions: [
        {
          host: "subpc",
          tmuxSessionName: "issue-deck-issue-1933",
          repositoryFullName: "guchi-apps/issue-deck",
          issueNumber: 1933,
          issueTitle: "ホーム画面の実装状況表示を簡略化",
          issueId: null,
          state: "ALIVE",
          exitStatus: null,
          firstSeenAt: "2026-08-16T00:00:00Z",
          lastReportedAt: "2026-08-16T00:00:00Z",
          activity: null,
          activityAt: null,
          remoteControlUrl: null,
          previewUrl: null,
          reapAt: null,
          reapReason: null,
        },
      ],
    });
    renderHome();

    expect(screen.queryByText("#1933 ホーム画面の実装状況表示を簡略化")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "サブPCの実行状況を開く" }));

    // ヘッダーのボタンと同じシートが開く（開いた中身にだけ出るキューの見出しで確かめる）
    expect(screen.getByRole("dialog", { name: "実行状況" })).toBeTruthy();
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

// 引っ張って更新（#2182）。ジェスチャーの判定そのものは`use-pull-to-refresh.test.tsx`が見るので、
// ここでは「ホームの枠に付いていて、離すとホームに出ているものが取り直されるか」だけを確かめる
describe("MobileHomeScreen の引っ張って更新（#2182）", () => {
  afterEach(cleanup);

  // jsdomには`TouchEvent`のコンストラクタが無いため、ハンドラが読む`touches`だけを持つ
  // イベントを組み立てる（`branch-flow-view.test.tsx`と同じ作り）
  function touchEvent(type: string, x: number, y: number) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "touches", { value: [{ clientX: x, clientY: y }] });
    return event;
  }

  /** 引っ張りのタッチを受ける枠（スクロール領域を包む枠） */
  function pullContainer(container: HTMLElement) {
    const scroller = container.querySelector(".overflow-y-auto");
    if (!scroller?.parentElement) throw new Error("スクロール領域が見つからない");
    return scroller.parentElement;
  }

  /** Providerを噛ませずに取り直しを差し込むため、描画だけの本体を直接描く */
  function renderHomeView(
    props: Partial<Parameters<typeof MobileHomeScreenView>[0]> = {},
  ) {
    return render(
      <MobileHomeScreenView
        overviewStats={OVERVIEW_STATS}
        navCounts={NAV_COUNTS}
        checkUserPullRequestCount={0}
        manualStepAttention={NO_MANUAL_STEP}
        unconfirmedQuestionCount={0}
        releaseActivity={null}
        pullRequestNavCounts={PR_NAV_COUNTS}
        onSelectQuickView={() => {}}
        onSelectPullRequests={() => {}}
        onSelectFlow={() => {}}
        favoriteRepositories={[]}
        onSelectRepository={() => {}}
        onCreateIssue={() => {}}
        onAskCrossRepoQuestion={() => {}}
        onOpenSettings={() => {}}
        {...props}
      />,
    );
  }

  it("下へ引っ張ると表示が出て、離すと数字と実行状況の両方を取り直す", async () => {
    const onRefresh = vi.fn();
    const { container } = renderHomeView({ onRefresh });
    const target = pullContainer(container);

    act(() => {
      target.dispatchEvent(touchEvent("touchstart", 100, 100));
      target.dispatchEvent(touchEvent("touchmove", 100, 140));
    });
    expect(screen.getByText("引っ張って更新")).toBeTruthy();

    act(() => {
      target.dispatchEvent(touchEvent("touchmove", 100, 300));
    });
    expect(screen.getByText("離すと更新")).toBeTruthy();

    await act(async () => {
      target.dispatchEvent(new Event("touchend", { bubbles: true }));
    });

    expect(onRefresh).toHaveBeenCalledTimes(1);
    // サブPCのカードはベルの取り直しに入っていないので、この画面が自分で取り直す
    expect(dispatchState.refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText("更新中…")).toBeTruthy();
  });

  it("取り直しを渡さない場合は引っ張っても反応しない", () => {
    const { container } = renderHomeView();
    const target = pullContainer(container);

    act(() => {
      target.dispatchEvent(touchEvent("touchstart", 100, 100));
      target.dispatchEvent(touchEvent("touchmove", 100, 300));
    });

    expect(screen.queryByText("引っ張って更新")).toBeNull();
    expect(screen.queryByText("離すと更新")).toBeNull();
  });
});
