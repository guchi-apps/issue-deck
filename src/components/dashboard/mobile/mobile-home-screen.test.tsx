// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DispatchHostView } from "@/lib/dispatch/dispatch-job";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import type { RemoteSessionView } from "@/lib/dispatch/remote-session-rules";
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
import type { MergePendingAttention } from "@/lib/merge-pending-attention";
import type { PullRequestNavCounts } from "@/lib/pull-request-list";
import { NAV_VIEW_IDS } from "@/types/issue";
import type { NavViewId } from "@/types/issue";

const NAV_COUNTS = Object.fromEntries(NAV_VIEW_IDS.map((id) => [id, 0])) as Record<
  NavViewId,
  number
>;

const PR_NAV_COUNTS: PullRequestNavCounts = { all: 0, "in-progress": 0, completed: null, release: 0 };

const NO_MANUAL_STEP: ManualStepAttention = { total: 0, actionable: 0, waitingForPrerequisites: 0 };

const NO_MERGE_PENDING: MergePendingAttention = {
  total: 0,
  autoMerging: 0,
  repairing: 0,
  actionRequired: 0,
};

function makeDispatch(overrides: {
  hosts?: DispatchHostView[];
  sessions?: DispatchSessionView[];
  /** 最初の取得が終わったか（#2090）。偽の間はサブPCのカードの代わりにスケルトンが出る */
  isLoaded?: boolean;
  remoteSessions?: RemoteSessionView[];
}): DispatchStateHandle {
  return {
    hosts: overrides.hosts ?? [],
    jobs: [],
    sessions: overrides.sessions ?? [],
    remoteSessions: overrides.remoteSessions ?? [],
    // エージェント別の一時停止（#2994）。既定は両方とも稼働中
    agentPause: { claude: null, codex: null },
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
    sessionControlCapable: true,
    instructionCapable: true,
    crossRepoQuestionCapable: true,
    manualStepCapable: null,
    manualStepAbortCapable: null,
    manualStepValuesCapable: null,
    manualStepVpsCapable: null,
    planReviewCapable: null,
    codeReviewCapable: null,
    codexCapable: null,
    codexRemoteControlCapable: null,
    manualStepSessionCapable: null,
    chatCodexCapable: null,
    selfUpdateCapable: null,
    previewCapable: null,
    rebootCapable: null,
    reboot: null,
    previewRepositories: null,
    preview: null,
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
      navCounts={NAV_COUNTS}
      manualStepAttention={NO_MANUAL_STEP}
      pullRequestNavCounts={PR_NAV_COUNTS}
      mergePendingAttention={NO_MERGE_PENDING}
      onSelectQuickView={() => {}}
      onSelectPullRequests={() => {}}
      onSelectPreview={() => {}}
        onSelectNightlyRun={() => {}}
        nightlyRunQueuedCount={null}
      previewRunning={false}
      onSelectRepos={() => {}}
      repositoryCount={0}
      onLaunchNewApp={() => {}}
      favoriteRepositories={[]}
      onSelectRepository={() => {}}
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
  // 並びは「要確認→進行→一覧」の3グループ（#3650）。PCの左メニューと同じ順にする約束は外した。
  // 確認環境は#3647で入口を隠している。「ブランチ」「リリース履歴」「AI使用量」はフッターへ移した
  it("タイルを要確認→進行→一覧の順に並べる", () => {
    renderHome();

    const labels = screen
      .getAllByRole("listitem")
      .map((item) => item.textContent?.replace(/\d+$/, "") ?? "");

    expect(labels).toEqual([
      "ユーザーの確認待ち",
      "ユーザーの作業待ち",
      "マージ待ち",
      // 進行状況の順に左上から右へ並べる（#3676）
      "未着手",
      "予約実行",
      "実行中",
      // 見出しが無くなってもIssueの「実行中」と区別できるようにする
      "PR実行中",
      "本番反映待ち",
      "本番リリース",
      "すべてのIssue",
      "すべてのPR",
      "リポジトリ",
      "コードレビュー",
      "リモートセッション",
      "構想",
      "iOS拡張",
    ]);
    // 最下部の1行（#2188）は年に数回なのでタイルには混ぜない
    expect(screen.getByRole("button", { name: /新規アプリを立ち上げる/ })).toBeTruthy();
  });

  it("グループの見出しを出す", () => {
    renderHome();

    for (const heading of ["要確認", "進行", "一覧"]) {
      expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
    }
  });

  // #2724でフッターの「Issue」タブ（リポジトリ一覧）を外した代わりの入口。無くなると、
  // お気に入りに入れていないリポジトリはURLを直に打つしか開く方法が無くなる
  it("「リポジトリ」の行からリポジトリ一覧を開き、連携数を出す", () => {
    const onSelectRepos = vi.fn();
    renderHome({ onSelectRepos, repositoryCount: 7 });

    const row = screen.getByRole("button", { name: /^リポジトリ/ });
    expect(row.textContent).toContain("7");

    row.click();
    expect(onSelectRepos).toHaveBeenCalledTimes(1);
  });

  it("「保存したフィルター」を出さない", () => {
    renderHome();

    expect(screen.queryByText("保存したフィルター")).toBeNull();
    expect(screen.queryByText("よくつかうフィルター")).toBeNull();
  });

  // マージ待ちは「マージ待ち」のタイルで見る。確認待ちには足さない（#3650）
  it("「ユーザーの確認待ち」の件数にマージ待ちPRを足さない", () => {
    renderHome({
      navCounts: { ...NAV_COUNTS, "check-user": 2 },
      pullRequestNavCounts: { all: 3, "in-progress": 0, completed: 3, release: 0 },
    });

    expect(screen.getByRole("button", { name: /ユーザーの確認待ち/ }).textContent).toBe(
      "ユーザーの確認待ち2",
    );
    expect(screen.getByRole("button", { name: /^マージ待ち/ }).textContent).toBe("マージ待ち3");
  });

  // PCの左メニューと同じ判定（`isPullRequestViewAttention`）を使う（#2334）
  it("要操作のマージ待ちPRがあれば件数をオレンジの丸で出す", () => {
    renderHome({
      pullRequestNavCounts: { all: 3, "in-progress": 1, completed: 2, release: 0 },
      mergePendingAttention: { total: 2, autoMerging: 1, repairing: 0, actionRequired: 1 },
    });

    const row = screen.getByRole("button", { name: /マージ待ち/ });
    expect(row.className).toContain("bg-amber-500");
  });

  it("マージ待ちが自動で進むものだけなら丸にしない", () => {
    renderHome({
      pullRequestNavCounts: { all: 3, "in-progress": 1, completed: 2, release: 0 },
      mergePendingAttention: { total: 2, autoMerging: 2, repairing: 0, actionRequired: 0 },
    });

    const row = screen.getByRole("button", { name: /マージ待ち/ });
    expect(row.className).not.toContain("bg-amber-500");
  });

  it("構想の行に件数を出し、未取得なら出さない（#3639）", () => {
    renderHome({ ideasCount: 7 });
    expect(screen.getByRole("button", { name: /構想/ }).textContent).toBe("構想7");

    cleanup();
    renderHome({ ideasCount: null });
    expect(screen.getByRole("button", { name: /構想/ }).textContent).toBe("構想");
  });

  it("「ユーザーの作業待ち」を強調するのは、いま実行できる手作業があるときだけ", () => {
    const { rerender } = renderHome({
      navCounts: { ...NAV_COUNTS, "manual-step": 2 },
      manualStepAttention: { total: 2, actionable: 0, waitingForPrerequisites: 2 },
    });

    function badgeClassName() {
      const row = screen.getByRole("button", { name: /ユーザーの作業待ち/ });
      return row.className;
    }

    expect(badgeClassName()).not.toContain("bg-amber-500");

    rerender(
      <MobileHomeScreen
        navCounts={{ ...NAV_COUNTS, "manual-step": 2 }}
        manualStepAttention={{ total: 2, actionable: 1, waitingForPrerequisites: 1 }}
        pullRequestNavCounts={PR_NAV_COUNTS}
      mergePendingAttention={NO_MERGE_PENDING}
        onSelectQuickView={() => {}}
        onSelectPullRequests={() => {}}
        onSelectPreview={() => {}}
        onSelectNightlyRun={() => {}}
        nightlyRunQueuedCount={null}
        previewRunning={false}
        onSelectRepos={() => {}}
        repositoryCount={0}
        onLaunchNewApp={() => {}}
        favoriteRepositories={[]}
        onSelectRepository={() => {}}
        onOpenSettings={() => {}}
      />,
    );

    expect(badgeClassName()).toContain("bg-amber-500");
  });

  // 「質問」のタイルは#5047で廃止した。コードレビューは合図なしで件数だけ（#2325・PCと同じ）
  it("「質問」のタイルを出さず、コードレビューは件数だけを出す", () => {
    renderHome({ navCounts: { ...NAV_COUNTS, "code-review": 2 } });

    expect(screen.queryByRole("button", { name: /^質問/ })).toBeNull();
    const row = screen.getByRole("button", { name: /^コードレビュー/ });
    expect(row.textContent).toContain("2");
    expect(row.querySelector(".animate-spin")).toBeNull();
    expect(row.className).not.toContain("amber");
    expect(row.getAttribute("title")).toBeNull();
  });

  it("タイルを押すと、そのビューへ遷移する", () => {
    const onSelectQuickView = vi.fn();
    renderHome({ onSelectQuickView, navCounts: { ...NAV_COUNTS, "release-pending": 3 } });

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
          answerInApp: false,
          reapAt: null,
          reapReason: null,
          codexThreadKnown: null,
    step: null,
    stepAt: null,
    stepSeenAt: null,
    interruptedReason: null,
    interruptedAt: null,
    waitingTool: null,
    waitingTarget: null,
    models: [],
        },
      ],
    });
    renderHome();

    expect(screen.queryByText("#1933 ホーム画面の実装状況表示を簡略化")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "サブPCの実行状況を開く" }));

    // ヘッダーのボタンと同じシートが開く（開いた中身にだけ出るキューの見出しで確かめる）
    expect(screen.getByRole("dialog", { name: "実行状況" })).toBeTruthy();
  });

});

