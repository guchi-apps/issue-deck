// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IssueList } from "@/components/dashboard/issue-list";
import type { Issue } from "@/types/issue";

vi.mock("@/hooks/use-dispatch-state", () => ({
  useDispatchState: () => ({
    hosts: [],
    jobs: [],
    sessions: [],
    concurrency: null,
    error: null,
    isSubmitting: false,
    setError: vi.fn(),
    enqueue: vi.fn(),
    cancel: vi.fn(),
  }),
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

function rowOf(issueNumber: number): HTMLElement {
  return screen.getByText(`#${issueNumber} Issue ${issueNumber}`).closest("button")!;
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

afterEach(cleanup);

describe("IssueListの選択ハイライト（#1597）", () => {
  it("押した行は、親から選択中Issueが渡ってくる前にハイライトされる", () => {
    // 選択の正はURLクエリで、その反映はトランジション（低優先度）で入るため、
    // 親（IssueDeckShell）のselectedIssueIdが変わるのは1テンポあと。
    // 押した瞬間の反応をここで作っている。
    const onSelectIssue = vi.fn();
    renderList({ onSelectIssue });

    fireEvent.click(rowOf(2));

    expect(onSelectIssue).toHaveBeenCalledTimes(1);
    expect(rowOf(2).className).toContain("border-l-primary");
    expect(rowOf(1).className).not.toContain("border-l-primary");
  });

  it("別経路で選択が変わったら、押した行のハイライトは残らない", () => {
    // 確認待ちトースト・本文中のIssueリンクなど、一覧の外から選択が変わる経路がある。
    const { rerender } = renderList();

    fireEvent.click(rowOf(2));
    expect(rowOf(2).className).toContain("border-l-primary");

    rerender(
      <IssueList title="すべて" issues={issues} selectedIssueId="3" onSelectIssue={vi.fn()} />,
    );

    expect(rowOf(3).className).toContain("border-l-primary");
    expect(rowOf(2).className).not.toContain("border-l-primary");
  });

  it("まとめて選択モードでは、行のクリックで選択ハイライトを動かさない", () => {
    const onSelectIssue = vi.fn();
    renderList({ onSelectIssue, selectedIssueId: "1" });

    fireEvent.click(screen.getByRole("button", { name: "まとめて選択" }));
    fireEvent.click(rowOf(2));

    expect(onSelectIssue).not.toHaveBeenCalled();
    expect(rowOf(1).className).not.toContain("border-l-primary");
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
    return screen.getByText(`#${issue.number} ${issue.title}`).closest("button")!;
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
