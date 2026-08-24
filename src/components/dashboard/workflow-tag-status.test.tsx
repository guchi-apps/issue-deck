// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkflowTagStatusSection } from "@/components/dashboard/workflow-tag-status";
import type { PropagationRun, WorkflowTagStatus } from "@/lib/workflow-tags";

/**
 * 「共有ワークフローのバージョン」パネルの表示と、連続押下の防止（#1602）。
 *
 * 判定そのもののケースは`src/lib/workflow-tags.test.ts`にあり、ここでは
 * **画面がその判定どおりに押せなくなるか**だけを見る。
 */

function status(overrides: Partial<WorkflowTagStatus> = {}): WorkflowTagStatus {
  return {
    fullName: "guchi-apps/car-care",
    refs: [
      { file: "issue-labels.yml", uses: "workflows/v18", promptsRef: "workflows/v18" },
    ],
    outdated: true,
    mismatched: false,
    updatePullRequest: null,
    missingRepairWorkflows: [],
    repairPullRequest: null,
    outdatedSharedFiles: [],
    customizedSharedFiles: [],
    sharedFilePullRequest: null,
    ...overrides,
  };
}

function mockFetch(overview: {
  latest: string | null;
  repositories: WorkflowTagStatus[];
  propagation: PropagationRun | null;
  repairPropagation?: PropagationRun | null;
  sharedFilePropagation?: PropagationRun | null;
}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      // 不足しているcallerの配布（#1948・#1475）はタグ配布と別のエンドポイント・別の応答
      // 共有スクリプトの更新（#2240）も別のエンドポイント・別の応答
      if (String(input).includes("propagate-shared")) {
        return {
          ok: true,
          json: async () => ({
            dispatched: true,
            targets: [
              {
                repository: "guchi-apps/aide",
                files: [".github/scripts/signaly-notify.sh"],
              },
            ],
          }),
        } as Response;
      }
      if (String(input).includes("propagate-repair")) {
        return {
          ok: true,
          json: async () => ({
            dispatched: true,
            targets: [{ repository: "guchi-apps/aide", workflows: ["claude-ci-fix.yml"] }],
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          dispatched: true,
          tag: overview.latest,
          repositories: ["guchi-apps/car-care"],
        }),
      } as Response;
    }
    return {
      ok: true,
      json: async () => ({ repairPropagation: null, sharedFilePropagation: null, ...overview }),
    } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * リポジトリ名は`guchi-apps/`と本体で濃さを変えるため2つの要素に分かれており、
 * 既定の文字列マッチでは引けない（#1952。共通の行コンポーネントへ寄せた）。
 * 全体の文字列で引くための補助。
 */
function repositoryNameMatcher(fullName: string) {
  return (_: string, element: Element | null) =>
    element?.tagName === "SPAN" && element.textContent === fullName;
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => cleanup());

describe("WorkflowTagStatusSection", () => {
  it("未更新のリポジトリを v18 → v19 の形で出す", async () => {
    mockFetch({ latest: "workflows/v19", repositories: [status()], propagation: null });
    render(<WorkflowTagStatusSection open />);

    expect(await screen.findByText(repositoryNameMatcher("guchi-apps/car-care"))).toBeTruthy();
    expect(screen.getByText("v18")).toBeTruthy();
    expect(screen.getByText("更新が必要（1）")).toBeTruthy();
    expect(screen.getByRole("button", { name: /1件を v19 へ更新する/ })).toBeTruthy();
  });

  it("実行中は更新ボタンを押せない", async () => {
    // 起動は数秒で返るが、PRが出来上がるまでは数分かかる。画面を開き直しても効くよう、
    // 判定はGitHub側のrunで行う
    mockFetch({
      latest: "workflows/v19",
      repositories: [status()],
      propagation: {
        status: "in_progress",
        conclusion: null,
        htmlUrl: "https://github.com/guchi-apps/issue-deck/actions/runs/1",
        createdAt: "2026-08-15T10:00:00.000Z",
      },
    });
    render(<WorkflowTagStatusSection open />);

    const button = await screen.findByRole("button", { name: /更新を実行中/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("実行を見る")).toBeTruthy();
  });

  it("押した直後は、runが見える前でもボタンを無効のままにする", async () => {
    const fetchMock = mockFetch({
      latest: "workflows/v19",
      repositories: [status()],
      propagation: null,
    });
    render(<WorkflowTagStatusSection open />);

    fireEvent.click(await screen.findByRole("button", { name: /1件を v19 へ更新する/ }));

    await waitFor(() => {
      const button = screen.getByRole("button", { name: /更新を実行中/ });
      expect((button as HTMLButtonElement).disabled).toBe(true);
    });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true);
  });

  it("更新PRが既にあるリポジトリは対象から外し、PRへのリンクを出す", async () => {
    mockFetch({
      latest: "workflows/v19",
      repositories: [
        status({
          updatePullRequest: {
            number: 42,
            url: "https://github.com/guchi-apps/car-care/pull/42",
          },
        }),
      ],
      propagation: null,
    });
    render(<WorkflowTagStatusSection open />);

    expect(await screen.findByText("更新PRの確認待ち（1）")).toBeTruthy();
    expect(screen.getByText(/PR #42/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /へ更新する/ })).toBeNull();
  });

  it("すべて最新なら更新ボタンを出さず、一覧はたたむ", async () => {
    mockFetch({
      latest: "workflows/v19",
      repositories: [
        status({
          refs: [{ file: "issue-labels.yml", uses: "workflows/v19", promptsRef: "workflows/v19" }],
          outdated: false,
        }),
      ],
      propagation: null,
    });
    render(<WorkflowTagStatusSection open />);

    expect(await screen.findByText("最新（1）")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /へ更新する/ })).toBeNull();
    expect(screen.queryByText(repositoryNameMatcher("guchi-apps/car-care"))).toBeNull();
  });

  it("uses と prompts-ref の不一致は、結果と同じ段ではなく別の段へ出す（#1952）", async () => {
    // 長い文言を結果と同じ段に置くと、スマホ幅で画面の外へ出て読めなくなる
    mockFetch({
      latest: "workflows/v19",
      repositories: [
        status({
          refs: [{ file: "issue-labels.yml", uses: "workflows/v19", promptsRef: "workflows/v18" }],
          outdated: false,
          mismatched: true,
        }),
      ],
      propagation: null,
    });
    render(<WorkflowTagStatusSection open />);

    const detail = await screen.findByText("uses と prompts-ref が不一致");
    expect(detail.tagName).toBe("P");
    expect(detail.className).toContain("break-words");
  });

  it("自動マージのチェックを外すとその指定でPOSTする", async () => {
    const fetchMock = mockFetch({
      latest: "workflows/v19",
      repositories: [status()],
      propagation: null,
    });
    render(<WorkflowTagStatusSection open />);

    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /1件を v19 へ更新する/ }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
      expect(post?.[1]?.body).toBe(JSON.stringify({ autoMerge: false }));
    });
  });
});

