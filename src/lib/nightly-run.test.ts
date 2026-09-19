import { describe, expect, it } from "vitest";

import {
  classifyNightlyRunOutcome,
  decideNightlyRunLaunch,
  findScheduledRunQueuedMark,
  resolveNightlyRunLabelRejection,
  selectLatestNightKey,
  selectScheduledRunQueuedMarks,
  summarizeNightlyRunOutcomes,
  type NightlyRunEntryView,
  type NightlyRunState,
} from "@/lib/nightly-run";

describe("resolveNightlyRunLabelRejection", () => {
  it("開発環境・アーティファクトのラベルだけを塞ぐ", () => {
    expect(
      resolveNightlyRunLabelRejection([{ name: "21.plan-required" }], "NEXT_WINDOW"),
    ).toBeNull();
    expect(
      resolveNightlyRunLabelRejection([{ name: "22.merge-confirm-required" }], "NEXT_WINDOW"),
    ).toBeNull();
    expect(
      resolveNightlyRunLabelRejection([{ name: "25.artifact-required" }], "NEXT_WINDOW"),
    ).toContain("デザインを提示");
    expect(
      resolveNightlyRunLabelRejection([{ name: "23.preview-required" }], "NEXT_WINDOW"),
    ).toContain("開発環境を起動");
  });
});

describe("decideNightlyRunLaunch", () => {
  it("openで塞ぐラベルが無ければ起動する", () => {
    expect(
      decideNightlyRunLaunch({
        issueState: "open",
        labels: [{ name: "21.plan-required" }],
        kind: "NEXT_WINDOW",
      }),
    ).toEqual({ action: "launch" });
  });

  it("状態が取れない・closed・着手済み・確認待ち・塞ぐラベルは見送る", () => {
    expect(
      decideNightlyRunLaunch({ issueState: null, labels: [], kind: "NEXT_WINDOW" }).action,
    ).toBe("skip");
    expect(
      decideNightlyRunLaunch({ issueState: "closed", labels: [], kind: "NEXT_WINDOW" }).action,
    ).toBe("skip");
    const local = decideNightlyRunLaunch({
      issueState: "open",
      labels: [{ name: "11.local" }],
      kind: "NEXT_WINDOW",
    });
    expect(local).toMatchObject({ action: "skip" });
    expect(local.action === "skip" && local.reason).toContain("11.local");
    const check = decideNightlyRunLaunch({
      issueState: "open",
      labels: [{ name: "00.check-user" }, { name: "01.check-plan" }],
      kind: "NEXT_WINDOW",
    });
    expect(check.action === "skip" && check.reason).toContain("計画の承認");
    const artifact = decideNightlyRunLaunch({
      issueState: "open",
      labels: [{ name: "25.artifact-required" }],
      kind: "NEXT_WINDOW",
    });
    expect(artifact.action).toBe("skip");
  });
});

describe("decideNightlyRunLaunch: 状態を取れなかった理由の文言（#3148）", () => {
  const reasonOf = (fetchFailure?: "reauth_required" | "api_error" | null) => {
    const decision = decideNightlyRunLaunch({ issueState: null, labels: [], kind: "NEXT_WINDOW", fetchFailure });
    return decision.action === "skip" ? decision.reason : null;
  };

  it("延長にも失敗したときだけ再ログインを促す", () => {
    expect(reasonOf("reauth_required")).toContain("ログインし直して");
    expect(reasonOf("api_error")).toContain("問い合わせに失敗");
    expect(reasonOf(null)).toContain("削除・移動");
    expect(reasonOf(undefined)).not.toContain("認証");
  });
});

describe("classifyNightlyRunOutcome", () => {
  const launched = { status: "LAUNCHED" as const, skipReason: null };
  const open = (projectStatus: string | null, labels: string[] = []) => ({
    state: "OPEN" as const,
    projectStatus,
    labels: labels.map((name) => ({ name })),
  });

  it("見送りは理由をそのまま出す", () => {
    expect(
      classifyNightlyRunOutcome({
        entry: { status: "SKIPPED", skipReason: "closeされていました" },
        issue: null,
        job: null,
        session: null,
      }),
    ).toEqual({ kind: "skip", detail: "closeされていました" });
  });

  it("developへ入っていれば本番反映待ち", () => {
    expect(
      classifyNightlyRunOutcome({ entry: launched, issue: open("Develop"), job: null, session: null })
        .kind,
    ).toBe("ok");
    expect(
      classifyNightlyRunOutcome({ entry: launched, issue: open("Release"), job: null, session: null })
        .kind,
    ).toBe("ok");
  });

  it("確認待ちは進捗より先に見て、理由を添える", () => {
    const outcome = classifyNightlyRunOutcome({
      entry: launched,
      issue: open("Develop PR", ["00.check-user", "01.check-merge"]),
      job: null,
      session: { state: "EXITED" },
    });
    expect(outcome).toEqual({ kind: "warn", detail: "PRのマージ待ち" });
  });

  it("PR待ちは実行中、セッションが落ちてPRが無ければ止まった", () => {
    expect(
      classifyNightlyRunOutcome({
        entry: launched,
        issue: open("Develop PR"),
        job: null,
        session: { state: "EXITED" },
      }).kind,
    ).toBe("run");
    expect(
      classifyNightlyRunOutcome({
        entry: launched,
        issue: open("Implementation"),
        job: { status: "SUCCEEDED" },
        session: { state: "EXITED" },
      }).kind,
    ).toBe("bad");
    expect(
      classifyNightlyRunOutcome({
        entry: launched,
        issue: open("Implementation"),
        job: { status: "SUCCEEDED" },
        session: { state: "ALIVE" },
      }).kind,
    ).toBe("run");
    expect(
      classifyNightlyRunOutcome({
        entry: launched,
        issue: open("Ready"),
        job: { status: "FAILED" },
        session: null,
      }).kind,
    ).toBe("bad");
  });

  it("closeされたIssueはDoneなら本番反映待ち、それ以外は見送り", () => {
    const closed = (projectStatus: string | null) => ({
      state: "CLOSED" as const,
      projectStatus,
      labels: [],
    });
    expect(
      classifyNightlyRunOutcome({ entry: launched, issue: closed("Done"), job: null, session: null })
        .kind,
    ).toBe("ok");
    expect(
      classifyNightlyRunOutcome({ entry: launched, issue: closed("Closed"), job: null, session: null })
        .kind,
    ).toBe("skip");
  });
});

