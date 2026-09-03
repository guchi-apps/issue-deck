import { describe, expect, it } from "vitest";

import {
  classifyNightlyRunOutcome,
  decideNightlyRunLaunch,
  describeNightlyRunWindowHours,
  formatNightlyRunHour,
  resolveNightlyRunLabelRejection,
  resolveNightlyRunWindow,
  selectLatestNightKey,
  summarizeNightlyRunOutcomes,
  type NightlyRunEntryView,
} from "@/lib/nightly-run";

/** UTCで動く環境（本番のVPS・サブPC・CI）を前提に、日本時間の値はUTC文字列から作る */
function jst(text: string): Date {
  return new Date(`${text}+09:00`);
}

describe("resolveNightlyRunWindow", () => {
  it("開始時刻の前は前日の窓を指し、閉じている", () => {
    const window = resolveNightlyRunWindow(jst("2026-09-03T00:30:00"), 1);
    expect(window.nightKey).toBe("2026-09-02");
    expect(window.isOpen).toBe(false);
    expect(window.startsAt.toISOString()).toBe(jst("2026-09-02T01:00:00").toISOString());
    expect(window.nextStartsAt.toISOString()).toBe(jst("2026-09-03T01:00:00").toISOString());
  });

  it("開始から3時間のあいだは開いている", () => {
    const window = resolveNightlyRunWindow(jst("2026-09-03T02:59:00"), 1);
    expect(window.nightKey).toBe("2026-09-03");
    expect(window.isOpen).toBe(true);
    expect(window.endsAt.toISOString()).toBe(jst("2026-09-03T04:00:00").toISOString());
    expect(window.nextStartsAt.toISOString()).toBe(window.startsAt.toISOString());
    expect(window.morningAt.toISOString()).toBe(jst("2026-09-03T07:00:00").toISOString());
  });

  it("3時間を過ぎると閉じ、次の開始は翌日", () => {
    const window = resolveNightlyRunWindow(jst("2026-09-03T04:00:00"), 1);
    expect(window.isOpen).toBe(false);
    expect(window.nightKey).toBe("2026-09-03");
    expect(window.nextStartsAt.toISOString()).toBe(jst("2026-09-04T01:00:00").toISOString());
  });

  it("22時開始は日付をまたぎ、nightKeyは開始側の日付、朝は翌日の7時", () => {
    const window = resolveNightlyRunWindow(jst("2026-09-03T00:10:00"), 22);
    expect(window.nightKey).toBe("2026-09-02");
    expect(window.isOpen).toBe(true);
    expect(window.startsAt.toISOString()).toBe(jst("2026-09-02T22:00:00").toISOString());
    expect(window.endsAt.toISOString()).toBe(jst("2026-09-03T01:00:00").toISOString());
    expect(window.morningAt.toISOString()).toBe(jst("2026-09-03T07:00:00").toISOString());
  });

  it("UTCの日付境界（日本時間9時）をまたいでも日本時間で判定する", () => {
    // 2026-09-03T08:50 JST = 2026-09-02T23:50 UTC。UTCの日付は2日だが、日本時間では3日
    const window = resolveNightlyRunWindow(jst("2026-09-03T08:50:00"), 1);
    expect(window.nightKey).toBe("2026-09-03");
    expect(window.isOpen).toBe(false);
  });
});

describe("formatNightlyRunHour / describeNightlyRunWindowHours", () => {
  it("2桁で整形し、窓の終わりは24時間で折り返す", () => {
    expect(formatNightlyRunHour(1)).toBe("01:00");
    expect(describeNightlyRunWindowHours(22)).toBe("22:00〜01:00");
    expect(describeNightlyRunWindowHours(5)).toBe("05:00〜08:00");
  });
});

describe("resolveNightlyRunLabelRejection", () => {
  it("開発環境・アーティファクトのラベルだけを塞ぐ", () => {
    expect(resolveNightlyRunLabelRejection([{ name: "21.plan-required" }])).toBeNull();
    expect(resolveNightlyRunLabelRejection([{ name: "22.merge-confirm-required" }])).toBeNull();
    expect(resolveNightlyRunLabelRejection([{ name: "24.screenshot-required" }])).toBeNull();
    expect(resolveNightlyRunLabelRejection([{ name: "25.artifact-required" }])).toContain(
      "アーティファクトで見た目を出す",
    );
    expect(resolveNightlyRunLabelRejection([{ name: "23.preview-required" }])).toContain(
      "開発環境を起動する",
    );
  });
});

describe("decideNightlyRunLaunch", () => {
  it("openで塞ぐラベルが無ければ起動する", () => {
    expect(
      decideNightlyRunLaunch({ issueState: "open", labels: [{ name: "21.plan-required" }] }),
    ).toEqual({ action: "launch" });
  });

  it("状態が取れない・closed・着手済み・確認待ち・塞ぐラベルは見送る", () => {
    expect(decideNightlyRunLaunch({ issueState: null, labels: [] }).action).toBe("skip");
    expect(decideNightlyRunLaunch({ issueState: "closed", labels: [] }).action).toBe("skip");
    const local = decideNightlyRunLaunch({ issueState: "open", labels: [{ name: "11.local" }] });
    expect(local).toMatchObject({ action: "skip" });
    expect(local.action === "skip" && local.reason).toContain("11.local");
    const check = decideNightlyRunLaunch({
      issueState: "open",
      labels: [{ name: "00.check-user" }, { name: "01.check-plan" }],
    });
    expect(check.action === "skip" && check.reason).toContain("計画の承認");
    const artifact = decideNightlyRunLaunch({
      issueState: "open",
      labels: [{ name: "25.artifact-required" }],
    });
    expect(artifact.action).toBe("skip");
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
      status: "LAUNCHED",
      nightKey: "2026-09-02",
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

  it("処理済みの予定から最新の夜を選ぶ（予定・取り消しは見ない）", () => {
    expect(
      selectLatestNightKey([
        { status: "LAUNCHED", nightKey: "2026-09-01" },
        { status: "SKIPPED", nightKey: "2026-09-02" },
        { status: "CANCELED", nightKey: "2026-09-03" },
        { status: "QUEUED", nightKey: null },
      ]),
    ).toBe("2026-09-02");
    expect(selectLatestNightKey([{ status: "QUEUED", nightKey: null }])).toBeNull();
  });
});
