// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IssueList } from "@/components/dashboard/issue-list";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import type { ManualStepRunView } from "@/lib/manual-step-run-view";
import type { Issue, IssueLabel } from "@/types/issue";

/**
 * 「まとめて実行」の入口は積める起動先の申告があるときだけ出る（#1993）ため、
 * テストごとにホストを差し替えられるようにしておく。
 */
const dispatchState: {
  hosts: { name: string; online: boolean; repositories: string[] }[];
  jobs: unknown[];
  sessions: unknown[];
  manualStepRuns: ManualStepRunView[];
} = { hosts: [], jobs: [], sessions: [], manualStepRuns: [] };

vi.mock("@/hooks/use-dispatch-state", () => ({
  useDispatchState: () => ({
    ...dispatchState,
    concurrency: null,
    error: null,
    isSubmitting: false,
    setError: vi.fn(),
    enqueue: vi.fn(),
    cancel: vi.fn(),
  }),
}));

// 選択モードのバーはリポジトリのラベル定義を取りに行く（#1993）。jsdomでは通信しない
vi.mock("@/hooks/use-repository-label-names", () => ({
  useRepositoryLabelNames: () => ({ labelNamesByRepository: new Map(), isLoading: false }),
}));

vi.mock("@/hooks/use-issues-workflow-running", () => ({
  useIssuesWorkflowRunning: () => ({}),
}));

vi.mock("@/hooks/use-issue-list-scroll", () => ({
  useIssueListScroll: () => undefined,
}));

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  const number = overrides.number ?? 1;
  return {
    id: String(number),
    number,
    title: `Issue ${number}`,
    body: "",
    state: "open",
    stateReason: null,
    repositoryFullName: "guchi-apps/issue-deck",
    repositoryPrivate: false,
    repositoryArchived: false,
    author: { login: "guchi", avatarUrl: "" },
    assignee: null,
    labels: [],
    milestone: null,
    commentCount: 0,
    createdAt: "2026-08-11T00:00:00Z",
    updatedAt: "2026-08-11T00:00:00Z",
    closedAt: null,
    checkUserLabeledAt: null,
    qaAnswerPendingAt: null,
    lastCommentAt: null,
    projectStatus: null,
    htmlUrl: "https://github.com/guchi-apps/issue-deck/issues/1",
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: 0,
    ...overrides,
  } as Issue;
}

const issues = [makeIssue({ number: 1 }), makeIssue({ number: 2 }), makeIssue({ number: 3 })];

// 行の枠は`<li>`（#1915）。カード全面に敷いた選択用ボタンと本文が兄弟に分かれたため、
// 選択ハイライトのクラスも`<li>`側に付く
function rowOf(issueNumber: number): HTMLElement {
  return screen.getByText(`#${issueNumber} Issue ${issueNumber}`).closest("li")!;
}

/** 行を選ぶ当たり判定（カード全面に敷いたボタン）。本文の中のボタン（チェックボックス等）と区別する */
function selectButtonOf(issueNumber: number): HTMLElement {
  return rowOf(issueNumber).querySelector(":scope > button")!;
}

function renderList(props: Partial<React.ComponentProps<typeof IssueList>> = {}) {
  return render(
    <IssueList
      title="すべて"
      issues={issues}
      selectedIssueId={null}
      onSelectIssue={vi.fn()}
      {...props}
    />,
  );
}

afterEach(() => {
  cleanup();
  dispatchState.hosts = [];
  dispatchState.manualStepRuns = [];
});

/** 積める起動先の申告（`resolveDispatchTargetRejection`が見るぶんだけ） */
function useDispatchHost() {
  dispatchState.hosts = [
    { name: "subpc", online: true, repositories: ["guchi-apps/issue-deck"] },
  ];
}

