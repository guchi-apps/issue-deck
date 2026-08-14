// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StartLocalSessionButton } from "@/components/dashboard/start-local-session-button";
import type { DispatchHostView, DispatchJobView } from "@/lib/dispatch/dispatch-job";
import type { Issue, IssueLabel } from "@/types/issue";

const updateIssue = vi.fn();
const onFirstLaunch = vi.fn();

vi.mock("@/hooks/use-issue-mutations", () => ({
  useIssueMutations: () => ({
    updateIssue,
    isSubmitting: false,
    error: null,
  }),
}));

// サブPCへのディスパッチ（#1179）の状態。既定は「申告しているホストが無い」で、
// この場合の見た目は#1180より前と同じ単独のボタンになる
const enqueue = vi.fn();
const cancel = vi.fn();
let dispatchState: {
  hosts: DispatchHostView[];
  jobs: DispatchJobView[];
  concurrency: number | null;
  error: string | null;
};

vi.mock("@/hooks/use-dispatch-state", () => ({
  useDispatchState: () => ({
    ...dispatchState,
    isSubmitting: false,
    setError: vi.fn(),
    enqueue,
    cancel,
  }),
}));

function makeHost(overrides: Partial<DispatchHostView> = {}): DispatchHostView {
  return {
    name: "subpc",
    repositories: ["guchi-apps/issue-deck"],
    contractVersion: 2,
    online: true,
    lastSeenAt: "2026-08-14T00:00:00Z",
    ...overrides,
  };
}

function makeJob(overrides: Partial<DispatchJobView> = {}): DispatchJobView {
  return {
    id: "job-1",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 1049,
    targetHost: "subpc",
    status: "QUEUED",
    message: null,
    tmuxSessionName: null,
    createdAt: "2026-08-14T00:00:00Z",
    claimedAt: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "1",
    number: 1049,
    title: "WSL実行時のクイックスタート機能の追加",
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
    htmlUrl: "https://github.com/guchi-apps/issue-deck/issues/1049",
    favorite: false,
    hasUnreadComments: false,
    readCommentCount: 0,
    ...overrides,
  } as Issue;
}

function label(name: string): IssueLabel {
  return { name, color: "#000000", description: null } as IssueLabel;
}

/** window.location.href への代入を観測できるよう差し替える */
function stubLocation(): { get href(): string } {
  const location = { href: "" };
  Object.defineProperty(window, "location", {
    configurable: true,
    value: location,
  });
  return location;
}

