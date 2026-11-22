import { describe, expect, it } from "vitest";

import { buildSessionTerminalCommands } from "@/lib/dispatch/session-terminal-command";

describe("buildSessionTerminalCommands", () => {
  it("ホスト上で直接実行するコマンドとSSH経由のコマンドを返す", () => {
    expect(buildSessionTerminalCommands({ hostName: "macmini", tmuxSessionName: "aide-issue-888" })).toEqual({
      onHost: "tmux attach -t aide-issue-888",
      viaSsh: `ssh -t macmini 'exec "$SHELL" -lc "tmux attach -t aide-issue-888"'`,
    });
  });

  it("シェルに解釈される文字や空白を含む名前では組み立てない", () => {
    for (const bad of ["a b", "a;rm -rf /", "$(id)", "a'b", "-x", ""]) {
      expect(buildSessionTerminalCommands({ hostName: "subpc", tmuxSessionName: bad })).toBeNull();
      expect(buildSessionTerminalCommands({ hostName: bad, tmuxSessionName: "issue-deck-issue-1" })).toBeNull();
    }
  });
});
