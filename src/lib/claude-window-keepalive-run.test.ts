import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const updateMany = vi.fn();
const readClaudeWindowSnapshot = vi.fn();
const peekClaudeFiveHourWindow = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    appSetting: {
      get findUnique() {
        return findUnique;
      },
      get updateMany() {
        return updateMany;
      },
    },
  },
}));

vi.mock("@/lib/next-window-run-db", () => ({
  get readClaudeWindowSnapshot() {
    return readClaudeWindowSnapshot;
  },
}));

vi.mock("@/lib/claude/usage", () => ({
  get peekClaudeFiveHourWindow() {
    return peekClaudeFiveHourWindow;
  },
}));

const { keepClaudeWindowOpen } = await import("@/lib/claude-window-keepalive-run");

const now = new Date("2026-09-18T10:00:00+09:00");

function settingsRow(overrides: Record<string, unknown> = {}) {
  return {
    claudeWindowKeepAliveEnabled: true,
    claudeWindowKeepAliveStartHour: 7,
    claudeWindowKeepAliveEndHour: 23,
    claudeWindowKeepAliveProbedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  peekClaudeFiveHourWindow.mockReturnValue(null);
  readClaudeWindowSnapshot.mockResolvedValue({ resetsAt: now.getTime() + 5 * 3600_000, usedPercent: 0 });
  updateMany.mockResolvedValue({ count: 1 });
});

describe("keepClaudeWindowOpen（#3032）", () => {
  it("ONで時間帯の中、枠が止まっていれば探りを送って時刻を残す", async () => {
    findUnique.mockResolvedValue(settingsRow());

    const result = await keepClaudeWindowOpen({ now });

    expect(result.decision).toEqual({ action: "probe" });
    expect(result.resetsAt).toBe(now.getTime() + 5 * 3600_000);
    expect(readClaudeWindowSnapshot).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { claudeWindowKeepAliveProbedAt: now },
    });
  });

  /** 送信そのものが枠を開始するため、送らない判定のときは取得もしない */
  it("OFF・枠が動いている間は取得もDBの書き込みもしない", async () => {
    findUnique.mockResolvedValue(settingsRow({ claudeWindowKeepAliveEnabled: false }));
    await keepClaudeWindowOpen({ now });

    findUnique.mockResolvedValue(settingsRow());
    peekClaudeFiveHourWindow.mockReturnValue({ resetsAt: now.getTime() + 60_000, usedPercent: 3 });
    const result = await keepClaudeWindowOpen({ now });

    expect(result.decision).toEqual({ action: "skip", reason: "window_open" });
    expect(readClaudeWindowSnapshot).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("設定の行が無ければOFFとして扱う", async () => {
    findUnique.mockResolvedValue(null);
    const result = await keepClaudeWindowOpen({ now });
    expect(result.decision).toEqual({ action: "skip", reason: "off" });
  });
});
