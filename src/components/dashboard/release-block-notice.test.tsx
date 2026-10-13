// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReleaseBlockNotice, releaseBlockShortLabel } from "@/components/dashboard/release-block-notice";
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
});
