import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ load: vi.fn(), reconcile: vi.fn(), successor: vi.fn() }));
vi.mock("@/lib/release-rc-run", () => ({ loadCandidateRow: mocks.load }));
vi.mock("@/lib/release-finalize-run", () => ({ reconcileRcFinalization: mocks.reconcile, reconcileSuccessorWaiting: mocks.successor }));
import { reconcileActiveRcPublication } from "@/lib/release-rc-reconcile";
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
