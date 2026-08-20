import { describe, expect, it } from "vitest";

import type { DispatchSessionView } from "@/lib/dispatch/session-state";

import {
  ACTIVE_DISPATCH_JOB_STATUSES,
  buildDispatchActiveKey,
  describeCrossRepoQuestionRejection,
  describeDispatchEnqueueRejection,
  describeDispatchJobKind,
  describeDispatchJobStatus,
  describeSessionControlRejection,
  DISPATCH_HOST_ONLINE_WINDOW_MS,
  findBlockingSession,
  findCrossRepoQuestionJobForIssue,
  findDispatchJobForIssue,
  findSessionControlJobForIssue,
  isActiveDispatchJobStatus,
  isCancelableDispatchJobStatus,
  isSessionControlJobKind,
  isSessionLaunchJobKind,
  isIssueExecutionPending,
  isDispatchHostOnline,
  normalizeDispatchHostRepositories,
  parseDispatchHostName,
  parseDispatchHostRepositories,
  parseDispatchJobKind,
  isOutOfBandJobKind,
  buildSelfUpdateActiveKey,
  SELF_UPDATE_REPOSITORY,
  SELF_UPDATE_ISSUE_NUMBER,
  parseDispatchReportStatus,
  parseDispatchTarget,
  parseSessionInstruction,
  resolveCrossRepoQuestionRejection,
  resolveDefaultCrossRepoQuestionHost,
  resolveDefaultPlanReviewHost,
  resolvePlanReviewRejection,
  describePlanReviewRejection,
  findPlanReviewJobForIssue,
  resolveDispatchConcurrency,
  resolveDispatchTargetRejection,
  describeManualStepExecutionRejection,
  resolveManualStepExecutionRejection,
  resolveManualStepHost,
  resolveScreenshotRejection,
  resolveSessionControlRejection,
  type DispatchHostView,
  type DispatchJobKind,
  type DispatchJobView,
} from "@/lib/dispatch/dispatch-job";

describe("parseDispatchTarget", () => {
  it("owner/repoとIssue番号が妥当なら受け入れる", () => {
    expect(parseDispatchTarget("guchi-apps/issue-deck", 1179)).toEqual({
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 1179,
    });
  });

  it("パス参照・空白・スラッシュ過多を弾く（サブPC側でパスの一部になるため）", () => {
    expect(parseDispatchTarget("../etc", 1)).toBeNull();
    expect(parseDispatchTarget("guchi-apps/../issue-deck", 1)).toBeNull();
    expect(parseDispatchTarget("guchi apps/issue-deck", 1)).toBeNull();
    expect(parseDispatchTarget("issue-deck", 1)).toBeNull();
    expect(parseDispatchTarget("guchi-apps/issue-deck/extra", 1)).toBeNull();
  });

  it("Issue番号は正の整数のみ", () => {
    expect(parseDispatchTarget("guchi-apps/issue-deck", 0)).toBeNull();
    expect(parseDispatchTarget("guchi-apps/issue-deck", -1)).toBeNull();
    expect(parseDispatchTarget("guchi-apps/issue-deck", 1.5)).toBeNull();
    expect(parseDispatchTarget("guchi-apps/issue-deck", "1179")).toBeNull();
  });
});

describe("parseDispatchHostName", () => {
  it("英数字と.-_のみ通す", () => {
    expect(parseDispatchHostName("subpc")).toBe("subpc");
    expect(parseDispatchHostName(" subpc ")).toBe("subpc");
    expect(parseDispatchHostName("sub pc")).toBeNull();
    expect(parseDispatchHostName("sub/pc")).toBeNull();
    expect(parseDispatchHostName("..")).toBeNull();
    expect(parseDispatchHostName("")).toBeNull();
    expect(parseDispatchHostName(42)).toBeNull();
  });
});

describe("buildDispatchActiveKey", () => {
  it("リポジトリとIssue番号から一意キーを組み立てる", () => {
    expect(buildDispatchActiveKey("guchi-apps/issue-deck", 1179)).toBe(
      "guchi-apps/issue-deck#1179",
    );
  });

  it("別リポジトリの同じ番号は衝突しない", () => {
    expect(buildDispatchActiveKey("guchi-apps/dayspan", 1179)).not.toBe(
      buildDispatchActiveKey("guchi-apps/issue-deck", 1179),
    );
  });
});

describe("isActiveDispatchJobStatus", () => {
  it("未完了の3状態だけをactiveとして扱う", () => {
    expect(ACTIVE_DISPATCH_JOB_STATUSES).toEqual(["QUEUED", "CLAIMED", "RUNNING"]);
    expect(isActiveDispatchJobStatus("QUEUED")).toBe(true);
    expect(isActiveDispatchJobStatus("RUNNING")).toBe(true);
    expect(isActiveDispatchJobStatus("SUCCEEDED")).toBe(false);
    expect(isActiveDispatchJobStatus("TIMEOUT")).toBe(false);
    expect(isActiveDispatchJobStatus("CANCELED")).toBe(false);
  });
});

describe("isDispatchHostOnline", () => {
  const now = new Date("2026-08-14T12:00:00Z");

  it("猶予の内側なら生存", () => {
    expect(isDispatchHostOnline(new Date(now.getTime() - 60 * 1000), now)).toBe(true);
    expect(
      isDispatchHostOnline(new Date(now.getTime() - DISPATCH_HOST_ONLINE_WINDOW_MS), now),
    ).toBe(true);
  });

  it("猶予を超えたらoffline", () => {
    expect(
      isDispatchHostOnline(new Date(now.getTime() - DISPATCH_HOST_ONLINE_WINDOW_MS - 1), now),
    ).toBe(false);
  });
});

describe("parseDispatchHostRepositories", () => {
  it("JSON配列から妥当なリポジトリ名だけを取り出す", () => {
    expect(
      parseDispatchHostRepositories('["guchi-apps/issue-deck","guchi-apps/dayspan","bad name"]'),
    ).toEqual(["guchi-apps/issue-deck", "guchi-apps/dayspan"]);
  });

  it("壊れた申告は例外にせず空配列にする（画面を落とさない）", () => {
    expect(parseDispatchHostRepositories("not json")).toEqual([]);
    expect(parseDispatchHostRepositories('{"a":1}')).toEqual([]);
    expect(parseDispatchHostRepositories("")).toEqual([]);
  });
});

describe("normalizeDispatchHostRepositories", () => {
  it("重複を落とし、検証を通ったものだけを並べる", () => {
    expect(
      normalizeDispatchHostRepositories([
        "guchi-apps/issue-deck",
        "guchi-apps/issue-deck",
        "guchi-apps/dayspan",
        "../etc",
        123,
      ]),
    ).toEqual(["guchi-apps/dayspan", "guchi-apps/issue-deck"]);
  });

  it("配列でなければ空配列", () => {
    expect(normalizeDispatchHostRepositories("guchi-apps/issue-deck")).toEqual([]);
    expect(normalizeDispatchHostRepositories(undefined)).toEqual([]);
  });
});

