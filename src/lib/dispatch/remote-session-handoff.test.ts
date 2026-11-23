import { afterEach, describe, expect, it } from "vitest";
import {
  clearRemoteSessionHandoff,
  peekRemoteSessionHandoff,
  REMOTE_SESSION_HANDOFF_TTL_MS,
  setRemoteSessionHandoff,
} from "./remote-session-handoff";

afterEach(() => clearRemoteSessionHandoff());

describe("リモートセッションへの転記の受け渡し（#5628）", () => {
  it("同じリポジトリ宛てなら何度でも読める", () => {
    setRemoteSessionHandoff("o/r", "質問", 0);
    expect(peekRemoteSessionHandoff("o/r", 1)).toBe("質問");
    expect(peekRemoteSessionHandoff("o/r", 2)).toBe("質問");
  });

  it("別リポジトリ・指定なしでは読めない", () => {
    setRemoteSessionHandoff("o/r", "質問", 0);
    expect(peekRemoteSessionHandoff("o/other", 1)).toBeNull();
    expect(peekRemoteSessionHandoff(null, 1)).toBeNull();
  });

  it("期限を過ぎると読めず破棄される", () => {
    setRemoteSessionHandoff("o/r", "質問", 0);
    expect(peekRemoteSessionHandoff("o/r", REMOTE_SESSION_HANDOFF_TTL_MS + 1)).toBeNull();
    expect(peekRemoteSessionHandoff("o/r", 1)).toBeNull();
  });

  it("破棄すると読めない", () => {
    setRemoteSessionHandoff("o/r", "質問", 0);
    clearRemoteSessionHandoff();
    expect(peekRemoteSessionHandoff("o/r", 1)).toBeNull();
  });
});
