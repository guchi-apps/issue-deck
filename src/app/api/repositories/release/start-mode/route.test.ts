import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ user: vi.fn(), repos: vi.fn(), reconcile: vi.fn(), block: vi.fn(), sync: vi.fn(), contract: vi.fn() }));
vi.mock("@/lib/auth-user", () => ({ requireUserId: mocks.user }));
vi.mock("@/lib/db", () => ({ db: { repository: { findMany: mocks.repos } } }));
vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn(async () => "t") }));
vi.mock("@/lib/github/release-api", () => ({ fetchReleaseCallerText: vi.fn(async () => "caller") }));
vi.mock("@/lib/release-start-mode", () => ({ decideReleaseStartMode: () => ({ mode: "candidate" }) }));
vi.mock("@/lib/release-rc-reconcile", () => ({ reconcileActiveRcPublication: mocks.reconcile }));
vi.mock("@/lib/release-rc-run", () => ({ loadRcBlock: mocks.block }));
vi.mock("@/lib/release-develop-sync-run", () => ({ observeDevelopSync: mocks.sync }));
vi.mock("@/lib/release-develop-sync", () => ({ decideDevelopSync: (s: unknown) => s }));
vi.mock("@/lib/release-production-stop-run", () => ({ readProductionTargetKind: mocks.contract }));
import { GET } from "./route";
const request = () => new NextRequest("http://localhost/api/repositories/release/start-mode?repos=o/r");
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue("u1");
  mocks.repos.mockResolvedValue([{ fullName: "o/r", installation: { installationId: 1 } }]);
  mocks.block.mockResolvedValue(null);
  mocks.sync.mockResolvedValue({ state: "synced" });
});
it("状態照合の後にブロックを再取得し、解放後もdevelop同期を評価する", async () => {
  mocks.sync.mockResolvedValue({ state: "unsynced", label: "同期待ち", reason: "未反映" });
  const res = await GET(request());
  expect((await res.json()).modes["o/r"].mode).toBe("develop_sync");
  expect(mocks.reconcile.mock.invocationCallOrder[0]).toBeLessThan(mocks.block.mock.invocationCallOrder[0]);
});
it("照合が失敗しても新規作成可能にはしない", async () => {
  mocks.reconcile.mockRejectedValue(new Error("unavailable"));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect((await (await GET(request())).json()).modes["o/r"].mode).toBe("unknown");
    expect(mocks.block).not.toHaveBeenCalled();
  } finally { log.mockRestore(); }
});
it("未認証なら状態照合しない", async () => {
  mocks.user.mockResolvedValue(null);
  expect((await GET(request())).status).toBe(401);
  expect(mocks.reconcile).not.toHaveBeenCalled();
});
it("権限のないリポジトリなら状態照合しない", async () => {
  mocks.repos.mockResolvedValue([]);
  expect((await (await GET(request())).json()).modes["o/r"].mode).toBe("unknown");
  expect(mocks.reconcile).not.toHaveBeenCalled();
});
it("証拠未設定で止まった候補は、次の候補で確かめられるなら開始を止めず、何が起きるかを添える（#4712）", async () => {
  const block = { label: "RC-1", reason: "止まっています", kind: "production_stopped", successorStart: { allowed: true } };
  mocks.block.mockResolvedValue(block);
  mocks.contract.mockResolvedValue("deploy_version_check");
  const mode = (await (await GET(request())).json()).modes["o/r"];
  expect(mode).toEqual({ mode: "candidate", successorOf: block, productionKind: "deploy_version_check" });
  expect(mocks.contract).toHaveBeenCalledWith({ owner: "o", repo: "r", token: "t" }, "develop");
});
it("稼働確認が止まった候補で、次の候補でも確かめられなければ開始を止める（#4712）", async () => {
  mocks.block.mockResolvedValue({ label: "RC-1", reason: "止まっています", kind: "production_stopped", successorStart: { allowed: false, reason: "照合なし" } });
  expect((await (await GET(request())).json()).modes["o/r"].mode).toBe("blocked");
  expect(mocks.sync).not.toHaveBeenCalled();
});