describe("resolveDispatchConcurrency", () => {
  it("issue-deck側の設定とホストの申告の小さい方を採る", () => {
    expect(resolveDispatchConcurrency(4, 2)).toBe(2);
    expect(resolveDispatchConcurrency(2, 6)).toBe(2);
  });

  it("ホストが申告しない場合は設定値をそのまま使う", () => {
    expect(resolveDispatchConcurrency(3, null)).toBe(3);
    expect(resolveDispatchConcurrency(3, 0)).toBe(3);
  });
});

describe("parseDispatchReportStatus", () => {
  it("pollerが報告してよい状態だけを受け入れる", () => {
    expect(parseDispatchReportStatus("running")).toBe("running");
    expect(parseDispatchReportStatus("succeeded")).toBe("succeeded");
    expect(parseDispatchReportStatus("failed")).toBe("failed");
    // 起動を見送ったときの報告（#1229）
    expect(parseDispatchReportStatus("skipped")).toBe("skipped");
  });

  it("issue-deck側だけが付ける状態は受け付けない", () => {
    expect(parseDispatchReportStatus("timeout")).toBeNull();
    expect(parseDispatchReportStatus("canceled")).toBeNull();
    expect(parseDispatchReportStatus("QUEUED")).toBeNull();
  });
});

describe("describeDispatchEnqueueRejection", () => {
  it("理由ごとに、次に何を見ればよいかが分かる日本語を返す", () => {
    expect(describeDispatchEnqueueRejection("host_offline", { hostName: "subpc" })).toContain(
      "サブPC",
    );
    expect(
      describeDispatchEnqueueRejection("repository_not_runnable", {
        hostName: "subpc",
        repositoryFullName: "guchi-apps/shopping-list",
      }),
    ).toContain("guchi-apps/shopping-list");
    expect(describeDispatchEnqueueRejection("already_queued", { hostName: "subpc" })).not.toBe("");
  });

  // #1311。畳むにはセッション名を指す必要があるため、名前が無いと押せない理由だけが残る
  it("セッション生存の理由には、セッション名と畳み方が入る", () => {
    const message = describeDispatchEnqueueRejection("session_alive", {
      hostName: "subpc",
      session: { host: "subpc", tmuxSessionName: "issue-deck-issue-1311" },
    });
    expect(message).toContain("issue-deck-issue-1311");
    expect(message).toContain("kill-session");
  });

  it("セッションの情報が無くても文言が壊れない", () => {
    expect(describeDispatchEnqueueRejection("session_alive", { hostName: "subpc" })).not.toBe("");
  });
});

describe("resolveDispatchTargetRejection", () => {
  const host = { online: true, repositories: ["guchi-apps/issue-deck"] };
  const repositoryFullName = "guchi-apps/issue-deck";
  const blockingSession = { host: "subpc", tmuxSessionName: "issue-deck-issue-1311" };

  it("実行できる組み合わせならnull（＝選べる）", () => {
    expect(
      resolveDispatchTargetRejection({
        host,
        repositoryFullName,
        hasActiveJob: false,
        blockingSession: null,
      }),
    ).toBe(null);
  });

  it("申告が無い・応答していないホストは選ばせない", () => {
    expect(
      resolveDispatchTargetRejection({
        host: null,
        repositoryFullName,
        hasActiveJob: false,
        blockingSession: null,
      }),
    ).toBe("host_unknown");
    expect(
      resolveDispatchTargetRejection({
        host: { ...host, online: false },
        repositoryFullName,
        hasActiveJob: false,
        blockingSession: null,
      }),
    ).toBe("host_offline");
  });

  it("cloneされていないリポジトリと、未完了ジョブがあるIssueも選ばせない", () => {
    expect(
      resolveDispatchTargetRejection({
        host: { ...host, repositories: [] },
        repositoryFullName,
        hasActiveJob: false,
        blockingSession: null,
      }),
    ).toBe("repository_not_runnable");
    expect(
      resolveDispatchTargetRejection({
        host,
        repositoryFullName,
        hasActiveJob: true,
        blockingSession: null,
      }),
    ).toBe("already_queued");
  });

  // #1311。起動済みのIssueをもう一度積んでも、poller側で見送られるだけで何も起きない
  it("セッションが動いているIssueは選ばせない", () => {
    expect(
      resolveDispatchTargetRejection({
        host,
        repositoryFullName,
        hasActiveJob: false,
        blockingSession,
      }),
    ).toBe("session_alive");
  });

  // 画面とAPIで並びが違うと、画面では押せるのにAPIが別の理由で断る状態が生まれる
  it("判定の並びはenqueueDispatchJobと同じ（ホストの状態が先・セッションは最後）", () => {
    expect(
      resolveDispatchTargetRejection({
        host: { online: false, repositories: [] },
        repositoryFullName,
        hasActiveJob: true,
        blockingSession,
      }),
    ).toBe("host_offline");
    // 両方あてはまるときは、押した直後から見えているジョブの方を出す
    expect(
      resolveDispatchTargetRejection({
        host,
        repositoryFullName,
        hasActiveJob: true,
        blockingSession,
      }),
    ).toBe("already_queued");
  });
});

