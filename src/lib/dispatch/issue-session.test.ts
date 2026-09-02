import { describe, expect, it } from "vitest";

import {
  compactIssueSessionLabel,
  describeSessionReap,
  describeSessionStep,
  describeSessionRecovery,
  findSessionForIssue,
  isSessionWaitingInput,
  resolveIssueImplementationAgent,
  shortIssueSessionLabel,
  summarizeIssueSession,
} from "@/lib/dispatch/issue-session";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";

const REPO = "guchi-apps/issue-deck";

function session(overrides: Partial<DispatchSessionView> = {}): DispatchSessionView {
  return {
    host: "subpc",
    tmuxSessionName: "issue-deck-issue-1",
    repositoryFullName: REPO,
    issueNumber: 1,
    issueTitle: null,
    issueId: null,
    state: "ALIVE",
    exitStatus: null,
    firstSeenAt: "2026-08-14T00:00:00.000Z",
    lastReportedAt: "2026-08-14T00:00:00.000Z",
    activity: null,
    activityAt: null,
    remoteControlUrl: null,
    previewUrl: null,
    reapAt: null,
    reapReason: null,
    codexThreadKnown: null,
    step: null,
    stepAt: null,
    stepSeenAt: null,
    models: [],
    ...overrides,
  };
}

/**
 * ステップを申告している（＝走っている）セッションの追加分（#2705）。**`stepSeenAt`は
 * `activityAt`より新しくする**——そこが「いま走っているか」の判定材料。
 */
function working(
  step: NonNullable<DispatchSessionView["step"]>,
  overrides: Partial<DispatchSessionView> = {},
): Partial<DispatchSessionView> {
  return {
    step,
    stepAt: "2026-08-14T00:00:00.000Z",
    stepSeenAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  };
}

describe("resolveIssueImplementationAgent", () => {
  it("nullだけをClaude Codeとして扱う", () => {
    expect(resolveIssueImplementationAgent(session({ codexThreadKnown: null }))).toBe("claude");
  });

  it.each([false, true])("codexThreadKnown=%sをCodexとして扱う", (codexThreadKnown) => {
    expect(resolveIssueImplementationAgent(session({ codexThreadKnown }))).toBe("codex");
  });
});

describe("findSessionForIssue", () => {
  it("別Issue・別リポジトリは選ばない", () => {
    expect(
      findSessionForIssue(
        [session({ issueNumber: 2 }), session({ repositoryFullName: "guchi-apps/other" })],
        REPO,
        1,
      ),
    ).toBeNull();
  });

  it("生きているセッションを最優先する", () => {
    const found = findSessionForIssue(
      [
        session({ host: "old", state: "GONE", lastReportedAt: "2026-08-14T09:00:00.000Z" }),
        session({ host: "subpc", state: "ALIVE", lastReportedAt: "2026-08-14T08:00:00.000Z" }),
      ],
      REPO,
      1,
    );
    expect(found?.host).toBe("subpc");
  });

  it("生きているものが無ければ直近に報告のあったもの", () => {
    const found = findSessionForIssue(
      [
        session({ host: "old", state: "EXITED", lastReportedAt: "2026-08-14T08:00:00.000Z" }),
        session({ host: "subpc", state: "GONE", lastReportedAt: "2026-08-14T09:00:00.000Z" }),
      ],
      REPO,
      1,
    );
    expect(found?.host).toBe("subpc");
  });
});

