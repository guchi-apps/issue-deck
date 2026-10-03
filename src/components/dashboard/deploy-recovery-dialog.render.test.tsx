// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DeployRecoveryDialog } from "@/components/dashboard/deploy-recovery-dialog";

const candidate = {
  number: 42,
  title: "本番修正",
  url: "https://example.test/pull/42",
  mergedAt: "2026-10-03T00:00:00Z",
  mergeCommitSha: "abc",
};

describe("DeployRecoveryDialog（#3913）", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("候補を選び、復旧用PRを作成する", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [candidate], truncated: false }), { status: 200 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ url: "https://example.test/pull/99" }), { status: 200 }));
    render(<DeployRecoveryDialog repositoryFullName="guchi-apps/issue-deck" />);

    fireEvent.click(screen.getByRole("button", { name: "修正PRを選んで復旧" }));
    expect(await screen.findByText("#42")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /#42 本番修正を取り込む/ }));
    fireEvent.click(screen.getByRole("button", { name: "1件で復旧用PRを作成" }));

    await waitFor(() => expect(screen.getByText("復旧用PRを作成しました。", { exact: false })).toBeTruthy());
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/repositories/deploy-recovery",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("候補が無ければ選択できない", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [], truncated: false }), { status: 200 }));
    render(<DeployRecoveryDialog repositoryFullName="guchi-apps/issue-deck" />);

    fireEvent.click(screen.getByRole("button", { name: "修正PRを選んで復旧" }));
    expect(await screen.findByText(/取り込めるマージ済みPRがありません/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "0件で復旧用PRを作成" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("取得上限に達したときは候補が欠ける可能性を表示する", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [candidate], truncated: true }), { status: 200 }));
    render(<DeployRecoveryDialog repositoryFullName="guchi-apps/issue-deck" />);

    fireEvent.click(screen.getByRole("button", { name: "修正PRを選んで復旧" }));
    expect(await screen.findByText(/表示されない復旧候補がある可能性/)).toBeTruthy();
  });
});