describe("findBlockingSession", () => {
  const repositoryFullName = "guchi-apps/issue-deck";
  const hosts = [{ name: "subpc", online: true }];

  function session(overrides: Partial<DispatchSessionView> = {}): DispatchSessionView {
    return {
      host: "subpc",
      tmuxSessionName: "issue-deck-issue-1311",
      repositoryFullName,
      issueNumber: 1311,
      issueTitle: null,
      issueId: null,
      state: "ALIVE",
      exitStatus: null,
      firstSeenAt: "2026-08-14T10:00:00.000Z",
      lastReportedAt: "2026-08-14T10:05:00.000Z",
      activity: null,
      activityAt: null,
      remoteControlUrl: null,
      previewUrl: null,
      reapAt: null,
      reapReason: null,
      ...overrides,
    };
  }

  it("生きているセッションを返す", () => {
    expect(
      findBlockingSession({ sessions: [session()], hosts, repositoryFullName, issueNumber: 1311 }),
    ).not.toBe(null);
  });

  // 死んだペインのセッションはstart-issue.shが畳んで作り直す。ここで止めると起動できなくなる
  it("終了・異常終了・消失したセッションは止めない", () => {
    for (const state of ["EXITED", "FAILED", "GONE"] as const) {
      expect(
        findBlockingSession({
          sessions: [session({ state })],
          hosts,
          repositoryFullName,
          issueNumber: 1311,
        }),
      ).toBe(null);
    }
  });

  // pollerが落ちている間、行はALIVEのまま古びる。判定材料が無いことと「動いている」ことは違う
  it("報告が途絶えたホストのセッションは止めない", () => {
    expect(
      findBlockingSession({
        sessions: [session()],
        hosts: [{ name: "subpc", online: false }],
        repositoryFullName,
        issueNumber: 1311,
      }),
    ).toBe(null);
    // 申告そのものが無いホストも同じ扱い
    expect(
      findBlockingSession({ sessions: [session()], hosts: [], repositoryFullName, issueNumber: 1311 }),
    ).toBe(null);
  });

  it("別のIssue・別のリポジトリのセッションは止めない", () => {
    expect(
      findBlockingSession({
        sessions: [session({ issueNumber: 1312 })],
        hosts,
        repositoryFullName,
        issueNumber: 1311,
      }),
    ).toBe(null);
    // Issue番号はリポジトリごとに振られるため、番号だけで突き合わせてはいけない（#1224と同じ理由）
    expect(
      findBlockingSession({
        sessions: [session({ repositoryFullName: "guchi-apps/dayspan" })],
        hosts,
        repositoryFullName,
        issueNumber: 1311,
      }),
    ).toBe(null);
  });

  // 各pollerは自分のtmuxしか見ないため、別ホストへの二重起動は向こう側では防げない
  it("別ホストで動いているセッションでも止める", () => {
    expect(
      findBlockingSession({
        sessions: [session({ host: "otherpc" })],
        hosts: [
          { name: "subpc", online: true },
          { name: "otherpc", online: true },
        ],
        repositoryFullName,
        issueNumber: 1311,
      })?.host,
    ).toBe("otherpc");
  });
});

describe("isIssueExecutionPending", () => {
  function session(overrides: Partial<DispatchSessionView> = {}): DispatchSessionView {
    return {
      host: "subpc",
      tmuxSessionName: "issue-deck-issue-1667",
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 1667,
      issueTitle: null,
      issueId: null,
      state: "ALIVE",
      exitStatus: null,
      firstSeenAt: "2026-08-15T10:00:00.000Z",
      lastReportedAt: "2026-08-15T10:05:00.000Z",
      activity: null,
      activityAt: null,
      remoteControlUrl: null,
      previewUrl: null,
      reapAt: null,
      reapReason: null,
      ...overrides,
    };
  }

  it("何も走っていなければ開始の導線を出す", () => {
    expect(isIssueExecutionPending({ job: null, blockingSession: null })).toBe(false);
  });

  // #1667。積んだ直後は進捗がまだReadyのままなので、この判定が無いと開始ボタンが残る
  it("未完了のジョブがあれば走っているとみなす", () => {
    for (const status of ACTIVE_DISPATCH_JOB_STATUSES) {
      expect(isIssueExecutionPending({ job: { status }, blockingSession: null })).toBe(true);
    }
  });

  // 失敗・取り消しで導線が戻らないと、落ちたセッションを立て直せなくなる
  it("終わったジョブでは出す（起動済み・失敗・取り消し・応答なし・見送り）", () => {
    for (const status of ["SUCCEEDED", "FAILED", "CANCELED", "TIMEOUT", "SKIPPED"] as const) {
      expect(isIssueExecutionPending({ job: { status }, blockingSession: null })).toBe(false);
    }
  });

  // ジョブの寿命は「tmuxが立った」までなので、SUCCEEDEDの後はセッション側で判定する
  it("セッションが生きていれば走っているとみなす", () => {
    expect(
      isIssueExecutionPending({ job: { status: "SUCCEEDED" }, blockingSession: session() }),
    ).toBe(true);
  });

  // #1815。ラベルはセッションが外すまで残るため、立て直しの導線はここで塞がない
  it("`11.local`が付いていても、実体が無ければ走っているとはみなさない", () => {
    expect(isIssueExecutionPending({ job: null, blockingSession: null })).toBe(false);
  });

});

describe("describeDispatchJobStatus", () => {
  // succeededは「tmuxセッションが立ち上がった」までで、実装の完了ではない
  it("succeededを「完了」とは書かない", () => {
    expect(describeDispatchJobStatus("SUCCEEDED").label).toBe("起動しました");
  });

  it("失敗と応答なしは同じ扱い（どちらも起動が届いていない）", () => {
    expect(describeDispatchJobStatus("FAILED").tone).toBe("error");
    expect(describeDispatchJobStatus("TIMEOUT").tone).toBe("error");
  });

  // #1229。正常に働いた安全機構を赤くすると、起動できなかったのかどうか判断できない
  it("見送りは失敗として見せない", () => {
    const skipped = describeDispatchJobStatus("SKIPPED");
    expect(skipped.tone).toBe("muted");
    expect(skipped.tone).not.toBe("error");
    expect(skipped.label).toBe("起動済みのため見送り");
  });

  // 質問ジョブのsucceededは「回答コメントが投稿された」までを指す（#1294）。起動ジョブとは
  // 寿命の意味が違うため、「起動しました」では何が終わったのか分からない
  it("質問ジョブは「起動しました」ではなく「回答しました」と書く", () => {
    expect(describeDispatchJobStatus("SUCCEEDED", "QUESTION").label).toBe("回答しました");
    expect(describeDispatchJobStatus("RUNNING", "QUESTION").label).toBe("回答中");
    expect(describeDispatchJobStatus("FAILED", "QUESTION").tone).toBe("error");
  });
});

/** #1519。実行キューの行に出す種別チップの文言 */
describe("describeDispatchJobKind", () => {
  // 状態ラベルだけでは、QUEUEDのときに起動と横断質問がどちらも「順番待ち」になり区別が付かない
  it("順番待ちの起動と横断質問を種別で見分けられる", () => {
    expect(describeDispatchJobStatus("QUEUED", "LAUNCH").label).toBe(
      describeDispatchJobStatus("QUEUED", "CROSS_REPO_QUESTION").label,
    );
    expect(describeDispatchJobKind("LAUNCH")).toBe("実装");
    expect(describeDispatchJobKind("CROSS_REPO_QUESTION")).toBe("横断質問");
  });

  // 押したボタンとキューに出る言葉が違うと、それが自分の押したものか分からなくなる
  it("制御ジョブはボタンの文言（SESSION_CONTROL_LABELS.action）と揃える", () => {
    expect(describeDispatchJobKind("INTERRUPT")).toBe("停止");
    expect(describeDispatchJobKind("KILL")).toBe("セッションを閉じる");
    expect(describeDispatchJobKind("INSTRUCTION")).toBe("追加指示を送る");
  });

  // 「チップが無い＝実装」という暗黙のルールを覚えなくて済むよう、全種別に文言を持たせる
  it("すべての種別に空でない文言がある", () => {
    const kinds: DispatchJobKind[] = [
      "LAUNCH",
      "INTERRUPT",
      "KILL",
      "QUESTION",
      "INSTRUCTION",
      "CROSS_REPO_QUESTION",
    ];
    for (const kind of kinds) {
      expect(describeDispatchJobKind(kind).length).toBeGreaterThan(0);
    }
  });
});