describe("summarizeIssueSession", () => {
  it("ALIVEで様子の報告が無ければ実行中", () => {
    const s = summarizeIssueSession(session());
    expect(s.tone).toBe("running");
    expect(s.label).toContain("サブPCで実行中");
  });

  it("入力待ちはRemote Controlの案内を添える", () => {
    const s = summarizeIssueSession(
      session({ activity: "WAITING_INPUT", remoteControlUrl: "https://claude.ai/code/x" }),
    );
    expect(s.tone).toBe("waiting");
    expect(s.remoteControlUrl).toBe("https://claude.ai/code/x");
    expect(s.detail).toContain("Remote Control");
  });

  it("Codexの入力待ちは端末から答える案内にする", () => {
    const s = summarizeIssueSession(
      session({ activity: "WAITING_INPUT", codexThreadKnown: false }),
    );
    expect(s.detail).toContain("端末から答えてください");
    expect(s.detail).not.toContain("Remote Control");
  });

  // #1357。承認に答えた直後をRESPONDEDで表すと「応答を終えています」と出てしまう
  it("入力に答えて作業へ戻った報告は、作業中として出す（入力待ちでも応答終了でもない）", () => {
    const s = summarizeIssueSession(session({ activity: "WORKING" }));
    expect(s.tone).toBe("running");
    expect(s.label).toContain("作業中");
    expect(s.detail).not.toContain("次の指示");
  });

  it("応答終了は「終わっている場合と次の指示待ちの場合がある」と断る", () => {
    const s = summarizeIssueSession(session({ activity: "RESPONDED" }));
    expect(s.tone).toBe("running");
    expect(s.detail).toContain("次の指示");
  });

  // 落ちたセッションに古い「入力待ち」が残らないことの担保
  it("セッションが落ちていれば、入力待ちの報告が残っていても状態を優先する", () => {
    const s = summarizeIssueSession(
      session({ state: "FAILED", exitStatus: 1, activity: "WAITING_INPUT" }),
    );
    expect(s.tone).toBe("error");
    expect(s.detail).toContain("終了コード 1");
  });

  it("落ちたセッションのRemote Controlは出さない（開いても意味が無い）", () => {
    const s = summarizeIssueSession(
      session({ state: "GONE", activity: "WAITING_INPUT", remoteControlUrl: "https://claude.ai/code/x" }),
    );
    expect(s.remoteControlUrl).toBeNull();
  });

  // #1830。「終了しました」だけでは、役目を終えて自動で畳まれたのか、こちらの回答を待ったまま
  // 消えたのか（復旧して答える必要がある）を区別できない
  describe("回答を待ったまま終わったセッション（#1830）", () => {
    it("回答前に終了したことを書き分ける", () => {
      const s = summarizeIssueSession(session({ state: "GONE", activity: "WAITING_INPUT" }));
      expect(s.tone).toBe("waiting");
      expect(s.shortLabel).toBe("回答前に終了");
      expect(s.label).toContain("回答を待っている間に終了");
      expect(s.detail).toContain("あなたの回答を待っている間に");
      // 一覧のバッジも同じ分岐で言う（片方だけ増やさない）
      expect(shortIssueSessionLabel(session({ state: "GONE", activity: "WAITING_INPUT" }))).toBe(
        "回答前に終了",
      );
    });

    it("答えた後に進んで終わったセッションは、これまでどおり「終了」とだけ出す", () => {
      const s = summarizeIssueSession(session({ state: "EXITED", activity: "RESPONDED" }));
      expect(s.tone).toBe("done");
      expect(s.shortLabel).toBe("終了");
      expect(s.detail).toBeNull();
      expect(shortIssueSessionLabel(session({ state: "EXITED", activity: "RESPONDED" }))).toBe(
        "終了",
      );
    });

    // 異常終了は終了コードを出すのが要点なので、これまでどおり`error`のまま
    it("異常終了は入力待ちのまま落ちていても「異常終了」", () => {
      const s = summarizeIssueSession(
        session({ state: "FAILED", exitStatus: 1, activity: "WAITING_INPUT" }),
      );
      expect(s.tone).toBe("error");
      expect(s.shortLabel).toBe("異常終了");
    });
  });

  describe("describeSessionRecovery（#1830）", () => {
    it("動いているセッションには出さない", () => {
      expect(describeSessionRecovery(session({ state: "ALIVE" }))).toBeNull();
    });

    it("終了したセッションには、押すと何が起きるかを添えて返す", () => {
      const recovery = describeSessionRecovery(session({ state: "GONE", activity: "RESPONDED" }));
      expect(recovery).not.toBeNull();
      expect(recovery?.primary).toBe(false);
      expect(recovery?.detail).toContain("前回の会話の続き");
      expect(recovery?.detail).toContain("11.local");
    });

    it("回答前に終了したときだけ主導線にする", () => {
      const recovery = describeSessionRecovery(
        session({ state: "GONE", activity: "WAITING_INPUT" }),
      );
      expect(recovery?.primary).toBe(true);
    });

    it("異常終了も復旧の対象にする", () => {
      expect(describeSessionRecovery(session({ state: "FAILED", exitStatus: 1 }))).not.toBeNull();
    });
  });

  // #1353。pollerは1巡ごとにlastReportedAtを更新するため、これを入力待ちに添えると
  // 何時間前の入力待ちでも「たった今」に見える
  describe("見出しに添える時刻（#1353）", () => {
    it("入力待ち・応答終了はフックが報告してきた時刻を指す", () => {
      const view = session({
        activityAt: "2026-08-14T09:00:00.000Z",
        lastReportedAt: "2026-08-14T12:00:00.000Z",
      });
      expect(summarizeIssueSession({ ...view, activity: "WAITING_INPUT" }).at).toBe(
        "2026-08-14T09:00:00.000Z",
      );
      expect(summarizeIssueSession({ ...view, activity: "RESPONDED" }).at).toBe(
        "2026-08-14T09:00:00.000Z",
      );
      expect(summarizeIssueSession({ ...view, activity: "WORKING" }).at).toBe(
        "2026-08-14T09:00:00.000Z",
      );
    });

    it("様子の報告が無ければpollerが最後に見た時刻", () => {
      expect(summarizeIssueSession(session({ lastReportedAt: "2026-08-14T12:00:00.000Z" })).at).toBe(
        "2026-08-14T12:00:00.000Z",
      );
    });

    it("終了・異常終了もpollerが最後に見た時刻（終わった時刻に相当する）", () => {
      const view = session({
        state: "FAILED",
        activity: "WAITING_INPUT",
        activityAt: "2026-08-14T09:00:00.000Z",
        lastReportedAt: "2026-08-14T12:00:00.000Z",
      });
      expect(summarizeIssueSession(view).at).toBe("2026-08-14T12:00:00.000Z");
    });
  });

  it("終了コードが取れなければ補足を出さない", () => {
    expect(summarizeIssueSession(session({ state: "FAILED" })).detail).toBeNull();
  });
});

