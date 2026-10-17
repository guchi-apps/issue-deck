// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReleaseBlockNotice, releaseBlockShortLabel } from "@/components/dashboard/release-block-notice";
import { decideDevelopSync } from "@/lib/release-develop-sync";
import { classifyRcBlock } from "@/lib/release-rc";
import type { ReleaseStartMode } from "@/lib/release-start-mode";

const inconsistent = classifyRcBlock({ candidateId: "c1", sequence: 1, prNumber: 4610, phase: "review", status: "deploying", statusLabel: "本番反映中" });
const inProgress = classifyRcBlock({ candidateId: "c2", sequence: 2, prNumber: 4701, phase: "review", status: "verifying", statusLabel: "検証中" });
const blocked = (block: typeof inconsistent): ReleaseStartMode => ({ mode: "blocked", label: block.reason, block });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ReleaseBlockNotice（#4628）", () => {
  it("取得中は確認中と表示する", () => {
    render(<ReleaseBlockNotice repositoryFullName="o/r" startMode={null} onChanged={() => {}} />);
    expect(screen.getByTestId("release-block-loading")).toBeTruthy();
  });

  it("取得失敗は取得不能と再取得を出し、候補なしとは扱わない", () => {
    const onChanged = vi.fn();
    render(<ReleaseBlockNotice repositoryFullName="o/r" startMode={{ mode: "unknown", label: "取得できませんでした" }} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "再取得" }));
    expect(onChanged).toHaveBeenCalled();
  });

  it("進行中の候補は既存の候補を開く導線を主操作にする", () => {
    render(<ReleaseBlockNotice repositoryFullName="o/r" startMode={blocked(inProgress)} onChanged={() => {}} />);
    expect(screen.getByRole("link", { name: "既存の候補を開く" }).getAttribute("href")).toBe("https://github.com/o/r/pull/4701");
    expect(screen.queryByRole("button", { name: /管理記録を終了/ })).toBeNull();
  });

  it("状態不整合は事実・未確認事項を示し、確認を通した明示操作で終了する（expectedPhaseを送る）", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();
    render(<ReleaseBlockNotice repositoryFullName="o/r" startMode={blocked(inconsistent)} onChanged={onChanged} />);
    expect(screen.getByText("状態不整合")).toBeTruthy();
    expect(screen.getByText(/未確認/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "管理記録を終了する…" }));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "管理記録を終了する" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ action: "cancel", candidateId: "c1", expectedPhase: "review" });
  });

  it("終了が競合で拒否されたらエラーを出す", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ ok: false, error: "candidate_changed" }) }));
    render(<ReleaseBlockNotice repositoryFullName="o/r" startMode={blocked(inconsistent)} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "管理記録を終了する…" }));
    fireEvent.click(await screen.findByRole("button", { name: "管理記録を終了する" }));
    expect((await screen.findAllByText(/状態が変わっています/)).length).toBeGreaterThan(0);
  });

  it("起動直前に見つかった既存候補は表示後に作られた旨と次の操作を出す", () => {
    render(<ReleaseBlockNotice repositoryFullName="o/r" startMode={{ mode: "candidate" }} blockOverride={inProgress} onChanged={() => {}} />);
    expect(screen.getByText(/表示後に別の候補が作られていました/)).toBeTruthy();
  });

  it("一括・折り畳み用の短い理由を返す", () => {
    expect(releaseBlockShortLabel(blocked(inconsistent))).toBe("RC-1 状態不整合・開始できません");
    expect(releaseBlockShortLabel(blocked(inProgress))).toBe("RC-2 進行中・開始できません");
    expect(releaseBlockShortLabel({ mode: "candidate" })).toBeNull();
  });

  describe("developへの同期（#4641）", () => {
    const MAIN = "a".repeat(40);
    const base = { kind: "observed" as const, mainSha: MAIN, developSha: "b".repeat(40), mainInDevelop: false, mainOnlyFiles: ["package.json"], squashCoveredBy: null, createFailure: null };
    const syncMode = (sync: ReturnType<typeof decideDevelopSync>): ReleaseStartMode => ({ mode: "develop_sync", label: sync.label, sync });

    it("未同期は同期PR・理由・次の操作を出し、公開の失敗とは表示しない", () => {
      const sync = decideDevelopSync({
        ...base,
        openPullRequest: { number: 70, url: "https://github.com/o/r/pull/70", headRef: "release-sync/main-aaaaaaaaaaaa", mainSha: MAIN, ciState: "success", mergeable: false },
      });
      render(<ReleaseBlockNotice repositoryFullName="o/r" startMode={syncMode(sync)} onChanged={() => {}} />);
      expect(screen.getByTestId("release-develop-sync").getAttribute("data-detail")).toBe("conflict");
      expect(screen.getByText("新規開始できません")).toBeTruthy();
      expect(screen.getByRole("link", { name: "同期PR #70 を開く" }).getAttribute("href")).toBe("https://github.com/o/r/pull/70");
      expect(screen.getByText(/本番公開の結果とは別の状態です/)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "同期PRを作成" })).toBeNull();
    });

    it("同期PRが無ければ作成を押せ、押したあとに状況を取り直す", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, developSync: decideDevelopSync({ ...base, openPullRequest: null }) }) });
      vi.stubGlobal("fetch", fetchMock);
      const onChanged = vi.fn();
      render(<ReleaseBlockNotice repositoryFullName="o/r" startMode={syncMode(decideDevelopSync({ ...base, openPullRequest: null }))} onChanged={onChanged} />);
      fireEvent.click(screen.getByRole("button", { name: "同期PRを作成" }));
      await waitFor(() => expect(onChanged).toHaveBeenCalled());
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ owner: "o", repo: "r", action: "develop_sync" });
    });

    it("判定不能は同期済みと扱わず、再確認を出す", () => {
      const sync = decideDevelopSync({ kind: "unreadable", reason: "developの先端を取得できませんでした" });
      render(<ReleaseBlockNotice repositoryFullName="o/r" startMode={syncMode(sync)} onChanged={() => {}} />);
      expect(screen.getByText("同期状態を判定できません")).toBeTruthy();
      expect(screen.getByRole("button", { name: "再確認" })).toBeTruthy();
    });
  });
});