// 引っ張って更新（#2182）。ジェスチャーの判定そのものは`use-pull-to-refresh.test.tsx`が見るので、
// ここでは「ホームの枠に付いていて、離すとホームに出ているものが取り直されるか」だけを確かめる
describe("MobileHomeScreen リモートセッションの起動数（#4948）", () => {
  const remoteSession = (status: RemoteSessionView["status"]): RemoteSessionView => ({
    id: status,
    repositoryFullName: "guchi-apps/issue-deck",
    host: "subpc",
    tmuxSessionName: "issue-deck-remote-abcdefgh",
    status,
    remoteControlUrl: null,
    failureMessage: null,
    stopping: false,
    createdAt: "2026-10-18T00:00:00.000Z",
    lastSeenAt: null,
  });
  const remoteTile = () => screen.getByText("リモートセッション").closest("button") as HTMLElement;

  it("終わっていないセッションの本数をタイルに出し、起動中なら回転アイコンを出す", () => {
    dispatchState = makeDispatch({
      remoteSessions: [remoteSession("running"), remoteSession("starting"), remoteSession("ended")],
    });
    renderHome();

    expect(remoteTile().textContent).toBe("リモートセッション2");
    expect(remoteTile().querySelector(".animate-spin")).toBeTruthy();
  });

  it("0本は0と出し、取得前は数字を出さない", () => {
    dispatchState = makeDispatch({ remoteSessions: [] });
    renderHome();
    expect(remoteTile().textContent).toBe("リモートセッション0");
    expect(remoteTile().querySelector(".animate-spin")).toBeNull();

    cleanup();
    dispatchState = makeDispatch({ isLoaded: false });
    renderHome();
    expect(remoteTile().textContent).toBe("リモートセッション");
  });
});

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
        navCounts={NAV_COUNTS}
        manualStepAttention={NO_MANUAL_STEP}
        pullRequestNavCounts={PR_NAV_COUNTS}
      mergePendingAttention={NO_MERGE_PENDING}
        onSelectQuickView={() => {}}
        onSelectPullRequests={() => {}}
        onSelectPreview={() => {}}
        onSelectNightlyRun={() => {}}
        nightlyRunQueuedCount={null}
        previewRunning={false}
        onSelectRepos={() => {}}
        repositoryCount={0}
        onLaunchNewApp={() => {}}
        favoriteRepositories={[]}
        onSelectRepository={() => {}}
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
