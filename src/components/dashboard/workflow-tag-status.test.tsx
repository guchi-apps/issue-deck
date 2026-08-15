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
    ...overrides,
  };
}

function mockFetch(overview: {
  latest: string | null;
  repositories: WorkflowTagStatus[];
  propagation: PropagationRun | null;
}) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      return {
        ok: true,
        json: async () => ({
          dispatched: true,
          tag: overview.latest,
          repositories: ["guchi-apps/car-care"],
        }),
      } as Response;
    }
    return { ok: true, json: async () => overview } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => cleanup());

describe("WorkflowTagStatusSection", () => {
  it("未更新のリポジトリを v18 → v19 の形で出す", async () => {
    mockFetch({ latest: "workflows/v19", repositories: [status()], propagation: null });
    render(<WorkflowTagStatusSection open />);

    expect(await screen.findByText("guchi-apps/car-care")).toBeTruthy();
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
    expect(screen.queryByText("guchi-apps/car-care")).toBeNull();
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