describe("IssueListの選択ハイライト（#1597）", () => {
  it("押した行は、親から選択中Issueが渡ってくる前にハイライトされる", () => {
    // 選択の正はURLクエリで、その反映はトランジション（低優先度）で入るため、
    // 親（IssueDeckShell）のselectedIssueIdが変わるのは1テンポあと。
    // 押した瞬間の反応をここで作っている。
    const onSelectIssue = vi.fn();
    renderList({ onSelectIssue });

    fireEvent.click(selectButtonOf(2));

    expect(onSelectIssue).toHaveBeenCalledTimes(1);
    expect(rowOf(2).className).toContain("border-l-primary");
    expect(rowOf(1).className).not.toContain("border-l-primary");
  });

  it("別経路で選択が変わったら、押した行のハイライトは残らない", () => {
    // 確認待ちトースト・本文中のIssueリンクなど、一覧の外から選択が変わる経路がある。
    const { rerender } = renderList();

    fireEvent.click(selectButtonOf(2));
    expect(rowOf(2).className).toContain("border-l-primary");

    rerender(
      <IssueList title="すべて" issues={issues} selectedIssueId="3" onSelectIssue={vi.fn()} />,
    );

    expect(rowOf(3).className).toContain("border-l-primary");
    expect(rowOf(2).className).not.toContain("border-l-primary");
  });

  it("まとめて選択モードでは、行のクリックで選択ハイライトを動かさない", () => {
    useDispatchHost();
    const onSelectIssue = vi.fn();
    renderList({ onSelectIssue, selectedIssueId: "1" });

    fireEvent.click(screen.getByRole("button", { name: "まとめて実行" }));
    fireEvent.click(selectButtonOf(2));

    expect(onSelectIssue).not.toHaveBeenCalled();
    expect(rowOf(1).className).not.toContain("border-l-primary");
  });
});

describe("まとめて実行の入口（#1993）", () => {
  // ヘッダーに置くとスマホ（`showHeader={false}`）からは押せない。一覧の上に出す
  it("ヘッダーを出さないスマホの一覧にも出る", () => {
    useDispatchHost();
    renderList({ showHeader: false });

    expect(screen.getByRole("button", { name: "まとめて実行" })).toBeTruthy();
    expect(screen.getByText("3件")).toBeTruthy();
  });

  it("積める起動先の申告が無ければ出さない", () => {
    renderList();

    expect(screen.queryByRole("button", { name: "まとめて実行" })).toBeNull();
  });

  // 1件しか積めないなら個別の「実装を開始」で足りる
  it("積めるIssueが1件しか無ければ出さない", () => {
    useDispatchHost();
    renderList({ issues: [makeIssue({ number: 1 })] });

    expect(screen.queryByRole("button", { name: "まとめて実行" })).toBeNull();
  });

  it("closeしたIssueは数えない", () => {
    useDispatchHost();
    renderList({
      issues: [makeIssue({ number: 1 }), makeIssue({ number: 2, state: "closed" })],
    });

    expect(screen.queryByRole("button", { name: "まとめて実行" })).toBeNull();
  });
});

describe("手作業Issueの前提条件アイコン（#1763）", () => {
  const readiness = new Map([
    ["1", { ready: true, blocking: [], message: "前提はすべて満たされています。いま実行できます。" }],
    [
      "2",
      {
        ready: false,
        blocking: [],
        message: "まだ実行できません。#100 がmainへ反映されるのを待ってください。",
      },
    ],
  ]);

  it("いま実行できる手作業と前提待ちの手作業を、別のアイコンで示す", () => {
    renderList({ prerequisiteReadiness: readiness });

    expect(rowOf(1).contains(screen.getByLabelText("前提条件がそろっている"))).toBe(true);
    expect(rowOf(2).contains(screen.getByLabelText("前提条件の完了待ち"))).toBe(true);
  });

  // 判定に載らないIssue（手作業でない・closed）へ印を付けない
  it("判定に無いIssueにはアイコンを出さない", () => {
    renderList({ prerequisiteReadiness: readiness });

    expect(rowOf(3).querySelector("[aria-label='前提条件がそろっている']")).toBeNull();
    expect(rowOf(3).querySelector("[aria-label='前提条件の完了待ち']")).toBeNull();
  });

  it("待っている相手はホバーで読めるようにする", () => {
    renderList({ prerequisiteReadiness: readiness });

    expect(
      rowOf(2).querySelector(
        "[title='まだ実行できません。#100 がmainへ反映されるのを待ってください。']",
      ),
    ).not.toBeNull();
  });

  // 左メニューが「いま実行できる件数」を出すため、一覧の行数のままだと数が食い違う
  it("「ユーザーの作業待ち」のヘッダーは、実行できる件数と前提待ちの件数を出す", () => {
    renderList({ prerequisiteReadiness: readiness, view: "manual-step" });

    expect(screen.getByText("1件・前提待ち1件")).toBeTruthy();
  });

  it("他のビューのヘッダーは今までどおり並んでいる件数を出す", () => {
    renderList({ prerequisiteReadiness: readiness, view: "all" });

    expect(screen.getByText("3件")).toBeTruthy();
  });
});

