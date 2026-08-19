// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IssueList } from "@/components/dashboard/issue-list";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import type { Issue, IssueLabel } from "@/types/issue";

/**
 * 「まとめて実行」の入口は積める起動先の申告があるときだけ出る（#1993）ため、
 * テストごとにホストを差し替えられるようにしておく。
 */
const dispatchState: {
  hosts: { name: string; online: boolean; repositories: string[] }[];
  jobs: unknown[];
  sessions: unknown[];
} = { hosts: [], jobs: [], sessions: [] };

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
    renderList({ manualStepReadiness: readiness });

    expect(rowOf(1).contains(screen.getByLabelText("前提条件がそろっている"))).toBe(true);
    expect(rowOf(2).contains(screen.getByLabelText("前提条件の完了待ち"))).toBe(true);
  });

  // 判定に載らないIssue（手作業でない・closed）へ印を付けない
  it("判定に無いIssueにはアイコンを出さない", () => {
    renderList({ manualStepReadiness: readiness });

    expect(rowOf(3).querySelector("[aria-label='前提条件がそろっている']")).toBeNull();
    expect(rowOf(3).querySelector("[aria-label='前提条件の完了待ち']")).toBeNull();
  });

  it("待っている相手はホバーで読めるようにする", () => {
    renderList({ manualStepReadiness: readiness });

    expect(
      rowOf(2).querySelector(
        "[title='まだ実行できません。#100 がmainへ反映されるのを待ってください。']",
      ),
    ).not.toBeNull();
  });

  // 左メニューが「いま実行できる件数」を出すため、一覧の行数のままだと数が食い違う
  it("「ユーザーの作業待ち」のヘッダーは、実行できる件数と前提待ちの件数を出す", () => {
    renderList({ manualStepReadiness: readiness, view: "manual-step" });

    expect(screen.getByText("1件・前提待ち1件")).toBeTruthy();
  });

  it("他のビューのヘッダーは今までどおり並んでいる件数を出す", () => {
    renderList({ manualStepReadiness: readiness, view: "all" });

    expect(screen.getByText("3件")).toBeTruthy();
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

function makeDispatch(sessions: DispatchSessionView[]): DispatchStateHandle {
  return {
    hosts: [],
    jobs: [],
    sessions,
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
