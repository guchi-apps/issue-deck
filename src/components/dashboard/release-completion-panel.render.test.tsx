// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReleaseCompletionPanel } from "@/components/dashboard/release-completion-panel";
import type { ReleaseCompletionRunView } from "@/lib/release-completion-run";

const base: ReleaseCompletionRunView = {
  id: "r1",
  repositoryFullName: "guchi-apps/issue-deck",
  status: "checking",
  statusLabel: "修正後のチェック中",
  stageIndex: 2,
  active: true,
  needsAction: false,
  scope: "until_production",
  releaseVersion: "8.56.0",
  originPrNumber: 4490,
  candidatePrNumber: 4497,
  candidateHeadSha: "8be41d0aaaa",
  candidateBaseSha: "3f9c2a1bbbb",
  candidatePrNumbers: [4490, 4492, 4497],
  fixes: [
    { issueNumber: 4493, fixPrNumber: 4494, generation: 1, status: "superseded" },
    { issueNumber: 4493, fixPrNumber: 4495, generation: 2, status: "reverifying" },
  ],
  costLimitUsd: 30,
  costUsedUsd: 8.4,
  mergeSha: null,
  mergedByRun: false,
  releaseRunUrl: null,
  completedAt: null,
  note: null,
  stopReason: null,
  stopMessage: null,
  deployRecovery: null,
  startedByUserId: "u1",
  expiresAt: "2026-10-13T05:02:00Z",
  createdAt: "2026-10-12T05:02:00Z",
  updatedAt: "2026-10-12T05:02:00Z",
};

function mockRun(run: Partial<ReleaseCompletionRunView> | null) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ run: run ? { ...base, ...run } : null }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const props = {
  repositoryFullName: "guchi-apps/issue-deck",
  pullRequestNumber: 4497,
  target: { baseSha: "3f9c2a1bbbb", headSha: "8be41d0aaaa" },
};

describe("ReleaseCompletionPanel（#4480）", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => cleanup());

  it("進行中は6段階の現在位置・世代・費用・残りを出し、停止を押せる", async () => {
    mockRun({});
    render(<ReleaseCompletionPanel {...props} canStart />);
    await waitFor(() => expect(screen.getByTestId("release-completion-run")).toBeTruthy());
    const current = screen.getByText("修正後のチェック中", { selector: "li" });
    expect(current.getAttribute("aria-current")).toBe("step");
    expect(screen.getByText(/世代 2\/3/)).toBeTruthy();
    expect(screen.getByText(/費用 \$8\.40 \/ \$30/)).toBeTruthy();
    expect(screen.getByTestId("release-completion-note").textContent).toContain("操作は不要です");
    expect(screen.getByRole("button", { name: "停止" })).toBeTruthy();
    // 進行中は開始ボタンを重ねて出さない
    expect(screen.queryByRole("button", { name: "リリース完了まで進める" })).toBeNull();
  });

  it("止まったときは操作が必要なことと理由を出す", async () => {
    mockRun({ status: "needs_attention", statusLabel: "操作が必要", stageIndex: -1, active: false, needsAction: true, stopReason: "base_changed", stopMessage: "mainが進んだため、検証済みの候補を自動で本番へマージしませんでした。" });
    render(<ReleaseCompletionPanel {...props} canStart />);
    await waitFor(() => expect(screen.getByText(/mainが進んだため/)).toBeTruthy());
    expect(screen.getByTestId("release-completion-status").textContent).toBe("操作が必要");
    expect(screen.queryByRole("button", { name: "停止" })).toBeNull();
  });

  it("本番承認待ちは人がマージすることを示す", async () => {
    mockRun({ status: "awaiting_approval", statusLabel: "本番承認待ち", needsAction: true, scope: "until_ready" });
    render(<ReleaseCompletionPanel {...props} canStart />);
    await waitFor(() => expect(screen.getByTestId("release-completion-note").textContent).toContain("本番へのマージは確認画面から人が行います"));
    expect(screen.getByTestId("release-completion-status").textContent).toBe("本番承認待ち");
  });

  it("系列が無く問題のある候補では開始でき、範囲を選んでサーバーへ送る", async () => {
    const fetchMock = mockRun(null);
    render(<ReleaseCompletionPanel {...props} canStart />);
    const button = await screen.findByRole("button", { name: "リリース完了まで進める" });
    fireEvent.click(button);
    expect(await screen.findByTestId("release-completion-dialog")).toBeTruthy();
    expect((screen.getByRole("button", { name: "開始する" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText(/本番反映・稼働確認まで/) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByLabelText(/チェック通過まで/));
    fireEvent.click(screen.getByRole("button", { name: "開始する" }));
    const isPost = (call: unknown) => ((call as unknown[])[1] as RequestInit | undefined)?.method === "POST";
    await waitFor(() => expect(fetchMock.mock.calls.some(isPost)).toBe(true));
    const post = fetchMock.mock.calls.find(isPost) as unknown as [string, RequestInit];
    expect(JSON.parse(String(post[1].body))).toMatchObject({ pullRequestNumber: 4497, scope: "until_ready", headSha: "8be41d0aaaa" });
  });

  it("問題の無い候補（開始できない）で系列も無ければ何も出さない", async () => {
    mockRun(null);
    const { container } = render(<ReleaseCompletionPanel {...props} canStart={false} />);
    await waitFor(() => expect(container.innerHTML).toBe(""));
  });
});
