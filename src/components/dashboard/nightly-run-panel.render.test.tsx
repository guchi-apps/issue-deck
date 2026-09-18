// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NightlyRunPanel } from "@/components/dashboard/nightly-run-panel";
import type { NightlyRunEntryView, NightlyRunState } from "@/lib/nightly-run";

/**
 * 「予約実行」画面（#2995）。「次の5時間枠」の節が正しく出ることと、設定の切り替えが送られる
 * ことを見る（かつては「今夜の夜間実行」の節も同じ画面に並んでいたが#3019で削除した）。
 */

function entry(overrides: Partial<NightlyRunEntryView> = {}): NightlyRunEntryView {
  return {
    id: "n1",
    repositoryFullName: "guchi-apps/issue-deck",
    issueNumber: 2996,
    issueId: "9002",
    issueTitle: "リリース履歴のPR参照を折りたたむ",
    targetHost: "subpc",
    agent: "claude",
    claudeModel: null,
    optionLabels: [],
    kind: "NEXT_WINDOW",
    status: "QUEUED",
    nightKey: null,
    createdAt: "2026-09-17T10:00:00.000Z",
    resolvedAt: null,
    outcome: null,
    ...overrides,
  };
}

function state(overrides: Partial<NightlyRunState["nextWindow"]> = {}): NightlyRunState {
  return {
    nextWindow: {
      settings: { enabled: true, leadMinutes: 60, intervalMinutes: 10 },
      window: {
        phase: "waiting",
        // 2026-09-18 08:40 JST
        resetsAt: "2026-09-17T23:40:00.000Z",
        opensAt: "2026-09-17T22:40:00.000Z",
        usedPercent: 62,
        runKey: "2026-09-18 08:40",
      },
      queued: [entry()],
      results: null,
      ...overrides,
    },
  };
}

function renderPanel(next: NightlyRunState | null = state()) {
  const onUpdateSettings = vi.fn();
  const onCancel = vi.fn();
  render(
    <NightlyRunPanel
      state={next}
      isLoading={false}
      error={null}
      isSubmitting={false}
      onRefresh={vi.fn()}
      onCancel={onCancel}
      onUpdateSettings={onUpdateSettings}
      onOpenIssue={vi.fn()}
    />,
  );
  return { onUpdateSettings, onCancel };
}

afterEach(cleanup);

describe("NightlyRunPanel", () => {
  it("次の5時間枠を画面に出す", () => {
    renderPanel();

    expect(screen.getByText("予約実行")).toBeTruthy();
    expect(screen.getByText("次の5時間枠")).toBeTruthy();
    expect(screen.getByText("リリース履歴のPR参照を折りたたむ")).toBeTruthy();
    expect(screen.getAllByText("取り消す")).toHaveLength(1);
  });

  it("5時間枠のメーターに使用率とリセット時刻を出す", () => {
    renderPanel();

    expect(screen.getByText("62%")).toBeTruthy();
    const meter = screen.getByText("いまの5時間枠").parentElement;
    // 起動が始まる時刻も出す（待ち時間が読めないと積む判断ができない）
    expect(meter?.textContent).toContain("08:40にリセット");
    expect(meter?.textContent).toContain("07:40から起動");
  });

  /** #2995: 枠を取りに行かなかった（OFFで予定も無い）ときはメーターを出さない */
  it("枠を取っていなければメーターを出さない", () => {
    renderPanel(
      state({
        settings: { enabled: false, leadMinutes: 60, intervalMinutes: 10 },
        window: null,
        queued: [],
      }),
    );

    expect(screen.queryByText("62%")).toBeNull();
    expect(screen.getByText(/次枠実行はOFFです/)).toBeTruthy();
  });

  it("設定の切り替えが送られる", () => {
    const { onUpdateSettings } = renderPanel();

    fireEvent.click(screen.getByLabelText("次の5時間枠での実行を有効にする"));
    expect(onUpdateSettings).toHaveBeenCalledWith({ nextWindow: { enabled: false } });
  });

  it("取得前は骨組みだけ出す", () => {
    renderPanel(null);
    expect(screen.queryByText("次の5時間枠")).toBeNull();
  });
});
