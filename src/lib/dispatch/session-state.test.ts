import { describe, expect, it } from "vitest";

import {
  nextEscalatedState,
  parseDispatchSessionActivity,
  parseDispatchSessionReport,
  parseRemoteControlUrl,
  parseSessionName,
  resolveRepositoryFullName,
  resolveSessionState,
  shouldEscalateSession,
} from "./session-state";

describe("parseSessionName", () => {
  it("<リポジトリ名>-issue-<番号> を分解する", () => {
    expect(parseSessionName("issue-deck-issue-1217")).toEqual({
      repoName: "issue-deck",
      issueNumber: 1217,
    });
  });

  it("リポジトリ名側に -issue- を含んでいても、末尾の区切りで分解する", () => {
    // `foo-issue-tracker` のようなリポジトリ名があると区切りが複数現れる。
    // 先頭から探すと `foo` と `tracker-issue-12` に割れて番号が取れない。
    expect(parseSessionName("foo-issue-tracker-issue-12")).toEqual({
      repoName: "foo-issue-tracker",
      issueNumber: 12,
    });
  });

  it("Issueに紐づかない名前はnullを返す", () => {
    expect(parseSessionName("scratch")).toBeNull();
    expect(parseSessionName("issue-deck-issue-")).toBeNull();
    expect(parseSessionName("-issue-12")).toBeNull();
  });

  it("0始まり・0・負数の番号は受け付けない", () => {
    expect(parseSessionName("issue-deck-issue-0")).toBeNull();
    expect(parseSessionName("issue-deck-issue-012")).toBeNull();
    expect(parseSessionName("issue-deck-issue--3")).toBeNull();
  });
});

describe("resolveRepositoryFullName", () => {
  const candidates = ["guchi-apps/issue-deck", "guchi-apps/dayspan"];

  it("リポジトリ名から owner/repo を復元する", () => {
    expect(resolveRepositoryFullName("issue-deck", candidates)).toBe("guchi-apps/issue-deck");
  });

  it("候補に無ければnull", () => {
    expect(resolveRepositoryFullName("shopping-list", candidates)).toBeNull();
  });

  it("別ownerに同名がある場合はnull（無関係なIssueへ投稿しないため）", () => {
    expect(
      resolveRepositoryFullName("issue-deck", ["guchi-apps/issue-deck", "someone/issue-deck"]),
    ).toBeNull();
  });

  it("同じ値が重複していても1件として扱う", () => {
    expect(
      resolveRepositoryFullName("issue-deck", ["guchi-apps/issue-deck", "guchi-apps/issue-deck"]),
    ).toBe("guchi-apps/issue-deck");
  });

  it("owner/repo の形をしていない候補は無視する", () => {
    expect(resolveRepositoryFullName("issue-deck", ["issue-deck", "guchi-apps/issue-deck"])).toBe(
      "guchi-apps/issue-deck",
    );
  });
});

describe("resolveSessionState", () => {
  it("生きているペインはALIVE", () => {
    expect(resolveSessionState({ paneDead: false, paneDeadStatus: null })).toBe("ALIVE");
  });

  it("終了コード0で残っているペインはEXITED", () => {
    // tmux 3.2未満では `remain-on-exit on` へ落ちるため、**正常終了でもペインが残る**。
    // ここをFAILEDにすると、正常に終わるたびに 00.check-user が付く。
    expect(resolveSessionState({ paneDead: true, paneDeadStatus: 0 })).toBe("EXITED");
  });

  it("終了コードが非0ならFAILED", () => {
    expect(resolveSessionState({ paneDead: true, paneDeadStatus: 3 })).toBe("FAILED");
    expect(resolveSessionState({ paneDead: true, paneDeadStatus: 137 })).toBe("FAILED");
  });

  it("終了コードが取れないときは鳴らさない側（EXITED）へ倒す", () => {
    expect(resolveSessionState({ paneDead: true, paneDeadStatus: null })).toBe("EXITED");
  });
});

describe("shouldEscalateSession", () => {
  it("FAILEDへ遷移した時だけ引き上げる", () => {
    expect(shouldEscalateSession(null, "FAILED")).toBe(true);
  });

  it("FAILEDが続く間は引き上げない（毎分コメントが増えないように）", () => {
    expect(shouldEscalateSession("FAILED", "FAILED")).toBe(false);
  });

  it("FAILED以外へは引き上げない", () => {
    expect(shouldEscalateSession(null, "ALIVE")).toBe(false);
    expect(shouldEscalateSession(null, "EXITED")).toBe(false);
    // 消失は人が作業を終えて畳んだ場合と区別が付かないため引き上げない
    expect(shouldEscalateSession(null, "GONE")).toBe(false);
  });
});