describe("isCancelableDispatchJobStatus", () => {
  it("running以降は取り消せない（中途半端なworktreeが残るため）", () => {
    expect(isCancelableDispatchJobStatus("QUEUED")).toBe(true);
    expect(isCancelableDispatchJobStatus("CLAIMED")).toBe(true);
    expect(isCancelableDispatchJobStatus("RUNNING")).toBe(false);
    expect(isCancelableDispatchJobStatus("SUCCEEDED")).toBe(false);
    // 見送りは終わった状態（#1229）。取り消す対象は残っていない
    expect(isCancelableDispatchJobStatus("SKIPPED")).toBe(false);
  });

  // 見送られたジョブが未完了のままだと、activeKeyが残って次のジョブを積めなくなる
  it("見送りは未完了ではない", () => {
    expect(isActiveDispatchJobStatus("SKIPPED")).toBe(false);
  });
});

describe("findDispatchJobForIssue", () => {
  function job(overrides: Partial<DispatchJobView>): DispatchJobView {
    return {
      id: "job",
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 1180,
      issueTitle: null,
      issueId: null,
      targetHost: "subpc",
      kind: "LAUNCH",
      status: "QUEUED",
      message: null,
      instruction: null,
      command: null,
      manualStepLine: null,
      targetJobId: null,
      exitCode: null,
      commandOutput: null,
      tmuxSessionName: null,
      queuePriority: 0,
      createdAt: "2026-08-14T00:00:00.000Z",
      claimedAt: null,
      startedAt: null,
      finishedAt: null,
      ...overrides,
    };
  }

  it("他のIssue・他のリポジトリのジョブは拾わない", () => {
    const jobs = [job({ id: "other-issue", issueNumber: 1179 }), job({ id: "mine" })];
    expect(findDispatchJobForIssue(jobs, "guchi-apps/issue-deck", 1180)?.id).toBe("mine");
    expect(findDispatchJobForIssue(jobs, "guchi-apps/car-care", 1180)).toBeNull();
  });

  it("未完了のジョブを、より新しい終了済みジョブより優先する", () => {
    const jobs = [
      job({ id: "finished", status: "FAILED", createdAt: "2026-08-14T01:00:00.000Z" }),
      job({ id: "active", status: "QUEUED", createdAt: "2026-08-14T00:00:00.000Z" }),
    ];
    expect(findDispatchJobForIssue(jobs, "guchi-apps/issue-deck", 1180)?.id).toBe("active");
  });

  // 押した結果が消えると「押しても何も起きなかった」と区別が付かない
  it("未完了が無ければ直近のジョブを返す", () => {
    const jobs = [
      job({ id: "old", status: "SUCCEEDED", createdAt: "2026-08-13T00:00:00.000Z" }),
      job({ id: "new", status: "FAILED", createdAt: "2026-08-14T00:00:00.000Z" }),
    ];
    expect(findDispatchJobForIssue(jobs, "guchi-apps/issue-deck", 1180)?.id).toBe("new");
  });

  // 混ざると、停止を押した瞬間に「未完了ジョブがある」と見なされて起動が塞がる（#1332）
  it("制御ジョブ（停止・終了）は拾わない", () => {
    const jobs = [job({ id: "control", kind: "INTERRUPT" })];
    expect(findDispatchJobForIssue(jobs, "guchi-apps/issue-deck", 1180)).toBeNull();
    expect(findSessionControlJobForIssue(jobs, "guchi-apps/issue-deck", 1180)?.id).toBe("control");
  });

  // 質問は実装中に割り込んで聞くための機能なので、拾うと質問した瞬間に実装の起動が塞がる（#1294）
  it("質問ジョブはどちらの側も拾わない", () => {
    const jobs = [job({ id: "question", kind: "QUESTION" })];
    expect(findDispatchJobForIssue(jobs, "guchi-apps/issue-deck", 1180)).toBeNull();
    expect(findSessionControlJobForIssue(jobs, "guchi-apps/issue-deck", 1180)).toBeNull();
  });

  it("制御ジョブの側は起動ジョブを拾わない", () => {
    const jobs = [job({ id: "launch", kind: "LAUNCH" })];
    expect(findSessionControlJobForIssue(jobs, "guchi-apps/issue-deck", 1180)).toBeNull();
  });
});