describe("StartLocalSessionButton", () => {
  beforeEach(() => {
    dispatchState = { hosts: [], jobs: [], concurrency: 2, error: null };
  });

  afterEach(() => {
    cleanup();
    updateIssue.mockReset();
    onFirstLaunch.mockReset();
    enqueue.mockReset();
    cancel.mockReset();
    // セットアップ手順を見せたかの記録はlocalStorageに残るため、テスト間で持ち越さない（#1088）
    window.localStorage.clear();
  });

  it("openなIssueではボタンを表示する", () => {
    render(
      <StartLocalSessionButton
        issue={makeIssue()}
        onIssueUpdated={vi.fn()}
        onFirstLaunch={onFirstLaunch}
      />,
    );

    expect(screen.getByRole("button", { name: /ローカルで開始/ })).not.toBeNull();
  });

  it("ローカル起動プロトコルに適合しておらず、申告しているホストも無ければ表示しない（#1073）", () => {
    const { container } = render(
      <StartLocalSessionButton
        issue={makeIssue()}
        onIssueUpdated={vi.fn()}
        onFirstLaunch={onFirstLaunch}
        hasLocalStartScript={false}
      />,
    );

    expect(container.innerHTML).toBe("");
  });

  it("ローカル起動プロトコルに適合していなくても、サブPCが実行できると申告していれば出す（#1224）", () => {
    // 汎用ランチャーでマーカー行の無いリポジトリも起動できるため、GitHub上のファイルの有無で
    // サブPC導線まで消さない。実際に起動できるかを知っているのはサブPC側の申告だけ
    dispatchState = { hosts: [makeHost()], jobs: [], concurrency: 2, error: null };

    render(
      <StartLocalSessionButton
        issue={makeIssue()}
        onIssueUpdated={vi.fn()}
        onFirstLaunch={onFirstLaunch}
        hasLocalStartScript={false}
      />,
    );

    // 「このPC」は候補に入らないため、メニューではなく単独のボタンになる
    const button = screen.getByRole("button", { name: /subpcで開始/i });
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  it("適合していないリポジトリを実行できないホストしか無ければ、押せない理由を出す（#1224）", () => {
    dispatchState = {
      hosts: [makeHost({ repositories: ["guchi-apps/dayspan"] })],
      jobs: [],
      concurrency: 2,
      error: null,
    };

    render(
      <StartLocalSessionButton
        issue={makeIssue()}
        onIssueUpdated={vi.fn()}
        onFirstLaunch={onFirstLaunch}
        hasLocalStartScript={false}
      />,
    );

    const button = screen.getByRole("button", { name: /subpcで開始/i });
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("リポジトリ情報が無い場合は表示する（誤って導線を消さない）", () => {
    render(
      <StartLocalSessionButton
        issue={makeIssue()}
        onIssueUpdated={vi.fn()}
        onFirstLaunch={onFirstLaunch}
        hasLocalStartScript={undefined}
      />,
    );

    expect(screen.getByRole("button", { name: /ローカルで開始/ })).not.toBeNull();
  });

  it("closeされたIssueでは表示しない（起動しても実装対象が無いため）", () => {
    const { container } = render(
      <StartLocalSessionButton
        issue={makeIssue({ state: "closed" })}
        onIssueUpdated={vi.fn()}
        onFirstLaunch={onFirstLaunch}
      />,
    );

    expect(container.firstChild).toBeNull();
  });

  it("URLを組み立てられないリポジトリ名では表示しない", () => {
    const { container } = render(
      <StartLocalSessionButton
        issue={makeIssue({ repositoryFullName: "guchi-apps/issue deck" })}
        onIssueUpdated={vi.fn()}
        onFirstLaunch={onFirstLaunch}
      />,
    );

    expect(container.firstChild).toBeNull();
  });

  it("押下すると11.localを付与してからissuedeck://へ遷移する", async () => {
    const location = stubLocation();
    const issue = makeIssue();
    const updated = makeIssue({ labels: [label("11.local")] });
    updateIssue.mockResolvedValue(updated);
    const onIssueUpdated = vi.fn();

    render(
      <StartLocalSessionButton
        issue={issue}
        onIssueUpdated={onIssueUpdated}
        onFirstLaunch={onFirstLaunch}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /ローカルで開始/ }));

    await waitFor(() => {
      expect(location.href).toBe("issuedeck://start/guchi-apps/issue-deck/1049");
    });
    expect(updateIssue).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      number: 1049,
      labels: ["11.local"],
    });
    expect(onIssueUpdated).toHaveBeenCalledWith(updated);
  });

  it("既に11.localが付いていればラベル更新はせず起動だけ行う", async () => {
    const location = stubLocation();

    render(
      <StartLocalSessionButton
        issue={makeIssue({ labels: [label("11.local"), label("50.feature")] })}
        onIssueUpdated={vi.fn()}
        onFirstLaunch={onFirstLaunch}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /ローカルで開始/ }));

    await waitFor(() => {
      expect(location.href).toBe("issuedeck://start/guchi-apps/issue-deck/1049");
    });
    expect(updateIssue).not.toHaveBeenCalled();
  });

  it("ラベル付与に失敗しても起動は妨げない", async () => {
    const location = stubLocation();
    updateIssue.mockResolvedValue(null);
    const onIssueUpdated = vi.fn();

    render(
      <StartLocalSessionButton
        issue={makeIssue()}
        onIssueUpdated={onIssueUpdated}
        onFirstLaunch={onFirstLaunch}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /ローカルで開始/ }));

    await waitFor(() => {
      expect(location.href).toBe("issuedeck://start/guchi-apps/issue-deck/1049");
    });
    expect(onIssueUpdated).not.toHaveBeenCalled();
  });

  // プロトコルが登録済みかはブラウザから検知できないため、初回だけこちらから見せる（#1088）
  it("初回の押下ではセットアップ手順の表示を要求する", async () => {
    stubLocation();

    render(
      <StartLocalSessionButton
        issue={makeIssue({ labels: [label("11.local")] })}
        onIssueUpdated={vi.fn()}
        onFirstLaunch={onFirstLaunch}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /ローカルで開始/ }));

    await waitFor(() => {
      expect(onFirstLaunch).toHaveBeenCalledTimes(1);
    });
  });

  it("2回目以降の押下ではセットアップ手順を要求しない", async () => {
    const location = stubLocation();

    render(
      <StartLocalSessionButton
        issue={makeIssue({ labels: [label("11.local")] })}
        onIssueUpdated={vi.fn()}
        onFirstLaunch={onFirstLaunch}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /ローカルで開始/ }));
    await waitFor(() => {
      expect(onFirstLaunch).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: /ローカルで開始/ }));
    await waitFor(() => {
      expect(location.href).toBe("issuedeck://start/guchi-apps/issue-deck/1049");
    });
    expect(onFirstLaunch).toHaveBeenCalledTimes(1);
  });

  // ここから起動先の選択（#1180）。Radixのメニューはjsdomでポインタ関連のAPIを要求するため、
  // 開く操作はpointerDownで行う（clickだけでは開かない）
  describe("起動先の選択（#1180）", () => {
    function openMenu() {
      fireEvent.pointerDown(screen.getByRole("button", { name: /ローカルで開始/ }), {
        button: 0,
        ctrlKey: false,
      });
    }

    function renderButton(issue = makeIssue({ labels: [label("11.local")] })) {
      render(
        <StartLocalSessionButton
          issue={issue}
          onIssueUpdated={vi.fn()}
          onFirstLaunch={onFirstLaunch}
        />,
      );
    }

    it("サブPCが申告していれば起動先のメニューになる", async () => {
      dispatchState = { hosts: [makeHost()], jobs: [], concurrency: 2, error: null };
      renderButton();
      openMenu();

      await waitFor(() => {
        expect(screen.getByRole("menuitem", { name: /このPC/ })).not.toBeNull();
      });
      expect(screen.getByRole("menuitem", { name: /subpc/ })).not.toBeNull();
    });

    it("サブPCを選ぶとジョブを積み、積めたら11.localを付ける", async () => {
      dispatchState = { hosts: [makeHost()], jobs: [], concurrency: 2, error: null };
      enqueue.mockResolvedValue(true);
      updateIssue.mockResolvedValue(makeIssue({ labels: [label("11.local")] }));
      renderButton(makeIssue());
      openMenu();

      fireEvent.click(await screen.findByRole("menuitem", { name: /subpc/ }));

      await waitFor(() => {
        expect(enqueue).toHaveBeenCalledWith({
          repositoryFullName: "guchi-apps/issue-deck",
          issueNumber: 1049,
          hostName: "subpc",
        });
      });
      await waitFor(() => {
        expect(updateIssue).toHaveBeenCalled();
      });
    });

    // 拒否されたのにラベルだけ残ると、無人実行（claude-issue-dispatch.yml）まで止まる
    it("積めなかった場合は11.localを付けない", async () => {
      dispatchState = { hosts: [makeHost()], jobs: [], concurrency: 2, error: null };
      enqueue.mockResolvedValue(false);
      renderButton(makeIssue());
      openMenu();

      fireEvent.click(await screen.findByRole("menuitem", { name: /subpc/ }));

      await waitFor(() => {
        expect(enqueue).toHaveBeenCalled();
      });
      expect(updateIssue).not.toHaveBeenCalled();
    });

    it("応答していないサブPCは選べない", async () => {
      dispatchState = {
        hosts: [makeHost({ online: false })],
        jobs: [],
        concurrency: 2,
        error: null,
      };
      renderButton();
      openMenu();

      const item = await screen.findByRole("menuitem", { name: /subpc/ });
      expect(item.getAttribute("data-disabled")).not.toBeNull();
      expect(item.textContent).toContain("応答していません");
    });

    it("サブPCで実行できないリポジトリは選べない", async () => {
      dispatchState = {
        hosts: [makeHost({ repositories: ["guchi-apps/other"] })],
        jobs: [],
        concurrency: 2,
        error: null,
      };
      renderButton();
      openMenu();

      const item = await screen.findByRole("menuitem", { name: /subpc/ });
      expect(item.getAttribute("data-disabled")).not.toBeNull();
    });

    it("積んだジョブの状態と取り消しを表示する", async () => {
      dispatchState = { hosts: [makeHost()], jobs: [makeJob()], concurrency: 2, error: null };
      cancel.mockResolvedValue(true);
      renderButton();

      expect(screen.getByText(/subpcで順番待ち/)).not.toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "取り消し" }));
      await waitFor(() => {
        expect(cancel).toHaveBeenCalledWith("job-1");
      });
    });

    // スマホからは`issuedeck://`を踏めない。押せる場所に置くこと自体が誤解になる
    describe("スマホの詳細画面（このPCを候補に入れない）", () => {
      function renderDispatchOnly() {
        render(
          <StartLocalSessionButton
            issue={makeIssue({ labels: [label("11.local")] })}
            onIssueUpdated={vi.fn()}
            onFirstLaunch={onFirstLaunch}
            includeLocalTarget={false}
            fullWidth
          />,
        );
      }

      it("サブPCの申告が無ければ導線ごと出さない", () => {
        dispatchState = { hosts: [], jobs: [], concurrency: 2, error: null };
        const { container } = render(
          <StartLocalSessionButton
            issue={makeIssue()}
            onIssueUpdated={vi.fn()}
            onFirstLaunch={onFirstLaunch}
            includeLocalTarget={false}
          />,
        );

        expect(container.firstChild).toBeNull();
      });

      // 選択肢が1つしか無いメニューを開かせない
      it("サブPCが1台ならメニューではなく単独のボタンにする", async () => {
        dispatchState = { hosts: [makeHost()], jobs: [], concurrency: 2, error: null };
        enqueue.mockResolvedValue(true);
        renderDispatchOnly();

        fireEvent.click(screen.getByRole("button", { name: /subpcで開始/ }));
        await waitFor(() => {
          expect(enqueue).toHaveBeenCalled();
        });
      });

      it("応答していないサブPCではボタンを押せず、理由を本文で出す", () => {
        dispatchState = {
          hosts: [makeHost({ online: false })],
          jobs: [],
          concurrency: 2,
          error: null,
        };
        renderDispatchOnly();

        expect(screen.getByRole("button", { name: /subpcで開始/ }).hasAttribute("disabled")).toBe(
          true,
        );
        expect(screen.getByText(/応答していません/)).not.toBeNull();
      });
    });

    it("失敗したジョブは理由を本文として出す（スマホではホバーできない）", () => {
      dispatchState = {
        hosts: [makeHost()],
        jobs: [
          makeJob({
            status: "FAILED",
            message: "start-issue.sh が見つかりません",
            finishedAt: "2026-08-14T00:05:00Z",
          }),
        ],
        concurrency: 2,
        error: null,
      };
      renderButton();

      expect(screen.getByText(/subpcで失敗/)).not.toBeNull();
      expect(screen.getByText("start-issue.sh が見つかりません")).not.toBeNull();
    });
  });
});
