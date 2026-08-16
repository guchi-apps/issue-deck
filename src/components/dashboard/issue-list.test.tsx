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