/**
 * #1676。起動ジョブの行（「サブPCで起動しました」）をセッションの行へ畳んだときの文言。
 * **`summarizeIssueSession`の`shortLabel`にホスト名を添えるだけ**で、分岐を持たない。
 */
describe("compactIssueSessionLabel", () => {
  it("ホスト名と短い言い方をつなぐ", () => {
    expect(compactIssueSessionLabel(session())).toBe("サブPC・実行中");
    expect(compactIssueSessionLabel(session({ activity: "NOT_STARTED" }))).toBe(
      "サブPC・まだ開始していません",
    );
    expect(compactIssueSessionLabel(session({ activity: "WAITING_INPUT" }))).toBe(
      "サブPC・入力を待っています",
    );
    expect(compactIssueSessionLabel(session({ state: "FAILED" }))).toBe("サブPC・異常終了");
  });
});

describe("shortIssueSessionLabel", () => {
  it("ステップの申告が無ければ出さない（古いpoller・フックがまだ飛んでいない）", () => {
    expect(shortIssueSessionLabel(session())).toBeNull();
    expect(shortIssueSessionLabel(session({ activity: "RESPONDED" }))).toBeNull();
    expect(shortIssueSessionLabel(session({ activity: "WORKING" }))).toBeNull();
  });

  // #2705。一覧の行が「サブPC」だけだと、動いているのは分かってもテストで詰まっているのか
  // 調べているだけなのかが分からなかった
  it("いま何をしているかが分かれば、それを出す", () => {
    expect(shortIssueSessionLabel(session(working("TESTING")))).toBe("テスト中");
  });

  // #2782。#2705当時は「一覧の行は狭く、経過時間まで並べるとステップ名が折り返す」として
  // 経過時間を捨てていたが、呼び出し側（`WorkflowStepBadge`）がこの短い表現だけを見せる形に
  // 変わったことで、活動＋経過だけなら幅に収まるようになった
  it("nowを渡すと、活動中は経過時間を添える", () => {
    expect(
      shortIssueSessionLabel(session(working("EXPLORING")), new Date("2026-08-14T00:02:30.000Z")),
    ).toBe("調査中(2分)");
  });

  it("nowを渡さなければ、活動中でも経過時間は添えない（マウント前に実時計へフォールバックしない）", () => {
    expect(shortIssueSessionLabel(session(working("EXPLORING")))).toBe("調査中");
  });

  it("入力待ち・終了・異常終了だけを出す", () => {
    expect(shortIssueSessionLabel(session({ activity: "WAITING_INPUT" }))).toBe("入力待ち");
    expect(shortIssueSessionLabel(session({ state: "EXITED" }))).toBe("終了");
    expect(shortIssueSessionLabel(session({ state: "FAILED" }))).toBe("異常終了");
  });

  it("まだ開始していないセッションも出す（人が端末で答えるまで進まない。#1465）", () => {
    expect(shortIssueSessionLabel(session({ activity: "NOT_STARTED" }))).toBe("未開始");
  });
});

