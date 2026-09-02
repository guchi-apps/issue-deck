import { describe, expect, it } from "vitest";

import {
  isRevivedSession,
  nextEscalatedState,
  parseDispatchSessionActivity,
  parseDispatchSessionName,
  parseDispatchSessionReport,
  parsePreviewUrl,
  parseRemoteControlUrl,
  parseSessionName,
  resolveRepositoryFullName,
  resolveSessionState,
  resolveStartingActivityTransition,
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

describe("parseDispatchSessionName", () => {
  it("そのままの名前を受け付ける", () => {
    expect(parseDispatchSessionName("issue-deck-issue-1321")).toBe("issue-deck-issue-1321");
  });

  it("文字列でなければnull", () => {
    expect(parseDispatchSessionName(1321)).toBeNull();
    expect(parseDispatchSessionName(null)).toBeNull();
    expect(parseDispatchSessionName(undefined)).toBeNull();
  });

  it("空文字とDBの列の上限を超える長さは受け付けない", () => {
    expect(parseDispatchSessionName("")).toBeNull();
    expect(parseDispatchSessionName("a".repeat(191))).toBe("a".repeat(191));
    expect(parseDispatchSessionName("a".repeat(192))).toBeNull();
  });

  // 形は見ない。照合キーにしか使わず、一致しなければ何も起きない
  it("ランチャーが付ける形以外も通す", () => {
    expect(parseDispatchSessionName("手で立てたセッション")).toBe("手で立てたセッション");
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

  // Remote ControlのURL（#2771）。pollerが引けた巡だけ載り、それ以外は既存の値を触らない
  it("remoteControlUrlはclaude.ai配下だけ受け、読めない値は項目ごと落とす", () => {
    expect(
      parseDispatchSessionReport({ ...valid, remoteControlUrl: "https://claude.ai/code/session_1" }),
    ).toEqual({ ...valid, remoteControlUrl: "https://claude.ai/code/session_1" });
    expect(parseDispatchSessionReport({ ...valid, remoteControlUrl: "https://example.com/x" })).toEqual(
      valid,
    );
    expect(parseDispatchSessionReport({ ...valid, remoteControlUrl: "" })).toEqual(valid);
    expect(parseDispatchSessionReport({ ...valid, remoteControlUrl: null })).toEqual(valid);
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

  /**
   * #1465。`claudeStarting`は新しいpollerだけが送る。**項目が無いことと`false`は別物**で、
   * 無い場合に`false`を埋めると、判断材料を持っていない古いホストの報告が
   * `NOT_STARTED`を解いてしまう。
   */
  it("claudeStartingは省略できる（項目そのものを増やさない）", () => {
    const parsed = parseDispatchSessionReport(valid);
    expect(parsed).not.toBeNull();
    expect(parsed && "claudeStarting" in parsed).toBe(false);
  });

  it("claudeStartingの真偽値をそのまま受け取る", () => {
    expect(parseDispatchSessionReport({ ...valid, claudeStarting: true })).toEqual({
      ...valid,
      claudeStarting: true,
    });
    expect(parseDispatchSessionReport({ ...valid, claudeStarting: false })).toEqual({
      ...valid,
      claudeStarting: false,
    });
  });

  it("claudeStartingが真偽値でなければ弾く", () => {
    expect(parseDispatchSessionReport({ ...valid, claudeStarting: "true" })).toBeNull();
    expect(parseDispatchSessionReport({ ...valid, claudeStarting: 1 })).toBeNull();
  });

  /**
   * #2519。Codexのセッションの宛先は3値（null＝Codexではない／false＝宛先がまだ無い／
   * true＝送れる）。**`null`と「項目が無い」を分ける**——無いのは古いpollerで、そのホストに
   * ついては何も判断できないため既存の値を触らない。
   */
  it("codexThreadKnownは3値をそのまま受け取り、省略もできる", () => {
    const parsed = parseDispatchSessionReport(valid);
    expect(parsed && "codexThreadKnown" in parsed).toBe(false);
    for (const value of [true, false, null]) {
      expect(parseDispatchSessionReport({ ...valid, codexThreadKnown: value })).toEqual({
        ...valid,
        codexThreadKnown: value,
      });
    }
  });

  // 壊れていても報告ごと弾かない（1件で弾くと、そのホストのセッションが全部「消えた」になる）
  it("codexThreadKnownが真偽値でもnullでもなければ、その項目だけを落とす", () => {
    expect(parseDispatchSessionReport({ ...valid, codexThreadKnown: "true" })).toEqual(valid);
  });

  /**
   * #1817。畳む予定は`claudeStarting`と同じく新しいpollerだけが送る。**壊れていても報告ごと
   * 弾かない**（1件でも弾くと、そのホストのセッションが全部「消えた」と判定される）。
   */
  it("畳む予定を受け取る", () => {
    expect(
      parseDispatchSessionReport({
        ...valid,
        reapAt: "2026-08-16T12:03:00Z",
        reapReason: "PR_MERGED",
      }),
    ).toEqual({ ...valid, reapAt: "2026-08-16T12:03:00.000Z", reapReason: "PR_MERGED" });
  });

  it("畳む予定は省略できる（古いpollerでは項目そのものを増やさない）", () => {
    const parsed = parseDispatchSessionReport(valid);
    expect(parsed && "reapAt" in parsed).toBe(false);
  });

  it("予定が無いことの報告（null）はそのまま受け取る", () => {
    expect(
      parseDispatchSessionReport({ ...valid, reapAt: null, reapReason: null }),
    ).toEqual({ ...valid, reapAt: null, reapReason: null });
  });

  it("知らない理由コード・壊れた時刻は、その項目だけを落として報告は通す", () => {
    expect(
      parseDispatchSessionReport({ ...valid, reapAt: "2026-08-16T12:03:00Z", reapReason: "WAT" }),
    ).toEqual({ ...valid, reapAt: null, reapReason: null });
    expect(
      parseDispatchSessionReport({ ...valid, reapAt: "まもなく", reapReason: "PR_MERGED" }),
    ).toEqual({ ...valid, reapAt: null, reapReason: null });
  });

  it("時刻と理由が揃っていなければ両方落とす（理由の無い終了予告を画面へ出さない）", () => {
    expect(parseDispatchSessionReport({ ...valid, reapAt: "2026-08-16T12:03:00Z" })).toEqual({
      ...valid,
      reapAt: null,
      reapReason: null,
    });
  });

  /**
   * #2705。いま何をしているかも`reapAt`と同じ向きで扱う——新しいpollerだけが送り、壊れていても
   * その項目だけを落として報告は通す。
   */
  it("ステップを受け取る", () => {
    expect(
      parseDispatchSessionReport({
        ...valid,
        step: "LINTING",
        stepAt: "2026-08-16T12:03:00Z",
        stepSeenAt: "2026-08-16T12:04:00Z",
      }),
    ).toEqual({
      ...valid,
      step: "LINTING",
      stepAt: "2026-08-16T12:03:00.000Z",
      stepSeenAt: "2026-08-16T12:04:00.000Z",
    });
  });

  it("ステップは省略できる（古いpollerでは項目そのものを増やさない）", () => {
    const parsed = parseDispatchSessionReport(valid);
    expect(parsed && "step" in parsed).toBe(false);
  });

  it("知らないステップ・欠けた時刻は、その項目だけを落として報告は通す", () => {
    for (const broken of [
      { step: "REFACTORING", stepAt: "2026-08-16T12:03:00Z", stepSeenAt: "2026-08-16T12:04:00Z" },
      { step: "LINTING", stepAt: "さっき", stepSeenAt: "2026-08-16T12:04:00Z" },
      { step: "LINTING", stepAt: "2026-08-16T12:03:00Z" },
    ]) {
      expect(parseDispatchSessionReport({ ...valid, ...broken })).toEqual({
        ...valid,
        step: null,
        stepAt: null,
        stepSeenAt: null,
      });
    }
  });
});

/**
 * #1465。フォルダの信頼確認で止まっている間はフックが1つも飛ばないため、pollerが持ち込む
 * `claudeStarting`だけが判断材料になる。
 */
describe("resolveStartingActivityTransition", () => {
  const base = {
    state: "ALIVE" as const,
    previousActivity: null,
    claudeStarting: undefined as boolean | undefined,
  };

  it("報告が無ければ触らない（古いpoller・古いランチャー）", () => {
    expect(resolveStartingActivityTransition(base)).toBe("none");
    expect(
      resolveStartingActivityTransition({ ...base, previousActivity: "NOT_STARTED" }),
    ).toBe("none");
  });

  it("止まっていればNOT_STARTEDへ入る", () => {
    expect(resolveStartingActivityTransition({ ...base, claudeStarting: true })).toBe("enter");
  });

  it("同じ報告が続く間は入り直さない（毎分コメントが増えないように）", () => {
    expect(
      resolveStartingActivityTransition({
        ...base,
        claudeStarting: true,
        previousActivity: "NOT_STARTED",
      }),
    ).toBe("none");
  });

  it("フックが飛んでいる行は上書きしない（Claude Codeは既に始まっている）", () => {
    expect(
      resolveStartingActivityTransition({
        ...base,
        claudeStarting: true,
        previousActivity: "WAITING_INPUT",
      }),
    ).toBe("none");
  });

  it("人が答えて始まればNOT_STARTEDから出る", () => {
    expect(
      resolveStartingActivityTransition({
        ...base,
        claudeStarting: false,
        previousActivity: "NOT_STARTED",
      }),
    ).toBe("leave");
  });

  it("元からNOT_STARTEDでなければ、止まっていない報告では何もしない", () => {
    expect(
      resolveStartingActivityTransition({
        ...base,
        claudeStarting: false,
        previousActivity: "WORKING",
      }),
    ).toBe("none");
    expect(resolveStartingActivityTransition({ ...base, claudeStarting: false })).toBe("none");
  });

  it("ALIVEでない行は触らない（待つ相手がいない）", () => {
    expect(
      resolveStartingActivityTransition({ ...base, state: "FAILED", claudeStarting: true }),
    ).toBe("none");
    expect(
      resolveStartingActivityTransition({
        ...base,
        state: "GONE",
        claudeStarting: false,
        previousActivity: "NOT_STARTED",
      }),
    ).toBe("none");
  });
});

describe("parseDispatchSessionActivity", () => {
  it("フックのイベント名を内部の表現へ写す", () => {
    expect(parseDispatchSessionActivity("waiting_input")).toBe("WAITING_INPUT");
    expect(parseDispatchSessionActivity("working")).toBe("WORKING");
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

describe("parsePreviewUrl", () => {
  it("tailnet内のhttp URLだけを通す", () => {
    expect(parsePreviewUrl("http://subpc.tail5210f2.ts.net:4123")).toBe(
      "http://subpc.tail5210f2.ts.net:4123/",
    );
  });

  it.each([
    ["tailnet外", "http://example.com:4123"],
    ["ts.netを含むだけの別ホスト", "http://evil-ts.net.example.com:4123"],
    ["https（証明書が未有効なので出ない形）", "https://subpc.tail5210f2.ts.net:4123"],
    ["URLでない", "subpc:4123"],
    ["空文字", ""],
  ])("%sは受け付けない", (_name, input) => {
    expect(parsePreviewUrl(input)).toBeNull();
  });
});

describe("isRevivedSession（#1353）", () => {
  it("消えていた行がALIVEへ戻る時だけ真", () => {
    expect(isRevivedSession("GONE", "ALIVE")).toBe(true);
    expect(isRevivedSession("EXITED", "ALIVE")).toBe(true);
    expect(isRevivedSession("FAILED", "ALIVE")).toBe(true);
  });

  it("ALIVEが続いている間は偽（同じセッション）", () => {
    expect(isRevivedSession("ALIVE", "ALIVE")).toBe(false);
  });

  it("ALIVE以外へ移るときは偽", () => {
    expect(isRevivedSession("ALIVE", "GONE")).toBe(false);
    expect(isRevivedSession("GONE", "FAILED")).toBe(false);
  });

  it("行がまだ無ければ偽（作る側で初期値が入る）", () => {
    expect(isRevivedSession(null, "ALIVE")).toBe(false);
    expect(isRevivedSession(undefined, "ALIVE")).toBe(false);
  });
});