describe("セッションの操作（#1332）", () => {
  function host(
    overrides: Partial<
      Pick<DispatchHostView, "online" | "sessionControlCapable" | "instructionCapable">
    > = {},
  ): Pick<DispatchHostView, "online" | "sessionControlCapable" | "instructionCapable"> {
    return { online: true, sessionControlCapable: true, instructionCapable: true, ...overrides };
  }

  function sessionState(state: DispatchSessionView["state"]): Pick<DispatchSessionView, "state"> {
    return { state };
  }

  describe("parseDispatchJobKind", () => {
    // 既存の呼び出し元（一括投入・実装開始ダイアログ）は`kind`を送らない
    it("省略時は起動ジョブ", () => {
      expect(parseDispatchJobKind(undefined)).toBe("LAUNCH");
      expect(parseDispatchJobKind(null)).toBe("LAUNCH");
      expect(parseDispatchJobKind("launch")).toBe("LAUNCH");
    });

    it("停止・終了・質問・追加指示を受け入れ、それ以外は弾く", () => {
      expect(parseDispatchJobKind("interrupt")).toBe("INTERRUPT");
      expect(parseDispatchJobKind("kill")).toBe("KILL");
      // 種別としては読めるが、積む受け口（POST /api/dispatch）はまだ開いていない（#1294）
      expect(parseDispatchJobKind("question")).toBe("QUESTION");
      expect(parseDispatchJobKind("instruction")).toBe("INSTRUCTION");
      expect(parseDispatchJobKind("INTERRUPT")).toBeNull();
      expect(parseDispatchJobKind("restart")).toBeNull();
      expect(parseDispatchJobKind(1)).toBeNull();
    });
  });

  describe("parseSessionInstruction（#1012）", () => {
    it("1行の本文は前後の空白を落として通す", () => {
      expect(parseSessionInstruction("  計画を承認します。実装に進んでください。  ")).toBe(
        "計画を承認します。実装に進んでください。",
      );
    });

    // 複数行は確定キーの解釈が画面の実装に依存し、途中の改行が意図せず1回目の送信になりうる
    it("改行・タブ・制御文字を含む本文は弾く", () => {
      expect(parseSessionInstruction("1行目\n2行目")).toBeNull();
      expect(parseSessionInstruction("前\r後")).toBeNull();
      expect(parseSessionInstruction("前\t後")).toBeNull();
      // 端末へ生のエスケープシーケンスを流す経路にしない
      expect(parseSessionInstruction("\u001b[31m赤\u001b[0m")).toBeNull();
      expect(parseSessionInstruction("消\u007f")).toBeNull();
    });

    it("空・空白だけ・長すぎる本文・文字列以外は弾く", () => {
      expect(parseSessionInstruction("")).toBeNull();
      expect(parseSessionInstruction("   ")).toBeNull();
      expect(parseSessionInstruction("あ".repeat(501))).toBeNull();
      expect(parseSessionInstruction("あ".repeat(500))).toHaveLength(500);
      expect(parseSessionInstruction(undefined)).toBeNull();
      expect(parseSessionInstruction(42)).toBeNull();
    });
  });

  describe("buildDispatchActiveKey", () => {
    // 前置きを付けないと、停止のジョブが起動ジョブとunique制約でぶつかる
    it("種別ごとに名前空間を分ける", () => {
      expect(buildDispatchActiveKey("guchi-apps/issue-deck", 1332)).toBe(
        "guchi-apps/issue-deck#1332",
      );
      expect(buildDispatchActiveKey("guchi-apps/issue-deck", 1332, "LAUNCH")).toBe(
        "guchi-apps/issue-deck#1332",
      );
      expect(buildDispatchActiveKey("guchi-apps/issue-deck", 1332, "INTERRUPT")).toBe(
        "interrupt:guchi-apps/issue-deck#1332",
      );
      expect(buildDispatchActiveKey("guchi-apps/issue-deck", 1332, "KILL")).toBe(
        "kill:guchi-apps/issue-deck#1332",
      );
      expect(buildDispatchActiveKey("guchi-apps/issue-deck", 1012, "INSTRUCTION")).toBe(
        "instruction:guchi-apps/issue-deck#1012",
      );
    });

    // キーを取ると、実装ジョブが走っているIssueに質問を積めなくなる（#1294）
    it("質問ジョブはキーを取らない", () => {
      expect(buildDispatchActiveKey("guchi-apps/issue-deck", 1294, "QUESTION")).toBeNull();
    });
  });

  describe("resolveSessionControlRejection", () => {
    it("生きているセッションなら停止も終了もできる", () => {
      expect(
        resolveSessionControlRejection({
          host: host(),
          session: sessionState("ALIVE"),
          kind: "INTERRUPT",
          hasActiveControlJob: false,
        }),
      ).toBeNull();
      expect(
        resolveSessionControlRejection({
          host: host(),
          session: sessionState("ALIVE"),
          kind: "KILL",
          hasActiveControlJob: false,
        }),
      ).toBeNull();
    });

    // 古いpollerは`kind`を読まず、制御ジョブを起動ジョブとして解釈してしまう
    it("申告していないpollerでは操作させない", () => {
      expect(
        resolveSessionControlRejection({
          host: host({ sessionControlCapable: null }),
          session: sessionState("ALIVE"),
          kind: "KILL",
          hasActiveControlJob: false,
        }),
      ).toBe("session_control_unsupported");
    });

    it("応答していないホストは理由が先に立つ", () => {
      expect(
        resolveSessionControlRejection({
          host: host({ online: false }),
          session: sessionState("ALIVE"),
          kind: "KILL",
          hasActiveControlJob: false,
        }),
      ).toBe("host_offline");
    });

    // 終了したペインが残っているセッションは「閉じる」で片付けられる
    it("終了済みのセッションは停止できないが閉じられる", () => {
      expect(
        resolveSessionControlRejection({
          host: host(),
          session: sessionState("EXITED"),
          kind: "INTERRUPT",
          hasActiveControlJob: false,
        }),
      ).toBe("session_not_alive");
      expect(
        resolveSessionControlRejection({
          host: host(),
          session: sessionState("EXITED"),
          kind: "KILL",
          hasActiveControlJob: false,
        }),
      ).toBeNull();
    });

    it("消えたセッション・記録の無いセッションは操作できない", () => {
      expect(
        resolveSessionControlRejection({
          host: host(),
          session: sessionState("GONE"),
          kind: "KILL",
          hasActiveControlJob: false,
        }),
      ).toBe("session_not_found");
      expect(
        resolveSessionControlRejection({
          host: host(),
          session: null,
          kind: "KILL",
          hasActiveControlJob: false,
        }),
      ).toBe("session_not_found");
    });

    // #1012。停止・終了に対応していても、内容のある文字列を送るのは別の実装
    it("追加指示は instructionCapable を申告したホストにだけ送れる", () => {
      expect(
        resolveSessionControlRejection({
          host: host(),
          session: sessionState("ALIVE"),
          kind: "INSTRUCTION",
          hasActiveControlJob: false,
        }),
      ).toBeNull();
      expect(
        resolveSessionControlRejection({
          host: host({ instructionCapable: null }),
          session: sessionState("ALIVE"),
          kind: "INSTRUCTION",
          hasActiveControlJob: false,
        }),
      ).toBe("instruction_unsupported");
      // 逆向きも独立している（停止・終了に未対応でも追加指示は送れる）
      expect(
        resolveSessionControlRejection({
          host: host({ sessionControlCapable: null }),
          session: sessionState("ALIVE"),
          kind: "INSTRUCTION",
          hasActiveControlJob: false,
        }),
      ).toBeNull();
    });

    // 死んだペインには送る相手がいない
    it("終了済みのセッションには追加指示を送れない", () => {
      expect(
        resolveSessionControlRejection({
          host: host(),
          session: sessionState("EXITED"),
          kind: "INSTRUCTION",
          hasActiveControlJob: false,
        }),
      ).toBe("session_not_alive");
    });

    // スマホでの連打が、そのぶんの`C-c`にならないようにする
    it("未処理の操作があれば重ねて積ませない", () => {
      expect(
        resolveSessionControlRejection({
          host: host(),
          session: sessionState("ALIVE"),
          kind: "INTERRUPT",
          hasActiveControlJob: true,
        }),
      ).toBe("already_queued");
    });
  });

  describe("describeDispatchJobStatus", () => {
    // 「起動しました」のままだと、停止を押したのに起動したように読める
    it("制御ジョブは種別に合わせた文言になる", () => {
      expect(describeDispatchJobStatus("QUEUED", "INTERRUPT").label).toBe("停止を送信しました");
      expect(describeDispatchJobStatus("SUCCEEDED", "INTERRUPT").label).toBe("停止を送りました");
      expect(describeDispatchJobStatus("SUCCEEDED", "KILL").label).toBe("セッションを閉じました");
      expect(describeDispatchJobStatus("SUCCEEDED").label).toBe("起動しました");
    });

    // 止めたかったものが既に無いだけで、何も壊れていない
    it("対象が無かった場合は赤くしない", () => {
      expect(describeDispatchJobStatus("SKIPPED", "KILL").tone).toBe("muted");
    });
  });

  describe("describeSessionControlRejection", () => {
    it("pollerが古い場合は何をすれば押せるようになるかまで書く", () => {
      const message = describeSessionControlRejection("session_control_unsupported", {
        hostName: "subpc",
        kind: "KILL",
      });
      expect(message).toContain("サブPC");
      expect(message).toContain("poller");
    });
  });
});