// #2174: 左メニューが実行中の確認待ちを件数から外すため、一覧の行数のままだと数が食い違う
describe("「ユーザーの確認待ち」のヘッダーの件数（#2174）", () => {
  it("実行中のIssueを引いた件数と、その内訳を出す", () => {
    renderList({ view: "check-user", checkUserRunningIssueIds: new Set(["1"]) });

    expect(screen.getByText("2件・実行中1件")).toBeTruthy();
  });

  it("実行中が無ければ今までどおり並んでいる件数を出す", () => {
    renderList({ view: "check-user", checkUserRunningIssueIds: new Set<string>() });

    expect(screen.getByText("3件")).toBeTruthy();
  });

  it("行は実行中でも一覧から消さない", () => {
    renderList({ view: "check-user", checkUserRunningIssueIds: new Set(["1"]) });

    expect(rowOf(1)).toBeTruthy();
  });
});

// #1945: 右下の丸ボタンが一覧の行の後ろに回っていた
describe("行の重なり順（#1945）", () => {
  it("行の中の重なり順を`isolate`で行の内側に閉じ込める", () => {
    // jsdomは重なりを計算しないため、クラスの有無で守る。
    // 行の中では当たり判定（z-0）と本文（z-10）の前後を決めているが、`isolate`が外れると
    // その比較が一覧の外まで及び、z-indexを持たない右下の丸ボタンが行の後ろへ回る。
    renderList();

    expect(rowOf(1).className).toContain("isolate");
  });
});

describe("IssueListの縦方向の縮小（#1665）", () => {
  it("ルートにmin-h-0が付いている", () => {
    // jsdomはレイアウトを計算しないため、クラスの有無で守る。
    // このクラスが外れると、`flex-1`で縦に並べたスマホのIssue一覧で、
    // Issue件数が多いときに下端の絞り込み行が画面外へ押し出される。
    const { container } = renderList({ className: "flex-1" });

    expect((container.firstChild as HTMLElement).className).toContain("min-h-0");
  });
});

// #1750: 絞り込みを黙って無視すると、件数が変わらない理由が画面から読めない
describe("絞り込みが効かないビューの注記（#1750）", () => {
  afterEach(cleanup);

  it("filtersIgnoredのときだけ件数の隣に注記を出す", () => {
    renderList({ filtersIgnored: true });
    expect(screen.getByText(/絞り込みは適用外/)).toBeTruthy();
  });

  it("既定では出さない", () => {
    renderList();
    expect(screen.queryByText(/絞り込みは適用外/)).toBeNull();
  });
});