describe("ReleaseBlockNotice — 稼働確認の停止（#4712）", () => {
  const stopped = {
    ...classifyRcBlock({
      candidateId: "c9",
      sequence: 1,
      prNumber: 254,
      phase: "verifying_production",
      status: "production_stopped",
      statusLabel: "稼働確認が停止（証拠未設定）",
      productionStopReason: "contract_missing",
      statusReason: "照合を入れてから次の候補を開始できます",
    }),
    successorStart: { allowed: false as const, reason: "developのdeploy.ymlにまだ稼働版の照合がありません" },
  };

  it("スピナー（進行中）ではなく停止として、原因・次の操作・始められない理由と再確認を出す", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const onChanged = vi.fn();
    render(<ReleaseBlockNotice repositoryFullName="guchi-apps/car-care" startMode={blocked(stopped)} onChanged={onChanged} />);
    expect(screen.getByTestId("release-block-notice").getAttribute("data-kind")).toBe("production_stopped");
    expect(screen.getByText("稼働確認が停止（証拠未設定）")).toBeTruthy();
    expect(screen.getByText(/次の操作: 照合を入れてから/)).toBeTruthy();
    expect(screen.getByText(/まだ稼働版の照合がありません/)).toBeTruthy();
    expect(screen.queryByText("管理記録を終了する…")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "稼働確認をやり直す" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body ?? "{}")));
    expect(bodies).toContainEqual(expect.objectContaining({ owner: "guchi-apps", repo: "car-care", action: "recheck_production", candidateId: "c9" }));
    expect(releaseBlockShortLabel(blocked(stopped))).toBe("RC-1 稼働確認が停止・開始できません");
  });

  it("developに照合が入っていれば開始できると出し、旧い候補が後続の確認待ちへ移ることを先に伝える", () => {
    const successorOf = { ...stopped, successorStart: { allowed: true as const } };
    render(<ReleaseBlockNotice repositoryFullName="guchi-apps/car-care" startMode={{ mode: "candidate", successorOf }} onChanged={() => {}} />);
    expect(screen.getByTestId("release-block-successor")).toBeTruthy();
    expect(screen.getByText(/後続の稼働確認待ち/)).toBeTruthy();
  });
});