describe("nextEscalatedState", () => {
  it("引き上げたらその状態を覚える", () => {
    expect(nextEscalatedState(null, "FAILED", true)).toBe("FAILED");
  });

  it("FAILEDが続く間は覚えたままにする", () => {
    expect(nextEscalatedState("FAILED", "FAILED", false)).toBe("FAILED");
  });

  it("FAILED以外へ移ったらクリアする（復帰後の再発を拾えるように）", () => {
    expect(nextEscalatedState("FAILED", "ALIVE", false)).toBeNull();
    expect(nextEscalatedState("FAILED", "GONE", false)).toBeNull();
  });

  it("FAILED → ALIVE → FAILED では2回目も引き上げる", () => {
    let escalated = nextEscalatedState(null, "FAILED", shouldEscalateSession(null, "FAILED"));
    expect(escalated).toBe("FAILED");

    escalated = nextEscalatedState(escalated, "ALIVE", shouldEscalateSession(escalated, "ALIVE"));
    expect(escalated).toBeNull();

    expect(shouldEscalateSession(escalated, "FAILED")).toBe(true);
  });
});

describe("parseDispatchSessionReport", () => {
  const valid = {
    tmuxSessionName: "issue-deck-issue-1217",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 1217,
    paneDead: false,
    paneDeadStatus: null,
  };

  it("妥当な報告を受け付ける", () => {
    expect(parseDispatchSessionReport(valid)).toEqual(valid);
  });

  it("paneDeadStatusは省略できる", () => {
    const { paneDeadStatus: _omitted, ...withoutStatus } = valid;
    expect(parseDispatchSessionReport(withoutStatus)).toEqual(valid);
  });

  it("owner/repo の形でないリポジトリ名は弾く", () => {
    expect(parseDispatchSessionReport({ ...valid, repositoryFullName: "issue-deck" })).toBeNull();
    expect(
      parseDispatchSessionReport({ ...valid, repositoryFullName: "../../etc/passwd" }),
    ).toBeNull();
  });

  it("Issue番号が正の整数でなければ弾く", () => {
    expect(parseDispatchSessionReport({ ...valid, issueNumber: 0 })).toBeNull();
    expect(parseDispatchSessionReport({ ...valid, issueNumber: -1 })).toBeNull();
    expect(parseDispatchSessionReport({ ...valid, issueNumber: 1.5 })).toBeNull();
    expect(parseDispatchSessionReport({ ...valid, issueNumber: "1217" })).toBeNull();
  });

  it("空のセッション名・長すぎるセッション名を弾く", () => {
    expect(parseDispatchSessionReport({ ...valid, tmuxSessionName: "" })).toBeNull();
    expect(
      parseDispatchSessionReport({ ...valid, tmuxSessionName: "a".repeat(192) }),
    ).toBeNull();
  });

  it("paneDeadが真偽値でなければ弾く", () => {
    expect(parseDispatchSessionReport({ ...valid, paneDead: "true" })).toBeNull();
  });

  it("paneDeadStatusが整数でなければ弾く", () => {
    expect(parseDispatchSessionReport({ ...valid, paneDeadStatus: "3" })).toBeNull();
    expect(parseDispatchSessionReport({ ...valid, paneDeadStatus: 1.5 })).toBeNull();
  });

  it("オブジェクト以外を弾く", () => {
    expect(parseDispatchSessionReport(null)).toBeNull();
    expect(parseDispatchSessionReport("x")).toBeNull();
    expect(parseDispatchSessionReport([])).toBeNull();
  });
});

describe("parseDispatchSessionActivity", () => {
  it("フックのイベント名を内部の表現へ写す", () => {
    expect(parseDispatchSessionActivity("waiting_input")).toBe("WAITING_INPUT");
    expect(parseDispatchSessionActivity("responded")).toBe("RESPONDED");
  });

  it("知らない値はnull（受け口が黙って別の状態にしない）", () => {
    expect(parseDispatchSessionActivity("stalled")).toBeNull();
    expect(parseDispatchSessionActivity("")).toBeNull();
    expect(parseDispatchSessionActivity(undefined)).toBeNull();
    expect(parseDispatchSessionActivity(123)).toBeNull();
  });
});

describe("parseRemoteControlUrl", () => {
  it("claude.aiのhttps URLだけを通す", () => {
    expect(parseRemoteControlUrl("https://claude.ai/code/session%5F01ABC")).toBe(
      "https://claude.ai/code/session%5F01ABC",
    );
  });

  it.each([
    ["別ホスト", "https://example.com/code/x"],
    ["サブドメイン偽装", "https://claude.ai.example.com/code/x"],
    ["http", "http://claude.ai/code/x"],
    ["javascript:", "javascript:alert(1)"],
    ["URLでない", "not a url"],
    ["空文字", ""],
  ])("%sは受け付けない（画面にリンクとして出すため）", (_name, input) => {
    expect(parseRemoteControlUrl(input)).toBeNull();
  });

  it("長すぎる値は受け付けない", () => {
    expect(parseRemoteControlUrl(`https://claude.ai/${"a".repeat(600)}`)).toBeNull();
  });
});
