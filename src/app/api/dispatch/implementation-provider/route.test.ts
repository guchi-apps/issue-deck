import { beforeEach, describe, expect, it, vi } from "vitest";
const { auth, record, resolve } = vi.hoisted(() => ({ auth: vi.fn(), record: vi.fn(), resolve: vi.fn() }));
vi.mock("@/lib/progress-report-auth", () => ({ authorizeProgressReport: auth }));
vi.mock("@/lib/dispatch/implementation-provider", () => ({ recordImplementationRun: record, resolveImplementationProvider: resolve }));
import { POST } from "./route";
const valid = { action: "resolve", repository: "guchi-apps/issue-deck", issueNumber: 4037 };
const post = (body: unknown) => POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(body) }) as Parameters<typeof POST>[0]);
beforeEach(() => { vi.resetAllMocks(); auth.mockReturnValue("ok"); });
describe("実装担当API", () => {
  it.each([["unauthorized", 401], ["not_configured", 503]])("認証失敗%s", async (reason, code) => {
    auth.mockReturnValue(reason); expect((await post(valid)).status).toBe(code);
    expect(resolve).not.toHaveBeenCalled();
  });
  it("不正な要求・登録エージェントを拒否する", async () => {
    for (const patch of [{ issueNumber: 0 }, { repository: "../etc" }, { action: "delete" }, { action: "record", agent: "bad", runId: "1", attempt: 1 }]) {
      expect((await post({ ...valid, ...patch })).status).toBe(400);
    }
    expect(record).not.toHaveBeenCalled();
  });
  it("担当不明は409、判明した担当だけ返す", async () => {
    resolve.mockResolvedValue(null); expect((await post(valid)).status).toBe(409);
    resolve.mockResolvedValue("codex"); expect(await (await post(valid)).json()).toEqual({ provider: "codex", source: "implementation" });
  });
  it("Actionsの実行・試行を識別して記録する", async () => {
    expect((await post({ ...valid, action: "record", agent: "claude", runId: "123", attempt: 2 })).status).toBe(200);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ runKey: "actions:123:2", agent: "claude", source: "actions" }));
    record.mockRejectedValue(new Error("implementation_run_conflict"));
    expect((await post({ ...valid, action: "record", agent: "codex", runId: "123", attempt: 2 })).status).toBe(409);
  });
});