// #1796: 回答が届いたのに読んでいない質問を、一覧の行だけで見分けられるようにする
describe("質問Issueの状態ラベル（#1796）", () => {
  const questions = [
    makeIssue({ number: 10, title: "[質問] 未確認のもの", commentCount: 2, hasUnreadComments: true }),
    makeIssue({
      number: 11,
      title: "[質問] 回答待ちのもの",
      commentCount: 1,
      hasUnreadComments: true,
      qaAnswerPendingAt: "2026-08-16T00:00:00Z",
    }),
    makeIssue({ number: 12, title: "[質問] 確認済みのもの", commentCount: 3 }),
  ];

  function questionRow(number: number): HTMLElement {
    const issue = questions.find((item) => item.number === number)!;
    return screen.getByText(`#${issue.number} ${issue.title}`).closest("li")!;
  }

  it("回答が届いていて未読なら「未確認」、まだ回答が来ていなければ「回答待ち」を出す", () => {
    renderList({ issues: questions, view: "question", showHeader: true });

    expect(questionRow(10).textContent).toContain("未確認");
    expect(questionRow(11).textContent).toContain("回答待ち");
    expect(questionRow(12).textContent).not.toContain("未確認");
    expect(questionRow(12).textContent).not.toContain("回答待ち");
  });

  it("質問Issueでなければラベルを出さない", () => {
    renderList({ issues: [makeIssue({ number: 20, hasUnreadComments: true })] });

    expect(rowOf(20).textContent).not.toContain("未確認");
  });

  // 左メニューの数字は総数のままなので、内訳はここでしか読めない
  it("質問ビューのヘッダーに未確認の件数を添える", () => {
    renderList({ issues: questions, view: "question", showHeader: true });

    expect(screen.getByText("3件・未確認1件")).toBeTruthy();
  });

  it("未確認が無ければヘッダーは従来どおりの件数だけにする", () => {
    renderList({ issues: [questions[2]], view: "question", showHeader: true });

    expect(screen.getByText("1件")).toBeTruthy();
  });
});

// #1891。当日ぶんをまとめて「今日」に丸めていたため、朝更新したIssueと数分前に
// 更新したIssueが同じ表記になっていた
describe("IssueList 更新日時", () => {
  it("当日の更新は「今日」ではなく分・時間まで刻んで出す", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 18, 12, 0, 0));
    try {
      renderList({
        issues: [
          makeIssue({ number: 30, updatedAt: new Date(2026, 7, 18, 11, 43, 0).toISOString() }),
          makeIssue({ number: 31, updatedAt: new Date(2026, 7, 18, 9, 0, 0).toISOString() }),
        ],
      });

      expect(rowOf(30).textContent).toContain("17分前");
      expect(rowOf(31).textContent).toContain("3時間前");
      expect(rowOf(30).textContent).not.toContain("今日");
    } finally {
      vi.useRealTimers();
    }
  });
});

function label(name: string): IssueLabel {
  return { name, color: "ededed", description: null };
}

function makeSession(overrides: Partial<DispatchSessionView> = {}): DispatchSessionView {
  return {
    host: "subpc",
    tmuxSessionName: "issue-deck-issue-1",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 1,
    issueTitle: null,
    issueId: null,
    state: "ALIVE",
    exitStatus: null,
    activity: "WAITING_INPUT",
    activityAt: "2026-08-18T00:00:00Z",
    remoteControlUrl: "https://claude.ai/remote/abc",
    previewUrl: null,
    reapAt: null,
    reapReason: null,
    firstSeenAt: "2026-08-18T00:00:00Z",
    lastReportedAt: "2026-08-18T00:00:00Z",
    ...overrides,
  };
}

function makePlanRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 1,
    hostName: "subpc",
    plan: "## 要約",
    status: "WAITING",
    createdAt: "2026-08-22T09:58:00.000Z",
    expiresAt: "2126-08-22T10:28:00.000Z",
    decidedAt: null,
    delivered: false,
    ...overrides,
  };
}

function makeDispatch(
  sessions: DispatchSessionView[],
  planRequests: unknown[] = [],
): DispatchStateHandle {
  return {
    hosts: [],
    jobs: [],
    sessions,
    planRequests,
    concurrency: null,
    error: null,
    isSubmitting: false,
    setError: vi.fn(),
    enqueue: vi.fn(),
    cancel: vi.fn(),
    sendSessionControl: vi.fn(),
  } as unknown as DispatchStateHandle;
}