describe("summarizeNightlyRunOutcomes / selectLatestNightKey", () => {
  function view(overrides: Partial<NightlyRunEntryView>): NightlyRunEntryView {
    return {
      id: "e1",
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 1,
      issueId: null,
      issueTitle: null,
      targetHost: "subpc",
      agent: "claude",
      claudeModel: null,
      optionLabels: [],
      kind: "NEXT_WINDOW",
      status: "LAUNCHED",
      nightKey: "2026-09-08 08:40",
      createdAt: "2026-09-02T10:00:00.000Z",
      resolvedAt: null,
      outcome: null,
      ...overrides,
    };
  }

  it("分類ごとに数える", () => {
    const counts = summarizeNightlyRunOutcomes([
      view({ outcome: { kind: "ok", detail: "" } }),
      view({ outcome: { kind: "ok", detail: "" } }),
      view({ outcome: { kind: "warn", detail: "" } }),
      view({ outcome: null }),
    ]);
    expect(counts).toEqual({ ok: 2, warn: 1, run: 0, bad: 0, skip: 0 });
  });

  it("処理済みの予定から最新の枠を選ぶ（予定・取り消しは見ない）", () => {
    expect(
      selectLatestNightKey([
        { status: "LAUNCHED", nightKey: "2026-09-01 08:40" },
        { status: "SKIPPED", nightKey: "2026-09-02 08:40" },
        { status: "CANCELED", nightKey: "2026-09-03 08:40" },
        { status: "QUEUED", nightKey: null },
      ]),
    ).toBe("2026-09-02 08:40");
    expect(selectLatestNightKey([{ status: "QUEUED", nightKey: null }])).toBeNull();
  });
});

describe("予約実行の目印（#2866・#2995）", () => {
  function entry(overrides: Partial<NightlyRunEntryView>): NightlyRunEntryView {
    return {
      id: "e1",
      repositoryFullName: "guchi-apps/issue-deck",
      issueNumber: 2866,
      issueId: "9001",
      issueTitle: null,
      targetHost: "subpc",
      agent: "claude",
      claudeModel: null,
      optionLabels: [],
      kind: "NEXT_WINDOW",
      status: "QUEUED",
      nightKey: null,
      createdAt: "2026-09-07T10:00:00.000Z",
      resolvedAt: null,
      outcome: null,
      ...overrides,
    };
  }

  function state(overrides: Partial<NightlyRunState["nextWindow"]> = {}): Pick<NightlyRunState, "nextWindow"> {
    return {
      nextWindow: {
        settings: { enabled: true, leadMinutes: 60, intervalMinutes: 10, fiveHourFloorPercent: 0, weeklyFloorPercent: 0 },
        window: null,
        queued: [entry({})],
        results: null,
        ...overrides,
      },
    };
  }

  it("`Issue.id`で引ける表を作る（`owner/repo#番号`の鍵は作らない）", () => {
    const marks = selectScheduledRunQueuedMarks(
      state({
        window: {
          phase: "waiting",
          resetsAt: "2026-09-07T23:40:00.000Z",
          opensAt: "2026-09-07T22:40:00.000Z",
          usedPercent: 62,
          weeklyUsedPercent: null,
          weeklyResetsAt: null,
          quotaBlock: null,
          runKey: "2026-09-08 08:40",
        },
      }),
    );
    const mark = findScheduledRunQueuedMark(marks, "9001");
    expect(mark).toMatchObject({ entryId: "e1", kind: "NEXT_WINDOW", enabled: true, chip: "次枠 07:40〜" });
    // 別のIssue・取得前（表そのものが無い）は目印を出さない
    expect(findScheduledRunQueuedMark(marks, "9002")).toBeNull();
    expect(findScheduledRunQueuedMark(undefined, "9001")).toBeNull();
  });

  it("同期できていないIssue（issueIdがnull）は表へ入れない", () => {
    expect(selectScheduledRunQueuedMarks(state({ queued: [entry({ issueId: null })] })).size).toBe(
      0,
    );
  });

  it("目印を出すのは`QUEUED`だけ（起動後は進捗の表示が受け持つ）", () => {
    const marks = selectScheduledRunQueuedMarks(
      state({
        queued: [entry({ status: "LAUNCHED" }), entry({ id: "e2", status: "CANCELED", issueId: "9002" })],
      }),
    );
    expect(marks.size).toBe(0);
  });

  it("取得前（stateがnull）は空の表になる", () => {
    expect(selectScheduledRunQueuedMarks(null).size).toBe(0);
  });

  it("次枠実行がOFFならチップがOFFの文言になる（#2995）", () => {
    const marks = selectScheduledRunQueuedMarks(
      state({
        settings: { enabled: false, leadMinutes: 60, intervalMinutes: 10, fiveHourFloorPercent: 0, weeklyFloorPercent: 0 },
        window: null,
        queued: [entry({ issueId: "9003" })],
      }),
    );
    expect(findScheduledRunQueuedMark(marks, "9003")?.chip).toBe("次枠実行OFF");
  });
});