describe("resolveScreenshotRejection（#1268）", () => {
  function host(overrides: Partial<DispatchHostView> = {}): DispatchHostView {
    return {
      name: "subpc",
      repositories: ["guchi-apps/issue-deck"],
      contractVersion: 2,
      online: true,
      lastSeenAt: "2026-08-14T00:00:00Z",
      screenshotCapable: true,
      sessionControlCapable: true,
      instructionCapable: true,
      crossRepoQuestionCapable: true,
      manualStepCapable: null,
      manualStepAbortCapable: null,
      planReviewCapable: null,
      selfUpdateCapable: null,
      maxSessions: 12,
      liveSessions: 0,
      metrics: null,
      checkout: null,
      ...overrides,
    };
  }

  it("撮れるホストでは塞がない", () => {
    expect(resolveScreenshotRejection(host())).toBeNull();
  });

  it("撮れないと申告しているホストでは理由を返す", () => {
    expect(resolveScreenshotRejection(host({ screenshotCapable: false }))).toContain(
      "Playwright",
    );
  });

  // 判定材料が無いことと「撮れない」ことは違う
  it("申告していないホスト（古いpoller）は塞がない", () => {
    expect(resolveScreenshotRejection(host({ screenshotCapable: null }))).toBeNull();
  });

  it("ホストを選んでいない（GitHub Actions等）なら塞がない", () => {
    expect(resolveScreenshotRejection(null)).toBeNull();
  });
});

/**
 * #1454。**起動ジョブ（`resolveDispatchTargetRejection`）とは判定が違う。** 横断質問セッションは
 * worktreeを作らず、記録先リポジトリへは`gh issue comment`で書くだけなので、記録先が
 * サブPCにcloneされている必要が無い。代わりに「参照できるリポジトリが1件以上あるか」を見る。
 */
describe("横断質問（#1454）", () => {
  function host(
    overrides: Partial<
      Pick<DispatchHostView, "online" | "crossRepoQuestionCapable" | "repositories">
    > = {},
  ): Pick<DispatchHostView, "online" | "crossRepoQuestionCapable" | "repositories"> {
    return {
      online: true,
      crossRepoQuestionCapable: true,
      repositories: ["guchi-apps/issue-deck", "guchi-apps/ops-dashboard"],
      ...overrides,
    };
  }

  function hostView(overrides: Partial<DispatchHostView> = {}): DispatchHostView {
    return {
      name: "subpc",
      repositories: ["guchi-apps/issue-deck"],
      contractVersion: 1,
      online: true,
      lastSeenAt: "2026-08-15T00:00:00Z",
      screenshotCapable: true,
      sessionControlCapable: true,
      instructionCapable: true,
      crossRepoQuestionCapable: true,
      manualStepCapable: null,
      manualStepAbortCapable: null,
      planReviewCapable: null,
      selfUpdateCapable: null,
      maxSessions: 12,
      liveSessions: 0,
      metrics: null,
      checkout: null,
      ...overrides,
    };
  }

  it("種別として受け付ける", () => {
    expect(parseDispatchJobKind("cross_repo_question")).toBe("CROSS_REPO_QUESTION");
  });

  // 実装ジョブと名前空間を分ける（実装中のIssueへも質問を積めるように）
  it("activeKeyは専用の名前空間を持つ", () => {
    expect(buildDispatchActiveKey("guchi-apps/question", 12, "CROSS_REPO_QUESTION")).toBe(
      "cross_repo_question:guchi-apps/question#12",
    );
  });

  // 起動ジョブと寿命の意味が同じ（succeededは「セッションが立った」まで）ことを文言で示す
  it("succeededは「起動しました」と読める文言にする", () => {
    expect(describeDispatchJobStatus("SUCCEEDED", "CROSS_REPO_QUESTION")).toEqual({
      label: "質問セッションを起動しました",
      tone: "success",
    });
  });

  it("条件が揃っていれば押せる", () => {
    expect(
      resolveCrossRepoQuestionRejection({ host: host(), hasActiveJob: false, blockingSession: null }),
    ).toBeNull();
  });

  it("記録先がそのホストで実行できるかは問わない", () => {
    // 申告に`question`リポジトリが無くても押せる（cloneが要らないため）
    expect(
      resolveCrossRepoQuestionRejection({
        host: host({ repositories: ["guchi-apps/issue-deck"] }),
        hasActiveJob: false,
        blockingSession: null,
      }),
    ).toBeNull();
  });

  it("参照できるリポジトリが1つも無ければ押せない", () => {
    expect(
      resolveCrossRepoQuestionRejection({
        host: host({ repositories: [] }),
        hasActiveJob: false,
        blockingSession: null,
      }),
    ).toBe("no_runnable_repositories");
  });

  // 未申告（古いpoller）は「できない」側へ倒す。配ると未知の種別として失敗し、質問が失われる
  it("申告していないpollerには押せない", () => {
    expect(
      resolveCrossRepoQuestionRejection({
        host: host({ crossRepoQuestionCapable: null }),
        hasActiveJob: false,
        blockingSession: null,
      }),
    ).toBe("cross_repo_question_unsupported");
  });

  it("応答していないホストには押せない", () => {
    expect(
      resolveCrossRepoQuestionRejection({
        host: host({ online: false }),
        hasActiveJob: false,
        blockingSession: null,
      }),
    ).toBe("host_offline");
  });

  it("既に動いているセッションがあれば押せない", () => {
    expect(
      resolveCrossRepoQuestionRejection({
        host: host(),
        hasActiveJob: false,
        blockingSession: { host: "subpc", tmuxSessionName: "question-issue-12" },
      }),
    ).toBe("session_alive");
  });

  it("理由には何をすれば押せるようになるかを書く", () => {
    expect(
      describeCrossRepoQuestionRejection("cross_repo_question_unsupported", { hostName: "subpc" }),
    ).toContain("更新してから");
  });

  it("既定の起動先は選べるホストの先頭", () => {
    expect(
      resolveDefaultCrossRepoQuestionHost([
        hostView({ name: "old-host", crossRepoQuestionCapable: null }),
        hostView({ name: "subpc" }),
      ]),
    ).toBe("subpc");
  });

  it("選べるホストが無ければnull（GitHub Actionsへのフォールバックは無い）", () => {
    expect(
      resolveDefaultCrossRepoQuestionHost([hostView({ crossRepoQuestionCapable: false })]),
    ).toBeNull();
  });

  // 起動ジョブの未完了判定に混ざると、質問を積んだ瞬間に実装の起動が押せなくなる
  it("起動ジョブとは別に取り出す", () => {
    const jobs: DispatchJobView[] = [
      {
        id: "question-1",
        repositoryFullName: "guchi-apps/question",
        issueNumber: 12,
        issueTitle: null,
        issueId: null,
        targetHost: "subpc",
        kind: "CROSS_REPO_QUESTION",
        status: "QUEUED",
        message: null,
        instruction: null,
        command: null,
        manualStepLine: null,
        targetJobId: null,
        exitCode: null,
        commandOutput: null,
        tmuxSessionName: null,
        queuePriority: 0,
        createdAt: "2026-08-15T00:00:00Z",
        claimedAt: null,
        startedAt: null,
        finishedAt: null,
      },
    ];
    expect(findCrossRepoQuestionJobForIssue(jobs, "guchi-apps/question", 12)?.id).toBe("question-1");
    expect(findDispatchJobForIssue(jobs, "guchi-apps/question", 12)).toBeNull();
  });
});