// #1915: 入力待ちに気づいてから答えるまで、Issueを開き直さずに済むようにする
describe("一覧からRemote Controlを開く（#1915）", () => {
  it("Remote ControlのURLがあるセッションの行にだけボタンを出す", () => {
    renderList({ dispatch: makeDispatch([makeSession()]) });

    expect(screen.getByRole("link", { name: "#1のRemote Controlで開く" })).toBeTruthy();
    // セッションが無い行には出さない
    expect(screen.queryByRole("link", { name: "#2のRemote Controlで開く" })).toBeNull();
  });

  // 開いても意味が無いURLを残さない（判定はsummarizeIssueSessionと共通）
  it("終了したセッションには出さない", () => {
    renderList({
      dispatch: makeDispatch([makeSession({ state: "EXITED" })]),
    });

    expect(screen.queryByRole("link", { name: "#1のRemote Controlで開く" })).toBeNull();
  });

  it("まだ開始していないセッションには出さない", () => {
    renderList({
      dispatch: makeDispatch([makeSession({ activity: "NOT_STARTED" })]),
    });

    expect(screen.queryByRole("link", { name: "#1のRemote Controlで開く" })).toBeNull();
  });

  // リンクを選択用ボタンの中に置くと、押したときにIssueの選択まで走る（不正なHTMLでもある）
  it("押してもIssueの選択は起こらない", () => {
    const onSelectIssue = vi.fn();
    renderList({ onSelectIssue, dispatch: makeDispatch([makeSession()]) });

    const link = screen.getByRole("link", { name: "#1のRemote Controlで開く" });
    expect(selectButtonOf(1).contains(link)).toBe(false);

    fireEvent.click(link);

    expect(onSelectIssue).not.toHaveBeenCalled();
  });
});

// #1964: 押さないと先へ進まない行を、一覧のまま見分けられるようにする
describe("Remoteボタンの強調（#1964）", () => {
  function remoteLinkOf(issueNumber: number): HTMLElement {
    return screen.getByRole("link", { name: `#${issueNumber}のRemote Controlで開く` });
  }

  it("セッションが入力待ちの行は枠線がamberになる", () => {
    renderList({ dispatch: makeDispatch([makeSession({ activity: "WAITING_INPUT" })]) });

    expect(remoteLinkOf(1).className).toContain("border-amber-500");
  });

  it("動いているだけの行は今までどおりの枠線", () => {
    renderList({ dispatch: makeDispatch([makeSession({ activity: "WORKING" })]) });

    expect(remoteLinkOf(1).className).not.toContain("border-amber-500");
  });

  it("00.check-userが付いていれば、入力待ちでなくても強調する", () => {
    renderList({
      issues: [makeIssue({ number: 1, labels: [{ name: "00.check-user" }] as IssueLabel[] })],
      dispatch: makeDispatch([makeSession({ activity: "WORKING" })]),
    });

    expect(remoteLinkOf(1).className).toContain("border-amber-500");
  });

  // マージはGitHub側の操作で、画面の対応PRから実行できる
  it("理由が01.check-mergeなら強調しない", () => {
    renderList({
      issues: [
        makeIssue({
          number: 1,
          labels: [{ name: "00.check-user" }, { name: "01.check-merge" }] as IssueLabel[],
        }),
      ],
      dispatch: makeDispatch([makeSession({ activity: "WORKING" })]),
    });

    expect(remoteLinkOf(1).className).not.toContain("border-amber-500");
  });
});

/**
 * #2061: 計画の承認・修正はアプリの中で完結する。一覧の主導線をRemote Controlから
 * アプリ内（Issueを開くと出る計画パネル）へ向け直す。
 */
