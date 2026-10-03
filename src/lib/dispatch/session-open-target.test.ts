import { describe, expect, it } from "vitest";

import {
  buildCodexResumeCommand,
  buildCodexThreadUrl,
  buildSessionOpenTarget,
} from "@/lib/dispatch/session-open-target";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";

function session(overrides: Partial<DispatchSessionView> = {}): DispatchSessionView {
  return {
    host: "subpc",
    tmuxSessionName: "issue-deck-issue-3885",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 3885,
    state: "ALIVE",
    remoteControlUrl: "https://claude.ai/code/session_01ABC",
    codexThreadKnown: null,
    ...overrides,
  } as DispatchSessionView;
}

describe("セッションを開く行き先", () => {
  it("Claude Codeの既存Remote Control URLを保つ", () => {
    expect(buildSessionOpenTarget(session())).toEqual({
      kind: "claude",
      url: "https://claude.ai/code/session_01ABC",
      label: "Claude Codeアプリで開く",
    });
  });

  it("Codexは検証済みUUIDからだけDeep Linkと再開コマンドを作る", () => {
    const threadId = "a0b1c2d3-1234-4abc-9def-0123456789ab";
    expect(buildCodexThreadUrl(threadId)).toBe(`codex://threads/${threadId}`);
    expect(buildCodexResumeCommand(threadId)).toBe(`codex resume ${threadId}`);
    expect(
      buildSessionOpenTarget(session({ codexThreadKnown: true, codexThreadId: threadId })),
    ).toEqual({ kind: "codex", url: `codex://threads/${threadId}`, label: "Codexで開く", threadId, host: "subpc" });
  });

  it("UUID未取得または不正ならCodexのリンクを作らない", () => {
    expect(buildSessionOpenTarget(session({ codexThreadKnown: false }))).toBeNull();
    expect(buildCodexThreadUrl("https://example.com")).toBeNull();
  });
});