/**
 * 計画の関門（G1・#1855）。**計画コメントの投稿を契機に自動で積まれる**ジョブなので、
 * 「動いているセッションでは弾かない」ことがこの種別の要点になる。
 */
describe("計画レビュー（PLAN_REVIEW）", () => {
  function host(
    overrides: Partial<Pick<DispatchHostView, "online" | "planReviewCapable" | "repositories">> = {},
  ): Pick<DispatchHostView, "online" | "planReviewCapable" | "repositories"> {
    return {
      online: true,
      planReviewCapable: true,
      repositories: ["guchi-apps/issue-deck"],
      ...overrides,
    };
  }

  function hostView(overrides: Partial<DispatchHostView> = {}): DispatchHostView {
    return {
      name: "subpc",
      repositories: ["guchi-apps/issue-deck"],
      contractVersion: 1,
      online: true,
      lastSeenAt: "2026-08-17T00:00:00Z",
      screenshotCapable: true,
      sessionControlCapable: true,
      instructionCapable: true,
      crossRepoQuestionCapable: true,
      manualStepCapable: true,
      manualStepAbortCapable: null,
      planReviewCapable: true,
      selfUpdateCapable: null,
      maxSessions: 12,
      liveSessions: 0,
      metrics: null,
      checkout: null,
      ...overrides,
    };
  }

  it("種別として受け付ける", () => {
    expect(parseDispatchJobKind("plan_review")).toBe("PLAN_REVIEW");
  });

  // 実装ジョブと名前空間を分ける（実装ジョブが走っているIssueにもレビューを積めるように）
  it("activeKeyは専用の名前空間を持つ", () => {
    expect(buildDispatchActiveKey("guchi-apps/issue-deck", 1855, "PLAN_REVIEW")).toBe(
      "plan_review:guchi-apps/issue-deck#1855",
    );
  });

  // tmuxセッションを立てるジョブなので、枠（同時実行数）を消費する側に入る
  it("セッションを立てるジョブとして数える", () => {
    expect(isSessionLaunchJobKind("PLAN_REVIEW")).toBe(true);
    expect(isSessionControlJobKind("PLAN_REVIEW")).toBe(false);
  });

  it("キューでは「計画レビュー」として並ぶ", () => {
    expect(describeDispatchJobKind("PLAN_REVIEW")).toBe("計画レビュー");
    expect(describeDispatchJobStatus("SUCCEEDED", "PLAN_REVIEW")).toEqual({
      label: "計画レビューを起動しました",
      tone: "success",
    });
  });

  it("条件が揃っていれば押せる", () => {
    expect(
      resolvePlanReviewRejection({
        host: host(),
        repositoryFullName: "guchi-apps/issue-deck",
        hasActiveJob: false,
      }),
    ).toBeNull();
  });

  // 未申告（古いpoller）は「できない」側へ倒す。自動で積まれる種別なので、配ると計画のたびに
  // 失敗したジョブが並ぶ
  it("申告していないpollerには押せない", () => {
    expect(
      resolvePlanReviewRejection({
        host: host({ planReviewCapable: null }),
        repositoryFullName: "guchi-apps/issue-deck",
        hasActiveJob: false,
      }),
    ).toBe("plan_review_unsupported");
  });

  // 横断質問と違い、対象リポジトリのコードを読むのでcloneが要る
  it("そのホストで実行できないリポジトリでは押せない", () => {
    expect(
      resolvePlanReviewRejection({
        host: host(),
        repositoryFullName: "guchi-apps/car-care",
        hasActiveJob: false,
      }),
    ).toBe("repository_not_runnable");
  });

  it("応答していないホストには押せない", () => {
    expect(
      resolvePlanReviewRejection({
        host: host({ online: false }),
        repositoryFullName: "guchi-apps/issue-deck",
        hasActiveJob: false,
      }),
    ).toBe("host_offline");
  });

  it("未処理の計画レビューがあれば押せない", () => {
    expect(
      resolvePlanReviewRejection({
        host: host(),
        repositoryFullName: "guchi-apps/issue-deck",
        hasActiveJob: true,
      }),
    ).toBe("already_queued");
  });

  it("理由には何をすれば押せるようになるかを書く", () => {
    expect(describePlanReviewRejection("plan_review_unsupported", { hostName: "subpc" })).toContain(
      "更新してから",
    );
  });

  it("既定の起動先はそのリポジトリを実行できるホストの先頭", () => {
    expect(
      resolveDefaultPlanReviewHost(
        [
          hostView({ name: "old-host", planReviewCapable: null }),
          hostView({ name: "other", repositories: ["guchi-apps/car-care"] }),
          hostView({ name: "subpc" }),
        ],
        "guchi-apps/issue-deck",
      ),
    ).toBe("subpc");
  });

  it("選べるホストが無ければnull（GitHub Actionsへのフォールバックは無い）", () => {
    expect(
      resolveDefaultPlanReviewHost([hostView({ planReviewCapable: false })], "guchi-apps/issue-deck"),
    ).toBeNull();
  });

  // 起動ジョブの未完了判定に混ざると、計画を出した瞬間に実装の起動が押せなくなる
  it("起動ジョブとは別に取り出す", () => {
    const jobs: DispatchJobView[] = [
      {
        id: "plan-review-1",
        repositoryFullName: "guchi-apps/issue-deck",
        issueNumber: 1855,
        issueTitle: null,
        issueId: null,
        targetHost: "subpc",
        kind: "PLAN_REVIEW",
        status: "QUEUED",
        message: null,
        instruction: null,
        command: null,
        manualStepLine: null,
        targetJobId: null,
        exitCode: null,
        commandOutput: null,
        tmuxSessionName: null,
        queuePriority: 0,
        createdAt: "2026-08-17T00:00:00Z",
        claimedAt: null,
        startedAt: null,
        finishedAt: null,
      },
    ];
    expect(findPlanReviewJobForIssue(jobs, "guchi-apps/issue-deck", 1855)?.id).toBe("plan-review-1");
    expect(findDispatchJobForIssue(jobs, "guchi-apps/issue-deck", 1855)).toBeNull();
  });
});