describe("計画の承認への入口（#2061）", () => {
  function planButton(issueNumber: number): HTMLElement {
    return screen.getByRole("button", { name: `#${issueNumber}の計画を承認する` });
  }

  it("計画の返事を待っている行にだけ「計画を承認」を出す", () => {
    renderList({
      issues: [makeIssue({ number: 1 }), makeIssue({ number: 2 })],
      dispatch: makeDispatch([makeSession({ activity: "WAITING_INPUT" })], [makePlanRequest()]),
    });

    expect(planButton(1)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "#2の計画を承認する" })).toBeNull();
  });

  it("押すとそのIssueを開く（外部へは出ない）", () => {
    const onSelectIssue = vi.fn();
    renderList({
      onSelectIssue,
      dispatch: makeDispatch([makeSession({ activity: "WAITING_INPUT" })], [makePlanRequest()]),
    });

    fireEvent.click(planButton(1));

    expect(onSelectIssue).toHaveBeenCalledTimes(1);
    expect(onSelectIssue.mock.calls[0][0].number).toBe(1);
  });

  /** 行の中でオレンジが2つ並ぶと、どちらを押せばよいのか分からなくなる */
  it("「計画を承認」を出す行では、Remote Controlの強調を下ろす", () => {
    renderList({
      dispatch: makeDispatch([makeSession({ activity: "WAITING_INPUT" })], [makePlanRequest()]),
    });

    expect(
      screen.getByRole("link", { name: "#1のRemote Controlで開く" }).className,
    ).not.toContain("border-amber-500");
  });

  /** 決まったあと（承認済み・待ち時間切れ）は押す相手がいない */
  it("返事が決まっている行には出さない", () => {
    renderList({
      dispatch: makeDispatch(
        [makeSession({ activity: "WAITING_INPUT" })],
        [makePlanRequest({ status: "APPROVED", decidedAt: "2026-08-22T10:00:00.000Z" })],
      ),
    });

    expect(screen.queryByRole("button", { name: "#1の計画を承認する" })).toBeNull();
  });
});

// #1915: 実装オプションでラベル行が折り返し、行の右端に置く場所が無かった
describe("一覧のカードに出すラベル（#1915）", () => {
  const labeled = [
    makeIssue({
      number: 1,
      labels: [
        label("50.feature"),
        label("21.plan-required"),
        label("25.artifact-required"),
        label("11.local"),
        label("80.Priority: High"),
      ],
    }),
  ];

  it("実装オプション（20番台）は出さない", () => {
    render(
      <IssueList title="すべて" issues={labeled} selectedIssueId={null} onSelectIssue={vi.fn()} />,
    );

    expect(screen.queryByText("21.plan-required")).toBeNull();
    expect(screen.queryByText("25.artifact-required")).toBeNull();
  });

  it("実行状態・分類・優先度は今までどおり出す", () => {
    render(
      <IssueList title="すべて" issues={labeled} selectedIssueId={null} onSelectIssue={vi.fn()} />,
    );

    expect(screen.getByText("50.feature")).toBeTruthy();
    expect(screen.getByText("11.local")).toBeTruthy();
    expect(screen.getByText("80.Priority: High")).toBeTruthy();
  });
});

/**
 * #1797。この一覧は開いている間ずっと10秒間隔で取り直しているのに、その形跡が画面に無く、
 * 止まっていても正常時と見分けが付かなかった。PR一覧・ブランチ画面と同じ並び・同じ文言にそろえる。
 */
describe("IssueList ヘッダーの自動更新の状態（#1797）", () => {
  it("いつ時点の内容かと自動更新の間隔を、件数の後ろに出す", () => {
    renderList({
      showHeader: true,
      fetchedAt: "2026-08-22T05:32:00.000Z",
      autoRefreshIntervalMs: 10_000,
    });

    const meta = screen.getByText(/件/).textContent ?? "";
    expect(meta).toContain("時点");
    expect(meta).toContain("自動更新10秒間隔");
  });

  // 何も出さないと「自動更新していない」のか「この一覧は状態を出さない」のかを見分けられない
  it("自動更新しない一覧では「手動更新のみ」と出す", () => {
    renderList({ showHeader: true, fetchedAt: null, autoRefreshIntervalMs: null });

    expect(screen.getByText(/件/).textContent).toContain("手動更新のみ");
  });

  // 取り直しを持たない一覧に「手動更新のみ」と出しても、押す手段が無いことしか伝わらない
  it("状態を渡していない一覧には何も足さない", () => {
    renderList({ showHeader: true });

    const meta = screen.getByText(/件/).textContent ?? "";
    expect(meta).not.toContain("時点");
    expect(meta).not.toContain("更新");
  });
});