describe("不足しているワークフローの配布（#1948・#1475）", () => {
  it("未配布のリポジトリと、何が不足しているかを出す", async () => {
    // callerが無いリポジトリでは、画面の「コンフリクトを自動解消」を押しても起動しない
    mockFetch({
      latest: "workflows/v19",
      repositories: [
        status({
          fullName: "guchi-apps/aide",
          outdated: false,
          refs: [{ file: "issue-labels.yml", uses: "workflows/v19", promptsRef: "workflows/v19" }],
          missingRepairWorkflows: [
            "claude-conflict-resolve.yml",
            "claude-ci-fix.yml",
            "claude-review-develop.yml",
          ],
        }),
      ],
      propagation: null,
    });
    render(<WorkflowTagStatusSection open />);

    expect(await screen.findByText("未配布（1）")).toBeTruthy();
    expect(screen.getByText(/develop向けPRのコンフリクト解消/)).toBeTruthy();
    // 自動修復以外（develop向けPRの自動マージ判定）も同じ一覧に出る（#1475）
    expect(screen.getByText(/develop向けPRの自動マージ判定/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /1件へ不足しているワークフローを配る/ }),
    ).toBeTruthy();
  });

  it("配布ボタンは専用のエンドポイントへPOSTする", async () => {
    const fetchMock = mockFetch({
      latest: "workflows/v19",
      repositories: [
        status({
          fullName: "guchi-apps/aide",
          outdated: false,
          refs: [{ file: "issue-labels.yml", uses: "workflows/v19", promptsRef: "workflows/v19" }],
          missingRepairWorkflows: ["claude-ci-fix.yml"],
        }),
      ],
      propagation: null,
    });
    render(<WorkflowTagStatusSection open />);

    fireEvent.click(
      await screen.findByRole("button", { name: /1件へ不足しているワークフローを配る/ }),
    );

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            init?.method === "POST" && String(input).includes("/api/workflow-tags/propagate-repair"),
        ),
      ).toBe(true);
    });
  });

  it("配布PRが既にあるリポジトリは対象から外し、PRへのリンクを出す", async () => {
    mockFetch({
      latest: "workflows/v19",
      repositories: [
        status({
          fullName: "guchi-apps/aide",
          outdated: false,
          refs: [{ file: "issue-labels.yml", uses: "workflows/v19", promptsRef: "workflows/v19" }],
          missingRepairWorkflows: ["claude-ci-fix.yml"],
          repairPullRequest: { number: 12, url: "https://github.com/guchi-apps/aide/pull/12" },
        }),
      ],
      propagation: null,
    });
    render(<WorkflowTagStatusSection open />);

    expect(await screen.findByText("配布PRの確認待ち（1）")).toBeTruthy();
    expect(screen.getByText(/PR #12/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /不足しているワークフローを配る/ })).toBeNull();
  });

  it("不足が無ければ欄自体を出さない", async () => {
    mockFetch({ latest: "workflows/v19", repositories: [status()], propagation: null });
    render(<WorkflowTagStatusSection open />);

    await screen.findByText(repositoryNameMatcher("guchi-apps/car-care"));
    expect(screen.queryByText("不足しているワークフロー")).toBeNull();
  });

  it("共有スクリプトが古いリポジトリと、独自の変更の目印を出す（#2240）", async () => {
    // 上書きで独自の変更が消えうるリポジトリは、押す前に見分けられる必要がある
    mockFetch({
      latest: "workflows/v19",
      repositories: [
        status({
          fullName: "guchi-apps/subpc",
          outdated: false,
          refs: [{ file: "issue-labels.yml", uses: "workflows/v19", promptsRef: "workflows/v19" }],
          outdatedSharedFiles: [".github/scripts/signaly-notify.sh"],
          customizedSharedFiles: [".github/scripts/signaly-notify.sh"],
        }),
      ],
      propagation: null,
    });
    render(<WorkflowTagStatusSection open />);

    expect(await screen.findByText("未更新（1）")).toBeTruthy();
    expect(screen.getByText(/Signaly通知スクリプト/)).toBeTruthy();
    expect(screen.getByText(/独自の変更あり/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /1件の共有スクリプトを更新する/ }),
    ).toBeTruthy();
  });

  it("共有スクリプトの更新ボタンは専用のエンドポイントへPOSTする", async () => {
    const fetchMock = mockFetch({
      latest: "workflows/v19",
      repositories: [
        status({
          fullName: "guchi-apps/aide",
          outdated: false,
          refs: [{ file: "issue-labels.yml", uses: "workflows/v19", promptsRef: "workflows/v19" }],
          outdatedSharedFiles: [".github/scripts/signaly-notify.sh"],
        }),
      ],
      propagation: null,
    });
    render(<WorkflowTagStatusSection open />);

    fireEvent.click(await screen.findByRole("button", { name: /1件の共有スクリプトを更新する/ }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            init?.method === "POST" && String(input).includes("/api/workflow-tags/propagate-shared"),
        ),
      ).toBe(true);
    });
  });

  it("共有スクリプトの更新PRが既にあるリポジトリは対象から外す", async () => {
    mockFetch({
      latest: "workflows/v19",
      repositories: [
        status({
          fullName: "guchi-apps/aide",
          outdated: false,
          refs: [{ file: "issue-labels.yml", uses: "workflows/v19", promptsRef: "workflows/v19" }],
          outdatedSharedFiles: [".github/scripts/signaly-notify.sh"],
          sharedFilePullRequest: { number: 33, url: "https://github.com/guchi-apps/aide/pull/33" },
        }),
      ],
      propagation: null,
    });
    render(<WorkflowTagStatusSection open />);

    expect(await screen.findByText("更新PRの確認待ち（1）")).toBeTruthy();
    expect(screen.getByText(/PR #33/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /共有スクリプトを更新する/ })).toBeNull();
  });

  it("共有スクリプトが最新なら欄自体を出さない", async () => {
    mockFetch({ latest: "workflows/v19", repositories: [status()], propagation: null });
    render(<WorkflowTagStatusSection open />);

    await screen.findByText(repositoryNameMatcher("guchi-apps/car-care"));
    expect(screen.queryByText("共有スクリプト")).toBeNull();
  });
});