/**
 * 手作業の代行実行（#1828）の可否。**画面とAPIが同じ関数を使う**ので、押せるのに拒否される
 * （その逆も）が生まれない。判定の**順番**にも意味がある。
 */
describe("resolveManualStepExecutionRejection", () => {
  function params(overrides: Record<string, unknown> = {}) {
    return {
      host: { online: true, manualStepCapable: true },
      isManualStepIssue: true,
      isSubpcDevice: true,
      hasCommand: true,
      interactiveCommand: null,
      hasActiveJob: false,
      ...overrides,
    } as Parameters<typeof resolveManualStepExecutionRejection>[0];
  }

  it("条件が揃っていれば押せる", () => {
    expect(resolveManualStepExecutionRejection(params())).toBeNull();
  });

  // **Issueと手順の性質を先に見る。** ホストの都合（更新すれば押せる）と違い、こちらは
  // そもそも代行の対象外で、ホストの状態を理由に出しても直す手がかりにならない
  it("Issue・手順の理由をホストの理由より先に出す", () => {
    expect(
      resolveManualStepExecutionRejection(params({ isSubpcDevice: false, host: null })),
    ).toBe("device_not_subpc");
    expect(
      resolveManualStepExecutionRejection(
        params({ hasCommand: false, host: { online: false, manualStepCapable: null } }),
      ),
    ).toBe("no_command");
  });

  // 更新すれば押せるようになるものではない（人が実行するしかない）ので、ホストの理由より先に出す
  it("対話が要るコマンドはホストの理由より先に出す", () => {
    expect(
      resolveManualStepExecutionRejection(
        params({ interactiveCommand: "op signin", host: null }),
      ),
    ).toBe("interactive_command");
    // どのコマンドで引っかかったのかを文面に出す
    expect(
      describeManualStepExecutionRejection("interactive_command", {
        hostName: "subpc",
        interactiveCommand: "op signin",
      }),
    ).toContain("op signin");
  });

  it("手作業Issueでなければ代行しない", () => {
    expect(resolveManualStepExecutionRejection(params({ isManualStepIssue: false }))).toBe(
      "not_manual_step",
    );
  });

  // 未申告（古いpoller）は「できない」として扱う。配ると未知の種別として失敗になる
  it("申告していないpollerには押させない", () => {
    expect(
      resolveManualStepExecutionRejection(
        params({ host: { online: true, manualStepCapable: null } }),
      ),
    ).toBe("manual_step_unsupported");
    expect(
      resolveManualStepExecutionRejection(
        params({ host: { online: false, manualStepCapable: true } }),
      ),
    ).toBe("host_offline");
    expect(resolveManualStepExecutionRejection(params({ host: null }))).toBe("host_unknown");
  });

  // activeKeyはIssue単位。順番に実行する前提の手順が入れ替わらないようにする
  it("同じIssueに未処理の代行実行があれば押させない", () => {
    expect(resolveManualStepExecutionRejection(params({ hasActiveJob: true }))).toBe(
      "already_queued",
    );
  });
});

/**
 * 代行実行の実行先（#1828）。**実行できるリポジトリは見ない**——代行するのはホスト上の
 * コマンドで、worktreeを作るわけではない。
 */
describe("resolveManualStepHost", () => {
  function hostFor(overrides: Partial<DispatchHostView> = {}): DispatchHostView {
    return {
      name: "subpc",
      online: true,
      manualStepCapable: true,
      manualStepAbortCapable: null,
      planReviewCapable: null,
      selfUpdateCapable: null,
      repositories: [],
      ...overrides,
    } as DispatchHostView;
  }

  it("対応していて応答しているホストを選ぶ", () => {
    const hosts = [
      hostFor({ name: "oldpc", manualStepCapable: null }),
      hostFor({ name: "subpc" }),
    ];
    expect(resolveManualStepHost(hosts)?.name).toBe("subpc");
  });

  // 押せない理由（未対応・応答なし）を出すのに相手の名前が要る
  it("対応しているホストが無ければ先頭を返す", () => {
    const hosts = [hostFor({ name: "oldpc", manualStepCapable: null })];
    expect(resolveManualStepHost(hosts)?.name).toBe("oldpc");
    expect(resolveManualStepHost([])).toBeNull();
  });
});

describe("チェックアウトの更新（#1875）", () => {
  it("更新ジョブの活性キーはホストで一意になる", () => {
    // **Issueではなくホストで一意にする。** 同じホストへ二重に積むと、1本目の再起動中に
    // 2本目が届いて中途半端な状態になる
    expect(buildSelfUpdateActiveKey("subpc")).toBe("self_update:host:subpc");
    expect(buildSelfUpdateActiveKey("subpc")).not.toBe(buildSelfUpdateActiveKey("subpc2"));
  });

  it("Issue単位のキーと混ざらない", () => {
    // 埋め草の`issue-deck#0`で作ったキーと衝突すると、Issue側の操作と取り合いになる
    expect(buildSelfUpdateActiveKey("subpc")).not.toBe(
      buildDispatchActiveKey(SELF_UPDATE_REPOSITORY, SELF_UPDATE_ISSUE_NUMBER, "SELF_UPDATE"),
    );
  });

  it("`self_update`を種別として読める", () => {
    expect(parseDispatchJobKind("self_update")).toBe("SELF_UPDATE");
  });

  it("セッションを立てない種別として扱う", () => {
    // 枠外で払い出し、QUEUEDのまま5分で失効させる（手作業の代行と同じ性質）
    expect(isOutOfBandJobKind("SELF_UPDATE")).toBe(true);
    expect(isSessionLaunchJobKind("SELF_UPDATE")).toBe(false);
  });

  it("画面に出す名前を持つ", () => {
    expect(describeDispatchJobKind("SELF_UPDATE")).toBe("チェックアウトの更新");
  });
});
