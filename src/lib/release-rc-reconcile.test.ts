import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  reconcile: vi.fn(),
  successor: vi.fn(),
  candidates: vi.fn(),
  check: vi.fn(),
  repository: vi.fn(),
}));
vi.mock("@/lib/release-rc-run", () => ({ loadCandidateRow: mocks.load }));
vi.mock("@/lib/release-finalize-run", () => ({ reconcileRcFinalization: mocks.reconcile, reconcileSuccessorWaiting: mocks.successor }));
vi.mock("@/lib/github/app-auth", () => ({ getInstallationToken: vi.fn(async () => "t") }));
vi.mock("@/lib/db", () => ({
  db: {
    releaseCandidate: { findMany: mocks.candidates },
    releaseProductionCheck: { findUnique: mocks.check },
    repository: { findFirst: mocks.repository },
  },
}));
import { reconcileActiveRcPublication, reconcileRcUntilSettled, runRcProductionSweep } from "@/lib/release-rc-reconcile";
const ctx = { owner: "o", repo: "r", token: "t" };
const row = (phase: string, activeKey: string | null = "o/r") => ({ id: "c1", phase, activeKey });
beforeEach(() => vi.resetAllMocks());
it("承認待ちから既存の照合で稼働確認・解放まで進む", async () => {
  mocks.load.mockResolvedValueOnce(row("awaiting_approval")).mockResolvedValueOnce(row("deploying")).mockResolvedValueOnce(row("verifying_production")).mockResolvedValueOnce(row("completed", null));
  await reconcileActiveRcPublication(ctx);
  expect(mocks.reconcile).toHaveBeenCalledTimes(3);
  expect(mocks.reconcile).toHaveBeenCalledWith(ctx, "c1");
});
it("検証待ち・失敗で段階が変わらなければ繰り返さない", async () => {
  mocks.load.mockResolvedValue(row("awaiting_approval"));
  await reconcileActiveRcPublication(ctx);
  expect(mocks.reconcile).toHaveBeenCalledTimes(1);
});
it("GitHub取得失敗は上位のunknownへ伝え、候補なしとは扱わない", async () => {
  mocks.load.mockResolvedValue(row("deploying"));
  mocks.reconcile.mockRejectedValue(new Error("GitHub unavailable"));
  await expect(reconcileActiveRcPublication(ctx)).rejects.toThrow("GitHub unavailable");
});
it("レビュー段階も照合へ渡し、マージ済みの候補の復旧（#4805）で段階が進めば続けて追う", async () => {
  mocks.load.mockResolvedValueOnce(row("review")).mockResolvedValueOnce(row("deploying")).mockResolvedValueOnce(row("deploying"));
  await reconcileActiveRcPublication(ctx);
  expect(mocks.reconcile).toHaveBeenCalledTimes(2);
});
it.each(["completed", "cancelled"])("%sでは公開処理を進めない", async (phase) => {
  mocks.load.mockResolvedValue(row(phase));
  await reconcileActiveRcPublication(ctx);
  expect(mocks.reconcile).not.toHaveBeenCalled();
});
it("完了解放後に新候補へ乗り換えない", async () => {
  mocks.load.mockResolvedValueOnce(row("deploying")).mockResolvedValueOnce(row("completed", null));
  await reconcileActiveRcPublication(ctx);
  expect(mocks.reconcile).toHaveBeenCalledTimes(1);
  expect(mocks.load).toHaveBeenLastCalledWith({ id: "c1" });
});
it("後続の確認を待つ候補（#4712）を、候補の枠の照合より先に確かめ直す", async () => {
  mocks.load.mockResolvedValue(null);
  await reconcileActiveRcPublication(ctx);
  expect(mocks.successor).toHaveBeenCalledWith(ctx);
  expect(mocks.reconcile).not.toHaveBeenCalled();
});

it("系列の照合も、段階が変わる限り続けて稼働確認まで進める（#5404）", async () => {
  mocks.load.mockResolvedValueOnce(row("awaiting_approval")).mockResolvedValueOnce(row("deploying")).mockResolvedValueOnce(row("completed", null));
  await reconcileRcUntilSettled(ctx, "c1");
  expect(mocks.reconcile).toHaveBeenCalledTimes(2);
});

describe("本番反映中の候補の巡回（#5404）", () => {
  const now = new Date("2026-11-14T05:00:00Z");
  beforeEach(() => {
    mocks.candidates.mockResolvedValue([{ id: "c1", repositoryFullName: "o/r" }]);
    mocks.repository.mockResolvedValue({ installation: { installationId: 1 } });
  });

  it("完了系列が閉じた後も、取り残された候補を照合して完了まで進める", async () => {
    mocks.check.mockResolvedValue({ lastObservedAt: new Date(now.getTime() - 5 * 60_000) });
    mocks.load.mockResolvedValueOnce(row("deploying")).mockResolvedValueOnce(row("completed", null));
    expect(await runRcProductionSweep({ now })).toEqual({ scanned: 1, reconciled: 1 });
    expect(mocks.reconcile).toHaveBeenCalledWith({ owner: "o", repo: "r", token: "t" }, "c1");
  });

  it("直近に観測した候補は間引き、GitHubへ問い合わせない", async () => {
    mocks.check.mockResolvedValue({ lastObservedAt: new Date(now.getTime() - 10_000) });
    expect(await runRcProductionSweep({ now })).toEqual({ scanned: 1, reconciled: 0 });
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it("1候補の失敗で巡回全体を落とさない", async () => {
    mocks.candidates.mockResolvedValue([
      { id: "c1", repositoryFullName: "o/r" },
      { id: "c2", repositoryFullName: "o/s" },
    ]);
    mocks.check.mockResolvedValue(null);
    mocks.load.mockImplementation(async ({ id }: { id: string }) => ({ id, phase: "deploying", activeKey: id === "c1" ? "o/r" : "o/s" }));
    mocks.reconcile.mockRejectedValueOnce(new Error("GitHub unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runRcProductionSweep({ now })).toEqual({ scanned: 2, reconciled: 1 });
  });
});
