import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const readNextWindowRunSettings = vi.fn();
const readClaudeWindowSnapshot = vi.fn();
const readLastNextWindowLaunchedAt = vi.fn();
const launchScheduledRunEntry = vi.fn();
const markScheduledRunSkipped = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    nightlyRunEntry: {
      get findMany() {
        return findMany;
      },
    },
  },
}));

vi.mock("@/lib/next-window-run-db", () => ({
  get readNextWindowRunSettings() {
    return readNextWindowRunSettings;
  },
  get readClaudeWindowSnapshot() {
    return readClaudeWindowSnapshot;
  },
  get readLastNextWindowLaunchedAt() {
    return readLastNextWindowLaunchedAt;
  },
}));

vi.mock("@/lib/nightly-run-launch", () => ({
  get launchScheduledRunEntry() {
    return launchScheduledRunEntry;
  },
  get markScheduledRunSkipped() {
    return markScheduledRunSkipped;
  },
}));

import { launchNextWindowRunEntries } from "@/lib/next-window-run-launch";

/** 2026-09-18 08:40 JST。実測のリセット時刻と同じ半端な時刻 */
const RESETS_AT = Date.UTC(2026, 8, 17, 23, 40);
const MINUTE = 60_000;

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: "e1",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 2995,
    agent: "claude",
    claudeModel: null,
    requestedByUserId: "user-1",
    createdAt: new Date(RESETS_AT - 3 * 60 * MINUTE),
    reservedResetsAt: null,
    ...overrides,
  };
}

