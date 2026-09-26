// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionHandoffButton } from "@/components/dashboard/session-handoff-dialog";
import type { DispatchStateHandle } from "@/hooks/use-dispatch-state";
import type { DispatchHostView } from "@/lib/dispatch/dispatch-job";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";
import type { Issue } from "@/types/issue";

const createComment = vi.fn();
vi.mock("@/hooks/use-issue-comment-mutations", () => ({
  useIssueCommentMutations: () => ({ createComment, isSubmitting: false, error: null }),
}));

// 枠の取得は画面ごとに差し替える（探りリクエストを実際に送らない）
let claudeWindows: unknown[] | undefined;
let codexWindows: unknown[] | undefined;
vi.mock("@/hooks/use-claude-usage", () => ({
  useClaudeUsage: () => ({
    data: claudeWindows ? { windows: claudeWindows } : null,
    isLoading: false,
    error: null,
    notConfigured: false,
  }),
}));
vi.mock("@/hooks/use-codex-usage", () => ({
  useCodexUsage: () => ({
    data: codexWindows ? { windows: codexWindows } : null,
    isLoading: false,
    error: null,
    notConfigured: false,
  }),
}));

const enqueue = vi.fn();

function makeHost(overrides: Partial<DispatchHostView> = {}): DispatchHostView {
  return {
    name: "subpc",
    repositories: ["guchi-apps/issue-deck"],
    contractVersion: 2,
    online: true,
    lastSeenAt: "2026-09-26T00:00:00Z",
    codexCapable: true,
    ...overrides,
  } as DispatchHostView;
}

function makeSession(overrides: Partial<DispatchSessionView> = {}): DispatchSessionView {
  return {
    host: "subpc",
    tmuxSessionName: "issue-deck-issue-3496",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 3496,
    state: "ALIVE",
    codexThreadKnown: null,
    models: [],
    ...overrides,
  } as DispatchSessionView;
}

function makeIssue(): Issue {
  return {
    id: "1",
    number: 3496,
    title: "AIモデル切り替え機能の実装",
    repositoryFullName: "guchi-apps/issue-deck",
    labels: [],
  } as unknown as Issue;
}

function makeDispatch(overrides: Partial<DispatchStateHandle> = {}): DispatchStateHandle {
  return {
    hosts: [makeHost()],
    jobs: [],
    sessions: [],
    error: null,
    isSubmitting: false,
    agentPause: { claude: null, codex: null },
    enqueue,
    ...overrides,
  } as unknown as DispatchStateHandle;
}

function renderButton({
  session = makeSession(),
  dispatch = makeDispatch(),
}: { session?: DispatchSessionView; dispatch?: DispatchStateHandle } = {}) {
  const onCommentCreated = vi.fn();
  render(
    <SessionHandoffButton
      issue={makeIssue()}
      session={session}
      dispatch={dispatch}
      comments={[]}
      // 「おまかせ」以外にしておく（判定APIを呼ばせない）
      claudeLocalModel="sonnet"
      codexModel="gpt-5.6-terra"
      onCommentCreated={onCommentCreated}
    />,
  );
  return { onCommentCreated };
}

function open() {
  fireEvent.click(screen.getByRole("button", { name: /別のAIで続ける/ }));
}

beforeEach(() => {
  claudeWindows = undefined;
  codexWindows = undefined;
  enqueue.mockResolvedValue(true);
  createComment.mockResolvedValue({ id: 1, body: "記録" });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SessionHandoffButton", () => {
  it("Claudeのセッションから開くと、引き継ぎ先はCodex CLIが最初に選ばれている", () => {
    renderButton();
    open();
    expect(screen.getByRole("radio", { name: /Codex CLI/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByRole("radio", { name: /Claude Code/ }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("Codexのセッションから開くと、Claude Codeが最初に選ばれている", () => {
    renderButton({ session: makeSession({ codexThreadKnown: true }) });
    open();
    expect(screen.getByRole("radio", { name: /Claude Code/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("「引き継いで開始」で、引き継ぎ元とモデルを付けてジョブを積み、記録をIssueへ残す", async () => {
    const { onCommentCreated } = renderButton();
    open();
    fireEvent.click(screen.getByRole("button", { name: "引き継いで開始" }));

    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(enqueue).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 3496,
      hostName: "subpc",
      agent: "codex",
      model: "gpt-5.6-terra",
      handoffFrom: "claude",
      handoffTranscript: false,
    });
    await waitFor(() => expect(createComment).toHaveBeenCalledTimes(1));
    expect(createComment.mock.calls[0][0].body).toContain("Claude Code → Codex CLI");
    await waitFor(() => expect(onCommentCreated).toHaveBeenCalledTimes(1));
  });

  it("転記の添付を選ぶと、handoffTranscriptがtrueで積まれる", async () => {
    renderButton();
    open();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "引き継いで開始" }));
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(enqueue.mock.calls[0][0].handoffTranscript).toBe(true);
  });

  it("積むのに失敗したら、記録を投稿しない", async () => {
    enqueue.mockResolvedValue(false);
    renderButton();
    open();
    fireEvent.click(screen.getByRole("button", { name: "引き継いで開始" }));
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(createComment).not.toHaveBeenCalled();
  });

  it("元のエージェントの枠を使い切っていると、その旨と戻る時刻を出し、そのチップは選べない", () => {
    claudeWindows = [
      {
        label: "5時間",
        usedPercent: 100,
        remainingPercent: 0,
        resetsAt: Math.floor(Date.now() / 1000) + 2 * 3600,
        status: "rejected",
      },
    ];
    renderButton();
    open();
    expect(screen.getByText(/Claude Codeの枠を使い切っています/)).toBeTruthy();
    expect(screen.getByText(/でリセット/)).toBeTruthy();
    expect((screen.getByRole("radio", { name: /Claude Code/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("引き継ぎ先の枠を使い切っているときは開始を押せない", () => {
    codexWindows = [
      {
        label: "5時間",
        usedPercent: 100,
        remainingPercent: 0,
        resetsAt: Math.floor(Date.now() / 1000) + 3600,
        status: null,
        expired: false,
      },
    ];
    renderButton();
    open();
    expect(screen.getByText(/Codex CLIの枠を使い切っているため/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "引き継いで開始" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("引き継ぎ先のエージェントの新規実行が一時停止中なら、理由を出して開始を押せない", () => {
    renderButton({
      dispatch: makeDispatch({ agentPause: { claude: null, codex: "manual" } }),
    });
    open();
    expect((screen.getByRole("button", { name: "引き継いで開始" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("Codexへの起動に対応していないホストでは、理由を出して開始を押せない", () => {
    renderButton({ dispatch: makeDispatch({ hosts: [makeHost({ codexCapable: null })] }) });
    open();
    expect(screen.getByText(/Codex CLIでの起動に対応していません/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "引き継いで開始" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
