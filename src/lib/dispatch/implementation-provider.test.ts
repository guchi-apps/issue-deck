import { beforeEach, describe, expect, it, vi } from "vitest";
const { runs, sessions, upsert } = vi.hoisted(() => ({ runs: vi.fn(), sessions: vi.fn(), upsert: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {
  implementationRun: { findMany: runs, upsert }, dispatchSession: { findMany: sessions },
} }));
import { recordImplementationRun, resolveImplementationProvider, selectImplementationProvider } from "./implementation-provider";
const old = new Date("2026-10-05T00:00:00Z");
const recent = new Date("2026-10-05T01:00:00Z");
beforeEach(() => { vi.clearAllMocks(); runs.mockResolvedValue([]); sessions.mockResolvedValue([]); });
describe("実装担当の継承", () => {
  it.each(["claude", "codex"])("共通設定を参照せず%sの記録を使う", async (agent) => {
    runs.mockResolvedValue([{ agent, startedAt: recent, source: "actions" }]);
    expect(await resolveImplementationProvider("guchi-apps/issue-deck", 4037)).toBe(agent);
  });
  it("後で開始した担当へ引き継ぎ、古い生存報告を優先しない", async () => {
    sessions.mockResolvedValue([{ codexThreadKnown: null, firstSeenAt: old, activity: "WORKING" }]);
    runs.mockResolvedValue([{ agent: "codex", startedAt: recent, source: "actions" }]);
    expect(await resolveImplementationProvider("guchi-apps/issue-deck", 4037)).toBe("codex");
  });
  it("Codexのthread未取得falseもCodexとして扱う", async () => {
    sessions.mockResolvedValue([{ codexThreadKnown: false, firstSeenAt: recent, activity: null }]);
    expect(await resolveImplementationProvider("guchi-apps/issue-deck", 4037)).toBe("codex");
  });
  it("未開始セッションは担当変更にならない", async () => {
    sessions.mockResolvedValue([{ codexThreadKnown: false, firstSeenAt: recent, activity: "NOT_STARTED" }]);
    runs.mockResolvedValue([{ agent: "claude", startedAt: old, source: "local" }]);
    expect(await resolveImplementationProvider("guchi-apps/issue-deck", 4037)).toBe("claude");
  });
  it("記録なし・不正・同時刻の異なる担当では推測しない", async () => {
    expect(await resolveImplementationProvider("guchi-apps/issue-deck", 4037)).toBeNull();
    expect(selectImplementationProvider([{ agent: "bad", startedAt: recent, source: "local" }])).toBeNull();
    expect(selectImplementationProvider(["claude", "codex"].map((agent) => ({ agent, startedAt: recent, source: "local" })))).toBeNull();
  });
  it("再送で担当・開始時刻を更新しない", async () => {
    const input = { repositoryFullName: "guchi-apps/issue-deck", issueNumber: 4037, runKey: "actions:1:1", agent: "codex" as const, source: "actions" as const, startedAt: old };
    upsert.mockResolvedValue(input);
    await recordImplementationRun(input);
    expect(upsert).toHaveBeenCalledWith({ where: { runKey: input.runKey }, create: input, update: {} });
    upsert.mockResolvedValue({ ...input, agent: "claude" });
    await expect(recordImplementationRun(input)).rejects.toThrow("implementation_run_conflict");
  });
});