/**
 * #1465。フォルダの信頼確認で止まっている間はセッションが始まっておらず、Remote Controlも
 * 繋がっていない。答えられる場所（端末）を出さないと、画面から辿れる出口が無くなる。
 */
describe("まだ開始していないセッション（#1465）", () => {
  it("待ちとして出し、tmuxのセッション名を添える", () => {
    const s = summarizeIssueSession(
      session({
        activity: "NOT_STARTED",
        activityAt: "2026-08-14T00:05:00.000Z",
        tmuxSessionName: "issue-deck-issue-1465",
      }),
    );
    expect(s.tone).toBe("waiting");
    expect(s.label).toContain("まだ開始していません");
    expect(s.detail).toContain("tmux attach -t issue-deck-issue-1465");
    expect(s.at).toBe("2026-08-14T00:05:00.000Z");
  });

  it("Remote ControlのURLは出さない（まだ繋がっていない）", () => {
    const s = summarizeIssueSession(
      session({
        activity: "NOT_STARTED",
        remoteControlUrl: "https://claude.ai/code/session_abc",
      }),
    );
    expect(s.remoteControlUrl).toBeNull();
  });

  it("承認ボタンを引っ込める入力待ち（#1417）とは別に扱う", () => {
    expect(isSessionWaitingInput(session({ activity: "NOT_STARTED" }))).toBe(false);
  });
});

describe("プレビューURL（#1265）", () => {
  it("生きているセッションでは出す", () => {
    const s = summarizeIssueSession(
      session({ previewUrl: "http://subpc.tail5210f2.ts.net:4123" }),
    );
    expect(s.previewUrl).toBe("http://subpc.tail5210f2.ts.net:4123");
  });

  it.each([["EXITED"], ["GONE"], ["FAILED"]] as const)(
    "%sのセッションでは出さない（serveは撤去済みで繋がらない）",
    (state) => {
      const s = summarizeIssueSession(
        session({ state, previewUrl: "http://subpc.tail5210f2.ts.net:4123" }),
      );
      expect(s.previewUrl).toBeNull();
    },
  );
});

/**
 * #1417。承認欄のボタンを引っ込めるかどうかの判断に使う。
 * **落ちたセッションの`WAITING_INPUT`は待つ相手がいない古い値**なので、ここまで隠すと
 * 画面から`00.check-user`を外す手段が無くなる。
 */