/**
 * 一覧の上に並ぶ「〜が n件あります。」の入口バー（#2107）。
 *
 * **折り返しはjsdomでは再現できない**（レイアウトを計算しないため）ので、
 * 幅が足りないときに折り返すための指定が残っているかをクラスで見張る。1行固定の`flex`へ
 * 戻ると、狭いカラムでテキストが幅0まで潰れて1文字ずつ縦に並ぶ。
 */
describe("件数バーの折り返し（#2107）", () => {
  function barOf(text: RegExp): HTMLElement {
    return screen.getByText(text).closest("div")!;
  }

  it("手作業の入口バーは、入りきらないときに折り返せる", () => {
    const readiness = new Map([
      ["1", { ready: true, blocking: [], message: "" }],
      ["2", { ready: true, blocking: [], message: "" }],
    ]);
    renderList({
      view: "manual-step",
      prerequisiteReadiness: readiness,
      onStartManualStepGuide: vi.fn(),
    });

    const bar = barOf(/いま実行できる手作業が/);
    expect(bar.className).toContain("flex-wrap");
    // テキストに基準幅が無いと、縮むだけで折り返しの合図にならない
    expect(screen.getByText(/いま実行できる手作業が/).className).toContain("basis-48");
    // ボタン側は折り返した後も右端に残す
    expect(screen.getByRole("button", { name: "順番に進める" }).closest("div")!.className).toContain(
      "ml-auto",
    );
  });

  it("「次にやること」の入口バーも折り返せる", () => {
    renderList({ view: "not-started", issueOrderCount: 67, onStartIssueOrder: vi.fn() });

    expect(barOf(/未着手のIssueが/).className).toContain("flex-wrap");
    expect(screen.getByText(/未着手のIssueが/).className).toContain("basis-48");
  });

  // #698。**このビュー唯一の起動口**なので、Issueが0件でも出す
  it("「コードレビュー」ビューでは、Issueが1件も無くても実行の入口を出す", () => {
    renderList({ issues: [], view: "code-review", onStartCodeReview: vi.fn() });

    expect(screen.getByRole("button", { name: "レビューを実行" })).toBeTruthy();
    expect(barOf(/リポジトリ全体を読ませて/).className).toContain("flex-wrap");
  });

  it("他のビューには実行の入口を出さない", () => {
    renderList({ view: "all", onStartCodeReview: vi.fn() });

    expect(screen.queryByRole("button", { name: "レビューを実行" })).toBeNull();
  });

  it("「まとめて実行」の入口バーも折り返せる", () => {
    useDispatchHost();
    renderList();

    expect(barOf(/まとめて実行できるIssueが/).className).toContain("flex-wrap");
    expect(screen.getByText(/まとめて実行できるIssueが/).className).toContain("basis-48");
  });
});

/**
 * 手作業の入口に出る自動実行のバッジ（#1882）と、押して開く一覧（#2119）。
 *
 * バッジは`.find`で先頭1件しか拾っておらず、複数走っていても1件ぶんの進捗しか出ていなかった。
 */