describe("launchNextWindowRunEntries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readNextWindowRunSettings.mockResolvedValue({
      enabled: true,
      leadMinutes: 60,
      intervalMinutes: 10,
      fiveHourFloorPercent: 0,
      weeklyFloorPercent: 0,
    });
    readClaudeWindowSnapshot.mockResolvedValue({ resetsAt: RESETS_AT, usedPercent: 62 });
    readLastNextWindowLaunchedAt.mockResolvedValue(null);
    findMany.mockResolvedValue([entry()]);
    launchScheduledRunEntry.mockImplementation(async ({ entry: row }) => ({
      reserved: true,
      action: {
        entryId: row.id,
        repositoryFullName: row.repositoryFullName,
        issueNumber: row.issueNumber,
        result: "launched",
        detail: "ジョブ job-1",
      },
      stop: false,
    }));
  });

  afterEach(() => vi.clearAllMocks());

  /** #2995: 取得そのものが5時間枠を開始するので、要らないときは呼ばない */
  it("OFFのあいだは予定も枠も読みに行かない", async () => {
    readNextWindowRunSettings.mockResolvedValue({
      enabled: false,
      leadMinutes: 60,
      intervalMinutes: 10,
    });

    const result = await launchNextWindowRunEntries({ hostName: "subpc" });

    expect(result.enabled).toBe(false);
    expect(findMany).not.toHaveBeenCalled();
    expect(readClaudeWindowSnapshot).not.toHaveBeenCalled();
  });

  it("予定が1件も無ければ枠を取りに行かない", async () => {
    findMany.mockResolvedValue([]);

    await launchNextWindowRunEntries({ hostName: "subpc" });

    expect(readClaudeWindowSnapshot).not.toHaveBeenCalled();
    expect(launchScheduledRunEntry).not.toHaveBeenCalled();
  });

  it("枠の終わり際になったら起動する", async () => {
    const result = await launchNextWindowRunEntries({
      hostName: "subpc",
      now: new Date(RESETS_AT - 30 * MINUTE),
    });

    expect(result.phase).toBe("open");
    expect(launchScheduledRunEntry).toHaveBeenCalledTimes(1);
    expect(launchScheduledRunEntry.mock.calls[0][0]).toMatchObject({
      kind: "NEXT_WINDOW",
      runKey: "2026-09-18 08:40",
      hostName: "subpc",
    });
  });

  /** #3100 */
  it("週間枠の残りが下限を下回っていれば、終わり際でも起動を見送る", async () => {
    readNextWindowRunSettings.mockResolvedValue({
      enabled: true,
      leadMinutes: 60,
      intervalMinutes: 10,
      fiveHourFloorPercent: 0,
      weeklyFloorPercent: 20,
    });
    readClaudeWindowSnapshot.mockResolvedValue({
      resetsAt: RESETS_AT,
      usedPercent: 62,
      weeklyResetsAt: RESETS_AT + 3 * 24 * 60 * MINUTE,
      weeklyUsedPercent: 83,
    });

    const result = await launchNextWindowRunEntries({
      hostName: "subpc",
      now: new Date(RESETS_AT - 30 * MINUTE),
    });

    expect(launchScheduledRunEntry).not.toHaveBeenCalled();
    expect(result.actions[0]).toMatchObject({ result: "deferred" });
    expect(result.actions[0]?.detail).toContain("週間枠の残りが17%");
  });

  it("下限の内側に戻れば起動する（下限は待つだけで予定は残る）", async () => {
    readNextWindowRunSettings.mockResolvedValue({
      enabled: true,
      leadMinutes: 60,
      intervalMinutes: 10,
      fiveHourFloorPercent: 0,
      weeklyFloorPercent: 20,
    });
    readClaudeWindowSnapshot.mockResolvedValue({
      resetsAt: RESETS_AT,
      usedPercent: 62,
      weeklyResetsAt: RESETS_AT + 3 * 24 * 60 * MINUTE,
      weeklyUsedPercent: 50,
    });

    await launchNextWindowRunEntries({ hostName: "subpc", now: new Date(RESETS_AT - 30 * MINUTE) });

    expect(launchScheduledRunEntry).toHaveBeenCalledTimes(1);
  });

  it("枠の途中では起動しない（待つ理由だけ返す）", async () => {
    const result = await launchNextWindowRunEntries({
      hostName: "subpc",
      now: new Date(RESETS_AT - 3 * 60 * MINUTE),
    });

    expect(result.phase).toBe("waiting");
    expect(launchScheduledRunEntry).not.toHaveBeenCalled();
    expect(result.actions[0]?.result).toBe("deferred");
  });

  /** #2995: リセットの瞬間に一斉起動しないための間隔 */
  it("1回の巡回で起動するのは1件まで", async () => {
    findMany.mockResolvedValue([entry(), entry({ id: "e2", issueNumber: 2996 })]);

    const result = await launchNextWindowRunEntries({
      hostName: "subpc",
      now: new Date(RESETS_AT - 30 * MINUTE),
    });

    expect(launchScheduledRunEntry).toHaveBeenCalledTimes(1);
    expect(result.actions).toHaveLength(1);
  });

  it("積んだときの枠が続いているあいだは起動しない", async () => {
    findMany.mockResolvedValue([entry({ reservedResetsAt: new Date(RESETS_AT) })]);

    await launchNextWindowRunEntries({
      hostName: "subpc",
      now: new Date(RESETS_AT - 30 * MINUTE),
    });

    expect(launchScheduledRunEntry).not.toHaveBeenCalled();
  });

  it("枠が動いていなければ待たずに起動する（起動が枠の開始になる）", async () => {
    const now = new Date(RESETS_AT + 60 * MINUTE);

    const result = await launchNextWindowRunEntries({ hostName: "subpc", now });

    expect(result.phase).toBe("idle");
    expect(launchScheduledRunEntry).toHaveBeenCalledTimes(1);
  });

  it("枠を取得できなければ起動しない", async () => {
    readClaudeWindowSnapshot.mockResolvedValue(null);

    const result = await launchNextWindowRunEntries({
      hostName: "subpc",
      now: new Date(RESETS_AT - 30 * MINUTE),
    });

    expect(result.phase).toBe("unknown");
    expect(launchScheduledRunEntry).not.toHaveBeenCalled();
    expect(markScheduledRunSkipped).not.toHaveBeenCalled();
  });

  it("24時間のあいだに起動できなかった予定は見送る", async () => {
    const now = new Date(RESETS_AT - 30 * MINUTE);
    findMany.mockResolvedValue([
      entry({ createdAt: new Date(now.getTime() - 25 * 60 * MINUTE) }),
    ]);

    const result = await launchNextWindowRunEntries({ hostName: "subpc", now });

    expect(markScheduledRunSkipped).toHaveBeenCalledTimes(1);
    expect(markScheduledRunSkipped.mock.calls[0][2]).toContain("24時間");
    expect(result.actions[0]?.result).toBe("skipped");
  });

  it("直前の起動から間隔が空くまでは起動しない", async () => {
    const now = new Date(RESETS_AT - 30 * MINUTE);
    readLastNextWindowLaunchedAt.mockResolvedValue(new Date(now.getTime() - 5 * MINUTE));

    await launchNextWindowRunEntries({ hostName: "subpc", now });

    expect(launchScheduledRunEntry).not.toHaveBeenCalled();
  });
});