describe("isSessionWaitingInput", () => {
  it("生きているセッションが入力待ちのときだけ真", () => {
    expect(isSessionWaitingInput(session({ state: "ALIVE", activity: "WAITING_INPUT" }))).toBe(true);
    expect(isSessionWaitingInput(session({ state: "ALIVE", activity: "WORKING" }))).toBe(false);
    expect(isSessionWaitingInput(session({ state: "ALIVE", activity: "RESPONDED" }))).toBe(false);
  });

  it("落ちたセッションの入力待ちは真としない", () => {
    expect(isSessionWaitingInput(session({ state: "FAILED", activity: "WAITING_INPUT" }))).toBe(false);
    expect(isSessionWaitingInput(session({ state: "EXITED", activity: "WAITING_INPUT" }))).toBe(false);
    expect(isSessionWaitingInput(session({ state: "GONE", activity: "WAITING_INPUT" }))).toBe(false);
  });

  it("セッションが無ければ偽", () => {
    expect(isSessionWaitingInput(null)).toBe(false);
  });
});

/**
 * 自動終了までの残り時間（#1817）。
 *
 * **判定そのものはサブPCの`reap-sessions.sh`が持ち、ここは運ばれてきた予定を言い方へ直すだけ。**
 * 画面側で条件を組み立て直すと必ずずれ、終わらないセッションに終了予告が出る。
 */
describe("describeSessionReap", () => {
  const NOW = new Date("2026-08-16T12:00:00.000Z");

  it("残り時間と理由を出す", () => {
    const notice = describeSessionReap(
      session({ reapAt: "2026-08-16T12:03:10.000Z", reapReason: "PR_MERGED" }),
      NOW,
    );
    expect(notice?.label).toBe("あと3分");
    expect(notice?.imminent).toBe(false);
    expect(notice?.detail).toContain("PRがマージ済みのため");
    // 畳まれた後どうなるかまで書く（続けたい場合に何をすればよいかが分かるように）
    expect(notice?.detail).toContain("worktreeは残る");
  });

  it("残り1分を切ったら「まもなく」に変える", () => {
    const notice = describeSessionReap(
      session({ reapAt: "2026-08-16T12:00:50.000Z", reapReason: "ISSUE_CLOSED" }),
      NOW,
    );
    expect(notice?.label).toBe("まもなく");
    expect(notice?.imminent).toBe(true);
  });

  it("期限を過ぎた直後はまだ出す（次の巡で畳まれる）", () => {
    expect(
      describeSessionReap(
        session({ reapAt: "2026-08-16T11:59:00.000Z", reapReason: "PR_MERGED" }),
        NOW,
      )?.label,
    ).toBe("まもなく");
  });

  it("期限を大きく過ぎたら出さない（回収が止まっているときに残り続けさせない）", () => {
    expect(
      describeSessionReap(
        session({ reapAt: "2026-08-16T11:55:00.000Z", reapReason: "PR_MERGED" }),
        NOW,
      ),
    ).toBeNull();
  });

  it("質問セッションは会話を引き継がない旨を出す", () => {
    const notice = describeSessionReap(
      session({ reapAt: "2026-08-16T12:10:00.000Z", reapReason: "QUESTION_IDLE" }),
      NOW,
    );
    expect(notice?.detail).toContain("新しく質問してください");
    expect(notice?.detail).not.toContain("worktree");
  });

  it("worktreeが消えているセッションは、前回の続きから再開しない旨を出す（#2422）", () => {
    const notice = describeSessionReap(
      session({ reapAt: "2026-08-16T12:03:00.000Z", reapReason: "WORKTREE_GONE" }),
      NOW,
    );
    expect(notice?.detail).toContain("worktreeが削除されているため");
    // 起動し直すとworktreeを作り直す経路になり、会話は引き継がれない（run-issue-session.sh）
    expect(notice?.detail).toContain("引き継ぎません");
    expect(notice?.detail).not.toContain("worktreeは残る");
    // 質問セッション向けの案内（「質問する」から聞き直す）とは別物
    expect(notice?.detail).not.toContain("新しく質問してください");
  });

  it("生きていないセッションには出さない", () => {
    for (const state of ["EXITED", "FAILED", "GONE"] as const) {
      expect(
        describeSessionReap(
          session({ state, reapAt: "2026-08-16T12:03:00.000Z", reapReason: "PR_MERGED" }),
          NOW,
        ),
      ).toBeNull();
    }
  });

  it("予定が無い・理由だけ・時刻だけのときは出さない", () => {
    expect(describeSessionReap(session(), NOW)).toBeNull();
    expect(describeSessionReap(session({ reapReason: "PR_MERGED" }), NOW)).toBeNull();
    expect(describeSessionReap(session({ reapAt: "2026-08-16T12:03:00.000Z" }), NOW)).toBeNull();
  });
});