describe("自動実行バッジの一覧（#2119）", () => {
  function manualStepRun(overrides: Partial<ManualStepRunView> = {}): ManualStepRunView {
    return {
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 1,
      issueTitle: "Issue 1",
      issueId: "1",
      targetHost: "subpc",
      status: "RUNNING",
      pausedReason: null,
      done: 1,
      total: 4,
      currentLine: 10,
      currentLabel: null,
      currentJobId: null,
      message: null,
      diagnoseConsent: false,
      startedAt: "2026-08-22T00:00:00Z",
      finishedAt: null,
      ...overrides,
    };
  }

  function renderManualStepList(onStartManualStepGuide = vi.fn()) {
    renderList({
      view: "manual-step",
      prerequisiteReadiness: new Map([["1", { ready: true, blocking: [], message: "" }]]),
      onStartManualStepGuide,
    });
    return onStartManualStepGuide;
  }

  it("走っている実行を全部数える（先頭1件で打ち切らない）", () => {
    dispatchState.manualStepRuns = [
      manualStepRun({ issueNumber: 1, done: 1, total: 4 }),
      manualStepRun({ issueNumber: 2, issueId: "2", done: 3, total: 5 }),
    ];
    renderManualStepList();

    expect(screen.getByRole("button", { name: /自動実行/ }).textContent).toContain(
      "自動実行 2件 4 / 9",
    );
  });

  // 一覧に並んでいない実行まで拾うと、別のビューの進捗がここへ割り込む
  it("この一覧に居ないIssueの実行は数えない", () => {
    dispatchState.manualStepRuns = [
      manualStepRun({ issueNumber: 1, done: 1, total: 4 }),
      manualStepRun({ repositoryFullName: "guchi-apps/vps", issueNumber: 48, issueId: "vps-48" }),
    ];
    renderManualStepList();

    expect(screen.getByRole("button", { name: /自動実行/ }).textContent).toContain("自動実行 1 / 4");
  });

  it("一覧の行を押すと、そのIssueを先頭にしたアシスタントが開く", () => {
    dispatchState.manualStepRuns = [
      manualStepRun({ issueNumber: 1 }),
      manualStepRun({ issueNumber: 2, issueId: "2", issueTitle: "Issue 2" }),
    ];
    const onStartManualStepGuide = renderManualStepList();

    fireEvent.click(screen.getByRole("button", { name: /自動実行/ }));
    fireEvent.click(screen.getByText("Issue 2"));

    expect(onStartManualStepGuide).toHaveBeenCalledWith("2");
  });

  // 「順番に進める」は今までどおり並び順に任せる（起点を渡さない）
  it("「順番に進める」は起点を渡さずに開く", () => {
    const onStartManualStepGuide = renderManualStepList();

    fireEvent.click(screen.getByRole("button", { name: "順番に進める" }));

    expect(onStartManualStepGuide).toHaveBeenCalledWith();
  });
});

/**
 * jsdomには`TouchEvent`のコンストラクタが無いため、フックが読む`touches`だけを持つ
 * イベントを組み立ててdispatchする（`use-pull-to-refresh.test.tsx`と同じやり方）。
 */
function touchEvent(type: string, x: number, y: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: [{ clientX: x, clientY: y }] });
  return event;
}

describe("先頭に固定したセクションの引っ張って更新（#2175）", () => {
  it("固定セクションの上から下へ引っ張っても更新が走る", async () => {
    // 「ユーザーの確認待ち」の先頭に並ぶマージ待ちPR（#1613）は画面の上半分を占めることが
    // あり、引っ張りのタッチを受ける枠の外に置くと、そこを下へなぞっても何も起きなかった。
    const onPullToRefresh = vi.fn().mockResolvedValue(undefined);
    renderList({
      pinnedSection: <div data-testid="pinned">あなたのマージを待っているPull Request</div>,
      onPullToRefresh,
    });

    const pinned = screen.getByTestId("pinned");
    await act(async () => {
      pinned.dispatchEvent(touchEvent("touchstart", 100, 100));
      pinned.dispatchEvent(touchEvent("touchmove", 100, 140));
      pinned.dispatchEvent(touchEvent("touchmove", 100, 300));
      pinned.dispatchEvent(new Event("touchend", { bubbles: true }));
    });

    expect(onPullToRefresh).toHaveBeenCalledTimes(1);
  });
});
