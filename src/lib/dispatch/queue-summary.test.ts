import { describe, expect, it } from "vitest";

import type { DispatchHostView, DispatchJobView } from "@/lib/dispatch/dispatch-job";
import {
  cancelableDispatchJobs,
  countDispatchQueueBadge,
  describeDispatchJobWaitReason,
  describeDispatchQueueLoad,
  describeDispatchQueueStall,
  describeDispatchSessionLoad,
  selectHostCodexPairingJob,
  selectHostSelfUpdateJob,
  selectHostSessions,
  summarizeDispatchQueue,
  summarizeDispatchSessionCapacity,
} from "@/lib/dispatch/queue-summary";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";

function job(overrides: Partial<DispatchJobView> = {}): DispatchJobView {
  return {
    id: "job-1",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 1,
    issueTitle: null,
    issueId: null,
    targetHost: "subpc",
    agent: "claude",
    claudeModel: null,
    kind: "LAUNCH",
    status: "QUEUED",
    message: null,
    instruction: null,
    command: null,
    placeholderValues: null,
    resolvedCommand: null,
    manualStepLine: null,
    targetJobId: null,
    previewAction: null,
    exitCode: null,
    commandOutput: null,
    codexPairingCode: null,
    codexPairingExpiresAt: null,
    tmuxSessionName: null,
    queuePriority: 0,
    createdAt: "2026-08-14T00:00:00.000Z",
    claimedAt: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

function host(overrides: Partial<DispatchHostView> = {}): DispatchHostView {
  return {
    name: "subpc",
    repositories: ["guchi-apps/issue-deck"],
    contractVersion: 1,
    online: true,
    lastSeenAt: "2026-08-14T00:00:00.000Z",
    screenshotCapable: true,
    sessionControlCapable: true,
    instructionCapable: true,
    crossRepoQuestionCapable: true,
    manualStepCapable: null,
    manualStepAbortCapable: null,
    manualStepValuesCapable: null,
    planReviewCapable: null,
    codeReviewCapable: null,
    codexCapable: null,
    codexRemoteControlCapable: null,
    manualStepSessionCapable: null,
    selfUpdateCapable: null,
    previewCapable: null,
    rebootCapable: null,
    reboot: null,
    previewRepositories: null,
    preview: null,
    maxSessions: 12,
    liveSessions: 3,
    metrics: null,
    launchHold: null,
    checkout: null,
    ...overrides,
  };
}

function session(overrides: Partial<DispatchSessionView> = {}): DispatchSessionView {
  return {
    host: "subpc",
    tmuxSessionName: "issue-deck-issue-1",
    repositoryFullName: "guchi-apps/issue-deck",
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

describe("summarizeDispatchQueue", () => {
  it("待機は積んだ順（＝払い出される順）に並べる", () => {
    const summary = summarizeDispatchQueue(
      [
        job({ id: "c", createdAt: "2026-08-14T03:00:00.000Z" }),
        job({ id: "a", createdAt: "2026-08-14T01:00:00.000Z" }),
        job({ id: "b", createdAt: "2026-08-14T02:00:00.000Z" }),
      ],
      2,
    );
    expect(summary.queued.map((j) => j.id)).toEqual(["a", "b", "c"]);
  });

  // 先頭へ上げる（#1541）。払い出し（claimDispatchJob）と同じ並びでないと、画面に見えている
  // 順番と実際に走る順番が食い違う
  it("先頭へ上げたジョブは、積んだ順より先に並べる", () => {
    const summary = summarizeDispatchQueue(
      [
        job({ id: "a", createdAt: "2026-08-14T01:00:00.000Z" }),
        job({ id: "b", createdAt: "2026-08-14T02:00:00.000Z" }),
        job({ id: "c", createdAt: "2026-08-14T03:00:00.000Z", queuePriority: 1 }),
      ],
      2,
    );
    expect(summary.queued.map((j) => j.id)).toEqual(["c", "a", "b"]);
  });

  // 「直近の失敗」で見たいのは順番ではなく直近かどうか
  it("先頭へ上げたあと失敗しても、直近の失敗は新しい順のまま", () => {
    const summary = summarizeDispatchQueue(
      [
        job({
          id: "old",
          status: "FAILED",
          createdAt: "2026-08-14T01:00:00.000Z",
          queuePriority: 5,
        }),
        job({ id: "new", status: "FAILED", createdAt: "2026-08-14T02:00:00.000Z" }),
      ],
      2,
    );
    expect(summary.failed.map((j) => j.id)).toEqual(["new", "old"]);
  });

  it("CLAIMEDとRUNNINGは実行中として数える", () => {
    const summary = summarizeDispatchQueue(
      [job({ id: "a", status: "CLAIMED" }), job({ id: "b", status: "RUNNING" })],
      2,
    );
    expect(summary.running.map((j) => j.id)).toEqual(["a", "b"]);
    expect(summary.activeCount).toBe(2);
  });

  it("失敗とタイムアウトは新しい順に出す", () => {
    const summary = summarizeDispatchQueue(
      [
        job({ id: "old", status: "FAILED", createdAt: "2026-08-14T01:00:00.000Z" }),
        job({ id: "new", status: "TIMEOUT", createdAt: "2026-08-14T02:00:00.000Z" }),
      ],
      2,
    );
    expect(summary.failed.map((j) => j.id)).toEqual(["new", "old"]);
  });

  it("成功したジョブはキューに含めない（バッジが減らなくなる）", () => {
    const summary = summarizeDispatchQueue([job({ status: "SUCCEEDED" })], 2);
    expect(summary.activeCount).toBe(0);
    expect(summary.failed).toHaveLength(0);
  });

  // 起動ジョブ以外は同時実行数の枠を使わない（#1332の制御ジョブと同じ理由。#1294）
  it("制御ジョブと質問ジョブは数えない", () => {
    const summary = summarizeDispatchQueue(
      [job({ id: "control", kind: "INTERRUPT" }), job({ id: "question", kind: "QUESTION" })],
      2,
    );
    expect(summary.activeCount).toBe(0);
    expect(summary.queued).toHaveLength(0);
  });

  // 横断質問（#1454）は`LAUNCH`と同じ枠で走る（`claimDispatchJobs`）。数えないと、枠が
  // 埋まっているのに「実行中 0/2」と出る（#1544）
  it("横断質問ジョブも実行中・順番待ちとして数える", () => {
    const summary = summarizeDispatchQueue(
      [
        job({ id: "running", kind: "CROSS_REPO_QUESTION", status: "RUNNING" }),
        job({
          id: "queued",
          kind: "CROSS_REPO_QUESTION",
          createdAt: "2026-08-14T02:00:00.000Z",
        }),
      ],
      2,
    );
    expect(summary.running.map((j) => j.id)).toEqual(["running"]);
    expect(summary.queued.map((j) => j.id)).toEqual(["queued"]);
    expect(summary.activeCount).toBe(2);
  });

  it("横断質問ジョブと起動ジョブは走る順で1つに並べる", () => {
    const summary = summarizeDispatchQueue(
      [
        job({ id: "launch", createdAt: "2026-08-14T02:00:00.000Z" }),
        job({
          id: "question",
          kind: "CROSS_REPO_QUESTION",
          createdAt: "2026-08-14T01:00:00.000Z",
        }),
      ],
      2,
    );
    expect(summary.queued.map((j) => j.id)).toEqual(["question", "launch"]);
  });

  it("横断質問ジョブの失敗も直近の失敗に出す", () => {
    const summary = summarizeDispatchQueue(
      [job({ id: "question", kind: "CROSS_REPO_QUESTION", status: "FAILED" })],
      2,
    );
    expect(summary.failed.map((j) => j.id)).toEqual(["question"]);
  });

  /**
   * #1519。制御ジョブは枠を使わないので数えないが（#1544）、pull型ぶん届くまで数秒〜30秒あり、
   * その間キューのどこにも出ないと「押したのに何も起きない」に見える。
   * **一覧には出すが、数えない**という分け方が壊れていないことを確かめる。
   */
  describe("制御ジョブ（送信中の操作）", () => {
    it("未完了の制御ジョブをcontrolsへ積んだ順に入れる", () => {
      const summary = summarizeDispatchQueue(
        [
          job({ id: "kill", kind: "KILL", createdAt: "2026-08-14T02:00:00.000Z" }),
          job({ id: "stop", kind: "INTERRUPT", createdAt: "2026-08-14T01:00:00.000Z" }),
          job({
            id: "say",
            kind: "INSTRUCTION",
            status: "CLAIMED",
            createdAt: "2026-08-14T03:00:00.000Z",
          }),
        ],
        2,
      );
      expect(summary.controls.map((j) => j.id)).toEqual(["stop", "kill", "say"]);
    });

    // ここを混ぜると「実行中 3/2」のような数え方になる
    it("controlsは実行中・順番待ち・件数・まとめて取り消しのどれにも混ざらない", () => {
      const summary = summarizeDispatchQueue(
        [job({ id: "stop", kind: "INTERRUPT" }), job({ id: "launch", status: "RUNNING" })],
        2,
      );
      expect(summary.controls.map((j) => j.id)).toEqual(["stop"]);
      expect(summary.queued).toHaveLength(0);
      expect(summary.running.map((j) => j.id)).toEqual(["launch"]);
      expect(summary.activeCount).toBe(1);
      expect(cancelableDispatchJobs(summary)).toHaveLength(0);
      expect(describeDispatchQueueLoad(summary)).toBe("実行中 1/2");
    });

    // 終わった制御ジョブの結果は、そのIssueのセッション表示（issue-session-status.tsx）に出る
    it("終わった制御ジョブは出さない", () => {
      const summary = summarizeDispatchQueue(
        [
          job({ id: "done", kind: "INTERRUPT", status: "SUCCEEDED" }),
          job({ id: "failed", kind: "KILL", status: "FAILED" }),
        ],
        2,
      );
      expect(summary.controls).toHaveLength(0);
      // 制御ジョブの失敗は「直近の失敗」にも出さない（枠を使わないジョブの結果はIssue側が持つ）
      expect(summary.failed).toHaveLength(0);
    });

    // 質問ジョブ（#1294）はセッションを立てず、制御ジョブでもない
    it("質問ジョブはcontrolsにも入れない", () => {
      const summary = summarizeDispatchQueue([job({ id: "q", kind: "QUESTION" })], 2);
      expect(summary.controls).toHaveLength(0);
      expect(summary.activeCount).toBe(0);
    });
  });
});

describe("describeDispatchQueueLoad", () => {
  it("上限が分かれば分母を出す", () => {
    const summary = summarizeDispatchQueue(
      [job({ status: "RUNNING" }), job({ id: "q" })],
      2,
    );
    expect(describeDispatchQueueLoad(summary)).toBe("実行中 1/2・待機 1");
  });

  it("待機が無ければ実行中だけ出す", () => {
    expect(describeDispatchQueueLoad(summarizeDispatchQueue([], 2))).toBe("実行中 0/2");
  });

  it("上限が分からなければ分母を出さない", () => {
    expect(describeDispatchQueueLoad(summarizeDispatchQueue([], null))).toBe("実行中 0");
  });
});

/**
 * #2265。バッジの数字は「積まれているジョブの件数」ではなく「サブPCで生きているセッション本数」。
 * ジョブはtmuxセッションが立った時点で`succeeded`になるため、10本走っていてもジョブの件数は
 * 0〜1にしかならず、バッジがサブPCの混み具合を映していなかった。
 */
describe("バッジに出す件数（セッション本数）", () => {
  it("申告しているホストのセッション本数と上限を要約へ入れる", () => {
    const summary = summarizeDispatchQueue([], 2, [host({ liveSessions: 10 })]);
    expect(summary.liveSessions).toBe(10);
    expect(summary.maxSessions).toBe(12);
    expect(countDispatchQueueBadge(summary)).toBe(10);
    expect(describeDispatchSessionLoad(summary)).toBe("セッション 10/12");
  });

  it("ホストが複数あれば足す", () => {
    const summary = summarizeDispatchQueue([], 2, [
      host({ liveSessions: 10 }),
      host({ name: "subpc2", liveSessions: 2, maxSessions: 4 }),
    ]);
    expect(summary.liveSessions).toBe(12);
    expect(summary.maxSessions).toBe(16);
  });

  // ホストの行は消えないため、絞らないと止まったpollerの最後の値でバッジが固まる
  it("応答していないホストの申告は数えず、ジョブの件数へ落とす", () => {
    const summary = summarizeDispatchQueue([job()], 2, [
      host({ liveSessions: 10, online: false }),
    ]);
    expect(summary.liveSessions).toBeNull();
    expect(countDispatchQueueBadge(summary)).toBe(1);
  });

  // 判定材料が無いことを理由にバッジを消すと、ジョブを積んだこと自体が画面から消える
  it("本数を申告するホストが1台も無ければ、従来どおりジョブの件数を出す", () => {
    const summary = summarizeDispatchQueue([job(), job({ id: "b" })], 2, [
      host({ maxSessions: null, liveSessions: null }),
    ]);
    expect(summary.liveSessions).toBeNull();
    expect(describeDispatchSessionLoad(summary)).toBeNull();
    expect(countDispatchQueueBadge(summary)).toBe(2);
  });

  // ホストを渡さない呼び出し（テスト・古い呼び出し元）でも壊れない
  it("ホストを渡さなければ申告なしとして扱う", () => {
    expect(summarizeDispatchQueue([], 2).liveSessions).toBeNull();
  });

  // セッションが0本でジョブだけ積まれている状態は、数字ではなく点で出す（DispatchQueueBadge）
  it("セッションが0本なら、順番待ちがあっても0を返す", () => {
    const summary = summarizeDispatchQueue([job()], 2, [host({ liveSessions: 0 })]);
    expect(countDispatchQueueBadge(summary)).toBe(0);
    expect(summary.activeCount).toBe(1);
  });
});

describe("summarizeDispatchSessionCapacity", () => {
  it("上限に達していれば印を付ける", () => {
    expect(summarizeDispatchSessionCapacity([host({ liveSessions: 12 })])).toEqual([
      { hostName: "subpc", live: 12, max: 12, atCapacity: true },
    ]);
  });

  // 判定材料が無いまま0本として並べると、実際には埋まっているホストが空いて見える
  it("本数を申告していないホスト（古いpoller）は落とす", () => {
    expect(summarizeDispatchSessionCapacity([host({ maxSessions: null })])).toEqual([]);
    expect(summarizeDispatchSessionCapacity([host({ liveSessions: null })])).toEqual([]);
  });

  it("0本は「申告していない」とは別物として扱う", () => {
    expect(summarizeDispatchSessionCapacity([host({ liveSessions: 0 })])).toEqual([
      { hostName: "subpc", live: 0, max: 12, atCapacity: false },
    ]);
  });
});

/** メモリの逼迫でpollerが起動を見送っている申告（#2095） */
const MEMORY_HOLD = { reason: "MEMORY", percent: 92.3, thresholdPercent: 85 } as const;

describe("describeDispatchQueueStall", () => {
  const queued = summarizeDispatchQueue([job()], 2);

  it("上限に達しているホストがあれば理由を出す", () => {
    expect(describeDispatchQueueStall(queued, [host({ liveSessions: 12 })])).toContain(
      "サブPC（12/12本）",
    );
  });

  it("待機が無ければ理由を出さない", () => {
    const empty = summarizeDispatchQueue([], 2);
    expect(describeDispatchQueueStall(empty, [host({ liveSessions: 12 })])).toBeNull();
  });

  // 落ちているホストは「上限で待っている」のではなく「取りに来られない」
  it("応答していないホストは数えない", () => {
    expect(
      describeDispatchQueueStall(queued, [host({ liveSessions: 12, online: false })]),
    ).toBeNull();
  });

  it("空きがあれば理由を出さない", () => {
    expect(describeDispatchQueueStall(queued, [host()])).toBeNull();
  });

  // 本数に空きがあってもメモリ・SWAPが逼迫していれば取りに来ない（#2095）。
  // 出さないと「順番待ちのまま進まない」としか見えず、pollerが落ちている状態と区別が付かない
  it("メモリ・SWAPの逼迫で見送っているホストがあれば理由を出す", () => {
    const reason = describeDispatchQueueStall(queued, [host({ launchHold: MEMORY_HOLD })]);
    expect(reason).toContain("サブPC（メモリ 92%（上限 85%））");
    expect(reason).toContain("余力が戻ると自動で再開");
  });

  // 両方に当てはまるなら畳むのが先。待っている人にできることがそちらの方が具体的
  it("本数の上限にも達していれば、そちらを理由に出す", () => {
    expect(
      describeDispatchQueueStall(queued, [host({ liveSessions: 12, launchHold: MEMORY_HOLD })]),
    ).toContain("セッション本数の上限");
  });

  it("見送っていても応答していないホストは数えない", () => {
    expect(
      describeDispatchQueueStall(queued, [host({ launchHold: MEMORY_HOLD, online: false })]),
    ).toBeNull();
  });
});

describe("describeDispatchJobWaitReason", () => {
  it("順番待ちのジョブに、上限で止まっている理由を添える", () => {
    const reason = describeDispatchJobWaitReason(job(), [host({ liveSessions: 12 })]);
    expect(reason).toContain("上限（12/12本）");
  });

  it("走り出したジョブには添えない", () => {
    expect(
      describeDispatchJobWaitReason(job({ status: "RUNNING" }), [host({ liveSessions: 12 })]),
    ).toBeNull();
  });

  // 制御ジョブ（#1332）はセッション本数の上限に達していても払い出される
  it("制御ジョブには添えない", () => {
    expect(
      describeDispatchJobWaitReason(job({ kind: "KILL" }), [host({ liveSessions: 12 })]),
    ).toBeNull();
  });

  // 横断質問セッション（#1454）も`<repo>-issue-<番号>`のtmuxセッションとして数えられ、
  // 実装セッションと同じ上限で待たされる（#1544）
  it("横断質問ジョブにも理由を添える", () => {
    const reason = describeDispatchJobWaitReason(job({ kind: "CROSS_REPO_QUESTION" }), [
      host({ liveSessions: 12 }),
    ]);
    expect(reason).toContain("上限（12/12本）");
  });

  it("宛先のホストが申告に無ければ添えない", () => {
    expect(
      describeDispatchJobWaitReason(job({ targetHost: "other" }), [host({ liveSessions: 12 })]),
    ).toBeNull();
  });

  // 本数の上限とは待っている人にできることが違うため、別の文で説明する（#2095）
  it("メモリ・SWAPの逼迫で見送っている場合はその理由を添える", () => {
    const reason = describeDispatchJobWaitReason(job(), [host({ launchHold: MEMORY_HOLD })]);
    expect(reason).toContain("サブPCのメモリ 92%（上限 85%）のため、まだ起動できません");
  });

  it("本数の上限にも達していれば、そちらを理由に添える", () => {
    expect(
      describeDispatchJobWaitReason(job(), [host({ liveSessions: 12, launchHold: MEMORY_HOLD })]),
    ).toContain("上限（12/12本）");
  });
});

describe("cancelableDispatchJobs", () => {
  // runningを止めるとworktreeの作成や依存インストールの途中で切れ、中途半端な状態が残る
  it("待機とCLAIMEDまで。RUNNINGは含めない", () => {
    const summary = summarizeDispatchQueue(
      [
        job({ id: "q" }),
        job({ id: "c", status: "CLAIMED" }),
        job({ id: "r", status: "RUNNING" }),
      ],
      2,
    );
    expect(cancelableDispatchJobs(summary).map((j) => j.id).sort()).toEqual(["c", "q"]);
  });
});

describe("selectHostSessions", () => {
  it("そのホストのセッションだけを返す", () => {
    const sessions = [
      session({ tmuxSessionName: "a" }),
      session({ tmuxSessionName: "b", host: "mainpc" }),
    ];
    expect(selectHostSessions(sessions, "subpc").map((s) => s.tmuxSessionName)).toEqual(["a"]);
  });

  // 畳んだセッションは24時間残るため、並べると今動いているものが埋もれる。
  // 異常終了だけは残す（セッションの異常終了はこの一覧を除くとキューのどこにも出ない）
  it("ALIVEとFAILEDだけを出し、EXITED・GONEは落とす", () => {
    const sessions = [
      session({ tmuxSessionName: "alive", state: "ALIVE" }),
      session({ tmuxSessionName: "failed", state: "FAILED" }),
      session({ tmuxSessionName: "exited", state: "EXITED" }),
      session({ tmuxSessionName: "gone", state: "GONE" }),
    ];
    expect(selectHostSessions(sessions, "subpc").map((s) => s.tmuxSessionName)).toEqual([
      "alive",
      "failed",
    ]);
  });

  it("生きているものが先、その中では新しい報告が上", () => {
    const sessions = [
      session({ tmuxSessionName: "old", lastReportedAt: "2026-08-14T01:00:00.000Z" }),
      session({ tmuxSessionName: "failed", state: "FAILED", lastReportedAt: "2026-08-14T09:00:00.000Z" }),
      session({ tmuxSessionName: "new", lastReportedAt: "2026-08-14T05:00:00.000Z" }),
    ];
    expect(selectHostSessions(sessions, "subpc").map((s) => s.tmuxSessionName)).toEqual([
      "new",
      "old",
      "failed",
    ]);
  });
});

// #1927。`SELF_UPDATE`はキューの一覧（running・queued・failed・controls）のどこにも入らないため、
// 押した結果を出すにはホストのカードが自分で引く必要がある
describe("selectHostSelfUpdateJob", () => {
  it("そのホストの最後のチェックアウト更新を返す", () => {
    const jobs = [
      job({ id: "old", kind: "SELF_UPDATE", createdAt: "2026-08-14T00:00:00.000Z" }),
      job({ id: "new", kind: "SELF_UPDATE", createdAt: "2026-08-14T01:00:00.000Z" }),
      job({ id: "launch", kind: "LAUNCH", createdAt: "2026-08-14T02:00:00.000Z" }),
      job({
        id: "other-host",
        kind: "SELF_UPDATE",
        targetHost: "mainpc",
        agent: "claude",
        claudeModel: null,
        createdAt: "2026-08-14T03:00:00.000Z",
      }),
    ];
    expect(selectHostSelfUpdateJob(jobs, "subpc")?.id).toBe("new");
    expect(selectHostSelfUpdateJob(jobs, "mainpc")?.id).toBe("other-host");
  });

  it("そのホストの更新が無ければnull", () => {
    expect(selectHostSelfUpdateJob([job({ kind: "LAUNCH" })], "subpc")).toBeNull();
  });
});

// #2524。`CODEX_PAIRING`も`SELF_UPDATE`・`REBOOT`と同じ枠外のジョブで、キューの一覧に出ない
describe("selectHostCodexPairingJob", () => {
  it("そのホストの最後のペアリングを返す", () => {
    const jobs = [
      job({ id: "old", kind: "CODEX_PAIRING", createdAt: "2026-08-30T00:00:00.000Z" }),
      job({ id: "new", kind: "CODEX_PAIRING", createdAt: "2026-08-30T01:00:00.000Z" }),
      job({ id: "reboot", kind: "REBOOT", createdAt: "2026-08-30T02:00:00.000Z" }),
      job({
        id: "other-host",
        kind: "CODEX_PAIRING",
        targetHost: "mainpc",
        createdAt: "2026-08-30T03:00:00.000Z",
      }),
    ];
    expect(selectHostCodexPairingJob(jobs, "subpc")?.id).toBe("new");
    expect(selectHostCodexPairingJob(jobs, "mainpc")?.id).toBe("other-host");
  });

  it("キューの一覧（実行中・順番待ち・失敗）には出ない", () => {
    const summary = summarizeDispatchQueue(
      [job({ id: "pairing", kind: "CODEX_PAIRING", status: "QUEUED" })],
      2,
    );
    expect(summary.running).toHaveLength(0);
    expect(summary.queued).toHaveLength(0);
    expect(summary.failed).toHaveLength(0);
  });

  it("そのホストのペアリングが無ければnull", () => {
    expect(selectHostCodexPairingJob([job({ kind: "LAUNCH" })], "subpc")).toBeNull();
  });
});