/**
 * #2705。ステップはフックが書いた`.step`をpollerが運んでくるもので、`activity`（人を待って
 * いるか）とは別物。**`stepSeenAt`が`activityAt`より新しいことが「いま走っている」の唯一の
 * 手掛かり**で、次のturnが始まったことを知らせるフックが無いぶんをここで補っている。
 */
describe("describeSessionStep（#2705）", () => {
  it("いま何をしているかと、そのステップに入ってからの経過を出す", () => {
    const notice = describeSessionStep(
      session(working("EDITING", { stepAt: "2026-08-14T00:00:00.000Z" })),
      new Date("2026-08-14T00:02:30.000Z"),
    );
    expect(notice).toEqual({ step: "EDITING", label: "実装中", since: "2分" });
  });

  it("1分未満のあいだは経過を添えない（0分と出さない）", () => {
    expect(
      describeSessionStep(session(working("LINTING")), new Date("2026-08-14T00:00:30.000Z"))?.since,
    ).toBeNull();
  });

  it("時・日の単位で動かないステップには経過を添えない（フックが飛ばなくなった側を疑う場面）", () => {
    const notice = describeSessionStep(
      session(working("BUILDING")),
      new Date("2026-08-14T05:00:00.000Z"),
    );
    expect(notice?.label).toBe("ビルド中");
    expect(notice?.since).toBeNull();
  });

  it("人を待っている間は出さない（次に何をすればよいかが読み取れなくなる）", () => {
    expect(describeSessionStep(session(working("EDITING", { activity: "WAITING_INPUT" })))).toBeNull();
    expect(describeSessionStep(session(working("EDITING", { activity: "NOT_STARTED" })))).toBeNull();
  });

  it("終わったセッションには出さない", () => {
    expect(describeSessionStep(session(working("EDITING", { state: "GONE" })))).toBeNull();
    expect(describeSessionStep(session(working("EDITING", { state: "FAILED" })))).toBeNull();
  });

  it("最後のフックより古い申告は出さない（応答を終えたあと何も動いていない）", () => {
    expect(
      describeSessionStep(
        session({
          activity: "RESPONDED",
          activityAt: "2026-08-14T00:10:00.000Z",
          step: "EDITING",
          stepAt: "2026-08-14T00:00:00.000Z",
          stepSeenAt: "2026-08-14T00:05:00.000Z",
        }),
      ),
    ).toBeNull();
  });
});

/**
 * #2705。`Stop`のあとに次のturnが始まってもフックは飛ばないため、走っている最中のセッションが
 * ずっと「応答を終えています」と出ていた。
 */
describe("応答終了のあとにツールが走っている場合（#2705）", () => {
  it("作業中として出す", () => {
    const summary = summarizeIssueSession(
      session(
        working("TESTING", {
          activity: "RESPONDED",
          activityAt: "2026-08-14T00:00:00.000Z",
          stepSeenAt: "2026-08-14T00:03:00.000Z",
        }),
      ),
    );
    expect(summary.shortLabel).toBe("作業中");
    expect(summary.at).toBe("2026-08-14T00:03:00.000Z");
  });

  it("ツールが走っていなければ従来どおり応答終了のまま", () => {
    expect(
      summarizeIssueSession(
        session({ activity: "RESPONDED", activityAt: "2026-08-14T00:00:00.000Z" }),
      ).shortLabel,
    ).toBe("応答を終えています");
  });
});
